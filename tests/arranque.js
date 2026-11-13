// tests/arranque.js — el ARRANQUE y las NOVEDADES (rediseño v4, diseño de Control TC v7).
//
// Fija las dos ultimas piezas del rediseño:
//   A. LA VENTANA DE ARRANQUE (desktop/splash.js): el HTML en los dos temas (cuatro vistas, la marca, la
//      barra fina, la version escapada, Inter solo si viene), los botones con su canal IPC, y el codigo que
//      main.js le ejecuta (mensaje, porcentaje, cuenta atras, vistas, textos) CORRIDO sobre ese HTML: cada id
//      que toca existe y el resultado es el esperado.
//   B. EL ORQUESTADOR (desktop/main.js, estatico: requiere Electron): usa splash.js, ya no muestra el cuadro
//      nativo "Error de arranque" (la vista "La app no pudo iniciar" lo reemplaza, con copiar el detalle), el
//      error del puerto se recoge, el tema del arranque se guarda (apariencia.json) y el preload lo expone, la
//      base de datos sigue sin tocarse antes de decidir la actualizacion, y el paso a la app es un fundido.
//   C. LA CARGA DENTRO DE LA APP (V4Arranque): la misma marca y barra, con 280 ms de retardo; index.html ya no
//      trae el circulo verde; el marco de la app entra con un fundido.
//   D. LAS NOVEDADES (NovedadesModal): titulo, "Ya está instalada", la lista con los titulos en negrita, el
//      cierre (X, Entendido, fondo, Escape), y que App las abre MEDIO SEGUNDO despues de cargar.
//
// Se ejecuta:
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron tests/arranque.js

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const { Reporter } = require('./lib/report');
const { REPO }     = require('./lib/paths');

const R = new Reporter('arranque');
const leer = p => fs.readFileSync(path.join(REPO, p), 'utf8');

// ── Arnes de render (el de las demas suites) ─────────────────────────────────
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
const clsDe = n => ((n && n.props && n.props.className) || '').split(/\s+/).filter(Boolean);
const conClase = (arbol, c) => nodos(arbol, n => clsDe(n).indexOf(c) !== -1);
const unir = n => textos(n).join('');

// Un DOM minimo armado con los ids del HTML del splash: alcanza para el codigo que main.js le ejecuta
// (getElementById, textContent, classList, style, focus) y anota cada id pedido que NO existe.
function domDe(html) {
  const ids = Array.from(html.matchAll(/\sid="([^"]+)"/g)).map(m => m[1]);
  const faltan = [], els = {};
  ids.forEach(id => {
    const cl = new Set((new RegExp('<[^>]*class="([^"]*)"[^>]*id="' + id + '"|<[^>]*id="' + id + '"[^>]*class="([^"]*)"').exec(html) || []).slice(1).filter(Boolean).join(' ').split(/\s+/).filter(Boolean));
    els[id] = { id, textContent: '', style: {}, enfocado: false, classList: { add: c => cl.add(c), remove: c => cl.delete(c), contains: c => cl.has(c) }, focus() { this.enfocado = true; } };
  });
  const document = { getElementById: id => { if (!els[id]) { faltan.push(id); return null; } return els[id]; } };
  const ctx = vm.createContext({ document });
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  // `mostrar` es la funcion del propio HTML; el resto del script (require de electron e IPC) no aplica aqui.
  vm.runInContext(/function mostrar\([\s\S]*?\}\);\}/.exec(script)[0], ctx);
  return { els, faltan, correr: js => vm.runInContext(js, ctx) };
}

(async () => {
  // ── A — LA VENTANA DE ARRANQUE ────────────────────────────────────────────
  R.seccion('A — la ventana de arranque (desktop/splash.js)');
  const SP = require(path.join(REPO, 'desktop', 'splash.js'));
  R.check('A0 exporta el HTML, las paletas, el codigo que main.js ejecuta y los textos',
    ['buildSplashHtml', 'PALETAS', 'jsMensaje', 'jsCuenta', 'notaCuenta', 'jsVista', 'jsTextos', 'TEXTOS'].every(k => SP[k] !== undefined));
  const oscuro = SP.buildSplashHtml('dark', { version: '3.7.1' }), claro = SP.buildSplashHtml('light', { version: '3.7.1' });
  R.check('A1 cuatro vistas: carga, sin conexion, error de la descarga y error grave (solo la de carga visible)',
    ['vLoading', 'vOffline', 'vUpdateError', 'vFatal'].every(v => oscuro.indexOf('id="' + v + '"') !== -1) &&
    oscuro.indexOf('#vLoading{display:flex;}') !== -1 && oscuro.indexOf('#vOffline,#vUpdateError,#vFatal{display:none;}') !== -1);
  R.check('A1 la marca, el nombre, "Buscando actualizaciones", la barra fina y la version',
    /<div class="marca"[^>]*><svg/.test(oscuro) && oscuro.indexOf('<div class="nombre">Cartera</div>') !== -1 &&
    oscuro.indexOf('<div id="splashMsg">Buscando actualizaciones</div>') !== -1 && oscuro.indexOf('id="barIndet"') !== -1 &&
    oscuro.indexOf('<div class="version" id="splashVersion">Versión 3.7.1</div>') !== -1);
  R.check('A2 cada tema con su paleta: negro real / blanco perla, y nada del tema viejo (#0d1117, verde de GitHub)',
    oscuro.indexOf('background:#000000') !== -1 && claro.indexOf('background:#f6f6f3') !== -1 && claro.indexOf('background:#000000') === -1 &&
    SP.buildSplashHtml('cualquiera', {}).indexOf('background:#000000') !== -1 && ![oscuro, claro].some(h => /#0d1117|#3fb950|#238636|spinner/.test(h)));
  R.check('A2 la version se escapa, e Inter solo va si viene la fuente',
    SP.buildSplashHtml('dark', { version: '<b>"x"</b>' }).indexOf('Versión &lt;b&gt;&quot;x&quot;&lt;/b&gt;') !== -1 &&
    oscuro.indexOf('@font-face') === -1 && SP.buildSplashHtml('dark', { fuente: 'QUJD' }).indexOf("src:url(data:font/woff2;base64,QUJD) format('woff2')") !== -1);
  const canales = Array.from(oscuro.matchAll(/getElementById\('(btn\w+)'\)\.addEventListener\('click',function\(\)\{ipc\.send\('([\w-]+)','(\w+)'\);\}\)/g)).map(m => m.slice(1).join(':'));
  R.eq('A3 cada boton avisa a main.js por su canal: decidir (seguir / cerrar) y el error grave (copiar / cerrar)', canales,
    ['btnContinue:splash-decision:continue', 'btnQuit:splash-decision:quit', 'btnQuitUpdate:splash-decision:quit', 'btnContinueUpdate:splash-decision:continue',
     'btnFatalCopy:splash-fatal:copiar', 'btnFatalQuit:splash-fatal:cerrar']);
  R.check('A3 los textos de las vistas de problema', ['No se pudo comprobar si hay una versión nueva', 'No se pudo instalar la versión nueva',
    'Seguir con la actual', 'Cerrar y reintentar', 'La app no pudo iniciar', 'Copiar el detalle', 'Detalle técnico'].every(t => oscuro.indexOf(t) !== -1));
  R.check('A3 nada del prototipo (postMessage, parametros de prueba)', !/postMessage|prototipo|forzarMov/.test(oscuro + leer('desktop/splash.js').replace(/^\/\/.*$/gm, '')));
  // El codigo que main.js ejecuta, corrido sobre el HTML.
  const d = domDe(oscuro);
  d.correr(SP.jsMensaje('Descargando la versión 3.8.0', 64.4, ''));
  R.check('A4 con porcentaje: la barra con su ancho y su "64 %", sin la barra fina',
    d.els.splashMsg.textContent === 'Descargando la versión 3.8.0' && d.els.barWrap.classList.contains('show') && d.els.barIndet.style.display === 'none' &&
    d.els.splashBar.style.width === '64%' && d.els.splashPct.textContent === '64 %' && d.els.countdown.textContent === '');
  d.correr(SP.jsMensaje('Abriendo tus datos', undefined, 'Todo en orden'));
  R.check('A4 sin porcentaje: vuelve la barra fina y la nota de abajo', !d.els.barWrap.classList.contains('show') && d.els.barIndet.style.display === '' &&
    d.els.countdown.textContent === 'Todo en orden');
  d.correr(SP.jsMensaje("Comillas ' \" \\ y\nsalto", 150));
  R.check('A4 los textos viajan intactos (comillas, barras, saltos) y el porcentaje se acota a 100',
    d.els.splashMsg.textContent === "Comillas ' \" \\ y\nsalto" && d.els.splashPct.textContent === '100 %');
  d.correr(SP.jsCuenta(47));
  R.check('A5 la cuenta atras como frase ("Si no responde en 47 s...") y vacia al llegar a 0',
    d.els.countdown.textContent === 'Si no responde en 47 s, podrás seguir sin conexión.' && SP.notaCuenta(0) === '' && SP.notaCuenta(-3) === '');
  d.correr(SP.jsVista('vFatal', 'btnFatalQuit'));
  R.check('A6 una vista a la vez, con el foco en su boton', d.els.vFatal.style.display === 'flex' && d.els.vLoading.style.display === 'none' &&
    d.els.vOffline.style.display === 'none' && d.els.vUpdateError.style.display === 'none' && d.els.btnFatalQuit.enfocado);
  d.correr(SP.jsTextos({ fatalMsg: 'Otro programa está usando el puerto 3420.', fatalDetail: 'EADDRINUSE · 127.0.0.1:3420', btnFatalCopy: 'Copiado' }));
  R.check('A6 los textos sueltos por id', d.els.fatalMsg.textContent === 'Otro programa está usando el puerto 3420.' && d.els.fatalDetail.textContent === 'EADDRINUSE · 127.0.0.1:3420' &&
    d.els.btnFatalCopy.textContent === 'Copiado');
  R.check('A6 ningun id que main.js toca falta en el HTML', d.faltan.length === 0, d.faltan);
  R.check('A7 las frases de la ventana', SP.TEXTOS.descargando('3.8.0') === 'Descargando la versión 3.8.0' && SP.TEXTOS.instalando('3.8.0') === 'Instalando la versión 3.8.0' &&
    SP.TEXTOS.tituloErrorUpdate('3.8.0') === 'No se pudo instalar la versión 3.8.0' && SP.TEXTOS.tituloErrorUpdate(null) === 'No se pudo instalar la versión nueva' &&
    SP.TEXTOS.abriendo === 'Abriendo tus datos' && SP.TEXTOS.notaAbriendo === 'Todo en orden: la app aparece en un momento.');
  const ICONOS = leer('public/js/componentes/iconos.js');
  R.check('A7 la marca y el icono de descarga son los trazos de iconos.js', ['briefcase', 'download'].every(n => {
    const m = new RegExp("\\b" + n + ":\\s*'([^']+)'").exec(ICONOS); return !!m && leer('desktop/splash.js').indexOf(m[1]) !== -1; }));

  // ── B — EL ORQUESTADOR ────────────────────────────────────────────────────
  R.seccion('B — desktop/main.js: arranque protegido, sin cuadros nativos de error');
  const MAIN = leer('desktop/main.js');
  const codigo = MAIN.replace(/^\s*\/\/.*$/gm, '');
  R.check('B1 usa la ventana de desktop/splash.js', /require\('\.\/splash'\)/.test(MAIN) && /buildSplashHtml\(tema, \{ fuente, version: app\.getVersion\(\) \}\)/.test(MAIN) &&
    !/<!DOCTYPE html>/.test(MAIN) && !/#0d1117|spinner/.test(codigo));
  R.check('B2 ya no hay cuadro nativo de error: ni showErrorBox ni showMessageBox', !/showErrorBox|showMessageBox/.test(codigo));
  R.check('B2 la vista "La app no pudo iniciar" lo reemplaza: textos, foco en Cerrar y "Copiar el detalle" al portapapeles',
    /jsTextos\(\{ fatalMsg: f\.texto, fatalDetail: f\.detalle \}\)/.test(MAIN) && /jsVista\('vFatal', 'btnFatalQuit'\)/.test(MAIN) &&
    /clipboard\.writeText\(f\.detalle\)/.test(MAIN) && /ipcMain\.on\('splash-fatal', alElegir\)/.test(MAIN) && /await showFatalInSplash\(err\);\s*app\.quit\(\);/.test(MAIN));
  R.check('B2 el puerto ocupado se recoge (y se dice que Cartera puede estar abierta) en vez de reventar',
    /server\.on\('error', \(err\) => \{ err\.fase = 'puerto'; errorPuerto = err; \}\)/.test(MAIN) && /if \(errorPuerto\) throw errorPuerto;/.test(MAIN) &&
    MAIN.indexOf('Puede que Cartera ya esté abierta: ciérrala y vuelve a abrirla.') !== -1);
  const vistas = Array.from(MAIN.matchAll(/jsVista\('(\w+)'(?:, '(\w+)')?\)/g)).map(m => m.slice(1).filter(Boolean));
  R.check('B3 cada vista y cada boton que main.js pide existen en el splash', vistas.length >= 4 && vistas.every(v => v.every(id => oscuro.indexOf('id="' + id + '"') !== -1)), vistas);
  const textosIds = Array.from(MAIN.matchAll(/jsTextos\(\{([^}]*)\}\)/g)).map(m => Array.from(m[1].matchAll(/(\w+):/g)).map(x => x[1])).reduce((a, b) => a.concat(b), []);
  R.check('B3 y cada texto que cambia por id', textosIds.length >= 4 && textosIds.every(id => oscuro.indexOf('id="' + id + '"') !== -1), textosIds);
  R.check('B3 las decisiones esperan por los canales del splash', (MAIN.match(/ipcMain\.once\('splash-decision'/g) || []).length === 2);
  R.check('B4 el tema del arranque: apariencia.json, escrito por IPC desde la app', /ipcMain\.on\('tema-cambiado', \(_e, tema\) => guardarTemaArranque\(tema\)\)/.test(MAIN) &&
    /backgroundColor: PALETAS\[tema\]\.bg/.test(MAIN) && /backgroundColor: PALETAS\[leerTemaArranque\(\)\]\.bg/.test(MAIN) &&
    /guardarTema:\s*\(tema\) => ipcRenderer\.send\('tema-cambiado', tema\)/.test(leer('desktop/preload.js')));
  const APP = leer('public/js/app.js');
  R.check('B4 la app lo manda al abrir y al cambiar de tema', /window\.electronAPI\.guardarTema\(t\)/.test(APP) && /guardarTemaArranque\(next\);/.test(APP) &&
    /setAttribute\('data-theme',theme\);guardarTemaArranque\(theme\);/.test(APP));
  const listo = MAIN.indexOf('app.whenReady()');
  const ordenOk = listo !== -1 && MAIN.indexOf('checkForUpdatesAtBoot();', listo) !== -1 &&
    MAIN.indexOf('startBackend();', listo) > MAIN.indexOf('await checkForUpdatesAtBoot();', listo);
  R.check('B5 la base de datos se conecta DESPUES de decidir la actualizacion (arranque protegido, intacto)', ordenOk);
  R.check('B6 el paso a la app: el arranque se desvanece y la principal aparece con un fundido, maximizada',
    /await fundir\(splashWin, 1, 0, 180\)/.test(MAIN) && /win\.setOpacity\(0\); \} catch \(_\) \{\}\s*win\.maximize\(\);\s*win\.show\(\);\s*await fundir\(win, 0, 1, 200\);/.test(MAIN) &&
    /await abrirVentanaPrincipal\(mainWin\)/.test(MAIN) && (codigo.match(/\bwin\.show\(\)/g) || []).length === 1);
  R.check('B6 la ventana de arranque aparece ya dibujada y con su fundido', /w\.once\('ready-to-show', \(\) => \{[\s\S]{0,140}w\.show\(\);\s*fundir\(w, 0, 1, 220\);/.test(MAIN) && /show: false,\s*webPreferences: \{ nodeIntegration: true/.test(MAIN));
  R.check('B7 las frases del arranque salen de TEXTOS (sin "v3.x" sueltas)', !/'Descargando v'|'Instalando v'|'Iniciando'|vDownloadError/.test(MAIN) &&
    /updateSplashMessage\(TEXTOS\.abriendo, undefined, TEXTOS\.notaAbriendo\)/.test(MAIN));

  // ── C y D — DENTRO DE LA APP ──────────────────────────────────────────────
  const { cargarFrontend } = require('./lib/load-frontend');
  const FE = cargarFrontend({ silenciarConsola: true });
  const X = FE.sandbox;
  R.seccion('C — la carga dentro de la app y la entrada del marco');
  const a = pintar({ type: X.V4Arranque, props: {}, children: [] });
  R.check('C1 V4Arranque: la marca (maletin), "Cartera", "Abriendo tus datos" y la barra fina', clsDe(a).join(' ') === 'v4a' && a.props.role === 'status' &&
    conClase(a, 'v4a-marca').length === 1 && nodos(conClase(a, 'v4a-marca')[0], n => n.tag === 'svg').length === 1 &&
    unir(conClase(a, 'v4a-nombre')[0]) === 'Cartera' && unir(conClase(a, 'v4a-msg')[0]) === 'Abriendo tus datos' && conClase(a, 'v4a-barra').length === 1 &&
    nodos(a, n => !!(n.props && n.props.style)).length === 0);
  R.check('C1 App la muestra mientras carga (en vez del circulo verde y "Cargando...")', /if\(loading\) return h\(V4Arranque\);/.test(APP) && !/Cargando\.\.\./.test(APP));
  const INDEX = leer('public/index.html');
  R.check('C2 index.html ya no trae el circulo verde: el fondo de la pagina hasta que entra la app', /<div id="root"><\/div>/.test(INDEX) && !/spinner/.test(INDEX));
  const acss = leer('public/css/arranque.css').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ');
  R.check('C3 aparece con 280 ms de retardo (una carga rapida no parpadea) y la barra avanza sola',
    acss.indexOf('.v4a-c { display: flex; flex-direction: column; align-items: center; text-align: center; animation: v4a-aparece .35s ease .28s both; }') !== -1 &&
    /\.v4a-barra i \{[^}]*animation: v4a-barra 1\.5s cubic-bezier\(\.2, \.7, \.2, 1\) infinite;/.test(acss));
  R.check('C4 el marco entra con un fundido (la app, el menu y el encabezado)', acss.indexOf('.app-layout { animation: v4a-app .42s ease both; }') !== -1 &&
    acss.indexOf('.app-layout .main-header { animation: v4a-cab .5s var(--ease) .08s both; }') !== -1 && /className:'app-layout'/.test(APP) && /className:'main-header'/.test(APP));
  R.check('C5 "reducir movimiento" apaga la entrada y deja la barra quieta', /@media \(prefers-reduced-motion: reduce\) \{ \.v4a-c, \.v4a-barra i, \.app-layout,[^}]*\{ animation: none; \} \.v4a-barra i \{ left: 0; width: 40%; \} \}/.test(acss));
  R.check('C6 index.html carga arranque.css al final, despues de modales.css', /href="\/css\/modales\.css">\s*<link[^>]*href="\/css\/arranque\.css">\s*<\/head>/.test(INDEX));

  R.seccion('D — las novedades de la version');
  const cierres = [];
  const efectos = [];
  const usaEf = X.useEffect;
  X.useEffect = fn => efectos.push(fn);
  const items = ['EL HISTORIAL, RENOVADO. Se lee como un diario.', 'Recibo de cobro: ahora con el detalle de cada cuota.', 'Mejoras y correcciones generales'];
  let nv;
  try { nv = pintar({ type: X.NovedadesModal, props: { version: '3.8.0', items, onClose: () => cierres.push(1) }, children: [] }); } finally { X.useEffect = usaEf; }
  R.check('D1 la ventana de los modales: fondo, tarjeta y la X', clsDe(nv).join(' ') === 'v4m-overlay v4n-fondo' && clsDe(nv.kids[0]).join(' ') === 'v4m-sheet v4n' &&
    nv.kids[0].props.role === 'dialog' && conClase(nv, 'v4m-x').length === 1);
  R.check('D1 "Novedades de la versión 3.8.0" y "Ya está instalada"', unir(conClase(nv, 'v4n-t')[0]) === 'Novedades de la versión 3.8.0' && unir(conClase(nv, 'v4n-sub')[0]) === 'Ya está instalada');
  const lis = nodos(nv, n => n.tag === 'li');
  R.check('D2 un renglon por novedad, con su marca gris (el visto) y el titulo en negrita cuando lo trae', lis.length === 3 &&
    lis.every(li => nodos(li, n => n.tag === 'svg').length === 1) && unir(nodos(lis[0], n => n.tag === 'b')[0]) === 'El historial, renovado.' &&
    unir(lis[0]).indexOf('Se lee como un diario.') !== -1 && unir(nodos(lis[1], n => n.tag === 'b')[0]) === 'Recibo de cobro.' &&
    unir(lis[1]).indexOf('Ahora con el detalle de cada cuota.') !== -1 && nodos(lis[2], n => n.tag === 'b').length === 0 && unir(lis[2]) === 'Mejoras y correcciones generales');
  R.check('D2 las siglas se respetan y un texto sin titulo no se parte', X.v4nPartir('LOS PDF, MAS CLAROS. Todo.').titulo === 'Los PDF, mas claros.' &&
    X.v4nPartir('Una frase larga con mas de ocho palabras antes de los dos puntos: x').titulo === null &&
    X.v4nPartir('Sin titulo, en minusculas. Y sigue.').titulo === null);
  boton(nv, 'Entendido').props.onClick(); conClase(nv, 'v4m-x')[0].props.onClick(); nv.props.onClick();
  let parado = 0; nv.kids[0].props.onClick({ stopPropagation: () => parado++ });
  R.check('D3 cierran Entendido, la X y el fondo; la tarjeta no', cierres.length === 3 && parado === 1);
  const oyentes = {};
  const winAnt = X.window.addEventListener, winQuita = X.window.removeEventListener;
  X.window.addEventListener = (t, f) => { oyentes[t] = f; };
  X.window.removeEventListener = (t, f) => { if (oyentes[t] === f) delete oyentes[t]; };
  let limpiar;
  try { limpiar = efectos[0](); oyentes.keydown({ key: 'Escape' }); oyentes.keydown({ key: 'Enter' }); } finally { X.window.addEventListener = winAnt; }
  R.check('D3 y la tecla Escape (y solo ella); al cerrarse deja de escuchar', cierres.length === 4 && typeof limpiar === 'function' && (limpiar(), !oyentes.keydown));
  X.window.removeEventListener = winQuita;
  R.check('D4 App abre las novedades MEDIO SEGUNDO despues de cargar, no mientras carga', X.NOVEDADES_RETARDO_MS === 500 &&
    /setNovedadesPend\(\{version:ver, items:CHANGELOGS\[ver\]\}\)/.test(APP) && !/setChangelogDlg\(\{version:ver/.test(APP) &&
    /if\(loading\|\|!novedadesPend\) return;\s*var t=setTimeout\(function\(\)\{ setChangelogDlg\(novedadesPend\); setNovedadesPend\(null\); \},NOVEDADES_RETARDO_MS\);\s*return function\(\)\{ clearTimeout\(t\); \};\s*\},\[loading,novedadesPend\]\);/.test(APP));
  R.check('D4 con el modal nuevo, y sin el dialogo viejo (circulo verde de "sparkle")', /changelogDlg&&h\(NovedadesModal,\{version:changelogDlg\.version,items:changelogDlg\.items,onClose:/.test(APP) &&
    !/name:'sparkle'/.test(APP));
  // CHANGELOGS es un `const` del modulo: no queda como propiedad del sandbox, se lee dentro del contexto.
  const CL = vm.runInContext('CHANGELOGS', X), version = require(path.join(REPO, 'package.json')).version;
  R.check('D5 las novedades de la version actual se muestran completas (titulo + texto = la linea original)', Array.isArray(CL[version]) && CL[version].length > 0 &&
    CL[version].every(it => { const p = X.v4nPartir(it); return p.titulo ? (p.titulo.replace(/\.$/, '').length > 0 && p.texto.length > 0) : p.texto === String(it); }), version);
  const ncss = acss;
  R.check('D6 la lista tipografica: marca gris, titulo en negrita, "Entendido" principal abajo', ncss.indexOf('.v4n-lista li > svg { margin-top: 2px; stroke: var(--ink-3); }') !== -1 &&
    ncss.indexOf('.v4n-lista b { display: block; font-weight: 600; color: var(--ink); }') !== -1 &&
    /\.v4n-ok \{[^}]*background: var\(--inverse-bg\); color: var\(--inverse-ink\);/.test(ncss));
  R.check('D7 nada del prototipo en produccion', ['v4-forzar', 'proto-chip', 'v4-embebido', 'PROTOTIPO', '__PROTO'].every(s =>
    leer('public/css/arranque.css').indexOf(s) === -1 && leer('public/js/componentes/arranque.js').indexOf(s) === -1 && APP.indexOf(s) === -1));

  process.exit(R.finalizar());
})().catch(e => { console.error(e); process.exit(1); });

function boton(arbol, txt) { return nodos(arbol, n => n.tag === 'button' && unir(n).indexOf(txt) !== -1)[0]; }
