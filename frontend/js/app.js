//const API_URL = 'http://localhost:3000/api';
const API_URL = '/api';
// --- VARIABLES DE ESTADO GLOBALES ---
let horarioFile = null;
let horariosMemoria = [];
let alumnosMemoria = [];
let directorioMemoria = [];
let maestroSeleccionadoDirectorio = null;
let turnoFiltroDirectorio = 'Todos';
let clasesMaestroSeleccionado = [];
const fotosCache = new Map();
let maestrosMemoria = [];
let maestroFile = null;

const SIN_FOTO_ADMIN = '<span style="font-size: 12px; color: #95A5A6;">Sin foto</span>';
const SIN_FOTO_ALUMNO = '<span style="font-size: 14px; color: #95A5A6;">Sin foto</span>';

// --- BLOQUES HORARIOS POR TURNO ---
const HORAS_MATUTINO = [
    "07:10 - 08:00",
    "08:00 - 08:50",
    "08:50 - 09:40",
    "09:40 - 10:30",
    "10:30 - 11:20",
    "11:20 - 12:10",
    "12:10 - 13:00",
    "13:00 - 13:50"
];

const HORAS_NOCTURNO = [
    "17:00 - 17:50",
    "17:50 - 18:40",
    "18:40 - 19:30",
    "19:30 - 20:20",
    "20:20 - 21:10",
    "21:10 - 22:00"
];

// --- UTILIDADES, TOASTS Y MODAL DE CONFIRMACIÓN ---
const showLoader = () => document.getElementById('loader').classList.remove('hidden');
const hideLoader = () => document.getElementById('loader').classList.add('hidden');

const authFetch = async (url, options = {}) => {
    const sesionGuardada = sessionStorage.getItem('sesionActiva');
    let token = null;
    if (sesionGuardada) {
        try {
            token = JSON.parse(sesionGuardada).token;
        } catch (e) {}
    }

    const headers = { ...(options.headers || {}) };
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }

    const res = await fetch(url, { ...options, headers });

    if (res.status === 401) {
        mostrarNotificacion('Tu sesión ha expirado. Inicia sesión nuevamente.', 'warning');
        cerrarSesion();
        throw new Error('No autorizado');
    }

    return res;
};

const escapeHTML = (str) => {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
};

const normalizarTexto = (txt) => {
    return String(txt || '')
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");
};

const mostrarNotificacion = (mensaje, tipo = 'info') => {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `toast ${tipo}`;
    toast.innerHTML = `
        <span>${escapeHTML(mensaje)}</span>
        <button type="button" class="toast-close">&times;</button>
    `;

    const cerrar = () => {
        toast.style.animation = 'toastOut 0.25s ease forwards';
        setTimeout(() => toast.remove(), 250);
    };

    toast.querySelector('.toast-close').onclick = cerrar;
    container.appendChild(toast);

    setTimeout(cerrar, 3800);
};

const mostrarConfirmacion = (mensaje, titulo = 'Confirmar eliminación') => {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'confirm-overlay';
        overlay.innerHTML = `
            <div class="confirm-box">
                <div class="confirm-icon">!</div>
                <h3 class="confirm-title">${escapeHTML(titulo)}</h3>
                <p class="confirm-message">${escapeHTML(mensaje)}</p>
                <div class="confirm-actions">
                    <button type="button" class="btn-muted" id="btn-confirm-cancelar">Cancelar</button>
                    <button type="button" class="btn-danger" id="btn-confirm-aceptar">Eliminar</button>
                </div>
            </div>
        `;

        const cerrar = (resultado) => {
            document.removeEventListener('keydown', onKey);
            overlay.remove();
            resolve(resultado);
        };

        const onKey = (e) => {
            if (e.key === 'Escape') cerrar(false);
        };

        overlay.querySelector('#btn-confirm-cancelar').onclick = () => cerrar(false);
        overlay.querySelector('#btn-confirm-aceptar').onclick = () => cerrar(true);
        overlay.onclick = (e) => {
            if (e.target === overlay) cerrar(false);
        };

        document.addEventListener('keydown', onKey);
        document.body.appendChild(overlay);
        overlay.querySelector('#btn-confirm-aceptar').focus();
    });
};

const copiarTexto = async (texto, etiqueta = 'Texto') => {
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(texto);
        } else {
            const tempInput = document.createElement('textarea');
            tempInput.value = texto;
            document.body.appendChild(tempInput);
            tempInput.select();
            document.execCommand('copy');
            tempInput.remove();
        }
        mostrarNotificacion(`${etiqueta} copiado al portapapeles`, 'success');
    } catch (err) {
        mostrarNotificacion(`No se pudo copiar el ${etiqueta.toLowerCase()}`, 'error');
    }
};

const convertirHoraAMinutos = (horaStr) => {
    const [h, m] = String(horaStr).split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
};

// Función para calcular automáticamente el salón del maestro según la hora actual
const actualizarSalonEnVivo = () => {
    if (!maestroSeleccionadoDirectorio || !Array.isArray(clasesMaestroSeleccionado)) return;

    const boxSalon = document.getElementById('preview-salon-actual');
    if (!boxSalon) return;

    if (clasesMaestroSeleccionado.length === 0) {
        boxSalon.innerHTML = `<strong>Salón actual:</strong><br><span class="badge-libre">Sin clases registradas</span>`;
        return;
    }

    const ahora = new Date();
    const diasMap = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
    const diaActual = diasMap[ahora.getDay()];
    const horaActualMinutos = ahora.getHours() * 60 + ahora.getMinutes();

    const clasesHoy = clasesMaestroSeleccionado.filter(
        c => c.dia && normalizarTexto(c.dia) === normalizarTexto(diaActual)
    );

    let estadoHtml = '';

    if (clasesHoy.length === 0) {
        estadoHtml = `<span class="badge-libre">Sin clases registradas para hoy (${diaActual})</span>`;
    } else {
        let claseActiva = null;
        let claseProxima = null;

        for (let c of clasesHoy) {
            const partesHora = String(c.hora).split('-');
            if (partesHora.length === 2) {
                const inicioMin = convertirHoraAMinutos(partesHora[0].trim());
                const finMin = convertirHoraAMinutos(partesHora[1].trim());

                if (horaActualMinutos >= inicioMin && horaActualMinutos < finMin) {
                    claseActiva = c;
                    break;
                } else if (inicioMin > horaActualMinutos) {
                    if (!claseProxima || inicioMin < convertirHoraAMinutos(claseProxima.hora.split('-')[0].trim())) {
                        claseProxima = c;
                    }
                }
            }
        }

        if (claseActiva) {
            estadoHtml = `<strong style="color:var(--primary); font-size:14px;">Salón: ${escapeHTML(claseActiva.salon)}</strong><br><span class="badge-en-clase">En clase: ${escapeHTML(claseActiva.materia)} (${escapeHTML(claseActiva.hora)})</span>`;
        } else if (claseProxima) {
            const horaInicioProx = claseProxima.hora.split('-')[0].trim();
            estadoHtml = `<span class="badge-libre">Hora libre</span><br><span class="badge-proxima">Próxima clase: ${horaInicioProx} en salón ${escapeHTML(claseProxima.salon)} (${escapeHTML(claseProxima.materia)})</span>`;
        } else {
            estadoHtml = `<span class="badge-libre">Hora libre</span><br><small class="text-muted">Clases concluidas por hoy</small>`;
        }
    }

    boxSalon.innerHTML = `<strong>Salón actual:</strong><br>${estadoHtml}`;
};

const toggleView = (viewId) => {
    document.querySelectorAll('.view').forEach(v => {
        v.classList.add('hidden');
        v.classList.remove('active');
    });
    const target = document.getElementById(viewId);
    if (target) {
        target.classList.remove('hidden');
        target.classList.add('active');
    }
};

const switchTab = (tabId, btnElement) => {
    document.querySelectorAll('.tab-content').forEach(t => {
        t.classList.add('hidden');
        t.classList.remove('active');
    });
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));

    const targetTab = document.getElementById(tabId);
    if (targetTab) {
        targetTab.classList.remove('hidden');
        targetTab.classList.add('active');
    }
    if (btnElement) {
        btnElement.classList.add('active');
    } else if (typeof event !== 'undefined' && event && event.target) {
        event.target.classList.add('active');
    }

    sessionStorage.setItem('adminTabActiva', tabId);
};

const iniciarReloj = () => {
    const opciones = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' };
    let ultimoMinuto = -1;

    const tick = () => {
        const ahora = new Date();
        const str = ahora.toLocaleDateString('es-ES', opciones);
        const rAdmin = document.getElementById('reloj-admin');
        const rAlumno = document.getElementById('reloj-alumno');
        if (rAdmin) rAdmin.innerText = str;
        if (rAlumno) rAlumno.innerText = str;

        if (ahora.getMinutes() !== ultimoMinuto) {
            ultimoMinuto = ahora.getMinutes();
            actualizarSalonEnVivo();
        }
    };
    tick();
    setInterval(tick, 1000);
};
iniciarReloj();

const resetearVistaAlumno = () => {
    const searchInput = document.getElementById('search-directorio');
    if (searchInput) searchInput.value = '';
    turnoFiltroDirectorio = 'Todos';
    document.querySelectorAll('.btn-filtro-turno').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.turno === 'Todos');
    });
    document.getElementById('preview-avatar').innerHTML = SIN_FOTO_ALUMNO;
    const previewNombre = document.getElementById('preview-nombre');
    previewNombre.innerText = 'Selecciona un maestro';
    previewNombre.classList.add('text-hint');
    previewNombre.classList.remove('text-primary');
    document.getElementById('preview-data').classList.add('hidden');
    maestroSeleccionadoDirectorio = null;
    clasesMaestroSeleccionado = [];
};

const cerrarModalCalendario = () => {
    document.getElementById('modal-calendario').classList.add('hidden');
};

const cerrarPreviewMovil = () => {
    const previewPanel = document.querySelector('.preview-panel');
    if (previewPanel) previewPanel.classList.remove('mobile-open');
};

const cerrarSesion = () => {
    sessionStorage.removeItem('sesionActiva');
    sessionStorage.removeItem('adminTabActiva');
    cerrarModalCalendario();
    cerrarPreviewMovil();
    toggleView('view-login');
    document.getElementById('form-login').reset();
};

const aplicarSesion = (sesion) => {
    if (sesion.role === 'admin') {
        toggleView('view-admin');
        const tabGuardada = sessionStorage.getItem('adminTabActiva') || 'tab-horarios';
        const mapaTabs = {
            'tab-horarios': 'btn-tab-horarios',
            'tab-maestros': 'btn-tab-maestros',
            'tab-alumnos': 'btn-tab-alumnos'
        };
        const btnTab = document.getElementById(mapaTabs[tabGuardada] || 'btn-tab-horarios');
        switchTab(tabGuardada, btnTab);
        cargarTablaHorarios();
        cargarTablaMaestros();
        cargarTablaAlumnos();
    } else {
        resetearVistaAlumno();
        toggleView('view-alumno');
        document.getElementById('alumno-welcome').innerText = `Bienvenido ${sesion.nombre}`;
        cargarDirectorio();
    }
};

const restaurarSesion = () => {
    const sesionGuardada = sessionStorage.getItem('sesionActiva');
    if (!sesionGuardada) return;

    try {
        const sesion = JSON.parse(sesionGuardada);
        if (sesion && sesion.role && sesion.token) {
            aplicarSesion(sesion);
        }
    } catch (e) {
        sessionStorage.removeItem('sesionActiva');
    }
};

// --- LOGIN ---

const ICONO_OJO_ABIERTO = `
<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
    <circle cx="12" cy="12" r="3"></circle>
</svg>`;

const ICONO_OJO_CERRADO = `
<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
    <line x1="1" y1="1" x2="23" y2="23"></line>
</svg>`;

const btnTogglePass = document.getElementById('toggle-pass');
if (btnTogglePass) {
    btnTogglePass.innerHTML = ICONO_OJO_ABIERTO;
    btnTogglePass.style.display = 'inline-flex';
    btnTogglePass.style.alignItems = 'center';
    btnTogglePass.style.justifyContent = 'center';

    btnTogglePass.addEventListener('click', function() {
        const input = document.getElementById('login-pass');
        if (input.type === 'password') {
            input.type = 'text';
            this.innerHTML = ICONO_OJO_CERRADO;
        } else {
            input.type = 'password';
            this.innerHTML = ICONO_OJO_ABIERTO;
        }
    });
}

document.getElementById('form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('btn-entrar');
    btn.disabled = true; showLoader();

    try {
        const res = await fetch(`${API_URL}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                usuario: document.getElementById('login-user').value,
                password: document.getElementById('login-pass').value
            })
        });
        const data = await res.json();
        
        if (data.success) {
            const sesion = { role: data.role, nombre: data.nombre, token: data.token };
            sessionStorage.setItem('sesionActiva', JSON.stringify(sesion));
            aplicarSesion(sesion);
            mostrarNotificacion(`Sesión iniciada como ${data.nombre}`, 'success');
        } else {
            mostrarNotificacion(data.message || 'Credenciales incorrectas', 'error');
        }
    } catch (error) {
    console.error(error);
    mostrarNotificacion('Error de conexión al servidor.', 'error');
    } finally {
        btn.disabled = false; hideLoader();
    }
});

// --- SELECTOR DINÁMICO DE HORAS SEGÚN TURNO ---
const actualizarSelectHoras = (turnoSeleccionado, horaPreseleccionada = '') => {
    const selectHora = document.getElementById('admin-hora');
    if (!selectHora) return;

    const valorActual = horaPreseleccionada !== '' ? horaPreseleccionada : selectHora.value;
    let html = '<option value="">Seleccione...</option>';

    if (turnoSeleccionado === 'Matutino') {
        html += HORAS_MATUTINO.map(h => `<option value="${h}">${h}</option>`).join('');
    } else if (turnoSeleccionado === 'Nocturno') {
        html += HORAS_NOCTURNO.map(h => `<option value="${h}">${h}</option>`).join('');
    } else {
        html += `<optgroup label="Turno Matutino (07:10 - 13:50)">` +
            HORAS_MATUTINO.map(h => `<option value="${h}">${h}</option>`).join('') +
            `</optgroup>` +
            `<optgroup label="Turno Nocturno (17:00 - 22:00)">` +
            HORAS_NOCTURNO.map(h => `<option value="${h}">${h}</option>`).join('') +
            `</optgroup>`;
    }

    selectHora.innerHTML = html;

    if (valorActual) {
        const existeOpcion = Array.from(selectHora.options).some(opt => opt.value === valorActual);
        if (!existeOpcion) {
            selectHora.innerHTML += `<option value="${escapeHTML(valorActual)}">${escapeHTML(valorActual)}</option>`;
        }
        selectHora.value = valorActual;
    }
};

const selectTurnoAdmin = document.getElementById('admin-turno');
if (selectTurnoAdmin) {
    selectTurnoAdmin.addEventListener('change', (e) => {
        actualizarSelectHoras(e.target.value);
    });
    actualizarSelectHoras(selectTurnoAdmin.value);
}

// --- ADMIN: HORARIOS Y MAESTROS ---
const FORMATOS_IMAGEN_VALIDOS = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
const MAX_TAMANO_ORIGEN_MB = 10;
const MAX_DIMENSION_FOTO = 500;
const CALIDAD_COMPRESION = 0.8;

const procesarYComprimirImagen = (file) => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('No se pudo leer el archivo de imagen.'));
        reader.onload = (ev) => {
            const img = new Image();
            img.onerror = () => reject(new Error('El archivo de imagen está dañado o no es válido.'));
            img.onload = () => {
                let width = img.width;
                let height = img.height;

                if (width > height) {
                    if (width > MAX_DIMENSION_FOTO) {
                        height = Math.round((height * MAX_DIMENSION_FOTO) / width);
                        width = MAX_DIMENSION_FOTO;
                    }
                } else {
                    if (height > MAX_DIMENSION_FOTO) {
                        width = Math.round((width * MAX_DIMENSION_FOTO) / height);
                        height = MAX_DIMENSION_FOTO;
                    }
                }

                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;

                const ctx = canvas.getContext('2d');
                ctx.fillStyle = '#FFFFFF';
                ctx.fillRect(0, 0, width, height);
                ctx.drawImage(img, 0, 0, width, height);

                const dataUrlPreview = canvas.toDataURL('image/jpeg', CALIDAD_COMPRESION);

                canvas.toBlob(
                    (blob) => {
                        if (!blob) return reject(new Error('Error al comprimir la imagen.'));
                        const nombreBase = (file.name || 'foto').replace(/\.[^/.]+$/, '');
                        const archivoOptimizado = new File([blob], `${nombreBase}.jpg`, {
                            type: 'image/jpeg',
                            lastModified: Date.now()
                        });
                        resolve({ file: archivoOptimizado, preview: dataUrlPreview });
                    },
                    'image/jpeg',
                    CALIDAD_COMPRESION
                );
            };
            img.src = ev.target.result;
        };
        reader.readAsDataURL(file);
    });
};

document.getElementById('admin-foto').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (!FORMATOS_IMAGEN_VALIDOS.includes(file.type)) {
        mostrarNotificacion('Formato no válido. Usa imágenes JPG, PNG o WEBP.', 'warning');
        e.target.value = '';
        horarioFile = null;
        return;
    }

    if (file.size > MAX_TAMANO_ORIGEN_MB * 1024 * 1024) {
        mostrarNotificacion(`La imagen supera los ${MAX_TAMANO_ORIGEN_MB} MB permitidos.`, 'warning');
        e.target.value = '';
        horarioFile = null;
        return;
    }

    try {
        const resultado = await procesarYComprimirImagen(file);
        horarioFile = resultado.file;
        document.getElementById('admin-foto-preview').innerHTML = `<img src="${resultado.preview}" alt="Foto">`;
        
        const kbFinal = Math.max(1, Math.round(horarioFile.size / 1024));
        mostrarNotificacion(`Imagen optimizada (${kbFinal} KB) lista para guardar`, 'success');
    } catch (error) {
        mostrarNotificacion(error.message || 'Error al procesar la imagen', 'error');
        e.target.value = '';
        horarioFile = null;
        document.getElementById('admin-foto-preview').innerHTML = SIN_FOTO_ADMIN;
    }
});

document.getElementById('admin-maestro').addEventListener('input', async (e) => {
    const nombreMaestro = e.target.value.trim();
    if (!nombreMaestro || !Array.isArray(horariosMemoria)) return;

    const maestroEncontrado = horariosMemoria.find(h => h.maestro && h.maestro.toLowerCase() === nombreMaestro.toLowerCase());
    if (maestroEncontrado) {
        if (maestroEncontrado.turno) {
            document.getElementById('admin-turno').value = maestroEncontrado.turno;
            actualizarSelectHoras(maestroEncontrado.turno);
        }
        if (maestroEncontrado.correo_institucional && maestroEncontrado.correo_institucional !== 'No registrado') {
            document.getElementById('admin-correo').value = maestroEncontrado.correo_institucional;
        }
        if (maestroEncontrado.telefono) {
            document.getElementById('admin-telefono').value = maestroEncontrado.telefono;
        }

        if (!horarioFile) {
            try {
                const resFoto = await authFetch(`${API_URL}/directorio/foto/${encodeURIComponent(maestroEncontrado.maestro)}`);
                const dataFoto = await resFoto.json();
                if (dataFoto.foto) {
                    document.getElementById('admin-foto-preview').innerHTML = `<img src="${dataFoto.foto}" alt="Docente">`;
                }
            } catch (err) {}
        }
    }
});

const limpiarFormHorarios = () => {
    document.getElementById('form-horarios').reset();
    document.getElementById('horario-id').value = "";
    document.getElementById('admin-foto').value = "";
    document.getElementById('admin-foto-preview').innerHTML = SIN_FOTO_ADMIN;
    horarioFile = null;
    actualizarSelectHoras(document.getElementById('admin-turno').value, '');
    document.querySelectorAll('#tabla-horarios tr').forEach(tr => tr.classList.remove('selected'));
};
document.getElementById('btn-limpiar-hr').addEventListener('click', limpiarFormHorarios);

const renderizarTablaHorarios = (datos) => {
    const tbody = document.querySelector('#tabla-horarios tbody');
    tbody.innerHTML = "";
    const lista = Array.isArray(datos) ? datos : [];
    const idSeleccionado = document.getElementById('horario-id').value;

    const contador = document.getElementById('contador-horarios');
    if (contador) contador.innerText = `${lista.length} ${lista.length === 1 ? 'registro encontrado' : 'registros encontrados'}`;

    if (lista.length === 0) {
        tbody.innerHTML = `<tr><td colspan="9" class="empty-row">No hay registros de horarios o maestros</td></tr>`;
        return;
    }

    lista.forEach(row => {
        const tr = document.createElement('tr');
        if (String(row.id) === String(idSeleccionado)) tr.classList.add('selected');
        
        tr.innerHTML = `
            <td>${escapeHTML(row.id)}</td>
            <td>${escapeHTML(row.maestro)}</td>
            <td>${escapeHTML(row.turno || 'Matutino')}</td>
            <td>${escapeHTML(row.correo_institucional || 'No registrado')}</td>
            <td>${escapeHTML(row.telefono || '--')}</td>
            <td>${escapeHTML(row.materia)}</td>
            <td>${escapeHTML(row.salon)}</td>
            <td>${escapeHTML(row.dia)}</td>
            <td>${escapeHTML(row.hora)}</td>
        `;

        tr.onclick = async () => {
            document.querySelectorAll('#tabla-horarios tr').forEach(t => t.classList.remove('selected'));
            tr.classList.add('selected');
            document.getElementById('horario-id').value = row.id;
            document.getElementById('admin-maestro').value = row.maestro;
            
            const turnoRow = row.turno || 'Matutino';
            document.getElementById('admin-turno').value = turnoRow;
            actualizarSelectHoras(turnoRow, row.hora);

            document.getElementById('admin-correo').value = (row.correo_institucional && row.correo_institucional !== 'No registrado') ? row.correo_institucional : '';
            document.getElementById('admin-telefono').value = row.telefono || '';
            document.getElementById('admin-materia').value = row.materia;
            document.getElementById('admin-salon').value = row.salon;
            document.getElementById('admin-dia').value = row.dia;
            document.getElementById('admin-foto').value = "";
            horarioFile = null;
            
            showLoader();
            try {
                const resFoto = await authFetch(`${API_URL}/horarios/foto/${encodeURIComponent(row.id)}`);
                const dataFoto = await resFoto.json();
                document.getElementById('admin-foto-preview').innerHTML = dataFoto.foto ? `<img src="${dataFoto.foto}" alt="Foto">` : SIN_FOTO_ADMIN;
            } catch (err) {
                document.getElementById('admin-foto-preview').innerHTML = SIN_FOTO_ADMIN;
            } finally {
                hideLoader();
            }
        };
        tbody.appendChild(tr);
    });
};

const cargarTablaHorarios = async () => {
    showLoader();
    try {
        const res = await authFetch(`${API_URL}/horarios`);
        const data = await res.json();
        horariosMemoria = Array.isArray(data) ? data : [];
        
        const maestros = new Set(), materias = new Set(), salones = new Set();
        horariosMemoria.forEach(row => {
            if (row.maestro) maestros.add(row.maestro);
            if (row.materia) materias.add(row.materia);
            if (row.salon) salones.add(row.salon);
        });

        document.getElementById('lista-maestros').innerHTML = [...maestros].map(m => `<option value="${escapeHTML(m)}">`).join('');
        document.getElementById('lista-materias').innerHTML = [...materias].map(m => `<option value="${escapeHTML(m)}">`).join('');
        document.getElementById('lista-salones').innerHTML = [...salones].map(s => `<option value="${escapeHTML(s)}">`).join('');

        const filtro = (document.getElementById('search-horarios-admin')?.value || '').toLowerCase().trim();
        if (filtro) {
            const filtrados = horariosMemoria.filter(r =>
                (r.maestro && r.maestro.toLowerCase().includes(filtro)) ||
                (r.materia && r.materia.toLowerCase().includes(filtro)) ||
                (r.salon && r.salon.toLowerCase().includes(filtro)) ||
                (r.correo_institucional && r.correo_institucional.toLowerCase().includes(filtro))
            );
            renderizarTablaHorarios(filtrados);
        } else {
            renderizarTablaHorarios(horariosMemoria);
        }
    } catch (e) {
        mostrarNotificacion('Error cargando horarios', 'error');
    } finally {
        hideLoader();
    }
};

const inputSearchHorarios = document.getElementById('search-horarios-admin');
if (inputSearchHorarios) {
    inputSearchHorarios.addEventListener('input', (e) => {
        const text = e.target.value.toLowerCase().trim();
        const filtrados = horariosMemoria.filter(row =>
            (row.maestro && row.maestro.toLowerCase().includes(text)) ||
            (row.materia && row.materia.toLowerCase().includes(text)) ||
            (row.salon && row.salon.toLowerCase().includes(text)) ||
            (row.dia && row.dia.toLowerCase().includes(text)) ||
            (row.correo_institucional && row.correo_institucional.toLowerCase().includes(text))
        );
        renderizarTablaHorarios(filtrados);
    });
}

document.getElementById('form-horarios').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (document.getElementById('horario-id').value) {
        mostrarNotificacion('Utiliza el botón Actualizar si el registro ya existe.', 'warning');
        return;
    }
    
    const formData = new FormData();
    formData.append('maestro', document.getElementById('admin-maestro').value.trim());
    formData.append('turno', document.getElementById('admin-turno').value);
    formData.append('correo_institucional', document.getElementById('admin-correo').value.trim());
    formData.append('telefono', document.getElementById('admin-telefono').value.trim());
    formData.append('materia', document.getElementById('admin-materia').value.trim());
    formData.append('salon', document.getElementById('admin-salon').value.trim());
    formData.append('dia', document.getElementById('admin-dia').value);
    formData.append('hora', document.getElementById('admin-hora').value);
    if (horarioFile) formData.append('foto', horarioFile);

    showLoader();
    try {
        const res = await authFetch(`${API_URL}/horarios`, { method: 'POST', body: formData });
        const data = await res.json();
        if (res.ok) {
            if (horarioFile) fotosCache.delete(document.getElementById('admin-maestro').value.trim());
            mostrarNotificacion('Clase y datos del maestro guardados correctamente', 'success');
            limpiarFormHorarios();
            await cargarTablaHorarios();
        } else {
            mostrarNotificacion(data.message || 'No se pudo guardar', 'error');
        }
    } catch (e) {
        mostrarNotificacion('Error al guardar', 'error');
    } finally {
        hideLoader();
    }
});

document.getElementById('btn-actualizar-hr').addEventListener('click', async () => {
    const id = document.getElementById('horario-id').value;
    if (!id) return mostrarNotificacion('Selecciona un registro de la tabla.', 'warning');
    const formHorarios = document.getElementById('form-horarios');
    if (!formHorarios.reportValidity()) return;

    const formData = new FormData();
    formData.append('maestro', document.getElementById('admin-maestro').value.trim());
    formData.append('turno', document.getElementById('admin-turno').value);
    formData.append('correo_institucional', document.getElementById('admin-correo').value.trim());
    formData.append('telefono', document.getElementById('admin-telefono').value.trim());
    formData.append('materia', document.getElementById('admin-materia').value.trim());
    formData.append('salon', document.getElementById('admin-salon').value.trim());
    formData.append('dia', document.getElementById('admin-dia').value);
    formData.append('hora', document.getElementById('admin-hora').value);
    if (horarioFile) formData.append('foto', horarioFile);

    showLoader();
    try {
        const res = await authFetch(`${API_URL}/horarios/${encodeURIComponent(id)}`, { method: 'PUT', body: formData });
        const data = await res.json();
        if (res.ok) {
            if (horarioFile) fotosCache.delete(document.getElementById('admin-maestro').value.trim());
            mostrarNotificacion('Registro actualizado correctamente', 'success');
            limpiarFormHorarios();
            await cargarTablaHorarios();
        } else {
            mostrarNotificacion(data.message || 'Error al actualizar', 'error');
        }
    } catch (e) {
        mostrarNotificacion('Error al actualizar', 'error');
    } finally {
        hideLoader();
    }
});

document.getElementById('btn-eliminar-hr').addEventListener('click', async () => {
    const id = document.getElementById('horario-id').value;
    if (!id) return mostrarNotificacion('Selecciona un registro de la tabla.', 'warning');
    
    const confirmado = await mostrarConfirmacion('¿Estás seguro de que deseas eliminar este horario? Esta acción no se puede deshacer.');
    if (!confirmado) return;

    showLoader();
    try {
        const res = await authFetch(`${API_URL}/horarios/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (res.ok) {
            mostrarNotificacion('Registro eliminado', 'success');
            limpiarFormHorarios();
            await cargarTablaHorarios();
        }
    } catch (e) {
        mostrarNotificacion('Error al eliminar', 'error');
    } finally {
        hideLoader();
    }
});

// --- ADMIN: ALUMNOS ---
const limpiarFormAlumnos = () => {
    document.getElementById('form-alumnos').reset();
    document.querySelectorAll('#tabla-alumnos tr').forEach(tr => tr.classList.remove('selected'));
    document.getElementById('alumno-matricula-original').value = '';
};
document.getElementById('btn-limpiar-al').addEventListener('click', limpiarFormAlumnos);

const renderizarTablaAlumnos = (datos) => {
    const tbody = document.querySelector('#tabla-alumnos tbody');
    tbody.innerHTML = "";
    const lista = Array.isArray(datos) ? datos : [];
    const matriculaActual = document.getElementById('admin-alumno-matricula').value.trim();

    const contador = document.getElementById('contador-alumnos');
    if (contador) contador.innerText = `${lista.length} ${lista.length === 1 ? 'alumno registrado' : 'alumnos registrados'}`;

    if (lista.length === 0) {
        tbody.innerHTML = `<tr><td colspan="2" class="empty-row">No se encontraron alumnos</td></tr>`;
        return;
    }

    lista.forEach(row => {
        const tr = document.createElement('tr');
        if (matriculaActual && row.matricula === matriculaActual) tr.classList.add('selected');
        tr.innerHTML = `<td>${escapeHTML(row.matricula)}</td><td>${escapeHTML(row.nombre)}</td>`;
        tr.onclick = () => {
            document.querySelectorAll('#tabla-alumnos tr').forEach(t => t.classList.remove('selected'));
            tr.classList.add('selected');
            document.getElementById('admin-alumno-matricula').value = row.matricula;
            document.getElementById('admin-alumno-nombre').value = row.nombre;
            document.getElementById('alumno-matricula-original').value = row.matricula;
        };
        tbody.appendChild(tr);
    });
};

const cargarTablaAlumnos = async () => {
    try {
        const res = await authFetch(`${API_URL}/alumnos`);
        const data = await res.json();
        alumnosMemoria = Array.isArray(data) ? data : [];
        const filtro = (document.getElementById('search-alumnos-admin')?.value || '').toLowerCase().trim();
        if (filtro) {
            const filtrados = alumnosMemoria.filter(a =>
                (a.matricula && a.matricula.toLowerCase().includes(filtro)) ||
                (a.nombre && a.nombre.toLowerCase().includes(filtro))
            );
            renderizarTablaAlumnos(filtrados);
        } else {
            renderizarTablaAlumnos(alumnosMemoria);
        }
    } catch (e) {
    mostrarNotificacion('Error cargando la lista de alumnos', 'error');
}
};

const inputSearchAlumnos = document.getElementById('search-alumnos-admin');
if (inputSearchAlumnos) {
    inputSearchAlumnos.addEventListener('input', (e) => {
        const text = e.target.value.toLowerCase().trim();
        const filtrados = alumnosMemoria.filter(row =>
            (row.matricula && row.matricula.toLowerCase().includes(text)) ||
            (row.nombre && row.nombre.toLowerCase().includes(text))
        );
        renderizarTablaAlumnos(filtrados);
    });
}

document.getElementById('form-alumnos').addEventListener('submit', async (e) => {
    e.preventDefault();
    const matriculaOriginal = document.getElementById('alumno-matricula-original').value.trim();
    const matricula = document.getElementById('admin-alumno-matricula').value.trim();
    const nombre = document.getElementById('admin-alumno-nombre').value.trim();

    const esEdicion = Boolean(matriculaOriginal);
    const url = esEdicion
        ? `${API_URL}/alumnos/${encodeURIComponent(matriculaOriginal)}`
        : `${API_URL}/alumnos`;
    const method = esEdicion ? 'PUT' : 'POST';

    showLoader();
    try {
        const res = await authFetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ matricula, nombre })
        });
        const data = await res.json();
        if (res.ok && data.success) {
            mostrarNotificacion(data.message || 'Alumno guardado correctamente', 'success');
            limpiarFormAlumnos();
            await cargarTablaAlumnos();
        } else {
            mostrarNotificacion(data.message || 'Error al guardar', 'error');
        }
    } catch (e) {
        mostrarNotificacion('Error de conexión', 'error');
    } finally {
        hideLoader();
    }
});

document.getElementById('btn-eliminar-al').addEventListener('click', async () => {
    const matricula = document.getElementById('admin-alumno-matricula').value.trim();
    if (!matricula) return mostrarNotificacion('Selecciona un alumno.', 'warning');
    
    const confirmado = await mostrarConfirmacion(`¿Eliminar al alumno con matrícula ${matricula}?`);
    if (!confirmado) return;

    showLoader();
    try {
        const res = await authFetch(`${API_URL}/alumnos/${encodeURIComponent(matricula)}`, { method: 'DELETE' });
        const data = await res.json();
        if (res.ok && data.success) {
            mostrarNotificacion('Alumno eliminado', 'success');
            limpiarFormAlumnos();
            await cargarTablaAlumnos();
        }
    } catch (e) {
        mostrarNotificacion('Error al eliminar alumno', 'error');
    } finally {
        hideLoader();
    }
});

// --- PANEL ALUMNO: DIRECTORIO, SALÓN ACTUAL Y CALENDARIO ---

const inicializarBotonesFiltroTurno = () => {
    if (document.getElementById('filtro-turno-container')) return;

    const searchBox = document.getElementById('search-directorio')?.closest('.search-box');
    if (!searchBox) return;

    const bar = document.createElement('div');
    bar.id = 'filtro-turno-container';
    bar.className = 'turno-filter-bar';
    bar.innerHTML = `
        <button type="button" class="btn-filtro-turno active" data-turno="Todos">Todos</button>
        <button type="button" class="btn-filtro-turno" data-turno="Matutino">Matutino</button>
        <button type="button" class="btn-filtro-turno" data-turno="Nocturno">Nocturno</button>
    `;

    bar.querySelectorAll('.btn-filtro-turno').forEach(btn => {
        btn.addEventListener('click', () => {
            bar.querySelectorAll('.btn-filtro-turno').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            turnoFiltroDirectorio = btn.dataset.turno;
            aplicarFiltrosDirectorio();
        });
    });

    searchBox.insertAdjacentElement('afterend', bar);
};

const aplicarFiltrosDirectorio = () => {
    const text = (document.getElementById('search-directorio')?.value || '').toLowerCase().trim();

    const filtrados = directorioMemoria.filter(row => {
        const turnoDocente = row.turno || 'Matutino';
        const coincideTurno =
            turnoFiltroDirectorio === 'Todos' ||
            turnoDocente === turnoFiltroDirectorio ||
            turnoDocente === 'Ambos';

        const coincideTexto =
            !text ||
            (row.maestro && row.maestro.toLowerCase().includes(text)) ||
            (row.materias && row.materias.toLowerCase().includes(text)) ||
            (row.salones && row.salones.toLowerCase().includes(text));

        return coincideTurno && coincideTexto;
    });

    renderizarDirectorio(filtrados);
};

const cargarDirectorio = async () => {
    inicializarBotonesFiltroTurno();
    showLoader();
    try {
        const res = await authFetch(`${API_URL}/directorio`);
        const data = await res.json();
        directorioMemoria = Array.isArray(data) ? data : [];
        aplicarFiltrosDirectorio();
    } catch (e) {
        mostrarNotificacion('Error cargando directorio', 'error');
    } finally {
        hideLoader();
    }
};

const renderizarDirectorio = (datos) => {
    const tbody = document.querySelector('#tabla-directorio tbody');
    tbody.innerHTML = "";
    const lista = Array.isArray(datos) ? datos : [];

    const contador = document.getElementById('contador-directorio');
    if (contador) contador.innerText = `${lista.length} ${lista.length === 1 ? 'docente' : 'docentes'}`;

    if (lista.length === 0) {
        tbody.innerHTML = `<tr><td colspan="2" class="empty-row">No se encontraron docentes registrados</td></tr>`;
        return;
    }

    lista.forEach(row => {
        const tr = document.createElement('tr');
        if (maestroSeleccionadoDirectorio === row.maestro) tr.classList.add('selected');
        
        tr.innerHTML = `<td>${escapeHTML(row.maestro)}</td><td><span class="badge-proxima" style="font-size:10px; padding:1px 5px;">${escapeHTML(row.turno || 'Matutino')}</span> ${escapeHTML(row.materias || '--')}</td>`;
        
        tr.onclick = async () => {
            if (window.innerWidth <= 960) {
            document.querySelector('.preview-panel')?.classList.add('mobile-open');
            }
            document.querySelectorAll('#tabla-directorio tr').forEach(t => t.classList.remove('selected'));
            tr.classList.add('selected');
            maestroSeleccionadoDirectorio = row.maestro;
            
            const nombreEl = document.getElementById('preview-nombre');
            nombreEl.innerText = row.maestro;
            nombreEl.classList.remove('text-hint');
            nombreEl.classList.add('text-primary');
            document.getElementById('preview-data').classList.remove('hidden');
            
            document.getElementById('preview-turno').innerHTML = `<strong>Turno:</strong> ${escapeHTML(row.turno || 'Matutino')}`;
            
            const correoEl = document.getElementById('preview-correo');
            const correoVal = (row.correo_institucional && row.correo_institucional !== 'No registrado') 
                ? row.correo_institucional.trim() 
                : '';

            if (correoVal) {
                correoEl.className = 'contact-row';
                correoEl.innerHTML = `
                    <span><strong>Correo:</strong> <a href="mailto:${escapeHTML(correoVal)}" class="contact-link">${escapeHTML(correoVal)}</a></span>
                    <button type="button" class="btn-copy-icon" id="btn-copy-email" title="Copiar correo">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                        </svg>
                    </button>
                `;
                correoEl.querySelector('#btn-copy-email').onclick = () => copiarTexto(correoVal, 'Correo');
            } else {
                correoEl.className = '';
                correoEl.innerHTML = `<strong>Correo:</strong> No registrado`;
            }
            
            const telRow = document.getElementById('preview-telefono');
            if (row.telefono && String(row.telefono).trim() !== '') {
                const telLimpio = String(row.telefono).trim();
                const soloDigitos = telLimpio.replace(/\D/g, '');
                const numWhatsApp = soloDigitos.length === 10 ? `52${soloDigitos}` : soloDigitos;

                telRow.className = 'contact-row';
                telRow.classList.remove('hidden');
                telRow.innerHTML = `
                    <span><strong>Teléfono:</strong> ${escapeHTML(telLimpio)}</span>
                    <a href="https://wa.me/${escapeHTML(numWhatsApp)}" target="_blank" rel="noopener noreferrer" class="btn-whatsapp" title="Enviar mensaje por WhatsApp">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M12.031 6.172c-3.181 0-5.767 2.586-5.768 5.766-.001 1.298.38 2.27 1.019 3.287l-.582 2.128 2.182-.573c.978.58 1.911.928 3.145.929 3.178 0 5.767-2.587 5.768-5.766.001-3.187-2.575-5.77-5.764-5.771zm3.392 8.244c-.144.405-.837.774-1.17.824-.299.045-.677.063-1.092-.069-.252-.08-.575-.187-.988-.365-1.739-.751-2.874-2.502-2.961-2.617-.087-.116-.708-.94-.708-1.793s.448-1.273.607-1.446c.159-.173.346-.217.462-.217l.332.006c.106.005.249-.04.39.298.144.347.491 1.2.534 1.287.043.087.072.188.014.304-.058.116-.087.188-.173.289l-.26.304c-.087.086-.177.18-.076.354.101.174.449.741.964 1.201.662.591 1.221.774 1.394.86s.274.072.376-.043c.101-.116.433-.506.549-.68.116-.173.231-.145.39-.087s1.011.477 1.184.564.289.13.332.202c.045.072.045.419-.1.824zm-3.423-14.416c-6.627 0-12 5.373-12 12 0 2.625.846 5.059 2.284 7.033l-1.494 5.461 5.601-1.469c1.914 1.252 4.195 1.975 6.609 1.975 6.627 0 12-5.373 12-12s-5.373-12-12-12z"/>
                        </svg>
                        WhatsApp
                    </a>
                `;
            } else {
                telRow.classList.add('hidden');
                telRow.innerHTML = '';
            }

            document.getElementById('preview-materias').innerHTML = `<strong>Materias:</strong> ${escapeHTML(row.materias || '--')}`;
            document.getElementById('preview-salones').innerHTML = `<strong>Salones asignados:</strong> ${escapeHTML(row.salones || '--')}`;

            try {
                const resClases = await authFetch(`${API_URL}/directorio/calendario/${encodeURIComponent(row.maestro.trim())}`);
                const dataClases = await resClases.json();
                clasesMaestroSeleccionado = Array.isArray(dataClases) ? dataClases : [];
                actualizarSalonEnVivo();
            } catch (err) {
                clasesMaestroSeleccionado = [];
            }

           if (fotosCache.has(row.maestro)) {
                const fotoGuardada = fotosCache.get(row.maestro);
                document.getElementById('preview-avatar').innerHTML = fotoGuardada ? `<img src="${fotoGuardada}" alt="Foto">` : SIN_FOTO_ALUMNO;
            } else {
                showLoader();
                try {
                    const res = await authFetch(`${API_URL}/directorio/foto/${encodeURIComponent(row.maestro)}`);
                    const fotoData = await res.json();
                    fotosCache.set(row.maestro, fotoData.foto || null);
                    document.getElementById('preview-avatar').innerHTML = fotoData.foto ? `<img src="${fotoData.foto}" alt="Foto">` : SIN_FOTO_ALUMNO;
                } catch (err) {
                    document.getElementById('preview-avatar').innerHTML = SIN_FOTO_ALUMNO;
                } finally {
                    hideLoader();
                }
            }
        };

        tr.ondblclick = () => abrirCalendario(row.maestro);
        tbody.appendChild(tr);
    });
};

const btnVerCalendario = document.getElementById('btn-ver-calendario');
if (btnVerCalendario) {
    btnVerCalendario.addEventListener('click', () => {
        if (maestroSeleccionadoDirectorio) abrirCalendario(maestroSeleccionadoDirectorio);
    });
}

document.getElementById('search-directorio').addEventListener('input', aplicarFiltrosDirectorio);

// --- MODAL CALENDARIO (MATUTINO, NOCTURNO Y AMBOS) ---
const dias = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes"];
const colores = ["#C0392B", "#2980B9", "#D35400", "#27AE60", "#8E44AD", "#16A085", "#F39C12"];

const diasCortos = ["Lun", "Mar", "Mié", "Jue", "Vie"];

const renderizarCalendarioMovil = (clases, asignacionColores) => {
    const tabsContainer = document.getElementById('dias-tabs-movil');
    const listaContainer = document.getElementById('clases-dia-movil');
    if (!tabsContainer || !listaContainer) return;

    const hoyJs = new Date().getDay(); // 1=Lun ... 5=Vie
    let diaActivoIdx = (hoyJs >= 1 && hoyJs <= 5) ? hoyJs - 1 : 0;

    const mostrarDia = (idx) => {
        diaActivoIdx = idx;
        tabsContainer.querySelectorAll('.dia-tab-btn').forEach((btn, i) => {
            btn.classList.toggle('active', i === idx);
        });

        const diaNombre = dias[idx];
        const clasesDia = clases
            .filter(c => normalizarTexto(c.dia) === normalizarTexto(diaNombre))
            .sort((a, b) => convertirHoraAMinutos(String(a.hora).split('-')[0]) - convertirHoraAMinutos(String(b.hora).split('-')[0]));

        if (clasesDia.length === 0) {
            listaContainer.innerHTML = `<div class="sin-clases-movil">Sin clases registradas para el ${escapeHTML(diaNombre)}</div>`;
            return;
        }

        listaContainer.innerHTML = clasesDia.map(c => {
            const color = asignacionColores[c.materia] || '#1A5276';
            return `
                <div class="clase-card-movil" style="background-color: ${color};">
                    <div class="clase-hora">${escapeHTML(c.hora)}</div>
                    <div class="clase-materia">${escapeHTML(c.materia)}</div>
                    <div class="clase-salon">Salón: ${escapeHTML(c.salon)}</div>
                </div>
            `;
        }).join('');
    };

    tabsContainer.innerHTML = diasCortos
        .map((d, i) => `<button type="button" class="dia-tab-btn" data-idx="${i}">${d}</button>`)
        .join('');

    tabsContainer.querySelectorAll('.dia-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => mostrarDia(Number(btn.dataset.idx)));
    });

    mostrarDia(diaActivoIdx);
};

const abrirCalendario = async (maestro) => {
    if (!maestro) return;
    document.getElementById('modal-titulo').innerText = `Horario Asignado: ${maestro}`;
    const tbody = document.getElementById('calendario-body');
    tbody.innerHTML = "";

    showLoader();
    try {
        let clases = [];

        if (maestroSeleccionadoDirectorio === maestro && Array.isArray(clasesMaestroSeleccionado) && clasesMaestroSeleccionado.length > 0) {
            clases = clasesMaestroSeleccionado;
        } else {
            const res = await authFetch(`${API_URL}/directorio/calendario/${encodeURIComponent(maestro.trim())}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const dataClases = await res.json();
            clases = Array.isArray(dataClases) ? dataClases : [];
        }

        const infoDocente = directorioMemoria.find(d => d.maestro === maestro);
        const turnoDocente = infoDocente?.turno || 'Matutino';

        const tieneClasesMatutinas = clases.some(c => HORAS_MATUTINO.some(h => h.replace(/\s+/g, '') === String(c.hora || '').replace(/\s+/g, '')));
        const tieneClasesNocturnas = clases.some(c => HORAS_NOCTURNO.some(h => h.replace(/\s+/g, '') === String(c.hora || '').replace(/\s+/g, '')));

        let horasMostrar = [];
        if (turnoDocente === 'Ambos' || (tieneClasesMatutinas && tieneClasesNocturnas)) {
            horasMostrar = [...HORAS_MATUTINO, ...HORAS_NOCTURNO];
        } else if (turnoDocente === 'Nocturno' || tieneClasesNocturnas) {
            horasMostrar = [...HORAS_NOCTURNO];
        } else {
            horasMostrar = [...HORAS_MATUTINO];
        }

        horasMostrar.forEach((hora, hIdx) => {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td class="td-hora">${escapeHTML(hora)}</td>` + 
                dias.map((d, dIdx) => `<td id="celda-${dIdx}-${hIdx}" class="td-libre">-- Libre --</td>`).join('');
            tbody.appendChild(tr);
        });
        
        let asignacionColores = {};
        let colorIdx = 0;

        clases.forEach(clase => {
            const diaNorm = normalizarTexto(clase.dia);
            const horaNorm = String(clase.hora || '').replace(/\s+/g, '');

            const dIdx = dias.findIndex(d => normalizarTexto(d) === diaNorm);
            const hIdx = horasMostrar.findIndex(h => h.replace(/\s+/g, '') === horaNorm);

            if (dIdx !== -1 && hIdx !== -1) {
                const td = document.getElementById(`celda-${dIdx}-${hIdx}`);
                if (td) {
                    if (!asignacionColores[clase.materia]) {
                        asignacionColores[clase.materia] = colores[colorIdx % colores.length];
                        colorIdx++;
                    }
                    td.classList.remove('td-libre');
                    td.classList.add('td-ocupada');
                    td.innerHTML = `<strong>${escapeHTML(clase.materia)}</strong><br>Salón: ${escapeHTML(clase.salon)}`;
                    td.style.backgroundColor = asignacionColores[clase.materia];
                    td.style.color = "white";
                }
            }
        });
        renderizarCalendarioMovil(clases, asignacionColores);
        document.getElementById('modal-calendario').classList.remove('hidden');
    } catch (e) {
        console.error("Detalle del error en calendario:", e);
        mostrarNotificacion('Error cargando el calendario', 'error');
    } finally {
        hideLoader();
    }
};

document.getElementById('modal-calendario').addEventListener('click', (e) => {
    if (e.target.id === 'modal-calendario') cerrarModalCalendario();
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') cerrarModalCalendario();
});

// --- ADMIN: CATÁLOGO DE MAESTROS ---
document.getElementById('maestro-foto')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!FORMATOS_IMAGEN_VALIDOS.includes(file.type)) {
        mostrarNotificacion('Formato no válido. Usa JPG, PNG o WEBP.', 'warning');
        e.target.value = ''; maestroFile = null; return;
    }
    if (file.size > MAX_TAMANO_ORIGEN_MB * 1024 * 1024) {
        mostrarNotificacion(`La imagen supera los ${MAX_TAMANO_ORIGEN_MB} MB permitidos.`, 'warning');
        e.target.value = ''; maestroFile = null; return;
    }
    try {
        const resultado = await procesarYComprimirImagen(file);
        maestroFile = resultado.file;
        document.getElementById('maestro-foto-preview').innerHTML = `<img src="${resultado.preview}" alt="Foto">`;
        mostrarNotificacion('Imagen optimizada lista para guardar', 'success');
    } catch (error) {
        mostrarNotificacion(error.message || 'Error al procesar la imagen', 'error');
        e.target.value = ''; maestroFile = null;
    }
});

const limpiarFormMaestros = () => {
    document.getElementById('form-maestros')?.reset();
    document.getElementById('maestro-id').value = '';
    document.getElementById('maestro-foto').value = '';
    document.getElementById('maestro-foto-preview').innerHTML = SIN_FOTO_ADMIN;
    maestroFile = null;
    document.querySelectorAll('#tabla-maestros tr').forEach(tr => tr.classList.remove('selected'));
};
document.getElementById('btn-limpiar-mt')?.addEventListener('click', limpiarFormMaestros);

const renderizarTablaMaestros = (datos) => {
    const tbody = document.querySelector('#tabla-maestros tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    const lista = Array.isArray(datos) ? datos : [];
    const idSel = document.getElementById('maestro-id').value;

    const contador = document.getElementById('contador-maestros');
    if (contador) contador.innerText = `${lista.length} ${lista.length === 1 ? 'docente registrado' : 'docentes registrados'}`;

    if (lista.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="empty-row">No hay docentes registrados</td></tr>`;
        return;
    }

    lista.forEach(row => {
        const tr = document.createElement('tr');
        if (String(row.id) === String(idSel)) tr.classList.add('selected');
        tr.innerHTML = `
            <td>${escapeHTML(row.id)}</td>
            <td>${escapeHTML(row.nombre_maestro)}</td>
            <td>${escapeHTML(row.turno)}</td>
            <td>${escapeHTML(row.correo_institucional)}</td>
            <td>${escapeHTML(row.telefono || '--')}</td>
            <td>${escapeHTML(row.total_clases)}</td>
        `;
        tr.onclick = async () => {
            document.querySelectorAll('#tabla-maestros tr').forEach(t => t.classList.remove('selected'));
            tr.classList.add('selected');
            document.getElementById('maestro-id').value = row.id;
            document.getElementById('mt-nombre').value = row.nombre_maestro;
            document.getElementById('mt-turno').value = row.turno || 'Matutino';
            document.getElementById('mt-correo').value = row.correo_institucional || '';
            document.getElementById('mt-telefono').value = row.telefono || '';
            document.getElementById('maestro-foto').value = '';
            maestroFile = null;

            showLoader();
            try {
                const resFoto = await authFetch(`${API_URL}/maestros/foto/${encodeURIComponent(row.id)}`);
                const dataFoto = await resFoto.json();
                document.getElementById('maestro-foto-preview').innerHTML = dataFoto.foto ? `<img src="${dataFoto.foto}" alt="Foto">` : SIN_FOTO_ADMIN;
            } catch (err) {
                document.getElementById('maestro-foto-preview').innerHTML = SIN_FOTO_ADMIN;
            } finally {
                hideLoader();
            }
        };
        tbody.appendChild(tr);
    });
};

const cargarTablaMaestros = async () => {
    try {
        const res = await authFetch(`${API_URL}/maestros`);
        const data = await res.json();
        maestrosMemoria = Array.isArray(data) ? data : [];
        const filtro = (document.getElementById('search-maestros-admin')?.value || '').toLowerCase().trim();
        const filtrados = filtro ? maestrosMemoria.filter(m =>
            (m.nombre_maestro && m.nombre_maestro.toLowerCase().includes(filtro)) ||
            (m.correo_institucional && m.correo_institucional.toLowerCase().includes(filtro))
        ) : maestrosMemoria;
        renderizarTablaMaestros(filtrados);
    } catch (e) {
        mostrarNotificacion('Error cargando catálogo de maestros', 'error');
    }
};

document.getElementById('search-maestros-admin')?.addEventListener('input', (e) => {
    const text = e.target.value.toLowerCase().trim();
    const filtrados = maestrosMemoria.filter(m =>
        (m.nombre_maestro && m.nombre_maestro.toLowerCase().includes(text)) ||
        (m.correo_institucional && m.correo_institucional.toLowerCase().includes(text))
    );
    renderizarTablaMaestros(filtrados);
});

document.getElementById('form-maestros')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (document.getElementById('maestro-id').value) {
        return mostrarNotificacion('Utiliza el botón Actualizar para modificar este docente.', 'warning');
    }
    const formData = new FormData();
    formData.append('nombre_maestro', document.getElementById('mt-nombre').value.trim());
    formData.append('turno', document.getElementById('mt-turno').value);
    formData.append('correo_institucional', document.getElementById('mt-correo').value.trim());
    formData.append('telefono', document.getElementById('mt-telefono').value.trim());
    if (maestroFile) formData.append('foto', maestroFile);

    showLoader();
    try {
        const res = await authFetch(`${API_URL}/maestros`, { method: 'POST', body: formData });
        const data = await res.json();
        if (res.ok) {
            mostrarNotificacion(data.message || 'Docente guardado', 'success');
            limpiarFormMaestros();
            await cargarTablaMaestros();
        } else {
            mostrarNotificacion(data.message || 'Error al guardar docente', 'error');
        }
    } catch (err) {
        mostrarNotificacion('Error de conexión', 'error');
    } finally {
        hideLoader();
    }
});

document.getElementById('btn-actualizar-mt')?.addEventListener('click', async () => {
    const id = document.getElementById('maestro-id').value;
    if (!id) return mostrarNotificacion('Selecciona un docente de la tabla.', 'warning');
    if (!document.getElementById('form-maestros').reportValidity()) return;

    const nombre = document.getElementById('mt-nombre').value.trim();
    const formData = new FormData();
    formData.append('nombre_maestro', nombre);
    formData.append('turno', document.getElementById('mt-turno').value);
    formData.append('correo_institucional', document.getElementById('mt-correo').value.trim());
    formData.append('telefono', document.getElementById('mt-telefono').value.trim());
    if (maestroFile) formData.append('foto', maestroFile);

    showLoader();
    try {
        const res = await authFetch(`${API_URL}/maestros/${encodeURIComponent(id)}`, { method: 'PUT', body: formData });
        const data = await res.json();
        if (res.ok) {
            if (maestroFile) fotosCache.delete(nombre);
            mostrarNotificacion(data.message || 'Docente actualizado', 'success');
            limpiarFormMaestros();
            await cargarTablaMaestros();
            await cargarTablaHorarios();
        } else {
            mostrarNotificacion(data.message || 'Error al actualizar docente', 'error');
        }
    } catch (err) {
        mostrarNotificacion('Error de conexión', 'error');
    } finally {
        hideLoader();
    }
});

document.getElementById('btn-eliminar-mt')?.addEventListener('click', async () => {
    const id = document.getElementById('maestro-id').value;
    if (!id) return mostrarNotificacion('Selecciona un docente de la tabla.', 'warning');
    const confirmado = await mostrarConfirmacion('¿Deseas eliminar este docente del catálogo?');
    if (!confirmado) return;

    showLoader();
    try {
        const res = await authFetch(`${API_URL}/maestros/${encodeURIComponent(id)}`, { method: 'DELETE' });
        const data = await res.json();
        if (res.ok) {
            mostrarNotificacion(data.message || 'Docente eliminado', 'success');
            limpiarFormMaestros();
            await cargarTablaMaestros();
        } else {
            mostrarNotificacion(data.message || 'No se pudo eliminar', 'warning');
        }
    } catch (err) {
        mostrarNotificacion('Error al eliminar docente', 'error');
    } finally {
        hideLoader();
    }
}); 

restaurarSesion();