const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const multer = require('multer');

const app = express();
app.use(cors());
app.use(express.json());


app.use(express.static(path.join(__dirname, '../frontend')));

const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 }
});

const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'escuela',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});


app.post('/api/login', async (req, res) => {
    const { usuario, password } = req.body;
    const adminUser = process.env.ADMIN_USER;
    const adminPass = process.env.ADMIN_PASS;

    if (adminUser && adminPass && usuario === adminUser && password === adminPass) {
    return res.json({ success: true, role: 'admin', nombre: 'Administrador' });
    }

    try {
        const [rows] = await pool.execute(
            'SELECT nombre, usuario FROM usuarios WHERE (usuario = ? OR matricula = ?) AND password = ?',
            [usuario, usuario, password]
        );

        if (rows.length > 0) {
            const nombreMostrar = rows[0].nombre ? rows[0].nombre : rows[0].usuario;
            res.json({ success: true, role: 'alumno', nombre: nombreMostrar });
        } else {
            res.status(401).json({ success: false, message: 'Usuario o contraseña incorrectos' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 2. Obtener Horarios e Info de Maestros (Admin)
app.get('/api/horarios', async (req, res) => {
    try {
        const [rows] = await pool.execute(`
            SELECT h.id, h.maestro, h.materia, h.salon, h.dia, h.hora,
                   COALESCE(m.turno, 'Matutino') AS turno,
                   m.correo_institucional,
                   m.telefono
            FROM horarios h
            LEFT JOIN maestros_info m ON h.maestro = m.nombre_maestro
            ORDER BY FIELD(h.dia, 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes'), h.hora, h.maestro
        `);
        res.json(rows);
    } catch (error) {
        // Fallback seguro si maestros_info aún no está disponible
        try {
            const [rowsBasic] = await pool.execute('SELECT id, maestro, materia, salon, dia, hora FROM horarios ORDER BY dia, hora');
            res.json(rowsBasic);
        } catch (err2) {
            res.status(500).json({ error: err2.message });
        }
    }
});

// 3. Crear Horario y Datos del Maestro
app.post('/api/horarios', upload.single('foto'), async (req, res) => {
    const maestro = (req.body.maestro || '').trim();
    const materia = (req.body.materia || '').trim();
    const salon = (req.body.salon || '').trim();
    const dia = (req.body.dia || '').trim();
    const hora = (req.body.hora || '').trim();
    const turno = (req.body.turno || 'Matutino').trim();
    const correo = (req.body.correo_institucional || '').trim();
    const telefono = (req.body.telefono || '').trim() || null;
    let foto = req.file ? req.file.buffer : null;

    if (!maestro || !materia || !salon || !dia || !hora || !correo) {
        return res.status(400).json({ message: 'Todos los campos obligatorios deben completarse (incluyendo correo institucional)' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(correo)) {
        return res.status(400).json({ message: 'El formato del correo institucional no es válido' });
    }

    if (telefono) {
        const telRegex = /^\+?[0-9\s\-()]{7,15}$/;
        if (!telRegex.test(telefono)) {
            return res.status(400).json({ message: 'El formato del número telefónico no es válido (7 a 15 dígitos)' });
        }
    }

    try {
        const [correoExistente] = await pool.execute(
            'SELECT nombre_maestro FROM maestros_info WHERE LOWER(correo_institucional) = LOWER(?) AND LOWER(nombre_maestro) != LOWER(?)',
            [correo, maestro]
        );
        if (correoExistente.length > 0) {
            return res.status(400).json({ message: `El correo institucional ya está registrado para el maestro: ${correoExistente[0].nombre_maestro}` });
        }

        const [choques] = await pool.execute(
            'SELECT maestro, salon FROM horarios WHERE dia = ? AND hora = ?',
            [dia, hora]
        );
        for (let row of choques) {
            if (row.maestro.trim().toLowerCase() === maestro.toLowerCase()) {
                return res.status(400).json({ message: `El maestro ya tiene clase el ${dia} a las ${hora}` });
            }
            if (row.salon.trim().toLowerCase() === salon.toLowerCase()) {
                return res.status(400).json({ message: `El salón está ocupado el ${dia} a las ${hora}` });
            }
        }

        if (!foto) {
            const [fotoExistente] = await pool.execute(
                'SELECT foto FROM horarios WHERE maestro = ? AND foto IS NOT NULL LIMIT 1',
                [maestro]
            );
            if (fotoExistente.length > 0) foto = fotoExistente[0].foto;
        }

        await pool.execute(`
            INSERT INTO maestros_info (nombre_maestro, turno, correo_institucional, telefono)
            VALUES (?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE turno = VALUES(turno), correo_institucional = VALUES(correo_institucional), telefono = VALUES(telefono)
        `, [maestro, turno, correo, telefono]);

        await pool.execute(
            'INSERT INTO horarios (maestro, materia, salon, dia, hora, foto) VALUES (?, ?, ?, ?, ?, ?)',
            [maestro, materia, salon, dia, hora, foto]
        );
        
        if (req.file && foto) {
            await pool.execute('UPDATE horarios SET foto = ? WHERE maestro = ?', [foto, maestro]);
        }
        
        res.json({ success: true, message: 'Clase y datos del maestro guardados' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// 4. Actualizar Horario y Maestro
app.put('/api/horarios/:id', upload.single('foto'), async (req, res) => {
    const id = req.params.id;
    const maestro = (req.body.maestro || '').trim();
    const materia = (req.body.materia || '').trim();
    const salon = (req.body.salon || '').trim();
    const dia = (req.body.dia || '').trim();
    const hora = (req.body.hora || '').trim();
    const turno = (req.body.turno || 'Matutino').trim();
    const correo = (req.body.correo_institucional || '').trim();
    const telefono = (req.body.telefono || '').trim() || null;
    const foto = req.file ? req.file.buffer : null;

    if (!maestro || !materia || !salon || !dia || !hora || !correo) {
        return res.status(400).json({ message: 'Todos los campos obligatorios deben completarse' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(correo)) {
        return res.status(400).json({ message: 'El formato del correo institucional no es válido' });
    }

    if (telefono) {
        const telRegex = /^\+?[0-9\s\-()]{7,15}$/;
        if (!telRegex.test(telefono)) {
            return res.status(400).json({ message: 'El formato del número telefónico no es válido' });
        }
    }

    try {
        // 1. Obtener el nombre anterior del maestro en este horario antes de modificarlo
        const [registroActual] = await pool.execute('SELECT maestro FROM horarios WHERE id = ?', [id]);
        if (registroActual.length === 0) {
            return res.status(404).json({ message: 'El registro de horario no existe' });
        }
        const maestroAnterior = (registroActual[0].maestro || '').trim();
        const cambioNombre = maestroAnterior.toLowerCase() !== maestro.toLowerCase();

        // 2. Validar que el correo no pertenezca a otro docente distinto (ignorando su nombre anterior si lo está corrigiendo)
        const [correoExistente] = await pool.execute(
            'SELECT nombre_maestro FROM maestros_info WHERE LOWER(correo_institucional) = LOWER(?) AND LOWER(nombre_maestro) != LOWER(?) AND LOWER(nombre_maestro) != LOWER(?)',
            [correo, maestro, maestroAnterior]
        );
        if (correoExistente.length > 0) {
            return res.status(400).json({ message: `El correo institucional ya está asignado a: ${correoExistente[0].nombre_maestro}` });
        }

        // 3. Validar choques de horario
        const [choques] = await pool.execute(
            'SELECT maestro, salon FROM horarios WHERE dia = ? AND hora = ? AND id != ?',
            [dia, hora, id]
        );
        for (let row of choques) {
            const nombreRow = row.maestro.trim().toLowerCase();
            if (nombreRow === maestro.toLowerCase() || (cambioNombre && nombreRow === maestroAnterior.toLowerCase())) {
                return res.status(400).json({ message: `El maestro ya tiene otra clase el ${dia} a las ${hora}` });
            }
            if (row.salon.trim().toLowerCase() === salon.toLowerCase()) {
                return res.status(400).json({ message: `El salón ya está ocupado el ${dia} a las ${hora}` });
            }
        }

        // 4. Si se corrigió el nombre del maestro, unificar sus demás clases y su registro en maestros_info
        if (maestroAnterior && maestroAnterior !== maestro) {
            await pool.execute('UPDATE horarios SET maestro = ? WHERE maestro = ?', [maestro, maestroAnterior]);
            await pool.execute('DELETE FROM maestros_info WHERE LOWER(nombre_maestro) = LOWER(?) AND LOWER(nombre_maestro) != LOWER(?)', [maestroAnterior, maestro]);
        }

        // 5. Insertar o actualizar la información del docente
        await pool.execute(`
            INSERT INTO maestros_info (nombre_maestro, turno, correo_institucional, telefono)
            VALUES (?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE nombre_maestro = VALUES(nombre_maestro), turno = VALUES(turno), correo_institucional = VALUES(correo_institucional), telefono = VALUES(telefono)
        `, [maestro, turno, correo, telefono]);

        // 6. Actualizar el registro del horario y sincronizar foto
        if (foto) {
            await pool.execute(
                'UPDATE horarios SET maestro=?, materia=?, salon=?, dia=?, hora=?, foto=? WHERE id=?',
                [maestro, materia, salon, dia, hora, foto, id]
            );
            await pool.execute('UPDATE horarios SET foto = ? WHERE maestro = ?', [foto, maestro]);
        } else {
            const [fotoMaestro] = await pool.execute(
                'SELECT foto FROM horarios WHERE maestro = ? AND foto IS NOT NULL LIMIT 1',
                [maestro]
            );
            if (fotoMaestro.length > 0) {
                await pool.execute(
                    'UPDATE horarios SET maestro=?, materia=?, salon=?, dia=?, hora=?, foto=? WHERE id=?',
                    [maestro, materia, salon, dia, hora, fotoMaestro[0].foto, id]
                );
            } else {
                await pool.execute(
                    'UPDATE horarios SET maestro=?, materia=?, salon=?, dia=?, hora=? WHERE id=?',
                    [maestro, materia, salon, dia, hora, id]
                );
            }
        }
        res.json({ success: true, message: 'Registro actualizado' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// 5. Eliminar Horario
app.delete('/api/horarios/:id', async (req, res) => {
    try {
        const id = req.params.id;

        // 1. Obtener el nombre del maestro antes de borrar la clase
        const [registro] = await pool.execute('SELECT maestro FROM horarios WHERE id = ?', [id]);
        
        if (registro.length > 0) {
            const nombreMaestro = (registro[0].maestro || '').trim();

            // 2. Eliminar el horario seleccionado
            await pool.execute('DELETE FROM horarios WHERE id = ?', [id]);

            // 3. Verificar si a ese maestro le quedan más clases registradas en horarios
            if (nombreMaestro) {
                const [clasesRestantes] = await pool.execute(
                    'SELECT COUNT(*) AS total FROM horarios WHERE TRIM(LOWER(maestro)) = TRIM(LOWER(?))',
                    [nombreMaestro]
                );

                // 4. Si ya tiene 0 clases, limpiar su registro de maestros_info para liberar el correo
                if (clasesRestantes[0].total === 0) {
                    await pool.execute(
                        'DELETE FROM maestros_info WHERE TRIM(LOWER(nombre_maestro)) = TRIM(LOWER(?))',
                        [nombreMaestro]
                    );
                }
            }
        } else {
            await pool.execute('DELETE FROM horarios WHERE id = ?', [id]);
        }

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 6. Foto por ID
app.get('/api/horarios/foto/:id', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT foto, maestro FROM horarios WHERE id = ?', [req.params.id]);
        if (rows.length > 0) {
            if (rows[0].foto) {
                return res.json({ foto: `data:image/jpeg;base64,${Buffer.from(rows[0].foto).toString('base64')}` });
            }
            const [otrasFotos] = await pool.execute(
                'SELECT foto FROM horarios WHERE maestro = ? AND foto IS NOT NULL LIMIT 1',
                [rows[0].maestro]
            );
            if (otrasFotos.length > 0 && otrasFotos[0].foto) {
                return res.json({ foto: `data:image/jpeg;base64,${Buffer.from(otrasFotos[0].foto).toString('base64')}` });
            }
        }
        res.json({ foto: null });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 7. Alumnos CRUD
app.get('/api/alumnos', async (req, res) => {
    try {
        const [rows] = await pool.execute("SELECT matricula, nombre FROM usuarios WHERE matricula != 'admin' ORDER BY nombre");
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/alumnos', async (req, res) => {
    const matricula = (req.body.matricula || '').trim();
    const nombre = (req.body.nombre || '').trim();

    if (!matricula || !nombre) {
        return res.status(400).json({ success: false, message: 'Matrícula y nombre son obligatorios' });
    }
    if (matricula.toLowerCase() === 'admin') {
        return res.status(400).json({ success: false, message: 'No se puede utilizar la matrícula reservada "admin"' });
    }

    try {
        const [exist] = await pool.execute('SELECT matricula FROM usuarios WHERE matricula = ?', [matricula]);
        if (exist.length > 0) {
            await pool.execute(
                'UPDATE usuarios SET nombre=?, usuario=?, password=? WHERE matricula=?',
                [nombre, matricula, matricula, matricula]
            );
        } else {
            await pool.execute(
                'INSERT INTO usuarios (matricula, usuario, password, nombre) VALUES (?, ?, ?, ?)',
                [matricula, matricula, matricula, nombre]
            );
        }
        res.json({ success: true, message: 'Alumno guardado correctamente' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/alumnos/:matricula', async (req, res) => {
    const matricula = (req.params.matricula || '').trim();
    if (matricula.toLowerCase() === 'admin') {
        return res.status(400).json({ success: false, message: 'No se puede eliminar la cuenta de administrador' });
    }
    try {
        await pool.execute('DELETE FROM usuarios WHERE matricula = ?', [matricula]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 8. Directorio (Panel Alumno con Turno, Correo y Teléfono)
app.get('/api/directorio', async (req, res) => {
    try {
        const [rows] = await pool.execute(`
            SELECT h.maestro, 
                   GROUP_CONCAT(DISTINCT h.materia ORDER BY h.materia SEPARATOR ', ') as materias, 
                   COUNT(h.id) as total_clases, 
                   GROUP_CONCAT(DISTINCT h.salon ORDER BY h.salon SEPARATOR ', ') as salones,
                   COALESCE(m.turno, 'Matutino') as turno,
                   COALESCE(m.correo_institucional, 'No registrado') as correo_institucional,
                   m.telefono
            FROM horarios h
            LEFT JOIN maestros_info m ON h.maestro = m.nombre_maestro
            GROUP BY h.maestro, m.turno, m.correo_institucional, m.telefono
            ORDER BY h.maestro
        `);
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/directorio/foto/:maestro', async (req, res) => {
    try {
        const [rows] = await pool.execute(
            'SELECT foto FROM horarios WHERE maestro = ? AND foto IS NOT NULL LIMIT 1',
            [req.params.maestro]
        );
        if (rows.length > 0 && rows[0].foto) {
            res.json({ foto: `data:image/jpeg;base64,${Buffer.from(rows[0].foto).toString('base64')}` });
        } else {
            res.json({ foto: null });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/directorio/calendario/:maestro', async (req, res) => {
    try {
        const [rows] = await pool.execute(
            'SELECT materia, salon, dia, hora FROM horarios WHERE maestro = ?',
            [req.params.maestro]
        );
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en http://localhost:${PORT}`));