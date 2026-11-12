// tests/desarrollador.js — la pestaña Desarrollador (rediseño v4): su conexion real con Electron y con el
// backend, y la vista.
//
// Desarrollador no calcula dinero: es la puerta a la capa nativa (la ruta de la BD, las actualizaciones), a
// la configuracion (los datos de pago de la factura) y al mantenimiento (sincronizar cronogramas). Lo que se
// puede romper al rediseñarla es el CABLE: un boton que deja de llamar a Electron, que lo llama con otro
// argumento, o que anuncia un exito que no ocurrio. Esta suite fija:
//
//   A. EL CONTRATO: cada metodo de `window.electronAPI` que la vista llama existe en desktop/preload.js, y
//      App le sigue pasando las mismas props (la sincronizacion, la configuracion, el reinicio...).
//   B. AL MONTARSE: pide la ruta y la version a Electron y se suscribe a las actualizaciones (y devuelve la
//      desuscripcion); sin Electron, las acciones del sistema de archivos se apagan y un aviso lo explica.
//   C. LA BASE DE DATOS: "Cambiar ubicacion" elige carpeta y la pasa a `setDbPath`, pide reiniciar solo si
//      salio bien y muestra el error si no; "Restaurar" pasa por la confirmacion y llama a `resetDbPath`.
//   D. LAS ACTUALIZACIONES: los siete estados con su chip y su cuerpo, y cada boton con su llamada.
//   E. EL REPORTE: cuantos prestamos activos (y con mora) entran, recalculado aparte; el clic lanza el
//      generador de siempre con los datos de siempre, y sin activos no lo lanza.
//   F. LOS DATOS DE PAGO contra el backend REAL: "Sin guardar" mientras difieren, el PUT /api/config
//      persiste, y el chip "Guardado" solo con una respuesta real.
//   G. SINCRONIZAR contra el backend REAL: POST /api/recalculate y el panel persistente de omitidos.
//   H. LA PRESENTACION v4: las cinco tarjetas en orden, sin colores en linea, con ortografia, animada.
//   I. GUARDAS ESTATICAS: dev.css y el orden de las hojas.
//
// Se ejecuta:
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron tests/desarrollador.js

const fs   = require('fs');
const path = require('path');
const { Reporter }          = require('./lib/report');
const { copiaDeProduccion } = require('./lib/db');
const { REPO }              = require('./lib/paths');

const R = new Reporter('desarrollador');

// ── RELOJ: calendario CONGELADO, reloj de ids INTACTO (como el resto de las suites del fixture) ──
const RelojReal = Date;
const INSTANTE_FIJO = new RelojReal(2026, 6, 31, 12, 0, 0);
global.Date = class extends RelojReal {
  constructor(...args) { if (args.length === 0) super(INSTANTE_FIJO.getTime()); else super(...args); }
  static now() { return RelojReal.now(); }
};

const createApp = require('../backend/server');
function arrancar(dbPath) {
  return new Promise((resolve, reject) => {
    let app;
    try { app = createApp(dbPath); } catch (e) { return reject(e); }
    const srv = app.listen(0, '127.0.0.1', () => resolve({ srv, base: 'http://127.0.0.1:' + srv.address().port }));
    srv.on('error', reject);
  });
}
const cerrar = S => new Promise(r => S.srv.close(() => r()));
async function pedir(S, metodo, ruta, cuerpo) {
  const r = await fetch(S.base + ruta, { method: metodo, headers: { 'Content-Type': 'application/json' }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}

// ── Arnes de render ──────────────────────────────────────────────────────────
const pintar = n => {
  if (n === null || n === undefined || typeof n === 'boolean') return null;
  if (typeof n === 'string' || typeof n === 'number') return String(n);
  if (Array.isArray(n)) return n.map(pintar).filter(x => x !== null);
  if (typeof n.type === 'function') return pintar(n.type(Object.assign({}, n.props, { children: n.children })));
  return { tag: n.type, props: n.props, kids: (n.children || []).map(pintar).filter(x => x !== null) };
};
const textos = (n, out) => {
  out = out || [];
  if (typeof n === 'string') { out.push(n); return out; }
  if (Array.isArray(n)) { n.forEach(x => textos(x, out)); return out; }
  if (n && n.kids) n.kids.forEach(x => textos(x, out));
  return out;
};
const nodos = (n, pred, out) => {
  out = out || [];
  if (Array.isArray(n)) { n.forEach(x => nodos(x, pred, out)); return out; }
  if (n && n.kids) { if (pred(n)) out.push(n); n.kids.forEach(x => nodos(x, pred, out)); }
  return out;
};
const clsDe = n => ((n && n.props && n.props.className) || '').split(/\s+/);
const conClase = (arbol, c) => nodos(arbol, n => clsDe(n).indexOf(c) !== -1);
const unir = n => textos(n).join('');
const boton = (arbol, txt) => nodos(arbol, n => n.tag === 'button' && unir(n).indexOf(txt) !== -1)[0];
const esperar = () => new Promise(r => setTimeout(r, 0));

// Orden de los estados de la vista: ruta, moviendo, version, actualizacion, datos de pago, guardando,
// omitidos, sincronizando, lo guardado, anima.
const E = { ruta: 0, moviendo: 1, version: 2, act: 3, datos: 4, guardando: 5, omitidos: 6, sincronizando: 7, guardado: 8 };

(async () => {
  const dbPath = copiaDeProduccion('desarrollador');
  const S = await arrancar(dbPath);
  try {
    const loans = (await pedir(S, 'GET', '/api/loans')).body;
    const pays = (await pedir(S, 'GET', '/api/payments')).body;

    const { cargarFrontend } = require('./lib/load-frontend');
    const FE = cargarFrontend({ silenciarConsola: true });
    const X = FE.sandbox;
    X.Date = Date;
    X.document.hidden = true;

    // Monta la vista con estado sembrado; registra cada setter que se llame (indice -> valores).
    const sets = [];
    const montar = (props, estado, conEfectos) => {
      const oS = X.useState, oE = X.useEffect; let i = 0;
      X.useState = init => { const k = i++;
        const v = (estado && k < estado.length && estado[k] !== undefined) ? estado[k] : (typeof init === 'function' ? init() : init);
        return [v, val => sets.push([k, val])]; };
      const efectos = [];
      X.useEffect = fn => { efectos.push(fn); };
      try {
        const arbol = pintar({ type: X.DevView, props, children: [] });
        const limpiezas = conEfectos ? efectos.map(fn => fn()) : [];
        return { arbol, limpiezas };
      } finally { X.useState = oS; X.useEffect = oE; }
    };
    const setsDe = k => sets.filter(s => s[0] === k).map(s => s[1]);
    // Un electronAPI que registra cada llamada y responde lo que se le pida.
    const llamadas = [];
    let respuestas = {};
    const subs = [];
    const apiFalsa = () => ({
      getDbPath: () => { llamadas.push(['getDbPath']); return Promise.resolve(respuestas.ruta || 'C:\\datos\\cartera.db'); },
      getAppVersion: () => { llamadas.push(['getAppVersion']); return Promise.resolve(respuestas.version || '3.7.1'); },
      onUpdateStatus: cb => { llamadas.push(['onUpdateStatus']); subs.push(cb); return function desuscribir(){ llamadas.push(['desuscribir']); }; },
      pickDbFolder: () => { llamadas.push(['pickDbFolder']); return Promise.resolve(respuestas.carpeta === undefined ? 'D:\\Nube' : respuestas.carpeta); },
      setDbPath: c => { llamadas.push(['setDbPath', c]); return Promise.resolve(respuestas.set || { ok: true, path: c + '\\cartera.db' }); },
      resetDbPath: () => { llamadas.push(['resetDbPath']); return Promise.resolve(respuestas.reset || { ok: true, path: 'C:\\defecto\\cartera.db' }); },
      checkForUpdates: () => { llamadas.push(['checkForUpdates']); return Promise.resolve({ status: 'checking' }); },
      downloadUpdate: () => { llamadas.push(['downloadUpdate']); return Promise.resolve(); },
      installUpdate: () => { llamadas.push(['installUpdate']); return Promise.resolve(); },
      printPDF: (html, f) => { llamadas.push(['printPDF', f]); return Promise.resolve({ ok: true }); },
    });
    const avisos = [], errores = [], reinicios = [], confirmaciones = [];
    const props = extra => Object.assign({ showToast: (m, t) => avisos.push([m, t || 'ok']), isMac: false, onNeedsRestart: () => reinicios.push(1),
      onSync: () => Promise.resolve({ ok: true, omitidos: [] }), onConfirm: cfg => confirmaciones.push(cfg), loans, pays, datosPago: '',
      onSaveConfig: () => Promise.resolve({ ok: true }) }, extra || {});
    const showErrorReal = X.showError;
    X.showError = m => errores.push(m);
    const limpiar = () => { llamadas.length = 0; sets.length = 0; avisos.length = 0; errores.length = 0; reinicios.length = 0; confirmaciones.length = 0; respuestas = {}; };

    // ── A — EL CONTRATO ───────────────────────────────────────────────────
    R.seccion('A — el contrato con Electron (preload.js) y con App');
    const fuente = fs.readFileSync(path.join(REPO, 'public/js/vistas/DevView.js'), 'utf8');
    const preload = fs.readFileSync(path.join(REPO, 'desktop/preload.js'), 'utf8');
    const app = fs.readFileSync(path.join(REPO, 'public/js/app.js'), 'utf8');
    const usados = Array.from(new Set((fuente.match(/window\.electronAPI\.([A-Za-z]+)/g) || []).map(s => s.split('.').pop()))).sort();
    const ESPERADOS = ['checkForUpdates', 'downloadUpdate', 'getAppVersion', 'getDbPath', 'installUpdate', 'onUpdateStatus', 'pickDbFolder', 'resetDbPath', 'setDbPath'];
    R.eq('A1 la vista llama exactamente los nueve metodos de Electron de siempre', usados, ESPERADOS);
    R.check('A1 y cada uno existe en desktop/preload.js', usados.every(m => new RegExp('\\b' + m + '\\s*:').test(preload)), usados.filter(m => !new RegExp('\\b' + m + '\\s*:').test(preload)));
    const cable = (app.match(/h\(DevView,\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}\)/) || [])[1] || '';
    R.check('A2 App le pasa la sincronizacion (recalculate), la configuracion (saveConfig) y los datos de pago guardados',
      /onSync:recalculate/.test(cable) && /onSaveConfig:saveConfig/.test(cable) && /datosPago:cfg\.datos_pago/.test(cable), cable);
    R.check('A2 y el aviso de reinicio, la confirmacion, los avisos, los prestamos y las cuotas',
      /onNeedsRestart:function\(\)\{setNeedsRestart\(true\);\}/.test(cable) && /onConfirm:function\(cfg\)\{setConfirmDlg\(cfg\);\}/.test(cable) &&
      /showToast:showToast/.test(cable) && /loans:loans/.test(cable) && /pays:pays/.test(cable), cable);

    // ── B — AL MONTARSE ───────────────────────────────────────────────────
    R.seccion('B — al montarse: la ruta, la version y las actualizaciones; sin Electron, un aviso');
    limpiar();
    X.window.electronAPI = apiFalsa();
    respuestas = { ruta: 'C:\\Users\\usuario\\cartera.db', version: '3.7.1' };
    const m1 = montar(props(), [], true);
    await esperar();
    R.eq('B1 pide la ruta y la version a Electron y se suscribe a las actualizaciones', llamadas.map(l => l[0]), ['getDbPath', 'getAppVersion', 'onUpdateStatus']);
    R.eq('B1 la ruta y la version llegan a la vista', [setsDe(E.ruta), setsDe(E.version)], [['C:\\Users\\usuario\\cartera.db'], ['3.7.1']]);
    m1.limpiezas[0] && m1.limpiezas[0]();
    R.check('B1 al desmontarse se desuscribe de las actualizaciones', llamadas.some(l => l[0] === 'desuscribir'));
    subs[0]({ status: 'available', version: '3.8.0' });
    R.eq('B1 un aviso de Electron llega al estado de la vista', setsDe(E.act).slice(-1), [{ status: 'available', version: '3.8.0' }]);
    const conRuta = montar(props(), ['C:\\Users\\usuario\\cartera.db', false, '3.7.1']).arbol;
    R.eq('B2 la tarjeta muestra la ruta y la version', [unir(nodos(conRuta, n => n.tag === 'code')[0]), unir(conClase(conRuta, 'dvv-version')[0])],
      ['C:\\Users\\usuario\\cartera.db', 'v3.7.1Cartera']);
    R.check('B2 con Electron, las acciones estan disponibles y no hay aviso', ['Cambiar ubicación', 'Restaurar la ruta por defecto', 'Buscar actualizaciones']
      .every(t => !boton(conRuta, t).props.disabled) && conClase(conRuta, 'dvv-aviso').length === 0);
    const apiGuardada = X.window.electronAPI;
    delete X.window.electronAPI;
    limpiar();
    const sinApi = montar(props(), [], true).arbol;
    R.check('B3 sin Electron no pide nada, apaga cambiar / restaurar / buscar y explica por que',
      llamadas.length === 0 && ['Cambiar ubicación', 'Restaurar la ruta por defecto', 'Buscar actualizaciones'].every(t => boton(sinApi, t).props.disabled === true) &&
      unir(conClase(sinApi, 'dvv-aviso')[0]).indexOf('solo está disponible en la app de escritorio') !== -1);
    X.window.electronAPI = apiGuardada;

    // ── C — LA BASE DE DATOS ──────────────────────────────────────────────
    R.seccion('C — cambiar y restaurar la ubicacion de la base de datos');
    limpiar();
    let v = montar(props(), ['C:\\a\\cartera.db']).arbol;
    boton(v, 'Cambiar ubicación').props.onClick(); await esperar(); await esperar();
    R.eq('C1 elige la carpeta y se la pasa a Electron tal cual', llamadas, [['pickDbFolder'], ['setDbPath', 'D:\\Nube']]);
    R.eq('C1 si sale bien: la ruta nueva, deja de "mover" y pide reiniciar', [setsDe(E.ruta), setsDe(E.moviendo), reinicios.length], [['D:\\Nube\\cartera.db'], [true, false], 1]);
    limpiar(); respuestas = { carpeta: null };
    v = montar(props(), ['C:\\a\\cartera.db']).arbol;
    boton(v, 'Cambiar ubicación').props.onClick(); await esperar(); await esperar();
    R.check('C2 si se cancela el dialogo, no mueve nada ni pide reiniciar', llamadas.length === 1 && llamadas[0][0] === 'pickDbFolder' && reinicios.length === 0 &&
      JSON.stringify(setsDe(E.moviendo)) === '[true,false]');
    limpiar(); respuestas = { set: { ok: false, error: 'La carpeta no tiene permisos' } };
    v = montar(props(), ['C:\\a\\cartera.db']).arbol;
    boton(v, 'Cambiar ubicación').props.onClick(); await esperar(); await esperar();
    R.check('C3 si Electron responde con error: lo muestra, no cambia la ruta ni pide reiniciar',
      errores[0] === 'La carpeta no tiene permisos' && setsDe(E.ruta).length === 0 && reinicios.length === 0, errores);
    limpiar();
    v = montar(props(), ['C:\\a\\cartera.db']).arbol;
    boton(v, 'Restaurar la ruta por defecto').props.onClick();
    R.check('C4 "Restaurar" pide confirmacion antes de tocar nada', confirmaciones.length === 1 && confirmaciones[0].title === 'Restaurar ubicación' && llamadas.length === 0);
    confirmaciones[0].onConfirm(); await esperar();
    R.check('C4 al confirmar llama a resetDbPath, muestra la ruta por defecto y pide reiniciar',
      llamadas.length === 1 && llamadas[0][0] === 'resetDbPath' && setsDe(E.ruta)[0] === 'C:\\defecto\\cartera.db' && reinicios.length === 1);
    limpiar();
    const copiado = [];
    X.navigator.clipboard = { writeText: t => copiado.push(t) };
    v = montar(props(), ['C:\\a\\cartera.db']).arbol;
    nodos(v, n => n.tag === 'button' && n.props.title === 'Copiar la ruta')[0].props.onClick();
    R.check('C5 el boton nuevo copia la ruta y lo avisa', copiado[0] === 'C:\\a\\cartera.db' && avisos[0][0] === 'Ruta copiada');
    R.check('C5 sin ruta todavia (cargando) no hay boton de copiar', nodos(montar(props(), ['']).arbol, n => n.props && n.props.title === 'Copiar la ruta').length === 0);

    // ── D — LAS ACTUALIZACIONES ───────────────────────────────────────────
    R.seccion('D — los siete estados de las actualizaciones y sus botones');
    const CASOS = [
      [null, 'Al día', 'good', 'Tienes la última versión.'],
      [{ status: 'not-available' }, 'Al día', 'good', 'Tienes la última versión.'],
      [{ status: 'checking' }, 'Buscando…', 'info', 'Buscando actualizaciones…'],
      [{ status: 'dev-mode' }, 'Modo desarrollo', 'warn', 'Las actualizaciones solo funcionan en la app instalada.'],
      [{ status: 'available', version: '3.8.0' }, 'v3.8.0 disponible', 'info', 'Hay una versión nueva: v3.8.0'],
      [{ status: 'downloading', percent: 42 }, 'Descargando 42%', 'info', 'Descargando… 42%'],
      [{ status: 'downloaded', version: '3.8.0' }, 'Lista para instalar', 'good', 'v3.8.0 está lista para instalar.'],
      [{ status: 'error', message: 'sin red' }, 'Error', 'crit', 'No se pudo verificar: sin red'],
    ];
    const malEstados = CASOS.filter(([info, chip, tono, msg]) => {
      const a = montar(props(), [undefined, undefined, undefined, info]).arbol;
      const sis = conClase(a, 'dvv-sis')[0], ch = conClase(conClase(sis, 'dvv-card-h')[0], 'v4-chip')[0];
      return unir(ch) !== chip || clsDe(ch).indexOf(tono) === -1 || unir(conClase(sis, 'dvv-act-msg')[0]) !== msg;
    }).map(c => c[1]);
    R.check('D1 cada estado con su chip, su tono y su mensaje', malEstados.length === 0, malEstados);
    const act = (info, txt) => { limpiar(); const a = montar(props(), [undefined, undefined, undefined, info]).arbol; boton(a, txt).props.onClick(); return llamadas.map(l => l[0]); };
    R.eq('D2 "Buscar actualizaciones" se lo pide a Electron y pasa a "Buscando…"', [act(null, 'Buscar actualizaciones'), setsDe(E.act)], [['checkForUpdates'], [{ status: 'checking' }]]);
    R.eq('D2 "Descargar actualización" descarga', act({ status: 'available', version: '3.8.0' }, 'Descargar actualización'), ['downloadUpdate']);
    R.eq('D2 "Reiniciar e instalar" instala', act({ status: 'downloaded', version: '3.8.0' }, 'Reiniciar e instalar'), ['installUpdate']);
    R.eq('D2 "Reintentar" vuelve a buscar', act({ status: 'error', message: 'x' }, 'Reintentar'), ['checkForUpdates']);
    const desc = montar(props(), [undefined, undefined, undefined, { status: 'downloading', percent: 42 }]).arbol;
    R.eq('D3 la barra de descarga marca el porcentaje', conClase(desc, 'dvv-barra')[0].kids[0].props.style.width, '42%');

    // ── E — EL REPORTE ────────────────────────────────────────────────────
    R.seccion('E — el reporte de prestamos activos: lo que entra y el boton');
    const activos = loans.filter(l => l.estado === 'Activo');
    const conMora = new Set(pays.filter(p => p.estadoPago === 'En Mora').map(p => p.prestamoId));
    const nMora = activos.filter(l => conMora.has(l.id)).length;
    const rep = conClase(montar(props()).arbol, 'dvv-rep')[0];
    R.eq('E1 cuantos prestamos activos entran y cuantos tienen cuotas en mora (recalculado aparte)',
      conClase(rep, 'dvv-rep-stats')[0].kids.map(k => textos(k).join('|')), [activos.length + '|préstamos activos', nMora + '|con cuotas en mora']);
    R.check('E1 anti-vacio: el fixture tiene activos y activos en mora', activos.length > 0 && nMora > 0, { activos: activos.length, nMora });
    const genReal = X.generateReportePrestamosPDF, argsR = [];
    X.generateReportePrestamosPDF = function(){ argsR.push([].slice.call(arguments)); };
    try {
      limpiar();
      boton(rep, 'Descargar PDF').props.onClick();
      R.check('E2 el boton lanza el generador de siempre con los prestamos, las cuotas y el tema',
        argsR.length === 1 && argsR[0][0] === loans && argsR[0][1] === pays && typeof argsR[0][2] === 'boolean');
      const repVacio = conClase(montar(props({ loans: loans.filter(l => l.estado !== 'Activo') })).arbol, 'dvv-rep')[0];
      argsR.length = 0;
      boton(repVacio, 'Descargar PDF').props.onClick();
      R.check('E3 sin prestamos activos no genera nada y lo avisa', argsR.length === 0 && avisos.some(a => a[0] === 'No hay préstamos activos para el reporte' && a[1] === 'error'));
    } finally { X.generateReportePrestamosPDF = genReal; }
    R.check('E4 la generacion del PDF no se toco: el boton llama a generateReportePrestamosPDF, importado de pdf/reporte-activos.js',
      /import \{ generateReportePrestamosPDF \} from '\.\.\/pdf\/reporte-activos\.js';/.test(fuente) && /generateReportePrestamosPDF\(props\.loans, props\.pays, /.test(fuente));

    // ── F — LOS DATOS DE PAGO, CONTRA EL BACKEND REAL ─────────────────────
    R.seccion('F — los datos de pago: "Sin guardar", el guardado contra el backend real y el chip');
    const chipPago = a => { const c = conClase(conClase(conClase(a, 'dvv-pago')[0], 'dvv-card-h')[0], 'v4-chip')[0]; return c ? [unir(c), clsDe(c).filter(x => x !== 'v4-chip')[0]] : null; };
    const guardar = a => boton(conClase(a, 'dvv-pago')[0], 'Guardar');
    let a0 = montar(props({ datosPago: '' })).arbol;
    R.check('F1 sin datos y sin cambios: sin chip y el boton "Guardar" apagado', chipPago(a0) === null && guardar(a0).props.disabled === true);
    a0 = montar(props({ datosPago: 'Nequi 300' })).arbol;
    R.eq('F1 con datos guardados y sin cambios: "Guardado" en verde', chipPago(a0), ['Guardado', 'good']);
    const TEXTO = 'Transferencia Bancolombia\nA nombre de la cartera';
    let a1 = montar(props({ datosPago: 'Nequi 300' }), [undefined, undefined, undefined, undefined, TEXTO]).arbol;
    R.check('F2 al escribir: "Sin guardar" en ambar y el boton se enciende', JSON.stringify(chipPago(a1)) === JSON.stringify(['Sin guardar', 'warn']) && guardar(a1).props.disabled === false);
    // El MISMO contrato de saveConfig (app.js): PUT /api/config y `null` si falla.
    const saveConfigReal = patch => pedir(S, 'PUT', '/api/config', patch).then(r => (r.status === 200 ? r.body : null));
    limpiar();
    a1 = montar(props({ datosPago: 'Nequi 300', onSaveConfig: saveConfigReal }), [undefined, undefined, undefined, undefined, TEXTO]).arbol;
    guardar(a1).props.onClick();
    for (let i = 0; i < 20 && !setsDe(E.guardado).length; i++) await new Promise(r => setTimeout(r, 10));
    const cfg = (await pedir(S, 'GET', '/api/config')).body;
    R.eq('F3 guardar persiste el texto en el backend real (GET /api/config)', cfg.datos_pago, TEXTO);
    R.eq('F3 la vista marca el texto como guardado, deja de "guardar" y lo avisa', [setsDe(E.guardado), setsDe(E.guardando), avisos.map(x => x[0])],
      [[TEXTO], [true, false], ['Datos de pago guardados']]);
    limpiar();
    a1 = montar(props({ datosPago: 'Nequi 300', onSaveConfig: () => Promise.resolve(null) }), [undefined, undefined, undefined, undefined, TEXTO]).arbol;
    guardar(a1).props.onClick(); await esperar(); await esperar();
    R.check('F4 si el guardado falla (saveConfig resuelve null), el chip NO pasa a "Guardado"', setsDe(E.guardado).length === 0 && JSON.stringify(setsDe(E.guardando)) === '[true,false]');

    // ── G — SINCRONIZAR, CONTRA EL BACKEND REAL ───────────────────────────
    R.seccion('G — sincronizar: POST /api/recalculate y el panel persistente de omitidos');
    const syncReal = () => pedir(S, 'POST', '/api/recalculate').then(r => r.body);
    limpiar();
    let g = montar(props({ onSync: syncReal })).arbol;
    boton(g, 'Sincronizar ahora').props.onClick();
    for (let i = 0; i < 50 && !setsDe(E.omitidos).length; i++) await new Promise(r => setTimeout(r, 20));
    R.eq('G1 sincroniza contra el backend real y recibe la lista de omitidos (vacia en el fixture)', [setsDe(E.sincronizando), setsDe(E.omitidos)], [[true, false], [[]]]);
    // Construido: el fixture no deja ningun prestamo sin recalcular, asi que la lista real llega vacia.
    const OMIT1 = [{ id: 'p9', nombre: 'Cliente Nueve', motivo: 'Cronograma huérfano' }];
    limpiar();
    g = montar(props({ onSync: () => Promise.resolve({ ok: true, omitidos: OMIT1 }) })).arbol;
    boton(g, 'Sincronizar ahora').props.onClick(); await esperar(); await esperar();
    R.eq('G1 si el backend omite prestamos, la lista llega tal cual al panel', setsDe(E.omitidos), [OMIT1]);
    g = montar(props(), [undefined, undefined, undefined, undefined, undefined, undefined, []]).arbol;
    R.eq('G2 sin omitidos lo confirma en verde', [unir(conClase(g, 'dvv-res')[0]), clsDe(conClase(g, 'dvv-res')[0]).indexOf('good') !== -1],
      ['Todos los cronogramas activos se recalcularon sin omisiones.', true]);
    const OMIT = [{ id: 'p1', nombre: 'Cliente Uno', motivo: 'El abono supera el capital' }, { id: 'p2', nombre: 'Cliente Dos', motivo: 'Plazo inválido' }];
    g = montar(props(), [undefined, undefined, undefined, undefined, undefined, undefined, OMIT]).arbol;
    const res = conClase(g, 'dvv-res')[0];
    R.check('G3 con omitidos, un panel en rojo que los nombra con su motivo, y que no se va solo',
      clsDe(res).indexOf('crit') !== -1 && unir(conClase(res, 'dvv-res-t')[0]) === '2 préstamos no se pudieron recalcular' &&
      conClase(res, 'dvv-res-f').map(f => textos(f).join('|')).join(';') === 'Cliente Uno|El abono supera el capital;Cliente Dos|Plazo inválido');
    g = montar(props(), [undefined, undefined, undefined, undefined, undefined, undefined, null, true]).arbol;
    R.check('G4 mientras sincroniza, el boton se apaga y lo dice', boton(g, 'Sincronizando…').props.disabled === true);

    // ── H — LA PRESENTACION v4 ────────────────────────────────────────────
    R.seccion('H — cinco tarjetas, sin colores en linea, con ortografia');
    const vista = montar(props({ datosPago: 'Nequi 300' }), ['C:\\a\\cartera.db', false, '3.7.1']).arbol;
    const tarjetas = conClase(vista, 'dvv-card');
    R.eq('H1 cinco tarjetas en orden: base de datos, sistema, reporte, datos de pago y sincronizar',
      tarjetas.map(t => unir(conClase(t, 'v4-titulo')[0])), ['Base de datos', 'Sistema', 'Reporte de préstamos activos', 'Datos de pago', 'Sincronizar datos']);
    R.check('H1 cada una con su icono en un recuadro neutro', tarjetas.every(t => conClase(t, 'dvv-ico').length === 1 && nodos(conClase(t, 'dvv-ico')[0], n => n.tag === 'svg').length === 1));
    R.check('H2 la accion principal de cada tarjeta es un boton primario (negro / blanco)',
      ['Cambiar ubicación', 'Descargar PDF', 'Guardar'].every(t => clsDe(boton(vista, t)).indexOf('pri') !== -1));
    const estilos = nodos(vista, n => n.props && n.props.style).map(n => Object.keys(n.props.style)).reduce((a, k) => a.concat(k), []);
    R.check('H3 la vista no pinta colores en linea: solo el retardo de entrada', estilos.every(k => k === '--i' || k === 'width'), Array.from(new Set(estilos)));
    R.check('H3 ni el codigo trae los colores de la vista anterior', !/var\(--(yellow|green|blue|red)(-bg|-bd)?\)'?\s*[,}]/.test(fuente.replace(/okColor: 'var\(--yellow\)'/, '')) && !/style: *\{[^}]*background/.test(fuente));
    const sinTilde = textos(vista).filter(s => /\b(ubicacion|version|configuracion|aqui|alli|despues|unicamente|prestamos?|estan?)\b/i.test(s) && !/\b(esta|estan)\b/.test(s));
    R.check('H4 ningun texto sale sin tilde', sinTilde.length === 0, sinTilde);
    X.document.hidden = false;
    const viva = montar(props()).arbol;
    X.document.hidden = true;
    R.check('H5 con la ventana visible entra animada; oculta, quieta', clsDe(viva).indexOf('anima') !== -1 && clsDe(montar(props()).arbol).indexOf('anima') === -1);

    // ── I — GUARDAS ESTATICAS ─────────────────────────────────────────────
    R.seccion('I — dev.css y el orden de las hojas');
    const leer = p => fs.readFileSync(path.join(REPO, p), 'utf8');
    const compacto = c => c.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, '');
    const dcss = compacto(leer('public/css/dev.css'));
    R.check('I1 index.html carga dev.css al final, despues de deudas.css',
      /href="\/css\/deudas\.css">\s*<link[^>]*href="\/css\/dev\.css">\s*<\/head>/.test(leer('public/index.html')));
    const SOLO_NOMBRE = ['dvv-card-t'];
    const usadas = Array.from(new Set((fuente.match(/dvv-[a-z0-9-]+/g) || []).filter(c => !/-$/.test(c) && SOLO_NOMBRE.indexOf(c) === -1)));
    const sinRegla = usadas.filter(c => !new RegExp('\\.' + c + '(?![A-Za-z0-9_-])').test(dcss));
    R.check('I2 cada clase dvv- que pinta la vista tiene su regla en dev.css (' + usadas.length + ' clases)', usadas.length > 25 && sinRegla.length === 0, sinRegla);
    R.check('I3 la rejilla aprobada: base de datos 7 + sistema 5, reporte 5 + datos de pago 7, sincronizar a lo ancho',
      dcss.indexOf('.dvv-grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));') !== -1 &&
      ['.dvv-bd{grid-column:span7;}', '.dvv-sis{grid-column:span5;}', '.dvv-rep{grid-column:span5;}', '.dvv-pago{grid-column:span7;}', '.dvv-sync{grid-column:1/-1;}'].every(s => dcss.indexOf(s) !== -1));
    R.check('I3 a 1.100 px o menos, una tarjeta por fila', /@media\(max-width:1100px\)\{\.dvv-bd,\.dvv-sis,\.dvv-rep,\.dvv-pago\{grid-column:1\/-1;\}\}/.test(dcss));
    R.check('I4 el icono va en un recuadro gris neutro', dcss.indexOf('.dvv-ico{width:36px;height:36px;border-radius:11px;display:grid;place-items:center;flex-shrink:0;background:var(--surface-3);color:var(--ink-2);}') !== -1);
    R.check('I4 la barra de descarga es propia (no depende de la hoja de Mis deudas)', dcss.indexOf('.dvv-barra{') !== -1 && !/dbv-/.test(fuente) && !/dbv-/.test(dcss));
    R.check('I5 los botones apagados solo se atenuan dentro de Desarrollador', dcss.indexOf('.v4v.v4-btn:disabled{opacity:.45;cursor:not-allowed;}') !== -1 && !/(^|\})\.v4-btn:disabled/.test(dcss));
    R.check('I5 "reducir movimiento" del sistema apaga las animaciones de Desarrollador',
      dcss.indexOf('@media(prefers-reduced-motion:reduce){.v4v*,.v4v*::before,.v4v*::after{animation:none!important;transition:none!important;}}') !== -1);
    R.check('I6 nada del prototipo en produccion', ['v4-forzar', 'PROTOTIPO'].every(s => leer('public/css/dev.css').indexOf(s) === -1 && fuente.indexOf(s) === -1));
    X.showError = showErrorReal;
  } finally { await cerrar(S); }

  process.exit(R.finalizar());
})().catch(e => { console.error(e); process.exit(1); });
