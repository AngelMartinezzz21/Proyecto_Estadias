const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const app = express();
const JWT_SECRET = process.env.JWT_SECRET || 'clave_respaldo_desarrollo';
const storage = multer.memoryStorage();
app.use(cors({
    origin: ['http://localhost:3000', 'http://127.0.0.1:3000']
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { success: false, message: 'Demasiados intentos de inicio de sesión. Intenta de nuevo en 15 minutos.' },
    standardHeaders: true,
    legacyHeaders: false
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const permitidos = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
        if (permitidos.includes(file.mimetype)) {
            cb(null, true);
        } else {
            req.fileValidationError = 'Formato no válido. Solo se permiten imágenes JPG, PNG o WEBP.';
            cb(null, false);
        }
    }
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

// --- MIDDLEWARES DE SEGURIDAD ---
const verificarToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ success: false, message: 'Acceso denegado. Inicia sesión primero.' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (error) {
        return res.status(401).json({ success: false, message: 'Sesión expirada o inválida.' });
    }
};

const soloAdmin = (req, res, next) => {
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'Permisos insuficientes.' });
    }
    next();
};

app.post('/api/login',loginLimiter, async (req, res) => {
    const { usuario, password } = req.body;
    const adminUser = process.env.ADMIN_USER;
    const adminPass = process.env.ADMIN_PASS;

    if (adminUser && adminPass && usuario === adminUser && password === adminPass) {
        const token = jwt.sign({ role: 'admin', nombre: 'Administrador' }, JWT_SECRET, { expiresIn: '8h' });
        return res.json({ success: true, role: 'admin', nombre: 'Administrador', token });
    }

    try {
        const [rows] = await pool.execute(
            'SELECT nombre, usuario FROM usuarios WHERE (usuario = ? OR matricula = ?) AND password = ?',
            [usuario, usuario, password]
        );

        if (rows.length > 0) {
            const nombreMostrar = rows[0].nombre ? rows[0].nombre : rows[0].usuario;
            const token = jwt.sign({ role: 'alumno', nombre: nombreMostrar, usuario: rows[0].usuario }, JWT_SECRET, { expiresIn: '8h' });
            res.json({ success: true, role: 'alumno', nombre: nombreMostrar, token });
        } else {
            res.status(401).json({ success: false, message: 'Usuario o contraseña incorrectos' });
        }
    } catch (error) {
        console.error('Error en login:', error);
        res.status(500).json({ success: false, message: 'Error interno del servidor' });
    }
});

// 2. Obtener Horarios e Info de Maestros (Admin)
app.get('/api/horarios', verificarToken, soloAdmin, async (req, res) => {
    try {
        const [rows] = await pool.execute(`
            SELECT h.id, m.nombre_maestro AS maestro, h.materia, h.salon, h.dia, h.hora,
                   m.turno, m.correo_institucional, m.telefono
            FROM horarios h
            INNER JOIN maestros_info m ON h.maestro_id = m.id
            ORDER BY FIELD(h.dia, 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes'), h.hora, m.nombre_maestro
        `);
        res.json(rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error interno del servidor' });
    }
});

// 3. Crear Horario y Datos del Maestro
app.post('/api/horarios', verificarToken, soloAdmin, upload.single('foto'), async (req, res) => {
    if (req.fileValidationError) {
        return res.status(400).json({ message: req.fileValidationError });
    }

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
        return res.status(400).json({ message: 'Todos los campos obligatorios deben completarse (incluyendo correo institucional)' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(correo)) {
        return res.status(400).json({ message: 'El formato del correo institucional no es válido' });
    }

    if (telefono && !/^\+?[0-9\s\-()]{7,15}$/.test(telefono)) {
        return res.status(400).json({ message: 'El formato del número telefónico no es válido (7 a 15 dígitos)' });
    }

    try {
        const [correoExistente] = await pool.execute(
            'SELECT nombre_maestro FROM maestros_info WHERE LOWER(correo_institucional) = LOWER(?) AND LOWER(nombre_maestro) != LOWER(?)',
            [correo, maestro]
        );
        if (correoExistente.length > 0) {
            return res.status(400).json({ message: `El correo institucional ya está registrado para el maestro: ${correoExistente[0].nombre_maestro}` });
        }

        // Insertar o actualizar docente (mantiene su foto anterior si no se subió una nueva)
        await pool.execute(`
            INSERT INTO maestros_info (nombre_maestro, turno, correo_institucional, telefono, foto)
            VALUES (?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                turno = VALUES(turno),
                correo_institucional = VALUES(correo_institucional),
                telefono = VALUES(telefono),
                foto = COALESCE(VALUES(foto), foto)
        `, [maestro, turno, correo, telefono, foto]);

        const [maestroRows] = await pool.execute('SELECT id FROM maestros_info WHERE nombre_maestro = ?', [maestro]);
        const maestroId = maestroRows[0].id;

        const [choques] = await pool.execute(
            'SELECT maestro_id, salon FROM horarios WHERE dia = ? AND hora = ?',
            [dia, hora]
        );
        for (let row of choques) {
            if (row.maestro_id === maestroId) {
                return res.status(400).json({ message: `El maestro ya tiene clase el ${dia} a las ${hora}` });
            }
            if (row.salon.trim().toLowerCase() === salon.toLowerCase()) {
                return res.status(400).json({ message: `El salón está ocupado el ${dia} a las ${hora}` });
            }
        }

        await pool.execute(
            'INSERT INTO horarios (maestro_id, materia, salon, dia, hora) VALUES (?, ?, ?, ?, ?)',
            [maestroId, materia, salon, dia, hora]
        );

        res.json({ success: true, message: 'Clase y datos del maestro guardados' });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ message: 'Conflicto de horario: el maestro o el salón ya están ocupados en ese bloque.' });
        }
        console.error(error);
        res.status(500).json({ message: 'Error interno del servidor' });
    }
});

// 4. Actualizar Horario y Maestro
app.put('/api/horarios/:id', verificarToken, soloAdmin, upload.single('foto'), async (req, res) => {
    if (req.fileValidationError) {
        return res.status(400).json({ message: req.fileValidationError });
    }

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

    if (telefono && !/^\+?[0-9\s\-()]{7,15}$/.test(telefono)) {
        return res.status(400).json({ message: 'El formato del número telefónico no es válido' });
    }

    try {
        const [registroActual] = await pool.execute('SELECT maestro_id FROM horarios WHERE id = ?', [id]);
        if (registroActual.length === 0) {
            return res.status(404).json({ message: 'El registro de horario no existe' });
        }
        const maestroIdActual = registroActual[0].maestro_id;

        // Verificar si el nombre ingresado corresponde a otro maestro ya existente
        const [maestroPorNombre] = await pool.execute(
            'SELECT id FROM maestros_info WHERE LOWER(nombre_maestro) = LOWER(?)',
            [maestro]
        );
        const maestroIdFinal = maestroPorNombre.length > 0 ? maestroPorNombre[0].id : maestroIdActual;

        const [correoExistente] = await pool.execute(
            'SELECT nombre_maestro FROM maestros_info WHERE LOWER(correo_institucional) = LOWER(?) AND id != ?',
            [correo, maestroIdFinal]
        );
        if (correoExistente.length > 0) {
            return res.status(400).json({ message: `El correo institucional ya está asignado a: ${correoExistente[0].nombre_maestro}` });
        }

        const [choques] = await pool.execute(
            'SELECT maestro_id, salon FROM horarios WHERE dia = ? AND hora = ? AND id != ?',
            [dia, hora, id]
        );
        for (let row of choques) {
            if (row.maestro_id === maestroIdFinal) {
                return res.status(400).json({ message: `El maestro ya tiene otra clase el ${dia} a las ${hora}` });
            }
            if (row.salon.trim().toLowerCase() === salon.toLowerCase()) {
                return res.status(400).json({ message: `El salón ya está ocupado el ${dia} a las ${hora}` });
            }
        }

        // Actualizar datos del docente
        await pool.execute(`
            UPDATE maestros_info
            SET nombre_maestro = ?, turno = ?, correo_institucional = ?, telefono = ?, foto = COALESCE(?, foto)
            WHERE id = ?
        `, [maestro, turno, correo, telefono, foto, maestroIdFinal]);

        // Actualizar horario
        await pool.execute(
            'UPDATE horarios SET maestro_id = ?, materia = ?, salon = ?, dia = ?, hora = ? WHERE id = ?',
            [maestroIdFinal, materia, salon, dia, hora, id]
        );

        res.json({ success: true, message: 'Registro actualizado' });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ message: 'Conflicto de horario: el maestro o el salón ya están ocupados en ese bloque.' });
        }
        console.error(error);
        res.status(500).json({ message: 'Error interno del servidor' });
    }
});

// 5. Eliminar Horario (ya no borra el perfil del maestro en maestros_info)
app.delete('/api/horarios/:id', verificarToken, soloAdmin, async (req, res) => {
    try {
        await pool.execute('DELETE FROM horarios WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error interno del servidor' });
    }
});

// 6. Foto por ID de horario
app.get('/api/horarios/foto/:id', verificarToken, soloAdmin, async (req, res) => {
    try {
        const [rows] = await pool.execute(`
            SELECT m.foto
            FROM horarios h
            INNER JOIN maestros_info m ON h.maestro_id = m.id
            WHERE h.id = ?
        `, [req.params.id]);

        if (rows.length > 0 && rows[0].foto) {
            return res.json({ foto: `data:image/jpeg;base64,${Buffer.from(rows[0].foto).toString('base64')}` });
        }
        res.json({ foto: null });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error interno del servidor' });
    }
});

// 7. Alumnos CRUD
app.get('/api/alumnos', verificarToken, soloAdmin, async (req, res) => {
    try {
        const [rows] = await pool.execute("SELECT matricula, nombre FROM usuarios WHERE matricula != 'admin' ORDER BY nombre");
        res.json(rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error interno del servidor' });    }
});

app.post('/api/alumnos', verificarToken, soloAdmin, async (req, res) => {
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
        console.error(error);
        res.status(500).json({ message: 'Error interno del servidor' });    }
});

app.put('/api/alumnos/:matriculaOriginal', verificarToken, soloAdmin, async (req, res) => {
    const matriculaOriginal = (req.params.matriculaOriginal || '').trim();
    const nuevaMatricula = (req.body.matricula || '').trim();
    const nombre = (req.body.nombre || '').trim();

    if (!nuevaMatricula || !nombre) {
        return res.status(400).json({ success: false, message: 'Matrícula y nombre son obligatorios' });
    }
    if (nuevaMatricula.toLowerCase() === 'admin' || matriculaOriginal.toLowerCase() === 'admin') {
        return res.status(400).json({ success: false, message: 'No se puede utilizar la matrícula reservada "admin"' });
    }

    try {
        if (nuevaMatricula !== matriculaOriginal) {
            const [duplicado] = await pool.execute('SELECT matricula FROM usuarios WHERE matricula = ?', [nuevaMatricula]);
            if (duplicado.length > 0) {
                return res.status(400).json({ success: false, message: 'Ya existe otro alumno con esa matrícula' });
            }
        }

        const [result] = await pool.execute(
            'UPDATE usuarios SET matricula = ?, usuario = ?, password = ?, nombre = ? WHERE matricula = ?',
            [nuevaMatricula, nuevaMatricula, nuevaMatricula, nombre, matriculaOriginal]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'Alumno no encontrado' });
        }

        res.json({ success: true, message: 'Alumno actualizado correctamente' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Error interno del servidor' });
    }
});

app.delete('/api/alumnos/:matricula', verificarToken, soloAdmin, async (req, res) => {
    const matricula = (req.params.matricula || '').trim();
    if (matricula.toLowerCase() === 'admin') {
        return res.status(400).json({ success: false, message: 'No se puede eliminar la cuenta de administrador' });
    }
    try {
        await pool.execute('DELETE FROM usuarios WHERE matricula = ?', [matricula]);
        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error interno del servidor' });
    }
});

// 8. Directorio (Panel Alumno con Turno, Correo y Teléfono)
app.get('/api/directorio', verificarToken, async (req, res) => {
    try {
        const [rows] = await pool.execute(`
            SELECT m.nombre_maestro AS maestro,
                   GROUP_CONCAT(DISTINCT h.materia ORDER BY h.materia SEPARATOR ', ') AS materias,
                   COUNT(h.id) AS total_clases,
                   GROUP_CONCAT(DISTINCT h.salon ORDER BY h.salon SEPARATOR ', ') AS salones,
                   m.turno,
                   m.correo_institucional,
                   m.telefono
            FROM horarios h
            INNER JOIN maestros_info m ON h.maestro_id = m.id
            GROUP BY m.id, m.nombre_maestro, m.turno, m.correo_institucional, m.telefono
            ORDER BY m.nombre_maestro
        `);
        res.json(rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error interno del servidor' });
    }
});

app.get('/api/directorio/foto/:maestro', verificarToken, async (req, res) => {
    try {
        const [rows] = await pool.execute(
            'SELECT foto FROM maestros_info WHERE nombre_maestro = ? LIMIT 1',
            [req.params.maestro]
        );
        if (rows.length > 0 && rows[0].foto) {
            res.json({ foto: `data:image/jpeg;base64,${Buffer.from(rows[0].foto).toString('base64')}` });
        } else {
            res.json({ foto: null });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error interno del servidor' });
    }
});

app.get('/api/directorio/calendario/:maestro', verificarToken, async (req, res) => {
    try {
        const [rows] = await pool.execute(`
            SELECT h.materia, h.salon, h.dia, h.hora
            FROM horarios h
            INNER JOIN maestros_info m ON h.maestro_id = m.id
            WHERE m.nombre_maestro = ?
        `, [req.params.maestro]);
        res.json(rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error interno del servidor' });
    }
});

// 9. Maestros CRUD (Pestaña independiente)
app.get('/api/maestros', verificarToken, soloAdmin, async (req, res) => {
    try {
        const [rows] = await pool.execute(`
            SELECT m.id, m.nombre_maestro, m.turno, m.correo_institucional, m.telefono,
                   COUNT(h.id) AS total_clases
            FROM maestros_info m
            LEFT JOIN horarios h ON h.maestro_id = m.id
            GROUP BY m.id, m.nombre_maestro, m.turno, m.correo_institucional, m.telefono
            ORDER BY m.nombre_maestro
        `);
        res.json(rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error interno del servidor' });
    }
});

app.get('/api/maestros/foto/:id', verificarToken, soloAdmin, async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT foto FROM maestros_info WHERE id = ?', [req.params.id]);
        if (rows.length > 0 && rows[0].foto) {
            return res.json({ foto: `data:image/jpeg;base64,${Buffer.from(rows[0].foto).toString('base64')}` });
        }
        res.json({ foto: null });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error interno del servidor' });
    }
});

app.post('/api/maestros', verificarToken, soloAdmin, upload.single('foto'), async (req, res) => {
    if (req.fileValidationError) return res.status(400).json({ message: req.fileValidationError });

    const nombre = (req.body.nombre_maestro || '').trim();
    const turno = (req.body.turno || 'Matutino').trim();
    const correo = (req.body.correo_institucional || '').trim();
    const telefono = (req.body.telefono || '').trim() || null;
    const foto = req.file ? req.file.buffer : null;

    if (!nombre || !correo) return res.status(400).json({ message: 'Nombre y correo institucional son obligatorios' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) return res.status(400).json({ message: 'Correo institucional no válido' });
    if (telefono && !/^\+?[0-9\s\-()]{7,15}$/.test(telefono)) return res.status(400).json({ message: 'Teléfono no válido' });

    try {
        await pool.execute(
            'INSERT INTO maestros_info (nombre_maestro, turno, correo_institucional, telefono, foto) VALUES (?, ?, ?, ?, ?)',
            [nombre, turno, correo, telefono, foto]
        );
        res.json({ success: true, message: 'Docente registrado correctamente' });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ message: 'Ya existe un docente con ese nombre o correo institucional' });
        }
        console.error(error);
        res.status(500).json({ message: 'Error interno del servidor' });
    }
});

app.put('/api/maestros/:id', verificarToken, soloAdmin, upload.single('foto'), async (req, res) => {
    if (req.fileValidationError) return res.status(400).json({ message: req.fileValidationError });

    const id = req.params.id;
    const nombre = (req.body.nombre_maestro || '').trim();
    const turno = (req.body.turno || 'Matutino').trim();
    const correo = (req.body.correo_institucional || '').trim();
    const telefono = (req.body.telefono || '').trim() || null;
    const foto = req.file ? req.file.buffer : null;

    if (!nombre || !correo) return res.status(400).json({ message: 'Nombre y correo institucional son obligatorios' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) return res.status(400).json({ message: 'Correo institucional no válido' });
    if (telefono && !/^\+?[0-9\s\-()]{7,15}$/.test(telefono)) return res.status(400).json({ message: 'Teléfono no válido' });

    try {
        const [result] = await pool.execute(
            `UPDATE maestros_info
             SET nombre_maestro = ?, turno = ?, correo_institucional = ?, telefono = ?, foto = COALESCE(?, foto)
             WHERE id = ?`,
            [nombre, turno, correo, telefono, foto, id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ message: 'Docente no encontrado' });
        res.json({ success: true, message: 'Docente actualizado correctamente' });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ message: 'Ese nombre o correo ya pertenece a otro docente' });
        }
        console.error(error);
        res.status(500).json({ message: 'Error interno del servidor' });
    }
});

app.delete('/api/maestros/:id', verificarToken, soloAdmin, async (req, res) => {
    try {
        await pool.execute('DELETE FROM maestros_info WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'Docente eliminado correctamente' });
    } catch (error) {
        if (error.code === 'ER_ROW_IS_REFERENCED_2') {
            return res.status(400).json({ message: 'No se puede eliminar este docente porque aún tiene clases asignadas en Horarios.' });
        }
        console.error(error);
        res.status(500).json({ message: 'Error interno del servidor' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en http://localhost:${PORT}`));