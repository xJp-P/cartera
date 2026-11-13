// tests/modales.js — LOS MODALES (rediseño v4): la base comun, la confirmacion y los 16 modales.
//
// La fase visual de los modales llevo a produccion la base que aprobo el PO sobre el prototipo: fondo
// oscuro con desenfoque, la tarjeta que entra con fundido y escala, campos de 44 px con anillo azul al
// enfocar, selectores en pastilla y botones con color semantico; los montos a cobrar pasan a ser cifras
// neutras. En el prototipo, una hoja armonizaba los estilos EN LINEA de cada modal con selectores de
// atributo; en produccion cada modal lleva sus CLASES PROPIAS. Esta suite fija:
//
//   A. LA BASE (componentes/base.js): `Modal` (fondo, tarjeta, ancho/alto, la X; el fondo NO cierra, QA3),
//      `Fld` (rotulo + campo) y `ABtn` (el tono semantico como clase; apagado = sin onClick), sin estilos
//      en linea.
//   B. LA CONFIRMACION (modales/ConfirmModal.js): sus clases, el tono (peligro / aviso / principal), el
//      fondo que cancela, la tarjeta que no, la casilla que viaja en onConfirm; y que App y Desarrollador
//      la llaman con `tono` (ya no con un color).
//   C. LOS COLORES DE ESTADO DE LA CUOTA (`ST` de componentes/iconos.js): tokens del tema, no hexadecimales.
//   D. LOS 16 MODALES RENDERIZADOS con el fixture, en varios estados sembrados: todos dentro de la
//      tarjeta comun; el titulo con su clase; NINGUN estilo en linea de los que el prototipo armonizaba
//      (tintes y bordes de la paleta vieja, monoespaciada, mayusculas, colores de casillas, botones de
//      relleno de color); cada ABtn con su tono; los montos a cobrar como cifras neutras; los selectores
//      en pastilla; la casilla del interes del mes con su clase propia.
//   E. LA HOJA modales.css: enlazada al final, sin selectores de atributo sobre `style` ni `!important`,
//      cada clase `v4m-` que pinta el codigo con su regla (y ninguna regla sin uso), los valores aprobados
//      (fondo, entrada, 44 px, anillo de foco, botones) y lo que salio de styles.css.
//
// Se ejecuta:
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron tests/modales.js

const fs   = require('fs');
const path = require('path');
const { Reporter }          = require('./lib/report');
const { copiaDeProduccion } = require('./lib/db');
const { REPO }              = require('./lib/paths');

const R = new Reporter('modales');

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
async function traer(S, ruta) {
  const r = await fetch(S.base + ruta);
  if (r.status !== 200) throw new Error('GET ' + ruta + ' ' + r.status);
  return r.json();
}

// ── Arnes de render (el de `operacion`: estado sembrado por posicion) ────────
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
const boton = (arbol, txt) => nodos(arbol, n => n.tag === 'button' && unir(n).indexOf(txt) !== -1)[0];

// El estilo en linea como lo escribe el navegador ("background: rgba(187, 128, 9, 0.08); ..."), para
// buscar en el los mismos patrones que armonizaba el prototipo.
const kebab = k => k.replace(/[A-Z]/g, m => '-' + m.toLowerCase());
const SIN_UNIDAD = new Set(['opacity', 'flex', 'fontWeight', 'zIndex', 'lineHeight', 'flexGrow', 'flexShrink', 'order']);
const valorCss = (k, v) => {
  if (typeof v === 'number' && !SIN_UNIDAD.has(k)) return v + 'px';
  return String(v).replace(/rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\.?[\d.]*)\s*\)/g,
    (m, a, b, c, d) => 'rgba(' + a + ', ' + b + ', ' + c + ', ' + (d.charAt(0) === '.' ? '0' + d : d) + ')');
};
const estiloTexto = st => Object.keys(st || {}).filter(k => st[k] !== undefined && st[k] !== null && st[k] !== false && st[k] !== '')
  .map(k => kebab(k) + ': ' + valorCss(k, st[k]) + ';').join(' ');
// Lo que el prototipo pintaba encima (y que en produccion tiene que venir de una clase de modales.css).
const ARMONIZADOS = [
  ['tinte amarillo viejo', /rgba\(187, 128, 9/], ['tinte verde viejo', /rgba\(63, 185, 80/], ['tinte azul viejo', /rgba\(88, 166, 255/],
  ['tinte rojo viejo', /rgba\(248, 81, 73/], ['borde amarillo fuerte', /border: 1(\.5)?px solid var\(--yellow\)/],
  ['borde azul fuerte', /border: 1(\.5)?px solid var\(--blue\)/], ['borde verde fuerte', /border: 1(\.5)?px solid var\(--green\)/],
  ['borde rojo fuerte', /border: 1(\.5)?px solid var\(--red\)/], ['letra monoespaciada', /font-family: monospace/],
  ['mayusculas en linea', /text-transform: uppercase/], ['color de casilla', /accent-color/],
  ['recuadro rojo del total', /background: var\(--red-bg\).*justify-content: space-between/],
  ['recuadro amarillo del valor del PDF', /background: var\(--yellow-bg\).*border: 1px solid var\(--border\)/],
];
const BOTON_DE_COLOR = /background: (var\(--(green2|green|yellow|blue|red|bg4)\)|#b91c1c|rgb\(185, 28, 28\));/;

// ═════════════════════════════════════════════════════════════════════════════
(async () => {
  const dbPath = copiaDeProduccion('modales');
  const S = await arrancar(dbPath);
  let loans, pays;
  try {
    loans = await traer(S, '/api/loans');
    pays  = await traer(S, '/api/payments');
  } finally { await cerrar(S); }

  const { cargarFrontend } = require('./lib/load-frontend');
  const FE = cargarFrontend({ silenciarConsola: true });
  const X = FE.sandbox;
  X.Date = Date;
  const useStateOrig = X.useState;
  // Monta un componente con su estado sembrado por posicion; devuelve el arbol y los valores iniciales.
  const montar = (Comp, props, estado) => {
    let i = 0; const valores = [];
    X.useState = init => {
      const k = i++;
      const v = (estado && k < estado.length && estado[k] !== undefined) ? estado[k] : (typeof init === 'function' ? init() : init);
      valores.push(v);
      return [v, () => {}];
    };
    try { return { arbol: pintar({ type: Comp, props: props, children: [] }), valores }; }
    finally { X.useState = useStateOrig; }
  };
  const leer = p => fs.readFileSync(path.join(REPO, p), 'utf8');
  const nada = () => {}, prom = () => Promise.resolve(null);

  // Prestamos del fixture para los modales.
  const L = id => loans.filter(l => l.id === id)[0];
  const P = id => pays.filter(p => String(p.prestamoId) === id);
  const reg = p => String(p.id).indexOf('-ab-') === -1 && String(p.id).indexOf('-ct-') === -1;
  const est = (id, e) => P(id).filter(p => reg(p) && p.estadoPago === e).sort((a, b) => a.cuotaN - b.cuotaN);
  const CI = '1773656997026zqmp', INT_MORA = '1773655076017', USD_MORA = '1782151590658w66y', DIARIO = 'fixture-diario-01', CI_AB = '1776205975507jkph';

  R.seccion('0 — el arnes ve la base, la confirmacion y los 16 modales; el fixture trae los casos');
  const MODALES = ['AbonoModal', 'CambiarDiaModal', 'CobroModal', 'CondonarModal', 'ConfirmModal', 'ConfirmUndoModal', 'CorteModal', 'CronogramaPdfModal',
    'DebtModal', 'DebtPayModal', 'DeleteDebtModal', 'LiquidarModal', 'LoanModal', 'PayModal', 'PreflightMoraModal', 'RestructureModal'];
  const archivos = fs.readdirSync(path.join(REPO, 'public/js/modales')).filter(f => /\.js$/.test(f)).map(f => f.replace(/\.js$/, '')).sort();
  R.eq('0 public/js/modales trae exactamente los 16 modales', archivos, MODALES.slice().sort());
  R.check('0 el arnes ve Modal, Fld, ABtn, ST y los 16', ['Modal', 'Fld', 'ABtn', 'ST'].concat(MODALES).every(k => X[k] !== undefined));
  R.check('0 anti-vacio: el fixture trae un C+I con cuotas pendientes, un Intereses con mora, un USD con mora y el credito abierto',
    est(CI, 'Pendiente').length > 0 && est(INT_MORA, 'En Mora').length > 0 && est(USD_MORA, 'En Mora').length > 0 && !!L(DIARIO));
  const conBase = archivos.filter(f => /import \{[^}]*\bModal\b[^}]*\} from '\.\.\/componentes\/base\.js'/.test(leer('public/js/modales/' + f + '.js')));
  R.check('0 15 de los 16 modales salen de la base comun (el 16, la confirmacion, arma su propia tarjeta)',
    conBase.length === 15 && conBase.indexOf('ConfirmModal') === -1, conBase);

  // ── A — LA BASE ───────────────────────────────────────────────────────────
  R.seccion('A — la base comun: Modal, Fld y ABtn');
  const hijo = { type: 'p', props: {}, children: ['contenido'] };
  const cierres = [];
  const cerrarM = () => cierres.push(1);
  const m0 = pintar({ type: X.Modal, props: { onClose: cerrarM }, children: [hijo] });
  const mW = pintar({ type: X.Modal, props: { onClose: cerrarM, wide: true, tall: true }, children: [hijo] });
  R.check('A1 el fondo (`v4m-overlay`) envuelve la tarjeta (`v4m-sheet`, role=dialog, aria-modal)',
    clsDe(m0).join(' ') === 'v4m-overlay' && m0.kids.length === 1 && clsDe(m0.kids[0]).join(' ') === 'v4m-sheet' &&
    m0.kids[0].props.role === 'dialog' && m0.kids[0].props['aria-modal'] === 'true');
  R.check('A1 `wide` y `tall` agregan "ancho" y "alto"; sin ellos, ninguno', clsDe(mW.kids[0]).join(' ') === 'v4m-sheet ancho alto' &&
    clsDe(pintar({ type: X.Modal, props: { onClose: cerrarM, wide: true }, children: [] }).kids[0]).join(' ') === 'v4m-sheet ancho' &&
    clsDe(pintar({ type: X.Modal, props: { onClose: cerrarM, tall: true }, children: [] }).kids[0]).join(' ') === 'v4m-sheet alto');
  const xBtn = m0.kids[0].kids[0];
  R.check('A1 la X es un boton `v4m-x` con su rotulo accesible y su icono', xBtn.tag === 'button' && clsDe(xBtn).join(' ') === 'v4m-x' &&
    xBtn.props['aria-label'] === 'Cerrar' && xBtn.props.title === 'Cerrar' && nodos(xBtn, n => n.tag === 'svg').length === 1);
  xBtn.props.onClick();
  R.check('A1 la X cierra (llama a onClose)', cierres.length === 1);
  R.check('A1 el cuerpo (`v4m-body`) trae el contenido', clsDe(m0.kids[0].kids[1]).join(' ') === 'v4m-body' && unir(m0.kids[0].kids[1]) === 'contenido');
  R.check('A2 el fondo NO cierra (QA3): ni el fondo ni la tarjeta tienen onClick', !m0.props.onClick && !m0.kids[0].props.onClick);
  R.check('A2 la base no pinta estilos en linea', nodos(mW, n => !!(n.props && n.props.style)).length === 0);
  const f0 = pintar({ type: X.Fld, props: { label: 'Monto' }, children: [{ type: 'input', props: { className: 'inp' }, children: [] }] });
  R.check('A3 Fld: `v4m-fld` con su rotulo `v4m-fld-l` y luego el campo', clsDe(f0).join(' ') === 'v4m-fld' && clsDe(f0.kids[0]).join(' ') === 'v4m-fld-l' &&
    unir(f0.kids[0]) === 'Monto' && f0.kids[1].tag === 'input' && !f0.props.style && !f0.kids[0].props.style);
  const toques = [];
  const ab = (props) => pintar({ type: X.ABtn, props: Object.assign({ icon: 'check', label: 'Pagado', onClick: () => toques.push(1) }, props), children: [] });
  R.check('A4 ABtn: el tono semantico es su clase (pri, peligro, aviso, info, neutro)',
    ['pri', 'peligro', 'aviso', 'info', 'neutro'].every(t => clsDe(ab({ tono: t })).join(' ') === 'v4m-btn ' + t));
  R.check('A4 sin tono, o con uno desconocido, es neutro (nunca un color suelto)', clsDe(ab({})).join(' ') === 'v4m-btn neutro' &&
    clsDe(ab({ tono: 'var(--green2)' })).join(' ') === 'v4m-btn neutro' && clsDe(ab({ color: 'var(--red)' })).join(' ') === 'v4m-btn neutro');
  const abOn = ab({ tono: 'pri' }), abOff = ab({ tono: 'pri', disabled: true });
  abOn.props.onClick();
  R.check('A4 encendido: su onClick llega; apagado (guarda anti doble-submit): disabled y SIN onClick',
    toques.length === 1 && abOn.props.disabled === false && abOff.props.disabled === true && abOff.props.onClick === undefined);
  R.check('A4 lleva su icono y su rotulo, sin estilos en linea', nodos(abOn, n => n.tag === 'svg').length === 1 && unir(abOn) === 'Pagado' &&
    nodos(abOn, n => !!(n.props && n.props.style)).length === 0);

  // ── B — LA CONFIRMACION ───────────────────────────────────────────────────
  R.seccion('B — la confirmacion: clases, tono, fondo que cancela y casilla');
  const conf = [];
  const cProps = extra => Object.assign({ title: 'Eliminar préstamo', message: 'No se puede deshacer.', okLabel: 'Eliminar',
    onConfirm: c => conf.push(['ok', c]), onCancel: () => conf.push(['no']) }, extra);
  const c0 = montar(X.ConfirmModal, cProps({ tono: 'peligro', detail: '$ 1.000', checkLabel: 'Generar recibo' }), [true]).arbol;
  const tarjeta = c0.kids[0];
  R.check('B1 el fondo `v4m-overlay confirm` y la tarjeta `v4m-sheet v4m-confirm` (alertdialog)',
    clsDe(c0).join(' ') === 'v4m-overlay confirm' && clsDe(tarjeta).join(' ') === 'v4m-sheet v4m-confirm' && tarjeta.props.role === 'alertdialog');
  R.check('B1 titulo, mensaje, detalle y casilla con sus clases', unir(conClase(c0, 'v4m-confirm-t')[0]) === 'Eliminar préstamo' &&
    unir(conClase(c0, 'v4m-confirm-m')[0]) === 'No se puede deshacer.' && unir(conClase(c0, 'v4m-confirm-d')[0]) === '$ 1.000' &&
    conClase(c0, 'v4m-check').length === 1 && nodos(c0, n => !!(n.props && n.props.style)).length === 0);
  const okDe = arbol => boton(arbol, arbol === c0 ? 'Eliminar' : 'Aceptar');
  R.check('B1 el tono: peligro en rojo con el icono de alerta; aviso igual en amarillo; principal (por defecto) con el visto',
    clsDe(okDe(c0)).join(' ') === 'v4m-btn peligro' && clsDe(conClase(c0, 'v4m-confirm-ico')[0]).join(' ') === 'v4m-confirm-ico peligro' &&
    clsDe(boton(montar(X.ConfirmModal, cProps({ tono: 'aviso', okLabel: 'Aceptar' })).arbol, 'Aceptar')).join(' ') === 'v4m-btn aviso' &&
    clsDe(boton(montar(X.ConfirmModal, cProps({ okLabel: 'Aceptar' })).arbol, 'Aceptar')).join(' ') === 'v4m-btn pri' &&
    clsDe(boton(montar(X.ConfirmModal, cProps({ okLabel: 'Aceptar', tono: '#b91c1c' })).arbol, 'Aceptar')).join(' ') === 'v4m-btn pri' &&
    nodos(conClase(montar(X.ConfirmModal, cProps({})).arbol, 'v4m-confirm-ico')[0], n => n.tag === 'path').length === 1);
  R.check('B1 Cancelar es el boton neutro', clsDe(boton(c0, 'Cancelar')).join(' ') === 'v4m-btn neutro');
  okDe(c0).props.onClick();
  boton(c0, 'Cancelar').props.onClick();
  c0.props.onClick();
  let parada = 0;
  tarjeta.props.onClick({ stopPropagation: () => parada++ });
  R.eq('B2 Aceptar manda la casilla marcada; Cancelar y el fondo cancelan; la tarjeta frena el clic', conf.concat([['parada', parada]]),
    [['ok', true], ['no'], ['no'], ['parada', 1]]);
  const app = leer('public/js/app.js'), dev = leer('public/js/vistas/DevView.js');
  const tonos = s => (s.match(/okLabel: ?'[^']+', ?tono: ?'[a-z]+'/g) || []).map(x => x.replace(/\s/g, ''));
  R.eq('B3 App y Desarrollador llaman a la confirmacion con su tono (lo irreversible en rojo)', tonos(app).concat(tonos(dev)),
    ["okLabel:'Crearigual',tono:'aviso'", "okLabel:'GenerarPDF',tono:'pri'", "okLabel:'Eliminar',tono:'peligro'", "okLabel:'Cerrarpréstamo',tono:'peligro'", "okLabel:'Restaurar',tono:'aviso'"]);
  const todoJs = d => fs.readdirSync(path.join(REPO, d)).filter(f => /\.js$/.test(f)).map(f => leer(d + '/' + f)).join('\n');
  const front = [todoJs('public/js'), todoJs('public/js/modales'), todoJs('public/js/componentes'), todoJs('public/js/vistas')].join('\n');
  R.check('B3 nadie le pasa ya un color a la confirmacion (okColor) ni a un ABtn (color)', !/okColor/.test(front) && !/h\(ABtn,\{[^}]*\bcolor:/.test(front));

  // ── C — LOS COLORES DE ESTADO DE LA CUOTA ─────────────────────────────────
  R.seccion('C — los colores de estado de la cuota (ST) salen del tema');
  R.eq('C1 los tres estados con sus tokens y sus marcas', X.ST, {
    'Pagado': { bg: 'var(--good-soft)', color: 'var(--good-text)', bd: 'var(--green-bd)', icon: '✓' },
    'Pendiente': { bg: 'var(--warn-soft)', color: 'var(--warn-text)', bd: 'var(--yellow)', icon: '•' },
    'En Mora': { bg: 'var(--crit-soft)', color: 'var(--crit-text)', bd: 'var(--red-bd)', icon: '!' } });
  R.check('C1 ningun hexadecimal en ST', !/#[0-9a-f]{3,6}/i.test(JSON.stringify(X.ST)));
  const pagoMora = montar(X.PayModal, { pay: est(INT_MORA, 'En Mora')[0], loan: L(INT_MORA), allPays: pays, onMark: prom, onPartial: prom, onClose: nada }).arbol;
  const pildora = nodos(pagoMora, n => n.tag === 'span' && /En Mora$/.test(unir(n)) && n.props.style && n.props.style.borderRadius === 99)[0];
  R.check('C2 el modal de pago pinta la pildora del estado con esos tokens', !!pildora && pildora.props.style.background === 'var(--crit-soft)' &&
    pildora.props.style.color === 'var(--crit-text)' && unir(pildora) === '! En Mora');

  // ── D — LOS 16 MODALES RENDERIZADOS ───────────────────────────────────────
  R.seccion('D — los 16 modales renderizados con el fixture, en varios estados');
  const deuda = { id: 'd1', titulo: 'Compra del carro', acreedor: 'banco popular', concepto: '5% mensual - Cuota inicial', monto_original: 1000000,
    saldo_pendiente: 500000, estado: 'Activa', fecha_creacion: '2026-07-01', total_cargos: 0, total_abonos: 500000 };
  const pend = est(CI, 'Pendiente')[0];
  const prest = id => ({ loan: L(id), pays, onSave: prom, onClose: nada, onRequestLiquidar: nada });
  // Prestamo nuevo: el formulario con su estado inicial, y variantes sembradas sobre el.
  const loanBase = { loan: null, trm: 4000, pays, clientes: [{ nombre: 'Marta Diaz', cedula: '1', telefono: '2' }], onSave: nada, onClose: nada };
  const fIni = montar(X.LoanModal, loanBase).valores[0];
  const conF = cambios => [Object.assign({}, fIni, cambios)];
  const ESCENAS = [
    ['ConfirmModal', X.ConfirmModal, cProps({ tono: 'peligro', detail: '$ 1.000', checkLabel: 'Generar recibo' })],
    ['ConfirmUndoModal (vieja, con caja)', X.ConfirmUndoModal, { entry: { id: 'u1', descripcion: 'Abono', created_at: '2026-07-01 10:00:00', afecta_caja: 1, scope_tipo: 'loan' }, onConfirm: prom, onClose: nada }],
    ['DeleteDebtModal', X.DeleteDebtModal, { debt: deuda, onConfirm: nada, onClose: nada }],
    ['PreflightMoraModal', X.PreflightMoraModal, { loan: L(CI), cuotas: est(CI, 'Pendiente').slice(0, 2), onMarkMora: prom, onContinue: prom, onCancel: nada }],
    ['DebtModal (nueva, con sugerencias)', X.DebtModal, { debt: null, existingAcreedores: ['Banco Popular', 'Bancolombia'], onSave: prom, onClose: nada }, [true, undefined, 'Ban']],
    ['DebtModal (editar, monto bloqueado)', X.DebtModal, { debt: deuda, existingAcreedores: [], onSave: prom, onClose: nada }, [undefined, undefined, undefined, '5%', 'desc']],
    ['DebtPayModal (abono que excede)', X.DebtPayModal, { debt: deuda, onSave: prom, onClose: nada }, [undefined, undefined, '600000']],
    ['DebtPayModal (cargo)', X.DebtPayModal, { debt: deuda, onSave: prom, onClose: nada }, ['cargo', undefined, '100000']],
    ['DebtPayModal (sin monto)', X.DebtPayModal, { debt: deuda, onSave: prom, onClose: nada }],
    ['PayModal (pendiente)', X.PayModal, { pay: pend, loan: L(CI), allPays: pays, onMark: prom, onPartial: prom, onClose: nada }],
    ['PayModal (parcial, con abono previo)', X.PayModal, { pay: Object.assign({}, pend, { partialPaid: 50000 }), loan: L(CI), allPays: pays, onMark: prom, onPartial: prom, onClose: nada },
      [undefined, undefined, undefined, undefined, undefined, 'parcial', '50000']],
    ['PayModal (USD, completo)', X.PayModal, { pay: est(USD_MORA, 'En Mora')[0], loan: L(USD_MORA), allPays: pays, onMark: prom, onPartial: prom, onClose: nada }],
    ['PayModal (USD, parcial)', X.PayModal, { pay: est(USD_MORA, 'En Mora')[0], loan: L(USD_MORA), allPays: pays, onMark: prom, onPartial: prom, onClose: nada },
      [undefined, undefined, undefined, undefined, undefined, 'parcial', '500000', '120']],
    ['PayModal (detalle de abono)', X.PayModal, { pay: P(CI_AB).filter(p => !reg(p))[0], loan: L(CI_AB), allPays: pays, onMark: prom, onPartial: prom, onClose: nada }],
    ['AbonoModal (COP, mantener)', X.AbonoModal, prest(CI), ['1000000']],
    ['AbonoModal (COP, fijar cuota invalida)', X.AbonoModal, prest(CI), ['1000000', undefined, undefined, undefined, undefined, undefined, undefined, 'fijarCuota', '', '1000']],
    ['AbonoModal (USD, fijar cuota)', X.AbonoModal, prest(USD_MORA), [undefined, undefined, undefined, '100', '400000', undefined, undefined, 'fijarCuota', '', '', '300']],
    ['AbonoModal (USD, supera el abono)', X.AbonoModal, prest(USD_MORA), [undefined, undefined, undefined, '99999', '1']],
    ['CobroModal (abono y recalculo)', X.CobroModal, { loan: L(CI), pays, onConfirm: prom, onClose: nada, onRequestLiquidar: nada },
      ['500000', undefined, undefined, undefined, undefined, undefined, true, null, true, true, false, 'mantener', '']],
    ['CobroModal (USD, fallo a mitad)', X.CobroModal, { loan: L(USD_MORA), pays, onConfirm: prom, onClose: nada, onRequestLiquidar: nada },
      [undefined, '500', '2000000', undefined, undefined, undefined, true, { ok: false, error: 'Fallo de prueba', hechos: [{ tipo: 'partial', cuotaN: 3, obligacionCOP: 100000 }] }, true, true, true]],
    ['CobroModal (sobra dinero)', X.CobroModal, { loan: L(INT_MORA), pays, onConfirm: prom, onClose: nada, onRequestLiquidar: nada }, ['999999999']],
    ['CondonarModal', X.CondonarModal, { loan: L(INT_MORA), pays, onConfirm: prom, onClose: nada }],
    ['CondonarModal (credito abierto)', X.CondonarModal, { loan: L(DIARIO), pays, onConfirm: prom, onClose: nada }],
    ['CorteModal', X.CorteModal, { loan: L(DIARIO), pays, onSave: prom, onClose: nada }, [undefined, undefined, '100000']],
    ['CorteModal (fecha futura)', X.CorteModal, { loan: L(DIARIO), pays, onSave: prom, onClose: nada }, ['2026-08-15']],
    ['CambiarDiaModal', X.CambiarDiaModal, { loan: L(CI), pays, onReload: nada, onClose: nada }, ['15']],
    ['CambiarDiaModal (registrado)', X.CambiarDiaModal, { loan: L(USD_MORA), pays, onReload: nada, onClose: nada },
      ['15', { nuevoDia: 15, primeraCuota: { fechaPago: '2026-08-15', cuotaTotal: 500000 }, capitalCuota: 300000, prorrateo: 50000, diasReales: 15, moraCount: 1, moraPendiente: 200000, cuotasRecurrentes: 450000 }]],
    ['CronogramaPdfModal', X.CronogramaPdfModal, { loan: L(INT_MORA), pays: P(INT_MORA), onClose: nada }, [true]],
    ['LiquidarModal', X.LiquidarModal, { loan: L(INT_MORA), pays, datosPago: '', onConfirm: prom, onClose: nada }, [true]],
    ['LiquidarModal (USD)', X.LiquidarModal, { loan: L(USD_MORA), pays, datosPago: '', onConfirm: prom, onClose: nada }],
    ['RestructureModal', X.RestructureModal, prest(CI), [undefined, '6']],
    ['RestructureModal (USD, fijar cuota)', X.RestructureModal, prest(USD_MORA), ['fijarCuota', '', '', '300']],
    ['LoanModal (nuevo, sugerencias)', X.LoanModal, loanBase, conF({ nombre: 'Ma' }).concat([true])],
    ['LoanModal (C+I con cronograma)', X.LoanModal, loanBase, conF({ nombre: 'Cliente', montoOrigen: '1000000', modalidad: 'Capital + Intereses', tasaMensual: '5', plazoMeses: '6' })
      .concat([undefined, undefined, undefined, undefined, true])],
    ['LoanModal (primer periodo con gracia)', X.LoanModal, loanBase, conF({ montoOrigen: '1000000', tasaMensual: '5', primerPago: '2026-09-20', primerPagoManual: true })],
    ['LoanModal (USD con compras fraccionadas)', X.LoanModal, loanBase, conF({ moneda: 'USD', montoOrigen: '1000' })
      .concat([undefined, [{ monto: '700', tasa: '4000', totalCOP: '' }, { monto: '200', tasa: '', totalCOP: '' }], true])],
    ['LoanModal (USD, compras que exceden)', X.LoanModal, loanBase, conF({ moneda: 'USD', montoOrigen: '100' })
      .concat([undefined, [{ monto: '700', tasa: '4000', totalCOP: '' }], true])],
    ['LoanModal (Pago Unico)', X.LoanModal, loanBase, conF({ montoOrigen: '1000000', modalidad: 'Pago Unico', fechaDevolucion: '2026-10-01', gananciaInput: '10' })],
    ['LoanModal (credito abierto)', X.LoanModal, loanBase, conF({ montoOrigen: '1000000', modalidad: 'Interes Diario', tasaMensual: '3', fechaInicio: '2026-07-01' })],
    ['LoanModal (editar con actividad)', X.LoanModal, { loan: L(CI), trm: 4000, pays, clientes: [], onSave: nada, onClose: nada }],
  ];
  const vistos = new Set(), errores = [], armonizados = [], botonesColor = [], abtnSinTono = [];
  const arboles = {};
  for (const [nom, Comp, props, estado] of ESCENAS) {
    let v;
    try { v = montar(Comp, props, estado).arbol; } catch (e) { errores.push(nom + ': ' + e.message); continue; }
    arboles[nom] = v;
    vistos.add(nom.replace(/ \(.*$/, ''));
    nodos(v, n => !!(n.props && n.props.style)).forEach(n => {
      const t = estiloTexto(n.props.style);
      ARMONIZADOS.forEach(([q, re]) => { if (re.test(t)) armonizados.push(nom + ' · ' + q + ' · ' + n.tag + ' [' + t.slice(0, 90) + ']'); });
      if (n.tag === 'button' && BOTON_DE_COLOR.test(t)) botonesColor.push(nom + ' · ' + unir(n).slice(0, 30) + ' [' + t.slice(0, 80) + ']');
    });
    conClase(v, 'v4m-btn').forEach(b => { if (clsDe(b).length !== 2) abtnSinTono.push(nom + ' · ' + unir(b)); });
  }
  R.check('D1 las ' + ESCENAS.length + ' escenas se renderizan sin excepciones y cubren los 16 modales', errores.length === 0 && vistos.size === 16, errores.concat([[...vistos].length]));
  R.check('D1 los 15 modales de la base van dentro de la tarjeta comun (y la confirmacion en la suya)',
    Object.entries(arboles).every(([n, a]) => conClase(a, 'v4m-sheet').length === 1 && conClase(a, n.indexOf('ConfirmModal') === 0 ? 'v4m-confirm' : 'v4m-body').length === 1));
  R.check('D2 ningun estilo en linea de los que el prototipo armonizaba (cada uno vive en una clase de modales.css)', armonizados.length === 0, armonizados.slice(0, 15));
  R.check('D2 ANTI-TRIVIAL: el detector reconoce los patrones tal como los escribe el codigo viejo',
    ARMONIZADOS[0][1].test(estiloTexto({ background: 'rgba(187,128,9,.08)' })) && ARMONIZADOS[4][1].test(estiloTexto({ border: '1px solid var(--yellow)' })) &&
    !ARMONIZADOS[4][1].test(estiloTexto({ border: '1px solid var(--yellow-bd)' })) && ARMONIZADOS[8][1].test(estiloTexto({ fontFamily: 'monospace' })) &&
    BOTON_DE_COLOR.test(estiloTexto({ background: 'var(--green2)', color: '#fff' })) && ARMONIZADOS[11][1].test(estiloTexto({ background: 'var(--red-bg)', border: '1px solid var(--red-bd)', display: 'flex', justifyContent: 'space-between' })));
  R.check('D2 ningun boton con relleno de color en linea (el principal es negro/blanco por clase; lo irreversible, rojo por clase)', botonesColor.length === 0, botonesColor);
  R.check('D2 todo ABtn trae su tono como clase', abtnSinTono.length === 0, abtnSinTono);
  const titulos = ['ConfirmUndoModal (vieja, con caja)', 'PreflightMoraModal', 'DebtModal (nueva, con sugerencias)', 'DebtPayModal (cargo)', 'PayModal (pendiente)',
    'PayModal (detalle de abono)', 'AbonoModal (COP, mantener)', 'CambiarDiaModal', 'CronogramaPdfModal', 'LiquidarModal', 'RestructureModal', 'LoanModal (C+I con cronograma)'];
  const primero = a => conClase(a, 'v4m-body')[0].kids[0];
  R.check('D3 el titulo de cada modal (su primer bloque) lleva la clase `v4m-tit` y ya no su tamaño ni su color en linea',
    titulos.every(t => clsDe(primero(arboles[t])).indexOf('v4m-tit') !== -1 &&
      !['fontSize', 'fontWeight', 'color', 'marginBottom'].some(k => primero(arboles[t]).props.style && primero(arboles[t]).props.style[k] !== undefined)),
    titulos.filter(t => clsDe(primero(arboles[t])).indexOf('v4m-tit') === -1));
  const tonoDe = (arbol, txt) => clsDe(boton(arbol, txt)).filter(c => c !== 'v4m-btn').join(' ');
  R.eq('D4 cada accion con su tono: pagar (principal), en mora (rojo), pendiente (neutro), parcial (aviso), cobrar, condonar, crear deuda, abono y cargo',
    [tonoDe(arboles['PayModal (pendiente)'], 'Pagado'), tonoDe(arboles['PayModal (pendiente)'], 'En Mora'), tonoDe(arboles['PayModal (USD, completo)'], 'Pendiente'),
      tonoDe(arboles['PayModal (parcial, con abono previo)'], 'Registrar parcial'), tonoDe(arboles['CobroModal (abono y recalculo)'], 'Registrar cobro'),
      tonoDe(arboles['CondonarModal'], 'Condonar'), tonoDe(arboles['DebtModal (nueva, con sugerencias)'], 'Crear deuda'),
      tonoDe(arboles['DebtPayModal (abono que excede)'], 'Registrar abono'), tonoDe(arboles['DebtPayModal (cargo)'], 'Registrar cargo'),
      tonoDe(arboles['DebtPayModal (sin monto)'], 'Registrar abono')],
    ['pri', 'peligro', 'neutro', 'aviso', 'pri', 'aviso', 'pri', 'neutro', 'peligro', 'neutro']);
  // Los montos a cobrar: cifras neutras, no recuadros rojos/amarillos.
  const total = a => conClase(a, 'v4m-total')[0];
  const sinColor = n => !(n.props.style && (n.props.style.color || n.props.style.background || n.props.style.border));
  R.check('D5 Liquidar deuda y Descargar cronograma: el monto a cobrar en un recuadro neutro (`v4m-total`), rotulo y cifra sin color en linea',
    ['LiquidarModal', 'LiquidarModal (USD)', 'CronogramaPdfModal'].every(t => { const n = total(arboles[t]);
      return !!n && sinColor(n) && conClase(n, 'v4m-total-l').length === 1 && sinColor(conClase(n, 'v4m-total-l')[0]) &&
        conClase(n, 'v4m-total-v').length === 1 && sinColor(conClase(n, 'v4m-total-v')[0]) && /^\$\s[\d.]+$/.test(unir(conClase(n, 'v4m-total-v')[0])); }));
  const confLiq = boton(arboles['LiquidarModal'], 'Confirmar liquidación');
  R.check('D5 confirmar la liquidacion es la accion principal (negro/blanco), ya no un boton rojo', clsDe(confLiq).join(' ') === 'btn-primary' &&
    confLiq.props.style.background === undefined && confLiq.props.style.color === undefined && confLiq.props.style.border === '1px solid transparent');
  const enviando = boton(montar(X.LiquidarModal, { loan: L(INT_MORA), pays, datosPago: '', onConfirm: prom, onClose: nada }, [false, true]).arbol, 'Procesando');
  R.check('D5 mientras procesa, el boton se apaga en gris (como antes)', enviando.props.disabled === true && enviando.props.style.background === 'var(--bg3)');
  // Los selectores segmentados.
  const seg = a => conClase(a, 'v4m-seg')[0];
  const opcion = (a, txt) => clsDe(boton(seg(a), txt)).join(' ');
  R.eq('D6 Completo / Parcial y Abono / Cargo en pastilla: la elegida con `on` (el cargo, ademas, en rojo)',
    [opcion(arboles['PayModal (pendiente)'], 'Pago completo'), opcion(arboles['PayModal (pendiente)'], 'Pago parcial'),
      opcion(arboles['PayModal (USD, parcial)'], 'Pago completo'), opcion(arboles['PayModal (USD, parcial)'], 'Pago parcial'),
      opcion(arboles['DebtPayModal (abono que excede)'], 'Abono'), opcion(arboles['DebtPayModal (cargo)'], 'Abono'), opcion(arboles['DebtPayModal (cargo)'], 'Cargo')],
    ['on', '', '', 'on', 'on', '', 'on rojo']);
  R.check('D6 las opciones del selector no pintan fondo ni color en linea', ['PayModal (pendiente)', 'DebtPayModal (cargo)'].every(t =>
    seg(arboles[t]).kids.every(b => !b.props.style.background && !b.props.style.color && !b.props.style.border)) && !seg(arboles['PayModal (pendiente)']).props.style.background);
  // Recuadros y bordes por clase.
  const cls = (t, c) => conClase(arboles[t], c).length;
  R.check('D7 los recuadros de color llegan por clase: aviso (pago parcial, campos bloqueados), bien (abono, ya abonado), info (como se aplica)',
    cls('PayModal (parcial, con abono previo)', 'v4m-caja-aviso') === 1 && cls('PayModal (parcial, con abono previo)', 'v4m-caja-bien') === 1 &&
    cls('LoanModal (editar con actividad)', 'v4m-caja-aviso') === 1 && cls('AbonoModal (COP, mantener)', 'v4m-caja-bien') === 1 &&
    cls('AbonoModal (COP, mantener)', 'v4m-caja-info') === 1 && cls('RestructureModal', 'v4m-caja-info') === 1 &&
    cls('ConfirmUndoModal (vieja, con caja)', 'v4m-caja-aviso') === 1 && cls('ConfirmUndoModal (vieja, con caja)', 'v4m-caja-peligro') === 1);
  R.check('D7 los grupos de opciones son neutros (`v4m-grupo`) y la elegida se tiñe por clase',
    cls('AbonoModal (COP, mantener)', 'v4m-grupo') === 1 && cls('RestructureModal', 'v4m-grupo') === 1 &&
    cls('LoanModal (primer periodo con gracia)', 'v4m-grupo') === 1 && cls('LoanModal (primer periodo con gracia)', 'v4m-elegida-info') === 1 &&
    cls('LoanModal (Pago Unico)', 'v4m-grupo') === 1 && cls('LoanModal (Pago Unico)', 'v4m-elegida-bien') === 1);
  const campos = (t, c) => nodos(arboles[t], n => n.tag === 'input' && clsDe(n).indexOf('inp') !== -1 && clsDe(n).indexOf(c) !== -1).length;
  R.check('D7 los campos con borde de color lo traen por clase (inp + v4m-b-*)',
    campos('PayModal (USD, parcial)', 'v4m-b-aviso') === 1 && campos('PayModal (USD, parcial)', 'v4m-b-info') === 1 &&
    campos('PayModal (USD, completo)', 'v4m-b-aviso') === 1 && campos('AbonoModal (COP, mantener)', 'v4m-b-bien') === 1 &&
    campos('AbonoModal (COP, fijar cuota invalida)', 'v4m-b-info') === 1 && campos('DebtPayModal (abono que excede)', 'v4m-b-peligro') === 1 &&
    campos('DebtPayModal (cargo)', 'v4m-b-peligro') === 0);
  R.check('D7 los botones de bloque con borde de color tambien (abono, reestructurar, corte, marcar en mora, liquidar desde el abono)',
    clsDe(boton(arboles['AbonoModal (COP, mantener)'], 'Registrar abono')).join(' ') === 'btn-primary v4m-b-info' &&
    clsDe(boton(arboles['RestructureModal'], 'Aplicar')).join(' ') === 'btn-primary v4m-b-info' &&
    clsDe(boton(arboles['CorteModal'], 'Registrar corte')).join(' ') === 'btn-primary v4m-b-bien' &&
    clsDe(boton(arboles['PreflightMoraModal'], 'Marcar en Mora')).join(' ') === 'btn-primary v4m-b-aviso' &&
    clsDe(boton(arboles['AbonoModal (USD, supera el abono)'], 'Liquidar deuda')).join(' ') === 'v4m-b-aviso v4m-pulsa');
  R.check('D7 lo irreversible en rojo por clase (eliminar deuda) y los botones de forma propia con su respuesta al toque',
    clsDe(boton(arboles['DeleteDebtModal'], 'Eliminar')).join(' ') === 'v4m-rojo v4m-pulsa' &&
    ['DeleteDebtModal', 'CobroModal (abono y recalculo)', 'CondonarModal', 'ConfirmUndoModal (vieja, con caja)', 'PreflightMoraModal']
      .every(t => clsDe(boton(arboles[t], 'Cancelar')).indexOf('v4m-pulsa') !== -1));
  const cerrarDia = boton(arboles['CambiarDiaModal (registrado)'], 'Cerrar');
  R.check('D7 el comprobante de Cambiar dia cierra con el boton principal, sin el verde en linea',
    !!cerrarDia && clsDe(cerrarDia).join(' ') === 'btn-primary' && !cerrarDia.props.style);
  R.check('D7 el pie de la tabla del cobro, las filas del cronograma tentativo y las cifras en Inter (sin monoespaciada)',
    cls('CobroModal (abono y recalculo)', 'v4m-pie') === 1 && cls('LoanModal (C+I con cronograma)', 'v4m-crono-th') === 1 &&
    cls('LoanModal (C+I con cronograma)', 'v4m-crono-tr') === 6 && cls('DebtPayModal (abono que excede)', 'v4m-num') === 1 &&
    cls('LoanModal (C+I con cronograma)', 'v4m-num') === 1 && cls('DebtPayModal (cargo)', 'v4m-mayus') === 1);
  // La casilla del interes del mes (componentes/CheckInteresMes.js): marcarla no cambia el borde.
  const casilla = a => conClase(a, 'v4m-casilla')[0];
  const liqSin = montar(X.LiquidarModal, { loan: L(INT_MORA), pays, datosPago: '', onConfirm: prom, onClose: nada }, [false]).arbol;
  R.check('D8 la casilla del interes del mes lleva `v4m-casilla`, marcada o no, sin fondo ni borde en linea',
    !!casilla(arboles['LiquidarModal']) && !!casilla(liqSin) && !!casilla(arboles['CronogramaPdfModal']) &&
    [casilla(arboles['LiquidarModal']), casilla(liqSin)].every(n => !n.props.style.background && !n.props.style.border) &&
    nodos(casilla(arboles['LiquidarModal']), n => n.tag === 'input')[0].props.checked === true);
  R.check('D8 la compra fraccionada de dolares (Prestamo) usa la misma casilla', cls('LoanModal (USD con compras fraccionadas)', 'v4m-casilla') === 1);
  const fuenteCasilla = leer('public/js/componentes/CheckInteresMes.js');
  R.check('D8 la casilla del periodo irregular y sus atajos tambien (estatico: el fixture no trae ese periodo en curso)',
    (fuenteCasilla.match(/className:'v4m-casilla'/g) || []).length === 2 && /className:activo\?'v4m-b-aviso':''/.test(fuenteCasilla) &&
    !/accentColor|'var\(--yellow\)':'var\(--border\)'/.test(fuenteCasilla));

  // ── E — LA HOJA modales.css ───────────────────────────────────────────────
  R.seccion('E — modales.css: orden, sin selectores de atributo, cada clase con su regla, valores aprobados');
  const crudo = leer('public/css/modales.css');
  const mcss = crudo.replace(/\/\*[\s\S]*?\*\//g, '');
  const mc = mcss.replace(/\s+/g, ' ');
  const scss = leer('public/css/styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
  // Detras solo va arranque.css (las novedades usan la ventana de los modales; la vigila tests/arranque.js).
  R.check('E1 index.html carga modales.css despues de dev.css, y detras solo la hoja del arranque',
    /href="\/css\/dev\.css">\s*<link[^>]*href="\/css\/modales\.css">\s*<link[^>]*href="\/css\/arranque\.css">\s*<\/head>/.test(leer('public/index.html')));
  R.check('E2 ninguna regla mira el atributo `style` (eso era solo del prototipo)', !/\[style/.test(mcss));
  R.check('E2 sin `!important`: nada pelea contra estilos en linea', mcss.indexOf('!important') === -1);
  const fuentesV4m = ['public/js/componentes/base.js', 'public/js/componentes/CheckInteresMes.js'].concat(archivos.map(f => 'public/js/modales/' + f + '.js')).map(leer).join('\n');
  const usadas = Array.from(new Set(fuentesV4m.match(/v4m-[a-z0-9-]+/g) || []));
  const reglas = Array.from(new Set(mcss.match(/\.v4m-[a-z0-9-]+/g) || [])).map(c => c.slice(1));
  const sinRegla = usadas.filter(c => reglas.indexOf(c) === -1), sinUso = reglas.filter(c => usadas.indexOf(c) === -1);
  R.check('E3 cada clase v4m- que pinta el codigo tiene su regla (' + usadas.length + ' clases)', usadas.length >= 35 && sinRegla.length === 0, sinRegla);
  R.check('E3 y ninguna regla v4m- se quedo sin uso', sinUso.length === 0, sinUso);
  R.check('E4 el fondo oscuro desenfocado y la tarjeta que entra con fundido y escala',
    mc.indexOf('background: rgba(0, 0, 0, .62); -webkit-backdrop-filter: blur(8px) saturate(115%); backdrop-filter: blur(8px) saturate(115%); animation: v4m-fondo .22s ease both;') !== -1 &&
    mc.indexOf('@keyframes v4m-entra { from { opacity: 0; transform: translateY(12px) scale(.965); } to { opacity: 1; transform: none; } }') !== -1 &&
    mc.indexOf('animation: v4m-entra .34s var(--ease) both;') !== -1 && /\[data-theme="light"\] \.v4m-overlay, \[data-theme="light"\] \.modal-overlay \{ background: rgba\(24, 24, 20, \.34\); \}/.test(mc));
  R.check('E4 los campos de 44 px con el anillo azul al enfocar', /\.v4m-sheet \.inp, \.modal-panel \.inp \{ min-height: 44px;/.test(mc) &&
    mc.indexOf('.v4m-sheet .inp:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); background: var(--surface); }') !== -1);
  R.check('E4 el foco y el paso del mouse le ganan al borde de color de un campo (van despues, misma especificidad)',
    mc.indexOf('.v4m-sheet .inp.v4m-b-aviso') !== -1 && mc.indexOf('.v4m-sheet .inp.v4m-b-aviso') < mc.indexOf('.v4m-sheet .inp:hover') &&
    mc.indexOf('.v4m-sheet .inp:hover') < mc.indexOf('.v4m-sheet .inp:focus'));
  R.check('E4 los botones con color semantico: principal negro/blanco, peligro rojo; y el boton de bloque tambien es el principal',
    mc.indexOf('.v4m-btn.pri { background: var(--inverse-bg); color: var(--inverse-ink); }') !== -1 &&
    mc.indexOf('.v4m-btn.peligro { background: var(--crit); color: #fff; }') !== -1 &&
    /\.v4m-sheet \.btn-primary \{ background: var\(--inverse-bg\); color: var\(--inverse-ink\); min-height: 46px;/.test(mc) && mc.indexOf('.v4m-rojo { background: var(--crit); color: #fff; }') !== -1);
  R.check('E4 la pastilla del selector y el monto a cobrar neutro',
    mc.indexOf('.v4m-seg { display: flex; gap: 6px; padding: 3px; background: var(--surface-2); border: 1px solid var(--line); border-radius: 999px; }') !== -1 &&
    mc.indexOf('.v4m-total { background: var(--surface-2); border: 1px solid var(--line-strong); }') !== -1);
  R.check('E4 "reducir movimiento" del sistema apaga la entrada', /@media \(prefers-reduced-motion: reduce\) \{ \.v4m-overlay, \.v4m-sheet, \.modal-overlay, \.modal-panel \{ animation: none; \} \}/.test(mc));
  R.check('E5 styles.css ya no trae la ventana vieja (`.modal-sheet`, `slideUp`, `.modal-overlay`, `.modal-panel`, `.modal-handle`)',
    !/\.modal-(sheet|overlay|panel|handle)\b|slideUp/.test(scss));
  R.check('E5 los dialogos de App (aviso al iniciar y novedades) siguen teniendo su ventana: vive en modales.css',
    /\.modal-overlay \{/.test(mc.replace(/\.v4m-overlay, \.modal-overlay/g, '.modal-overlay')) && mc.indexOf('.modal-panel { padding: 24px 26px; }') !== -1 &&
    mc.indexOf('.modal-handle {') !== -1 && /className:'modal-overlay'/.test(app) && /className:'modal-handle'/.test(app));
  R.check('E5 la animacion fadeIn sigue en styles.css (la usan otras vistas)', /@keyframes fadeIn/.test(scss));
  R.check('E6 nada del prototipo en produccion', ['PROTOTIPO', 'proto-chip', 'v4-forzar', 'v4mVariante', 'v4cVariante'].every(s => crudo.indexOf(s) === -1 && fuentesV4m.indexOf(s) === -1));

  process.exit(R.finalizar());
})().catch(e => { console.error(e); process.exit(1); });
