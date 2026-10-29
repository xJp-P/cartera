// tests/resumen.js — la pestaña Resumen (3.4.0) contra el fixture y el server real.
//
// El Resumen reemplazo al Inicio de cuatro tarjetas. No trae formulas nuevas de dinero: todas sus
// cifras salen de los helpers del dominio (cobrosDe, imputarCobros, gananciaDe, pendCuota). Lo que
// SI es nuevo es la forma de agregarlas —por prestamo, por deudor, por mes, por dia—, y ahi es
// donde una vista se puede equivocar sin que ninguna otra suite lo note. Esta suite fija:
//
//   A. EL MODELO (`modeloResumen`): capital en la calle, prestado, mora por deudor, caja / interes
//      / ganancia de cada mes y la proyeccion, recalculados APARTE con los helpers del dominio.
//      La curva del mes termina exactamente en "Cobros del Mes" (la cifra de App).
//   B. LA META DEL MES (`rzMetaDelMes`): solo cuotas del cronograma. Hasta 3.3.0 la tarjeta de
//      Recaudo contaba los CORTES de interes diario en la meta y en lo recibido (123% contra el
//      125% real). El anti-vacio comprueba que el fixture SI tiene un corte en julio: sin el,
//      la exclusion pasaria en verde sin estar probando nada.
//   C. LA AGENDA (`rzAgendaDias`): cuotas Pendientes de prestamos activos, por dia, con lo que
//      falta por cobrar de cada una; los rangos de 7, 14 y 30 dias.
//   D. LA VISTA REAL (`DashView`) renderizada con el arnes: sin excepciones, con las cifras de A-C
//      en pantalla, con la ortografia completa que aprobo el PO, en escritorio y en telefono.
//   E. GUARDAS ESTATICAS del reemplazo: el Inicio viejo no deja restos.
//
// Se ejecuta:
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron tests/resumen.js

const fs   = require('fs');
const path = require('path');
const { Reporter }          = require('./lib/report');
const { copiaDeProduccion } = require('./lib/db');
const { REPO }              = require('./lib/paths');

const R = new Reporter('resumen');

// ── RELOJ: calendario CONGELADO, reloj de ids INTACTO ────────────────────────
// Mismo instante y misma razon que `pdf-render`, `cascada-cobro`, `periodo-irregular` y
// `e2e-api`: 31-jul-2026, la fecha de referencia del fixture. El Resumen es la vista que MAS
// depende del dia (agenda, mes en curso, meses hacia atras), asi que sin esto caducaria sola.
const RelojReal = Date;
const INSTANTE_FIJO = new RelojReal(2026, 6, 31, 12, 0, 0);
global.Date = class extends RelojReal {
  constructor(...args) { if (args.length === 0) super(INSTANTE_FIJO.getTime()); else super(...args); }
  static now() { return RelojReal.now(); }
};
const HOY = '2026-07-31';

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

// ── Arnes de render (el de `periodo-irregular` H, sin estado sembrado) ────────
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
const clases = (n, out) => {
  out = out || [];
  if (Array.isArray(n)) { n.forEach(x => clases(x, out)); return out; }
  if (n && n.kids) { if (n.props && n.props.className) out.push(n.props.className); n.kids.forEach(x => clases(x, out)); }
  return out;
};
const suma = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
const mesDe = iso => String(iso).slice(0, 7);

// Los props que App le pasa a la vista, armados como los arma App (`metrics` en app.js). Solo los
// campos que el Resumen lee; la suite compara contra ellos, asi que no pueden salir de la vista.
function metricsComoApp(X, loans, pays) {
  const td = X.nowStr(), thisM = td.slice(0, 7), nxtW = X.addDays(td, 7);
  const usd = {}; loans.forEach(l => { usd[l.id] = l.moneda === 'USD'; });
  const mora = pays.filter(p => p.estadoPago === 'En Mora' && X.esCuotaRegular(p));
  return {
    esperado: suma(pays.filter(p => p.fechaPago.startsWith(thisM) && X.esCuotaRegular(p)), p => p.cuotaTotal),
    recibido: suma(pays, p => suma(X.cobrosDe(p), e => (e.fecha.slice(0, 7) === thisM ? e.cop : 0))),
    mora, totalMora: suma(mora, p => X.pendCuota(p)),
    totalInteresesRecibidos: suma(pays, p => X.gananciaDe(p, usd[p.prestamoId]).total),
    hoy: pays.filter(p => p.estadoPago === 'Pendiente' && p.fechaPago === td),
    proximos: pays.filter(p => p.estadoPago === 'Pendiente' && p.fechaPago > td && p.fechaPago <= nxtW),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
(async () => {
  const dbPath = copiaDeProduccion('resumen');
  const S = await arrancar(dbPath);
  let loans, pays, debts;
  try {
    // GET /api/payments corre la auto-mora a la fecha congelada: es el estado que ve la app.
    loans = await traer(S, '/api/loans');
    pays  = await traer(S, '/api/payments');
    debts = await traer(S, '/api/debts');
  } finally { await cerrar(S); }

  const { cargarFrontend } = require('./lib/load-frontend');
  const FE = cargarFrontend({ silenciarConsola: true });
  const X = FE.sandbox;
  X.Date = Date;                         // el reloj congelado de esta suite (31-jul-2026)

  R.seccion('0 — el arnes ve el dia congelado y los simbolos de la vista');
  R.eq('0 nowStr() dentro del frontend = 31-jul-2026', X.nowStr(), HOY);
  R.check('0 la vista expone modeloResumen, rzMetaDelMes, rzAgendaDias y DashView',
    ['modeloResumen', 'rzMetaDelMes', 'rzAgendaDias', 'DashView'].every(k => typeof X[k] === 'function'));
  R.check('0 el fixture trae prestamos, cuotas y deudas propias', loans.length > 0 && pays.length > 0 && debts.length > 0,
    { loans: loans.length, pays: pays.length, debts: debts.length });

  const M = X.modeloResumen(loans, pays, HOY);
  const met = metricsComoApp(X, loans, pays);
  const activos = loans.filter(l => l.estado === 'Activo');
  const loanMap = {}; loans.forEach(l => { loanMap[l.id] = l; });

  // ── A — EL MODELO ─────────────────────────────────────────────────────────
  R.seccion('A — modeloResumen contra los helpers del dominio');
  const origCOP = l => (l.moneda === 'USD' ? Math.round(l.montoOrigen * l.trmAcordada) : Math.round(l.montoOrigen));
  const vivoDe = l => Math.max(0, origCOP(l) - Math.round(suma(pays.filter(p => p.prestamoId === l.id), p => X.imputarCobros(p).totales.capital)));
  R.eq('A1 capital en la calle = suma por prestamo activo de (original - capital imputado)', M.vivo, suma(activos, vivoDe));
  R.eq('A1 cifra del fixture: 36.153.366', M.vivo, 36153366);
  R.eq('A2 prestado = suma del capital original de los activos (41.586.369)', M.prestado, suma(activos, origCOP));
  R.eq('A2 cifra del fixture: 41.586.369', M.prestado, 41586369);
  R.eq('A3 una fila por prestamo activo', M.por.length, activos.length);

  const moraActiva = pays.filter(p => X.esCuotaRegular(p) && p.estadoPago === 'En Mora' && loanMap[p.prestamoId] && loanMap[p.prestamoId].estado === 'Activo');
  R.eq('A4 mora agrupada = suma de lo que falta de cada cuota En Mora (pendCuota)',
    suma(M.moraGrupos, g => g.total), suma(moraActiva, p => X.pendCuota(p)));
  R.eq('A4 y coincide con el total de mora de App (3.012.407)', suma(M.moraGrupos, g => g.total), met.totalMora);
  R.eq('A4 cifra del fixture: 3.012.407 en 7 cuotas de 3 deudores',
    [met.totalMora, suma(M.moraGrupos, g => g.n), M.deudoresMora], [3012407, 7, 3]);
  R.check('A4 los grupos van de la mora mas vieja a la mas nueva',
    M.moraGrupos.every((g, i) => i === 0 || M.moraGrupos[i - 1].vieja <= g.vieja));
  R.eq('A4 la mora mas antigua tiene 146 dias', M.diasMoraMax, 146);
  R.check('A5 todo prestamo con cuotas En Mora queda en estado "mora" (y ninguno sin ellas)',
    M.por.every(x => (x.moraN > 0) === (x.estado === 'mora')), M.por.map(x => [x.nombre, x.moraN, x.estado]));

  R.eq('A6 quince meses: 12 hacia atras, el actual y 3 adelante', M.meses.length, 15);
  R.check('A6 el mes actual es julio de 2026, en la posicion 12', M.meses[11].key === '2026-07' && M.meses[11].actual === true
    && M.meses.filter(m => m.actual).length === 1, M.meses.map(m => m.key));
  // Lo esperado por mes, recalculado sin pasar por la vista.
  const esp = {};
  const acc = k => (esp[k] = esp[k] || { caja: 0, interes: 0, ganancia: 0, proy: 0 });
  pays.forEach(p => {
    X.cobrosDe(p).forEach(e => { acc(mesDe(e.fecha)).caja += e.cop; });
    X.imputarCobros(p).eventos.forEach(e => { acc(mesDe(e.fecha)).interes += e.interes; });
    const l = loanMap[p.prestamoId];
    X.gananciaDe(p, !!(l && l.moneda === 'USD')).eventos.forEach(e => { acc(mesDe(e.fecha)).ganancia += e.ganancia; });
    if (X.esCuotaRegular(p) && p.estadoPago !== 'Pagado' && mesDe(p.fechaPago) >= '2026-07') acc(mesDe(p.fechaPago)).proy += X.pendCuota(p);
  });
  const malCaja = M.meses.filter(m => m.caja !== Math.round((esp[m.key] || {}).caja || 0)).map(m => m.key);
  const malInt  = M.meses.filter(m => m.interes !== Math.round((esp[m.key] || {}).interes || 0)).map(m => m.key);
  const malGan  = M.meses.filter(m => m.ganancia !== Math.round((esp[m.key] || {}).ganancia || 0)).map(m => m.key);
  const malProy = M.meses.filter(m => m.proy !== (m.key >= '2026-07' ? Math.round((esp[m.key] || {}).proy || 0) : 0)).map(m => m.key);
  R.check('A7 caja de cada mes = suma de los eventos de cobrosDe de ese mes', malCaja.length === 0, malCaja);
  R.check('A7 interes de cada mes = suma de lo imputado a interes (imputarCobros)', malInt.length === 0, malInt);
  R.check('A7 ganancia de cada mes = suma de gananciaDe', malGan.length === 0, malGan);
  R.check('A7 lo proyectado = lo que falta de las cuotas no pagadas de ese mes (solo desde el actual)', malProy.length === 0, malProy);
  R.check('A7 intereses + capital = caja en cada mes con cobros',
    M.meses.every(m => m.caja === 0 || m.interes + m.capital === m.caja), M.meses.map(m => [m.key, m.caja, m.interes, m.capital]));
  R.check('A7 el anti-vacio: hay caja en al menos 6 de los 12 meses de historia', M.meses.slice(0, 12).filter(m => m.caja > 0).length >= 6);

  R.eq('A8 la curva del mes tiene un punto por dia corrido (31)', M.curva.length, 31);
  R.check('A8 la curva nunca baja', M.curva.every((v, i) => i === 0 || v >= M.curva[i - 1]));
  R.eq('A8 la curva termina en "Cobros del Mes" de App', M.curva[M.curva.length - 1], met.recibido);
  R.eq('A8 y en la caja del mes del grafico', M.curva[M.curva.length - 1], M.meses[11].caja);
  R.eq('A8 cifra del fixture: 8.411.353 cobrados en julio', met.recibido, 8411353);
  R.eq('A9 movimientos del mes = eventos de caja de julio (14)', M.movMes,
    suma(pays, p => X.cobrosDe(p).filter(e => mesDe(e.fecha) === '2026-07').length));
  R.eq('A9 cifra del fixture: 14 movimientos', M.movMes, 14);
  R.eq('A10 ganancia de julio (2.481.524)', M.gananciaMes, 2481524);
  R.eq('A10 ganancia de los ultimos 12 meses = suma de las barras (11.235.701)', M.ganancia12, 11235701);
  R.eq('A10 ganancia historica de App (12.390.701)', met.totalInteresesRecibidos, 12390701);
  R.check('A11 los movimientos recientes van del mas nuevo al mas viejo',
    M.recientes.every((e, i) => i === 0 || M.recientes[i - 1].fecha >= e.fecha));

  // ── B — LA META DEL MES ───────────────────────────────────────────────────
  R.seccion('B — rzMetaDelMes: solo cuotas del cronograma (sin cortes)');
  const meta = X.rzMetaDelMes(pays, '2026-07');
  R.eq('B1 meta de julio = 5.953.891', meta.esperado, 5953891);
  R.eq('B1 y coincide con el "esperado" de App, que ya excluia los cortes', meta.esperado, met.esperado);
  R.eq('B2 cobrado del mes 3.274.095 y mora recuperada 4.147.258', [meta.cobrado, meta.moraRec], [3274095, 4147258]);
  R.eq('B2 falta por cobrar 2.452.407 = lo que falta de cada cuota pendiente', [meta.falta, suma(meta.pend, p => X.pendCuota(p))], [2452407, 2452407]);
  R.check('B2 las pendientes son de julio, no estan pagadas y son cuotas del cronograma',
    meta.pend.every(p => mesDe(p.fechaPago) === '2026-07' && p.estadoPago !== 'Pagado' && X.esCuotaRegular(p)));
  R.eq('B3 el anillo marca 125%', Math.round((meta.cobrado + meta.moraRec) / meta.esperado * 100), 125);
  // Anti-vacio: la exclusion solo prueba algo si julio TIENE cortes. Y la formula vieja (todo lo
  // que no es abono) es la que daba 123%: se recalcula aqui para ver que la diferencia es esa.
  const cortesJul = pays.filter(p => X.esCorte(p) && mesDe(p.fechaPago) === '2026-07');
  R.check('B4 anti-vacio: el fixture tiene cortes de interes diario en julio', cortesJul.length > 0, cortesJul.length);
  R.eq('B4 esos cortes suman 430.000', suma(cortesJul, p => p.cuotaTotal), 430000);
  const viejaEsp = suma(pays.filter(p => !X.esAbono(p) && mesDe(p.fechaPago) === '2026-07'), p => p.cuotaTotal);
  const viejaRec = suma(pays.filter(p => !X.esAbono(p) && p.estadoPago === 'Pagado' && p.fechaRecaudo && mesDe(p.fechaRecaudo) === '2026-07'), p => p.montoCOPRecibido || p.cuotaTotal)
    + suma(pays.filter(p => !X.esAbono(p) && mesDe(p.fechaPago) === '2026-07' && p.estadoPago !== 'Pagado'), p => p.partialPaid || 0);
  R.eq('B4 la formula vieja (Recaudo hasta 3.3.0) sumaba los cortes a la meta: 6.383.891', viejaEsp, meta.esperado + 430000);
  R.eq('B4 y daba 123%: el porcentaje nuevo es el que cuadra con Cobros del Mes', Math.round(viejaRec / viejaEsp * 100), 123);
  R.check('B4 ningun corte entra en la meta ni en la lista de pendientes',
    meta.pend.every(p => !X.esCorte(p)) && meta.esperado === suma(pays.filter(p => X.esCuotaRegular(p) && mesDe(p.fechaPago) === '2026-07'), p => p.cuotaTotal));
  const sinCuotas = X.rzMetaDelMes(pays, '2031-01');
  R.eq('B5 un mes sin vencimientos da meta 0 y nada pendiente', [sinCuotas.esperado, sinCuotas.cobrado, sinCuotas.pend.length], [0, 0, 0]);

  // ── C — LA AGENDA ─────────────────────────────────────────────────────────
  R.seccion('C — rzAgendaDias: lo que entra en los proximos dias');
  const ag = {}; [7, 14, 30].forEach(n => { ag[n] = X.rzAgendaDias(pays, M.loanMap, HOY, n); });
  [7, 14, 30].forEach(n => {
    const desde = HOY, hasta = X.addDays(HOY, n - 1);
    const items = pays.filter(p => X.esCuotaRegular(p) && p.estadoPago === 'Pendiente' && p.fechaPago >= desde && p.fechaPago <= hasta
      && loanMap[p.prestamoId] && loanMap[p.prestamoId].estado === 'Activo');
    R.eq('C1 ' + n + ' dias: total = lo que falta de las cuotas Pendientes de activos en el rango',
      [ag[n].total, ag[n].n], [suma(items, p => X.pendCuota(p)), items.length]);
    R.check('C1 ' + n + ' dias: una columna por dia, consecutivas desde hoy, y cada una suma sus cuotas',
      ag[n].dias.length === n && ag[n].dias.every((d, i) => d.iso === X.addDays(HOY, i) && d.total === suma(d.items, p => X.pendCuota(p))));
  });
  R.eq('C2 cifra del fixture: 14 dias = 1.754.250 en 4 cuotas', [ag[14].total, ag[14].n], [1754250, 4]);
  R.check('C2 7 <= 14 <= 30 dias', ag[7].total <= ag[14].total && ag[14].total <= ag[30].total && ag[30].n > ag[7].n,
    [ag[7].total, ag[14].total, ag[30].total]);
  R.check('C3 la agenda no lleva mora, pagadas, abonos ni cortes',
    ag[30].dias.every(d => d.items.every(p => p.estadoPago === 'Pendiente' && X.esCuotaRegular(p))));
  // pendCuota y no cuotaTotal: una cuota con abono parcial muestra lo que FALTA. Anti-vacio
  // construido: el fixture a esta fecha no tiene un parcial dentro del rango.
  const conParcial = pays.map(p => Object.assign({}, p));
  const objetivo = conParcial.find(p => p.id === ag[14].dias.find(d => d.items.length).items[0].id);
  objetivo.partialPaid = 100000;
  const agP = X.rzAgendaDias(conParcial, M.loanMap, HOY, 14);
  R.eq('C4 un abono parcial de 100.000 baja la agenda en 100.000 (cuenta lo que falta, no la cuota)', agP.total, ag[14].total - 100000);
  // El mismo parcial en el modelo: la barra "por cobrar" de ese mes tambien cuenta lo que falta.
  const mesObj = mesDe(objetivo.fechaPago);
  const proyDe = (MM, k) => MM.meses.filter(m => m.key === k)[0].proy;
  R.eq('C4 y baja en 100.000 lo "por cobrar" de su mes en el flujo de caja',
    proyDe(X.modeloResumen(loans, conParcial, HOY), mesObj), proyDe(M, mesObj) - 100000);
  // Una cuota futura marcada En Mora a mano (PayModal lo permite) va a la columna "Vencido", no
  // a su dia en la agenda. Construido: el fixture no tiene ninguna a esta fecha.
  const conMoraFutura = pays.map(p => Object.assign({}, p));
  const futura = conMoraFutura.find(p => p.id === objetivo.id);   // sin el parcial de C4
  futura.estadoPago = 'En Mora';
  const agM = X.rzAgendaDias(conMoraFutura, M.loanMap, HOY, 14);
  R.eq('C5 una cuota futura marcada En Mora sale de su dia en la agenda', [agM.total, agM.n], [ag[14].total - X.pendCuota(futura), ag[14].n - 1]);
  R.eq('C5 y entra en la columna "Vencido"', suma(X.modeloResumen(loans, conMoraFutura, HOY).moraGrupos, g => g.total),
    suma(M.moraGrupos, g => g.total) + X.pendCuota(futura));
  // Un parcial sobre una cuota En Mora: la columna "Vencido" muestra lo que falta. Construido:
  // en el fixture ninguna cuota en mora trae un parcial a esta fecha.
  const conParcialMora = pays.map(p => Object.assign({}, p));
  const enMora = conParcialMora.find(p => p.id === moraActiva[0].id);
  enMora.partialPaid = 50000;
  R.eq('C6 un parcial de 50.000 sobre una cuota En Mora baja el vencido en 50.000',
    suma(X.modeloResumen(loans, conParcialMora, HOY).moraGrupos, g => g.total), suma(M.moraGrupos, g => g.total) - 50000);

  // ── D — LA VISTA REAL ─────────────────────────────────────────────────────
  R.seccion('D — DashView renderizado con los datos del fixture');
  const props = { metrics: met, isEmpty: false, loans, pays, debts, onNav: () => {}, onNameClick: () => {}, onNewLoan: () => {} };
  const render = ancho => {
    X.window.innerWidth = ancho;
    try { return pintar({ type: X.DashView, props, children: [] }); }
    finally { X.window.innerWidth = 1280; }
  };
  let arbol = null, error = null;
  try { arbol = render(1280); } catch (e) { error = e; }
  R.check('D1 la vista se pinta sin excepciones', !error, error && (error.stack || String(error)));
  if (arbol) {
    const t = textos(arbol), todo = t.join(' ');
    const tiene = s => todo.indexOf(s) !== -1;
    const cls = clases(arbol).join(' ').split(/\s+/);
    R.check('D2 las ocho piezas estan: encabezado, cifras, agenda, meta, radar, flujo, composicion y movimientos',
      ['rz-hero', 'rz-kpis', 'rz-agenda', 'rz-meta', 'rz-radar', 'rz-flujo', 'rz-comp', 'rz-mov'].every(c => cls.indexOf(c) !== -1),
      ['rz-hero', 'rz-kpis', 'rz-agenda', 'rz-meta', 'rz-radar', 'rz-flujo', 'rz-comp', 'rz-mov'].filter(c => cls.indexOf(c) === -1));
    R.check('D3 el encabezado dice el dia: "viernes 31 de julio"', tiene('viernes 31 de julio'));
    R.check('D4 "Capital en la calle" muestra ' + X.fmt(M.vivo), tiene('Capital en la calle') && t.indexOf(X.fmt(M.vivo)) !== -1);
    R.check('D4 "Cobrado en julio" muestra "Cobros del Mes" de App', tiene('Cobrado en julio') && t.indexOf(X.fmt(met.recibido)) !== -1);
    R.check('D4 "En mora" muestra el total vencido', t.indexOf(X.fmt(met.totalMora)) !== -1);
    const debo = suma(debts.filter(d => d.estado === 'Activa'), d => +d.saldo_pendiente || 0);
    R.eq('D5 posicion neta = capital en la calle - lo que se debe (18.828.586)', M.vivo - debo, 18828586);
    R.check('D5 "Posición neta" muestra esa cifra', tiene('Posición neta') && t.indexOf(X.fmt(M.vivo - debo)) !== -1);
    R.check('D5 y cuenta las deudas propias activas', tiene(debts.filter(d => d.estado === 'Activa').length + ' deudas propias activas'));
    R.check('D6 el anillo de la meta marca 125%', t.indexOf('125%') !== -1);
    R.check('D6 la meta muestra sus cuatro cifras', [meta.esperado, meta.cobrado, meta.moraRec, meta.falta].every(v => t.indexOf(X.fmt(v)) !== -1));
    // Hotfix 3.4.1: la lista de pendientes NO lleva un tope de alto en linea. La tarjeta se estira a
    // la altura del Radar y un `maxHeight` fijo dejaba la lista cortada a media fila con la tarjeta
    // vacia por debajo. El alto lo gobierna styles.css (`.rz-meta-lista`, ver E4).
    const listas = [];
    const buscar = n => { if (Array.isArray(n)) return n.forEach(buscar); if (!n || !n.kids) return;
      if (n.props && /\brz-meta-lista\b/.test(n.props.className || '')) listas.push(n); n.kids.forEach(buscar); };
    buscar(arbol);
    R.check('D6b la lista de la meta lleva su clase y ningun tope de alto en linea',
      listas.length === 1 && !(listas[0].props.style && listas[0].props.style.maxHeight != null),
      listas.map(l => ({ className: l.props.className, style: l.props.style })));
    R.check('D6b con mas de 4 cuotas pendientes es "larga" (parte de 0 con minimo 250 px)',
      listas.length === 1 && (meta.pend.length > 4) === /\blarga\b/.test(listas[0].props.className) && meta.pend.length > 4,
      { pendientes: meta.pend.length, className: listas[0] && listas[0].props.className });
    // El Radar, igual (su tope en linea de 460 px dejaba 35 px vacios a 1.366 px).
    const radares = [];
    const buscarR = n => { if (Array.isArray(n)) return n.forEach(buscarR); if (!n || !n.kids) return;
      if (n.props && /\brz-radar-lista\b/.test(n.props.className || '')) radares.push(n); n.kids.forEach(buscarR); };
    buscarR(arbol);
    R.check('D6c la tabla del Radar lleva su clase y ningun tope de alto en linea',
      radares.length === 1 && !(radares[0].props.style && radares[0].props.style.maxHeight != null),
      radares.map(l => ({ className: l.props.className, style: l.props.style })));
    R.check('D6c con mas de 6 prestamos activos es "larga" (parte de 0 con minimo 460 px)',
      radares.length === 1 && activos.length > 6 && /\blarga\b/.test(radares[0].props.className),
      { activos: activos.length, className: radares[0] && radares[0].props.className });
    // A 1.280 px la agenda arranca con una semana (14 dias desde 1.500 px).
    R.check('D7 a 1.280 px la agenda cubre 7 dias con su total', tiene('durante los próximos 7 días') && t.indexOf(X.fmt(ag[7].total) + ' por entrar en ' + ag[7].n + ' cuota' + (ag[7].n > 1 ? 's' : '') + ' durante los próximos 7 días') !== -1,
      t.filter(s => /por entrar/.test(s)));
    R.check('D8 el radar lista cada prestamo activo', activos.every(l => t.indexOf(X.properCase(l.nombre)) !== -1));
    // Ortografia: aprobada con tildes en toda la pestaña. Ningun rotulo vuelve a salir sin ellas.
    const conTilde = ['Posición neta', 'Últimos movimientos', 'Dónde está tu capital', 'Préstamo', 'próximos', 'días'];
    R.check('D9 ortografia completa: ' + conTilde.join(' · '),
      conTilde.every(s => todo.toLowerCase().indexOf(s.toLowerCase()) !== -1), conTilde.filter(s => todo.toLowerCase().indexOf(s.toLowerCase()) === -1));
    const sinTilde = t.filter(s => /\b(dias|posicion|ultimos|donde esta|proximos|prestamos?|creditos?|interes|historico|unico|dolares)\b/i.test(s));
    R.check('D9 ningun texto de la vista sale sin tilde', sinTilde.length === 0, sinTilde);
  }
  let ancho = null;
  try { ancho = render(1600); } catch (e) { error = e; }
  R.check('D10 a 1.600 px la agenda arranca en 14 dias', !!ancho && textos(ancho).join(' ').indexOf('durante los próximos 14 días') !== -1);
  let movil = null;
  try { movil = render(375); } catch (e) { error = e; }
  R.check('D11 en telefono (375 px) se pinta sin excepciones', !!movil, error && String(error));
  if (movil) {
    const cm = clases(movil).join(' ').split(/\s+/);
    R.check('D11 la agenda pasa a lista: sin rejilla de dias y con el vencido arriba',
      cm.indexOf('rz-agenda-grid') === -1 && textos(movil).join(' ').indexOf('Vencido · ' + X.fmt(suma(M.moraGrupos, g => g.total))) !== -1);
  }
  // Las otras dos pestañas de la composicion: se siembra su estado (`useState('deudor')`).
  const conPestana = tab => {
    const orig = X.useState;
    X.useState = init => (init === 'deudor' ? [tab, () => {}] : orig(init));
    try { return pintar({ type: X.RzComposicion, props: { M, onNameClick: () => {} }, children: [] }); }
    finally { X.useState = orig; }
  };
  const vivoPor = f => { const g = {}; M.por.filter(x => x.vivo > 0).forEach(x => { g[f(x)] = (g[f(x)] || 0) + x.vivo; }); return g; };
  const porMod = vivoPor(x => x.loan.modalidad);
  const tMod = textos(conPestana('modalidad')).join(' ');
  const ROT = { 'Prestamo': 'Préstamo', 'Pago Unico': 'Pago único', 'Interes Diario': 'Interés diario' };
  R.check('D13 composicion por modalidad: cada modalidad con capital, rotulada con tildes',
    Object.keys(porMod).every(m => tMod.indexOf(ROT[m] || m) !== -1) && !/\b(Pago Unico|Interes Diario|Prestamo)\b/.test(tMod),
    { modalidades: Object.keys(porMod), texto: tMod });
  R.check('D13 anti-vacio: el fixture tiene capital vivo en una modalidad que lleva tilde',
    Object.keys(porMod).some(m => ROT[m]), Object.keys(porMod));
  const porMon = vivoPor(x => x.loan.moneda);
  const tMon = textos(conPestana('moneda')).join('');
  R.check('D14 composicion por moneda: la parte en dolares con su porcentaje',
    tMon.indexOf('Dólares (USD)') !== -1 && tMon.indexOf(Math.round((porMon.USD || 0) / M.vivo * 100) + '% del capital en la calle está en dólares') !== -1, tMon);
  // El grafico de flujo mide su contenedor. Con el menu abierto en un telefono llego a medir 94 px
  // (menos que los margenes del eje) y dibujaba un <rect> de ancho negativo: error en consola.
  const rectsInvalidos = ancho => {
    const orig = X.useState;
    X.useState = init => (init === 760 ? [ancho, () => {}] : orig(init));
    try {
      const out = [];
      const ver = n => { if (Array.isArray(n)) return n.forEach(ver); if (!n || !n.kids) return;
        if (n.tag === 'rect' && (+n.props.width < 0 || +n.props.height < 0 || !isFinite(+n.props.width))) out.push(n.props);
        n.kids.forEach(ver); };
      ver(pintar({ type: X.RzFlujo, props: { M }, children: [] }));
      return out;
    } finally { X.useState = orig; }
  };
  R.check('D15 flujo de caja sin rectangulos de ancho negativo en 94, 40 y 0 px', [94, 40, 0].every(a => rectsInvalidos(a).length === 0),
    [94, 40, 0].map(a => rectsInvalidos(a).length));
  R.check('D15 anti-vacio: a 760 px el grafico SI dibuja barras', (() => {
    const orig = X.useState; X.useState = init => (init === 760 ? [760, () => {}] : orig(init));
    try { const a = pintar({ type: X.RzFlujo, props: { M }, children: [] }); const r = []; const v = n => { if (Array.isArray(n)) return n.forEach(v); if (!n || !n.kids) return; if (n.tag === 'rect') r.push(n); n.kids.forEach(v); }; v(a); return r.length > 20; }
    finally { X.useState = orig; } })());
  let vacio = null;
  try { vacio = pintar({ type: X.DashView, props: Object.assign({}, props, { isEmpty: true, loans: [], pays: [] }), children: [] }); } catch (e) { error = e; }
  R.check('D12 sin prestamos: estado vacio con su llamado a crear el primero',
    !!vacio && textos(vacio).join(' ').indexOf('Tu cartera empieza aquí') !== -1, error && String(error));

  // ── E — GUARDAS ESTATICAS ─────────────────────────────────────────────────
  R.seccion('E — el Inicio viejo no deja restos');
  const leerRepo = p => fs.readFileSync(path.join(REPO, p), 'utf8');
  const css = leerRepo('public/css/styles.css');
  const app = leerRepo('public/js/app.js');
  R.check('E1 SparklineChart ya no existe (solo lo usaba el Inicio viejo)', !fs.existsSync(path.join(REPO, 'public/js/componentes/SparklineChart.js')));
  R.check('E2 styles.css sin las clases .dash-* y con las .rz-*', !/\.dash-(card|lists|container|list-body)/.test(css) && /\.rz-card\b/.test(css) && /\.rz-agenda\b/.test(css));
  R.check('E3 App le pasa las deudas propias al Resumen (alimentan la posicion neta)', /h\(DashView,\s*\{[^}]*debts:debts/.test(app));
  // El layout no se puede medir en el arnes (no hay motor de CSS): se fijan las reglas que lo
  // sostienen. Medido en la app real: a 1.600 px la lista paso de 249 a 326 px y el hueco bajo ella
  // de 78 a 1 px, sin cambiar el alto de la fila.
  const reglas = css.replace(/\/\*[\s\S]*?\*\//g, '');
  R.check('E4 Meta del mes: el cuerpo es una columna flexible y la lista crece hasta el borde',
    /\.rz-meta > \.rz-body(,[^{]*)?\{[^}]*flex:1 1 auto[^}]*display:flex[^}]*flex-direction:column/.test(reglas) &&
    /\.rz-meta \.rz-meta-lista\{[^}]*flex:1 1 auto[^}]*max-height:none/.test(reglas));
  R.check('E4 con lista larga parte de 0 con el minimo de antes (250 px) y sola en su fila vuelve a un tope',
    /\.rz-meta \.rz-meta-lista\.larga\{[^}]*flex-basis:0[^}]*min-height:250px/.test(reglas) &&
    /@media \(max-width:1180px\)\{\s*\.rz-meta \.rz-meta-lista,\.rz-meta \.rz-meta-lista\.larga\{[^}]*max-height:360px/.test(reglas));
  R.check('E5 Radar: cuerpo flexible y tabla que crece hasta el borde (medido a 1.366 px: 460 -> 494 px, hueco 35 -> 1 px)',
    /[,{}\s]\.rz-radar > \.rz-body[,{][^}]*flex:1 1 auto[^}]*display:flex[^}]*flex-direction:column/.test(reglas) &&
    /\.rz-radar \.rz-radar-lista\{[^}]*flex:1 1 auto[^}]*max-height:none/.test(reglas));
  R.check('E5 Radar largo parte de 0 con el minimo de antes (460 px) y solo en su fila conserva ese tope',
    /\.rz-radar \.rz-radar-lista\.larga\{[^}]*flex-basis:0[^}]*min-height:460px/.test(reglas) &&
    /@media \(max-width:1180px\)\{[^@]*\.rz-radar \.rz-radar-lista,\.rz-radar \.rz-radar-lista\.larga\{[^}]*max-height:460px/.test(reglas));

  process.exit(R.finalizar());
})().catch(e => { console.error(e); process.exit(1); });
