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
//   C. POR COBRAR (`rzParaCobrar`, 3.7.1): lo vencido y lo de hoy, una fila por persona, recalculado
//      APARTE sin `bandejaCobro`; y lo que entra esta semana.
//   D. LA VISTA REAL (`DashView`) renderizada con el arnes: sin excepciones, con las piezas del Resumen
//      hibrido que aprobo el PO (3.7.1), las cifras de A-C en pantalla y la ortografia completa.
//   E. GUARDAS ESTATICAS: el Inicio viejo y las piezas de 3.4.0 que salieron no dejan restos.
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
const nodosDe = (n, pred, out) => {
  out = out || [];
  if (Array.isArray(n)) { n.forEach(x => nodosDe(x, pred, out)); return out; }
  if (n && n.kids) { if (pred(n)) out.push(n); n.kids.forEach(x => nodosDe(x, pred, out)); }
  return out;
};
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
  R.check('0 la vista expone modeloResumen, rzMetaDelMes, rzParaCobrar, RzPorCobrar y DashView',
    ['modeloResumen', 'rzMetaDelMes', 'rzParaCobrar', 'RzPorCobrar', 'DashView'].every(k => typeof X[k] === 'function'));
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

  // ── C — POR COBRAR ────────────────────────────────────────────────────────
  R.seccion('C — rzParaCobrar: lo vencido y lo de hoy, una fila por persona (3.7.1)');
  const bandeja = X.bandejaCobro(loans, pays, HOY);
  const ya = X.rzParaCobrar(bandeja, HOY);
  // Recalculado APARTE, sin bandejaCobro: cuotas del cronograma sin pagar de prestamos activos que estan
  // En Mora, vencieron antes de hoy o vencen hoy; lo que falta de cada una (pendCuota), por persona.
  const debeYaDe = ps => ps.filter(p => X.esCuotaRegular(p) && p.estadoPago !== 'Pagado' && loanMap[p.prestamoId]
    && loanMap[p.prestamoId].estado === 'Activo' && (p.estadoPago === 'En Mora' || p.fechaPago <= HOY));
  const porPersona = ps => { const g = {}; debeYaDe(ps).forEach(p => { const n = loanMap[p.prestamoId].nombre; g[n] = (g[n] || 0) + X.pendCuota(p); }); return g; };
  const esperadoYa = porPersona(pays);
  R.eq('C1 una fila por persona con algo vencido o que vence hoy', ya.map(g => g.nombre).sort(), Object.keys(esperadoYa).sort());
  R.check('C1 cada persona suma lo que falta de sus cuotas (pendCuota, no la cuota entera)',
    ya.every(g => g.total === esperadoYa[g.nombre]), ya.map(g => [g.nombre, g.total, esperadoYa[g.nombre]]));
  const totYa = suma(ya, g => g.total);
  R.eq('C2 el total = la mora de App + lo que vence hoy', totYa, met.totalMora + suma(met.hoy, p => X.pendCuota(p)));
  R.eq('C2 cifra del fixture: 3.652.407 entre 5 personas (3.012.407 vencidos + 640.000 de hoy)',
    [totYa, ya.length, suma(met.hoy, p => X.pendCuota(p))], [3652407, 5, 640000]);
  R.check('C3 primero la mora mas vieja; a igual antiguedad, el mayor monto',
    ya.every((g, i) => i === 0 || ya[i - 1].dias > g.dias || (ya[i - 1].dias === g.dias && ya[i - 1].total >= g.total)), ya.map(g => [g.nombre, g.dias, g.total]));
  const viejaDe = n => debeYaDe(pays).filter(p => loanMap[p.prestamoId].nombre === n && (p.estadoPago === 'En Mora' || p.fechaPago < HOY))
    .map(p => p.fechaPago).sort()[0];
  R.check('C3 los dias son los de la cuota vencida mas vieja de cada persona (0 si solo vence hoy)',
    ya.every(g => g.dias === (viejaDe(g.nombre) ? X.diasEntre(viejaDe(g.nombre), HOY) : 0)), ya.map(g => [g.nombre, g.dias]));
  R.check('C3 anti-vacio: en el fixture hay personas con mora y personas que solo vencen hoy',
    ya.some(g => g.venc > 0) && ya.some(g => g.venc === 0 && g.hoyN > 0), ya.map(g => [g.nombre, g.venc, g.hoyN]));
  // En dolares: la cifra en dolares solo si TODO lo de esa persona es en dolares.
  const usdEsp = n => { const fs = bandeja.filter(f => f.l.nombre === n && (f.tramo === 'vencido' || f.tramo === 'hoy'));
    return { todo: fs.every(f => f.l.moneda === 'USD'), usd: suma(fs.filter(f => f.l.moneda === 'USD'), f => f.pend / f.l.trmAcordada) }; };
  R.check('C4 la parte en dolares de cada persona = lo que falta / la TRM pactada, y "todo en dolares" solo si lo es',
    ya.every(g => { const e = usdEsp(g.nombre); return g.todoUSD === e.todo && Math.abs(g.usd - e.usd) < 1e-6; }), ya.map(g => [g.nombre, g.todoUSD, g.usd]));
  R.check('C4 anti-vacio: el fixture tiene una persona con todo en dolares', ya.some(g => g.todoUSD && g.usd > 0));
  // Un parcial sobre una cuota En Mora: la fila muestra lo que falta. Construido: en el fixture ninguna
  // cuota en mora trae un parcial a esta fecha.
  const conParcialMora = pays.map(p => Object.assign({}, p));
  const enMora = conParcialMora.find(p => p.id === moraActiva[0].id);
  enMora.partialPaid = 50000;
  const yaP = X.rzParaCobrar(X.bandejaCobro(loans, conParcialMora, HOY), HOY);
  const dueno = loanMap[enMora.prestamoId].nombre;
  R.eq('C5 un parcial de 50.000 sobre una cuota En Mora baja en 50.000 la fila de su deudor',
    yaP.filter(g => g.nombre === dueno)[0].total, ya.filter(g => g.nombre === dueno)[0].total - 50000);
  // "Esta semana": las cuotas que vencen despues de hoy y hasta dentro de 7 dias.
  const semana = bandeja.filter(f => f.tramo === 'semana');
  const semEsp = pays.filter(p => X.esCuotaRegular(p) && p.estadoPago === 'Pendiente' && p.fechaPago > HOY && p.fechaPago <= X.addDays(HOY, 7)
    && loanMap[p.prestamoId] && loanMap[p.prestamoId].estado === 'Activo');
  R.eq('C6 "Esta semana" = las cuotas Pendientes de activos entre mañana y dentro de 7 dias',
    semana.map(f => f.p.id).sort(), semEsp.map(p => p.id).sort());
  R.eq('C6 y su total es el de "los próximos 7 días" del encabezado (1.114.250)',
    [suma(semana, f => f.pend), suma(met.proximos, p => X.pendCuota(p))], [1114250, 1114250]);
  // Una cuota de esta semana marcada En Mora a mano (PayModal lo permite) sale de la semana y entra en
  // "Para cobrar ya". Construido: el fixture no tiene ninguna.
  const conMoraFutura = pays.map(p => Object.assign({}, p));
  const futura = conMoraFutura.find(p => p.id === semana[0].p.id);
  futura.estadoPago = 'En Mora';
  const bandejaM = X.bandejaCobro(loans, conMoraFutura, HOY);
  R.eq('C7 una cuota de la semana marcada En Mora sale de "Esta semana"',
    bandejaM.filter(f => f.tramo === 'semana').length, semana.length - 1);
  R.eq('C7 y entra en "Para cobrar ya"', suma(X.rzParaCobrar(bandejaM, HOY), g => g.total), totYa + X.pendCuota(futura));

  // ── D — LA VISTA REAL ─────────────────────────────────────────────────────
  R.seccion('D — DashView renderizado con los datos del fixture');
  const props = { metrics: met, isEmpty: false, loans, pays, onNav: () => {}, onNameClick: () => {}, onNewLoan: () => {} };
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
    R.check('D2 las piezas del Resumen hibrido: encabezado, tres cifras, por cobrar, meta y movimientos',
      ['rz-hero', 'rz-puntos', 'rz-cifras', 'rz-cobrar', 'rz-meta', 'rz-mov'].every(c => cls.indexOf(c) !== -1),
      ['rz-hero', 'rz-puntos', 'rz-cifras', 'rz-cobrar', 'rz-meta', 'rz-mov'].filter(c => cls.indexOf(c) === -1));
    R.check('D2 salieron la agenda, el radar y los KPI de 3.4.0 (el modelo los reemplaza)',
      ['rz-kpis', 'rz-kpi', 'rz-agenda', 'rz-agenda-grid', 'rz-radar', 'rz-insight'].every(c => cls.indexOf(c) === -1) &&
      !tiene('Posición neta') && !tiene('Agenda de cobro') && !tiene('Radar de la cartera'));
    // 3.7.0 (decision del PO): el "Analisis del negocio" se mudo a Rendimiento; aqui queda el enlace.
    R.check('D2 el flujo de caja y la composicion ya no estan en el Resumen, y en su lugar va el enlace al analisis',
      cls.indexOf('rz-flujo') === -1 && cls.indexOf('rz-comp') === -1 && cls.indexOf('rz-analisis') !== -1 &&
      tiene('Análisis del negocio') && tiene('ahora en Rendimiento'));
    R.check('D3 el encabezado dice el dia: "viernes 31 de julio"', tiene('viernes 31 de julio'));
    // El dia en tres puntos: lo de hoy, la semana y lo vencido, con las cifras de App.
    const puntos = nodosDe(arbol, n => n.tag === 'li').map(li => textos(li).join(''));
    R.eq('D3 tres puntos: hoy, los próximos 7 días y lo vencido', puntos, [
      'Hoy vencen ' + met.hoy.length + ' cuotas por ' + X.fmt(suma(met.hoy, p => X.pendCuota(p))) + '.',
      'En los próximos 7 días entran ' + X.fmt(suma(met.proximos, p => X.pendCuota(p))) + '.',
      'Tienes ' + X.fmt(met.totalMora) + ' vencidos en ' + met.mora.length + ' cuotas de ' + M.deudoresMora + ' deudores.']);
    R.check('D4 "En la calle" muestra ' + X.fmt(M.vivo) + ' y cuanto de lo prestado ya volvio',
      tiene('En la calle') && t.indexOf(X.fmt(M.vivo)) !== -1 && tiene(Math.round((1 - M.vivo / M.prestado) * 100) + '% de lo prestado ya volvió'));
    R.check('D4 "Cobrado en julio" muestra "Cobros del Mes" de App', tiene('Cobrado en julio') && t.indexOf(X.fmt(met.recibido)) !== -1);
    R.check('D4 "Ganancia de julio" muestra la del mes y la de 12 meses',
      tiene('Ganancia de julio') && t.indexOf(X.fmt(M.gananciaMes)) !== -1 && tiene('Últimos 12 meses: ') && t.indexOf(X.fmt(M.ganancia12)) !== -1);
    // Por cobrar: las dos listas con sus totales, una fila por persona y una por cuota de la semana.
    const cobrar = nodosDe(arbol, n => /\brz-cobrar\b/.test((n.props && n.props.className) || ''))[0];
    const esSec = n => n.props && (n.props.className || '').split(' ')[0] === 'rz-pc-sec';
    const secs = nodosDe(cobrar, esSec);
    const filasSec = i => nodosDe(secs[i], n => n.tag === 'button' && n.props.className === 'rz-pc-fila');
    R.check('D5 "Por cobrar" trae "Para cobrar ya" con su total y una fila por persona',
      secs.length === 2 && textos(secs[0]).join(' ').indexOf('Para cobrar ya') !== -1 && textos(secs[0]).indexOf(X.fmt(totYa)) !== -1 &&
      filasSec(0).length === ya.length && filasSec(0).every((f, i) => textos(f).indexOf(X.properCase(ya[i].nombre)) !== -1),
      secs.map(x => textos(x)));
    R.check('D5 y "Esta semana" con su total y una fila por cuota',
      textos(secs[1]).join(' ').indexOf('Esta semana') !== -1 && textos(secs[1]).indexOf(X.fmt(suma(semana, f => f.pend))) !== -1 &&
      filasSec(1).length === Math.min(semana.length, 6));
    // Las cifras en dolares van en gris (opcion A del PO, 3.7.0): `dp-usd`, nunca un color en linea.
    const usdC = nodosDe(cobrar, n => n.props && /\bdp-usd\b/.test(n.props.className || ''));
    R.check('D5 los dolares de "Por cobrar" van en gris, sin color en linea', usdC.length > 0 &&
      usdC.every(n => !(n.props.style && n.props.style.color)), usdC.map(n => n.props));
    R.check('D6 el anillo de la meta marca 125%', t.indexOf('125%') !== -1);
    R.check('D6 la meta muestra sus cuatro cifras', [meta.esperado, meta.cobrado, meta.moraRec, meta.falta].every(v => t.indexOf(X.fmt(v)) !== -1));
    // Hotfix 3.4.1: la lista de pendientes NO lleva un tope de alto en linea. La tarjeta se estira a
    // la altura de su fila y un `maxHeight` fijo dejaba la lista cortada a media fila con la tarjeta
    // vacia por debajo. El alto lo gobierna styles.css (`.rz-meta-lista`, ver E4).
    const listas = nodosDe(arbol, n => n.props && /\brz-meta-lista\b/.test(n.props.className || ''));
    R.check('D6b la lista de la meta lleva su clase y ningun tope de alto en linea',
      listas.length === 1 && !(listas[0].props.style && listas[0].props.style.maxHeight != null),
      listas.map(l => ({ className: l.props.className, style: l.props.style })));
    R.check('D6b con mas de 4 cuotas pendientes es "larga" (parte de 0 con minimo 250 px)',
      listas.length === 1 && (meta.pend.length > 4) === /\blarga\b/.test(listas[0].props.className) && meta.pend.length > 4,
      { pendientes: meta.pend.length, className: listas[0] && listas[0].props.className });
    // Ortografia: aprobada con tildes en toda la pestaña. Ningun rotulo vuelve a salir sin ellas.
    const conTilde = ['Últimos movimientos', 'Análisis del negocio', 'Préstamo', 'próximos', 'días', 'ya volvió', 'Últimos 12 meses'];
    R.check('D9 ortografia completa: ' + conTilde.join(' · '),
      conTilde.every(s => todo.toLowerCase().indexOf(s.toLowerCase()) !== -1), conTilde.filter(s => todo.toLowerCase().indexOf(s.toLowerCase()) === -1));
    const sinTilde = t.filter(s => /\b(dias|posicion|ultimos|donde esta|proximos|prestamos?|creditos?|interes|historico|unico|dolares|volvio|abono una)\b/i.test(s));
    R.check('D9 ningun texto de la vista sale sin tilde', sinTilde.length === 0, sinTilde);
  }
  // A donde lleva cada cosa: los puntos del dia a Cobros en su tramo, las filas al deudor en Cartera.
  {
    const navs = [], abre = [];
    const a = pintar({ type: X.DashView, props: Object.assign({}, props,
      { onNav: (v, d) => navs.push([v, d]), onNameClick: (n, l, p) => abre.push([n, l, p]) }), children: [] });
    nodosDe(a, n => n.tag === 'li' && typeof n.props.onClick === 'function').forEach(li => li.props.onClick());
    R.eq('D3b cada punto del dia lleva a Cobros en su tramo', navs, [['cobros', 'hoy'], ['cobros', 'semana'], ['cobros', 'vencido']]);
    const filas = nodosDe(a, n => n.tag === 'button' && n.props.className === 'rz-pc-fila');
    abre.length = 0; filas[0].props.onClick();
    R.eq('D5b la primera fila de "Para cobrar ya" abre a esa persona en Cartera', abre, [[ya[0].nombre, ya[0].loanId, undefined]]);
    const fSem = filas[ya.length];
    abre.length = 0; fSem.props.onClick();
    R.eq('D5b una fila de "Esta semana" abre ese prestamo con la cuota marcada', abre, [[semana[0].l.nombre, semana[0].l.id, semana[0].p.id]]);
  }
  // "Para cobrar ya" trae a TODAS las personas en una lista que se desplaza (como la Meta y los
  // movimientos); "Esta semana" muestra hasta 6 cuotas y anuncia el resto. Construido: el fixture tiene
  // 5 personas con algo vencido y 2 cuotas en la semana.
  {
    const clon = (f, i, sufijo) => Object.assign({}, f, { l: Object.assign({}, f.l, { nombre: 'Zz ' + sufijo + i, id: 'zz-' + sufijo + i }),
      p: Object.assign({}, f.p, { id: 'zz-' + sufijo + i }) });
    const extraYa = [1, 2, 3].map(i => clon(bandeja.filter(x => x.tramo === 'vencido')[0], i, 'v'));
    const extraSem = [1, 2, 3, 4, 5, 6].map(i => clon(bandeja.filter(x => x.tramo === 'semana')[0], i, 's'));
    const navs = [];
    const card = pintar({ type: X.RzPorCobrar, props: { filas: bandeja.concat(extraYa, extraSem), hoy: HOY, onNav: (v, d) => navs.push([v, d]), onNameClick: () => {} }, children: [] });
    const [sec0, sec1] = nodosDe(card, n => n.props && (n.props.className || '').split(' ')[0] === 'rz-pc-sec');
    const lista = nodosDe(sec0, n => n.props && /\brz-pc-lista\b/.test(n.props.className || ''));
    R.check('D5c con 8 personas, "Para cobrar ya" las muestra a las 8 dentro de una lista que se desplaza, sin "y N más"',
      /\bdesplaza\b/.test(sec0.props.className) && lista.length === 1 && /\brz-scroll\b/.test(lista[0].props.className) &&
      nodosDe(lista[0], n => n.tag === 'button' && n.props.className === 'rz-pc-fila').length === 8 &&
      nodosDe(sec0, n => n.tag === 'button' && n.props.className === 'rz-pc-mas').length === 0, textos(sec0));
    R.check('D5c y la lista no lleva tope de alto en linea (lo gobierna styles.css, regla de 3.4.1)',
      lista.length === 1 && !(lista[0].props.style && lista[0].props.style.maxHeight != null));
    const mas = nodosDe(sec1, n => n.tag === 'button' && n.props.className === 'rz-pc-mas');
    R.check('D5c con 8 cuotas en la semana, "Esta semana" muestra 6 y dice "y 2 cuotas más"',
      nodosDe(sec1, n => n.tag === 'button' && n.props.className === 'rz-pc-fila').length === 6 && mas.length === 1 && textos(mas[0]).join('') === 'y 2 cuotas más →',
      textos(sec1));
    if (mas[0]) mas[0].props.onClick();
    R.eq('D5c y ese enlace abre Cobros en la semana', navs, [['cobros', 'semana']]);
    const vacia = pintar({ type: X.RzPorCobrar, props: { filas: [], hoy: HOY, onNav: () => {}, onNameClick: () => {} }, children: [] });
    R.check('D5d sin nada por cobrar, las dos listas lo dicen', textos(vacia).join(' ').indexOf('Nada vencido ni nada que venza hoy.') !== -1 &&
      textos(vacia).join(' ').indexOf('Nada vence en los próximos 7 días.') !== -1);
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

  // El enlace del Resumen lleva a Rendimiento.
  {
    const navs = [];
    const arbolNav = pintar({ type: X.DashView, props: Object.assign({}, props, { onNav: (v, d) => navs.push(v) }), children: [] });
    const enlaces = [];
    const buscarE = n => { if (Array.isArray(n)) return n.forEach(buscarE); if (!n || !n.kids) return;
      if (n.props && /\brz-analisis-h\b/.test(n.props.className || '')) enlaces.push(n); n.kids.forEach(buscarE); };
    buscarE(arbolNav);
    if (enlaces[0]) enlaces[0].props.onClick();
    R.check('D16 el enlace "Análisis del negocio" abre Rendimiento', enlaces.length === 1 && navs.join() === 'rendimiento', navs);
    // Ultimos movimientos comparte fila con Por cobrar y la Meta: su lista llena la tarjeta, sin tope en linea.
    const movs = [];
    const buscarM = n => { if (Array.isArray(n)) return n.forEach(buscarM); if (!n || !n.kids) return;
      if (n.props && /\brz-mov-lista\b/.test(n.props.className || '')) movs.push(n); n.kids.forEach(buscarM); };
    buscarM(arbolNav);
    R.check('D17 la lista de Últimos movimientos lleva su clase y ningun tope de alto en linea',
      movs.length === 1 && !(movs[0].props.style && movs[0].props.style.maxHeight != null), movs.map(m => m.props));
  }

  // ── R — RENDIMIENTO (3.7.0) ───────────────────────────────────────────────
  // Rediseno aprobado por el PO: cuatro cifras, la tabla de prestamos (filtros, orden, clic a Cartera) y
  // el analisis mudado del Resumen. Ninguna cifra nueva de dinero salvo el cociente de la rentabilidad.
  R.seccion('R — Rendimiento: cifras, tabla, rentabilidad y el analisis mudado (3.7.0)');
  const nodos = (n, pred, out) => {
    out = out || [];
    if (Array.isArray(n)) { n.forEach(x => nodos(x, pred, out)); return out; }
    if (n && n.kids) { if (pred(n)) out.push(n); n.kids.forEach(x => nodos(x, pred, out)); }
    return out;
  };
  const montarR = (comp, pr, estado) => {
    const orig = X.useState; let i = 0;
    X.useState = init => { const k = i++;
      const v = (estado && k < estado.length && estado[k] !== undefined) ? estado[k] : (typeof init === 'function' ? init() : init);
      return [v, () => {}]; };
    try { return pintar({ type: comp, props: pr, children: [] }); } finally { X.useState = orig; }
  };
  const clicks = [];
  const propsR = { loans, pays, onNav: () => {}, onNameClick: (n, id) => clicks.push([n, id]) };
  let rend = null; error = null;
  try { rend = montarR(X.PortfolioView, propsR, []); } catch (e) { error = e; }
  R.check('R1 la vista se pinta sin excepciones', !!rend, error && (error.stack || String(error)));
  if (rend) {
    const tR = textos(rend), todoR = tR.join(' ');
    const filasDe = arbol => nodos(arbol, n => n.tag === 'tr' && /\brd-fila\b/.test((n.props && n.props.className) || ''));
    // Las cifras: la ganancia es la de la tarjeta del Resumen (Bug #68: tarjeta == Rendimiento), el saldo
    // es el "Capital en la calle" del Resumen y el colocado es el capital original de los activos.
    const origCOP = l => (l.moneda === 'USD' ? Math.round(l.montoOrigen * l.trmAcordada) : Math.round(l.montoOrigen));
    R.check('R2 "Ganancia obtenida" = la ganancia historica de la app (' + X.fmt(met.totalInteresesRecibidos) + ')',
      tR.indexOf(X.fmt(met.totalInteresesRecibidos)) !== -1, X.fmt(met.totalInteresesRecibidos));
    R.check('R2 y debajo, los ultimos 12 meses del Resumen (' + X.fmt(M.ganancia12) + ')', tR.indexOf(X.fmt(M.ganancia12)) !== -1);
    R.check('R3 "Saldo en la calle" = el "Capital en la calle" del Resumen (' + X.fmt(M.vivo) + ')', tR.indexOf(X.fmt(M.vivo)) !== -1);
    R.check('R3 "Capital colocado" = el capital original de los prestamos activos',
      tR.indexOf(X.fmt(suma(activos, origCOP))) !== -1, X.fmt(suma(activos, origCOP)));
    const prestadoTodo = suma(loans, origCOP);
    R.check('R3 "Rentabilidad de la cartera" = ganancia obtenida / todo lo prestado',
      tR.indexOf(X.rdPct(met.totalInteresesRecibidos / prestadoTodo)) !== -1, X.rdPct(met.totalInteresesRecibidos / prestadoTodo));
    // La tabla: por defecto los activos, una fila cada uno, y los filtros con su conteo.
    const filasA = filasDe(rend);
    R.eq('R4 por defecto lista los prestamos activos', filasA.length, activos.length);
    const nUSD = loans.filter(l => l.moneda === 'USD').length;
    R.check('R4 los filtros con su conteo: activos, finalizados, en dolares y todos',
      ['Activos' + activos.length, 'Finalizados' + (loans.length - activos.length), 'En dólares' + nUSD, 'Todos' + loans.length]
        .every(x => nodos(rend, n => n.tag === 'button' && /\brd-filtro\b/.test(n.props.className || '')).some(b => textos(b).join('') === x)));
    // La rentabilidad, recalculada aparte: ganancia / capital, en dolares si el credito es en dolares.
    const lpDe = id => pays.filter(p => p.prestamoId === id);
    const esperadaR = l => { const g = X.gananciaDePrestamo(l, lpDe(l.id));
      return l.moneda === 'USD' ? (g.usd || 0) / l.montoOrigen : g.cop / origCOP(l); };
    const malasR = activos.filter(l => l.modalidad !== 'Prestamo').filter(l => !filasA.some(f => {
      const t = textos(f).join(' ');
      return t.indexOf(X.properCase(l.nombre)) !== -1 && t.indexOf(X.rdPct(esperadaR(l))) !== -1; }))
      .map(l => l.nombre + ' ' + X.rdPct(esperadaR(l)));
    R.check('R5 cada fila muestra su rentabilidad acumulada = ganancia obtenida / capital prestado', malasR.length === 0, malasR);
    // La MENSUAL, recalculada aparte: la acumulada / los meses del prestamo (dias reales / 30 hasta hoy),
    // nunca dividida por menos de 1. Con su propia cuenta de dias, sin `diasEntre`.
    const hoyR = X.nowStr();
    const mesesR = l => Math.round((new Date(hoyR + 'T12:00:00') - new Date(l.fechaInicio + 'T12:00:00')) / 86400000) / 30;
    const mensualR = l => esperadaR(l) / Math.max(1, mesesR(l));
    const celdas = (f, cls) => nodos(f, n => n.tag === 'td' && new RegExp('\\b' + cls + '\\b').test(n.props.className || ''));
    const malasM = activos.filter(l => l.modalidad !== 'Prestamo').filter(l => !filasA.some(f => {
      const t = textos(f).join(' ');
      return t.indexOf(X.properCase(l.nombre)) !== -1 && celdas(f, 'rd-col-mes').some(c => textos(c).join(' ').indexOf(X.rdPct(mensualR(l))) === 0); }))
      .map(l => l.nombre + ' ' + X.rdPct(mensualR(l)));
    R.check('R5 cada fila muestra su rentabilidad MENSUAL = la acumulada / los meses del prestamo', malasM.length === 0, malasM);
    const ana = X.rdFilas(loans, pays, hoyR).find(r => r.m.activo && /restrepo/i.test(r.l.nombre) && r.meses > 12);
    R.check('R5 la mensual de un prestamo viejo es mucho menor que su acumulada (' + (ana ? X.rdPct(ana.mes) + ' frente a ' + X.rdPct(ana.rent) : 'sin caso') + ')',
      !!ana && ana.mes > 0 && ana.mes < ana.rent / 12);
    const todasR = X.rdFilas(loans, pays, hoyR).filter(r => !r.m.esPrest);
    R.check('R5 la mensual nunca supera a la acumulada (con menos de un mes se divide por 1)',
      todasR.every(r => r.mes <= r.rent + 1e-12 && r.mesCOP <= r.rentCOP + 1e-12));
    R.check('R5 en un mes recien empezado la mensual es la acumulada', (() => {
      const r = X.rdFila(Object.assign({}, todasR[0].m, { loan: Object.assign({}, todasR[0].l, { fechaInicio: X.addDays(hoyR, -10) }), activo: true }), hoyR);
      return r.mes === r.rent && X.rdMeses(r.meses) === 'en menos de un mes'; })());
    R.eq('R5 los meses se rotulan en espanol', [X.rdMeses(23.833), X.rdMeses(1), X.rdMeses(0.4)], ['en 23,8 meses', 'en 1 mes', 'en menos de un mes']);
    // Las dos columnas, lado a lado y en este orden: primero la mensual, luego la acumulada.
    const cab = nodos(rend, n => n.tag === 'th').map(th => textos(th).join('').replace(/[↑↓↕]/g, '').trim());
    const iM = cab.indexOf('Rent. mensual'), iA = cab.indexOf('Rent. acumulada');
    R.check('R5 las columnas "Rent. mensual" y "Rent. acumulada" van juntas, la mensual primero', iM !== -1 && iA === iM + 1, cab);
    R.check('R5 debajo de la acumulada, cuanto lleva el prestamo', ana && filasA.some(f => celdas(f, 'rd-col-rent').some(c => textos(c).join(' ').indexOf(X.rdMeses(ana.meses)) !== -1)));
    const lUSD = activos.find(l => l.moneda === 'USD' && l.id === '1773657323435hkkb');
    if (lUSD) {
      const g = X.gananciaDePrestamo(lUSD, lpDe(lUSD.id));
      R.check('R5 un credito en dolares se mide en dolares (' + X.rdPct(g.usd / lUSD.montoOrigen) + ') y muestra debajo la de pesos (' + X.rdPct(g.cop / origCOP(lUSD)) + ')',
        todoR.indexOf(X.rdPct(g.usd / lUSD.montoOrigen)) !== -1 && todoR.indexOf('en pesos ' + X.rdPct(g.cop / origCOP(lUSD))) !== -1);
      const dv = Math.max(1, mesesR(lUSD));
      R.check('R5 y su mensual tambien: en dolares (' + X.rdPct(g.usd / lUSD.montoOrigen / dv) + ') con la de pesos debajo',
        todoR.indexOf(X.rdPct(g.usd / lUSD.montoOrigen / dv)) !== -1 && todoR.indexOf('en pesos ' + X.rdPct(g.cop / origCOP(lUSD) / dv)) !== -1);
    }
    // Orden: por rentabilidad de mayor a menor; sembrando el estado, por ganancia y por nombre.
    const ordenFilas = arbol => filasDe(arbol).map(f => f.props.title);
    const ordenadas = (k, dir, activas) => X.rdFilas(loans, pays, X.nowStr()).filter(r => r.m.activo === (activas !== false)).sort((a, b) => {
      const x = a.clave[k], y = b.clave[k]; const c = typeof x === 'string' ? x.localeCompare(y) : x - y;
      return c * dir || a.clave.nombre.localeCompare(b.clave.nombre); });
    const esperadoOrden = (k, dir) => ordenadas(k, dir).map(r => 'Abrir ' + X.properCase(r.l.nombre) + ' en Cartera');
    R.eq('R6 por defecto, de mayor a menor rentabilidad mensual', ordenFilas(rend), esperadoOrden('mes', -1));
    R.eq('R6 ordenada por rentabilidad acumulada', ordenFilas(montarR(X.PortfolioView, propsR, [undefined, { k: 'rent', dir: -1 }])), esperadoOrden('rent', -1));
    R.eq('R6 ordenada por ganancia', ordenFilas(montarR(X.PortfolioView, propsR, [undefined, { k: 'ganancia', dir: -1 }])), esperadoOrden('ganancia', -1));
    R.eq('R6 ordenada por nombre (A-Z)', ordenFilas(montarR(X.PortfolioView, propsR, [undefined, { k: 'nombre', dir: 1 }])), esperadoOrden('nombre', 1));
    // 3.7.1 (aprobado por el PO): bajo la barra de "Recuperado" va el capital que ya volvio. Recalculado
    // aparte: el capital imputado a la caja de cada fila (imputarCobros), el mismo "Capital recuperado"
    // del panel del deudor. Y en cada fila cuadra: capital = recuperado + saldo.
    const recDe = l => Math.round(suma(lpDe(l.id), p => X.imputarCobros(p).totales.capital));
    const celda = (f, col) => nodos(f, n => n.tag === 'td' && (n.props.className || '').split(' ').indexOf(col) !== -1)[0];
    const revisarRec = (arbol, esperadas) => esperadas.filter((r, i) => {
      const c = celda(filasDe(arbol)[i], 'rd-col-recuperado'), t = c ? textos(c) : [];
      return !c || t.indexOf(X.fmt(recDe(r.l))) === -1 || t.indexOf(r.m.pct + ' %') === -1;
    }).map(r => r.l.nombre + ' ' + X.fmt(recDe(r.l)));
    const malRec = revisarRec(rend, ordenadas('mes', -1));
    R.check('R12 bajo la barra de "Recuperado", el % y el capital que ya volvio, en cada prestamo activo', malRec.length === 0, malRec);
    const malSum = ordenadas('mes', -1).filter((r, i) => textos(celda(filasDe(rend)[i], 'rd-col-saldo')).indexOf(X.fmt(origCOP(r.l) - recDe(r.l))) === -1)
      .map(r => r.l.nombre);
    R.check('R12 en cada fila, capital = recuperado + saldo', malSum.length === 0, malSum);
    R.check('R12 anti-vacio: hay prestamos activos con capital recuperado y sin el', ordenadas('mes', -1).some(r => recDe(r.l) > 0) &&
      ordenadas('mes', -1).some(r => recDe(r.l) === 0));
    // En dolares: debajo, la misma cifra en dolares a la TRM pactada (la del saldo), en gris y sin color en linea.
    const usdRec = ordenadas('mes', -1).map((r, i) => ({ r, c: celda(filasDe(rend)[i], 'rd-col-recuperado') })).filter(x => x.r.esUSD);
    R.check('R12 en un prestamo en dolares, el recuperado tambien en dolares, en gris (' + usdRec.length + ' filas)', usdRec.length > 0 && usdRec.every(x => {
      const u = nodos(x.c, n => n.props && (n.props.className || '').split(' ').indexOf('dp-usd') !== -1);
      return u.length === 1 && !(u[0].props.style && u[0].props.style.color) &&
        textos(u[0]).join('') === X.copToUsd(recDe(x.r.l), x.r.m.trm).replace('USD $', 'US$');
    }), usdRec.map(x => [x.r.l.nombre, textos(x.c)]));
    R.check('R12 anti-vacio: un prestamo en dolares con capital recuperado', usdRec.some(x => recDe(x.r.l) > 0));
    // Filtros: finalizados y "con perdida" (condonacion por la via vieja y efecto TRM negativo de un Prestamo USD).
    const fin = montarR(X.PortfolioView, propsR, ['finalizados']);
    R.eq('R7 "Finalizados" lista los prestamos cerrados', filasDe(fin).length, loans.length - activos.length);
    const malRecFin = revisarRec(fin, ordenadas('mes', -1, false));
    R.check('R12 los cerrados tambien muestran lo que se recupero', malRecFin.length === 0, malRecFin);
    const per = montarR(X.PortfolioView, propsR, ['perdida']);
    const tPer = textos(per).join(' ');
    R.check('R7 "Con pérdida" incluye la condonacion y el efecto TRM negativo, con su nota',
      filasDe(per).length >= 2 && /condonó \$/.test(tPer) && /efecto TRM −\$/.test(tPer), tPer.slice(0, 300));
    // El clic en una fila abre ese prestamo en Cartera (el mismo `openDebtorByName` de los nombres del Resumen).
    clicks.length = 0;
    filasA[0].props.onClick();
    const prim = X.rdFilas(loans, pays, X.nowStr()).find(r => 'Abrir ' + X.properCase(r.l.nombre) + ' en Cartera' === filasA[0].props.title && r.m.activo);
    R.check('R8 un clic en la fila abre su deudor y ese prestamo en Cartera', clicks.length === 1 && !!prim && clicks[0][0] === prim.l.nombre && clicks[0][1] === prim.l.id, clicks);
    // El analisis mudado: el flujo y la composicion viven aqui.
    const clsR = clases(rend).join(' ').split(/\s+/);
    R.check('R9 el analisis del negocio (flujo de caja y composicion) esta en Rendimiento',
      clsR.indexOf('rz-flujo') !== -1 && clsR.indexOf('rz-comp') !== -1 && todoR.indexOf('Dónde está tu capital') !== -1 && todoR.indexOf('Flujo de caja') !== -1);
    const sinTildeR = tR.filter(s => /\b(dias|posicion|ultimos|donde esta|proximos|prestamos?|creditos?|interes|unico|dolares|perdida|analisis|condono)\b/i.test(s));
    R.check('R10 ningun texto de Rendimiento sale sin tilde', sinTildeR.length === 0, sinTildeR);
  }
  let rendVacio = null; error = null;
  try { rendVacio = montarR(X.PortfolioView, { loans: [], pays: [] }, []); } catch (e) { error = e; }
  R.check('R11 sin prestamos: un estado vacio, sin excepciones', !!rendVacio && textos(rendVacio).join(' ').indexOf('Todavía no hay préstamos') !== -1, error && String(error));

  // ── E — GUARDAS ESTATICAS ─────────────────────────────────────────────────
  R.seccion('E — el Inicio viejo no deja restos');
  const leerRepo = p => fs.readFileSync(path.join(REPO, p), 'utf8');
  const css = leerRepo('public/css/styles.css');
  const app = leerRepo('public/js/app.js');
  R.check('E1 SparklineChart ya no existe (solo lo usaba el Inicio viejo)', !fs.existsSync(path.join(REPO, 'public/js/componentes/SparklineChart.js')));
  R.check('E2 styles.css sin las clases .dash-* y con las .rz-* del Resumen hibrido', !/\.dash-(card|lists|container|list-body)/.test(css) &&
    /\.rz-card\b/.test(css) && /\.rz-cifras\{/.test(css) && /\.rz-pc-fila\{/.test(css) && /\.rz-puntos\{/.test(css));
  R.check('E2 y sin los estilos de las piezas que salieron (KPI, agenda, radar)',
    !/\.rz-(kpis?|kpi-[a-z]+|agenda|agenda-grid|radar|radar-lista|dia|chip|chipm|tabla|minibar|spark|est|filtros?)\b/.test(css),
    (css.match(/\.rz-(kpis?|kpi-[a-z]+|agenda|agenda-grid|radar|radar-lista|dia|chip|chipm|tabla|minibar|spark|est|filtros?)\b/g) || []).slice(0, 10));
  R.check('E3 la Posicion neta salio: App ya no le pasa las deudas propias al Resumen y la vista no las lee',
    /h\(DashView,\s*\{/.test(app) && !/h\(DashView,\s*\{[^}]*debts/.test(app) && !/debts/.test(leerRepo('public/js/vistas/DashView.js')));
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
  R.check('E5 "Para cobrar ya" llena la tarjeta: parte de 0 con minimo 250 px; a lo ancho, tope de 320 px',
    /\.rz-cobrar > \.rz-body\{[^}]*flex:1 1 auto[^}]*display:flex[^}]*flex-direction:column/.test(reglas) &&
    /\.rz-pc-sec\.desplaza\{flex:1 1 auto;display:flex;flex-direction:column;min-height:0\}/.test(reglas) &&
    /\.rz-cobrar \.rz-pc-lista\{flex:1 1 0;min-height:250px;max-height:none\}/.test(reglas) &&
    /@media \(max-width:1439px\)\{\s*\.rz-cobrar \.rz-pc-lista\{flex:0 1 auto;min-height:0;max-height:320px\}/.test(reglas));
  R.check('E5 la fila de tres (3.7.1): Por cobrar 5 + Meta 4 + movimientos 3 columnas',
    /\.rz-cobrar\{grid-column:span 5\}\s*\.rz-meta\{grid-column:span 4\}\s*\.rz-mov\{grid-column:span 3\}/.test(reglas));
  R.check('E5 a 1.439 px o menos, Por cobrar a lo ancho con sus dos listas lado a lado, y Meta y movimientos mitad y mitad',
    /@media \(max-width:1439px\)\{\s*\.rz-cobrar\{grid-column:1 \/ -1\}\s*\.rz-meta,\.rz-mov\{grid-column:span 6\}/.test(reglas) &&
    /@media \(max-width:1439px\)\{[^@]*\.rz-pc-secciones\{display:grid;grid-template-columns:minmax\(0,1fr\) minmax\(0,1fr\)/.test(reglas));
  R.check('E6 Ultimos movimientos (3.7.0): cuerpo flexible y lista que parte de 0 con minimo 240 px; sola en su fila, tope de 360 px',
    /\.rz-mov > \.rz-body[,{][^}]*flex:1 1 auto[^}]*display:flex/.test(reglas) &&
    /\.rz-mov \.rz-mov-lista\{flex:1 1 0;min-height:240px;max-height:none\}/.test(reglas) &&
    /@media \(max-width:1180px\)\{[^@]*\.rz-mov \.rz-mov-lista\{[^}]*max-height:360px/.test(reglas));
  R.check('E7 App le pasa a Rendimiento la navegacion a Cartera', /h\(PortfolioView,\{[^}]*onNameClick:openDebtorByName/.test(app));

  process.exit(R.finalizar());
})().catch(e => { console.error(e); process.exit(1); });
