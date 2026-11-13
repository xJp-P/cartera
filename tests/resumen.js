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
//   D. LA VISTA REAL (`DashView`, el rediseño v4 que aprobo el PO) renderizada con el arnes: sin
//      excepciones, con sus piezas, las cifras de A-C en pantalla, la comparacion con el mismo tramo
//      del mes anterior recalculada aparte, la rentabilidad IGUAL a la de Rendimiento, a donde lleva
//      cada cosa, el movimiento (cifras que cuentan desde 0 solo con la ventana visible) y la ortografia.
//   E. GUARDAS ESTATICAS: las hojas del rediseño (base.css, resumen.css) y sus reglas de layout, la
//      fuente Inter local, el marco de app.js, la compatibilidad del panel del deudor con el marco nuevo,
//      el fondo de la ventana principal, y que el Resumen anterior no deja restos.
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
  R.check('0 la vista expone modeloResumen, rzMetaDelMes, rzParaCobrar, V4PorCobrar, V4Dinero y DashView',
    ['modeloResumen', 'rzMetaDelMes', 'rzParaCobrar', 'V4PorCobrar', 'V4Dinero', 'DashView'].every(k => typeof X[k] === 'function'));
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
  // El Resumen v4 (rediseño aprobado por el PO sobre el prototipo). Las cifras cuentan desde 0 al
  // montarse y el arnes no corre efectos: se pinta con la ventana "oculta" (`document.hidden`), que es
  // justo el caso en que la vista muestra el valor final sin animar. D10 prueba las dos ramas.
  R.seccion('D — DashView (rediseño v4) renderizado con los datos del fixture');
  X.document.hidden = true;
  const props = { metrics: met, isEmpty: false, loans, pays, onNav: () => {}, onNameClick: () => {}, onNewLoan: () => {} };
  const render = (pr) => pintar({ type: X.DashView, props: pr || props, children: [] });
  const sinPeso = s => String(s).replace(/^-?\$\s*/, '');
  const conClase = (n, c) => nodosDe(n, x => x.props && (' ' + (x.props.className || '') + ' ').indexOf(' ' + c + ' ') !== -1);
  let arbol = null, error = null;
  try { arbol = render(); } catch (e) { error = e; }
  R.check('D1 la vista se pinta sin excepciones', !error, error && (error.stack || String(error)));
  if (arbol) {
    const t = textos(arbol), todo = t.join(' ');
    const tiene = s => todo.indexOf(s) !== -1;
    const cls = clases(arbol).join(' ').split(/\s+/);
    const PIEZAS = ['v4', 'v4-head', 'v4-pills', 'v4-kpis', 'v4-cobrar', 'v4-meta', 'v4-mov', 'v4-rend'];
    R.check('D2 las piezas del Resumen v4: encabezado, pastillas, tres cifras, por cobrar, meta, movimientos y rendimiento',
      PIEZAS.every(c => cls.indexOf(c) !== -1), PIEZAS.filter(c => cls.indexOf(c) === -1));
    R.check('D2 no queda ninguna pieza del Resumen anterior (rejilla .rz, puntos, franja de cifras, enlace al analisis)',
      cls.every(c => !/^rz(-|$)/.test(c)), cls.filter(c => /^rz(-|$)/.test(c)));
    R.check('D2 el flujo de caja y la composicion siguen fuera del Resumen (viven en Rendimiento)',
      !tiene('Flujo de caja') && !tiene('Dónde está tu capital'));
    // Encabezado: la fecha, el estado y el dia en tres pastillas con las cifras de App.
    R.check('D3 el encabezado dice el dia y los prestamos activos: "viernes 31 de julio · 13 préstamos activos"',
      tiene('viernes 31 de julio · ' + M.activos.length + ' préstamos activos'));
    R.check('D3 el estado de la cartera: "' + M.deudoresMora + ' deudores en mora"', tiene(M.deudoresMora + ' deudores en mora'));
    const pills = conClase(arbol, 'v4-pill').map(n => textos(n).join('|'));
    const totHoy = suma(met.hoy, p => X.pendCuota(p)), totSem = suma(met.proximos, p => X.pendCuota(p));
    R.eq('D3 tres pastillas: hoy, los próximos 7 días y lo vencido, con las cifras de App', pills, [
      'Hoy vencen|' + X.fmt(totHoy) + '|' + met.hoy.length + ' cuotas',
      'Próximos 7 días|' + X.fmt(totSem) + '|por entrar',
      'Vencido|' + X.fmt(met.totalMora) + '|' + met.mora.length + ' cuotas de ' + M.deudoresMora + ' deudores']);
    // Un parcial sobre una cuota que vence hoy: la pastilla dice lo que FALTA (pendCuota), no la cuota
    // entera. Construido: en el fixture ninguna cuota de hoy trae un parcial.
    {
      const paysP = pays.map(p => Object.assign({}, p));
      const cuotaHoy = paysP.find(p => p.id === met.hoy[0].id);
      cuotaHoy.partialPaid = 100000;
      const arbolP = render(Object.assign({}, props, { pays: paysP, metrics: metricsComoApp(X, loans, paysP) }));
      R.eq('D3 un parcial de 100.000 sobre una cuota de hoy baja en 100.000 la pastilla de hoy',
        conClase(arbolP, 'v4-pill').map(n => textos(n).join('|'))[0], 'Hoy vencen|' + X.fmt(totHoy - 100000) + '|' + met.hoy.length + ' cuotas');
    }
    // Tres cifras: el valor en pesos va con el "$" aparte (pequeño): se busca la cifra sin el signo.
    const pctRec = Math.round((1 - M.vivo / M.prestado) * 100);
    R.check('D4 "En la calle" muestra ' + X.fmt(M.vivo) + ', lo prestado y cuanto ya volvio, con su anillo',
      tiene('En la calle') && t.indexOf(sinPeso(X.fmt(M.vivo))) !== -1 && t.indexOf(X.fmt(M.prestado)) !== -1 &&
      tiene(pctRec + '% ya volvió') && t.indexOf(pctRec + '%') !== -1);
    R.check('D4 "Cobrado en julio" muestra "Cobros del Mes" de App', tiene('Cobrado en julio') && t.indexOf(sinPeso(X.fmt(met.recibido))) !== -1);
    R.check('D4 "Ganancia de julio" muestra la del mes y la de 12 meses',
      tiene('Ganancia de julio') && t.indexOf(sinPeso(X.fmt(M.gananciaMes))) !== -1 && tiene('Últimos 12 meses: ') && t.indexOf(X.fmt(M.ganancia12)) !== -1);
    const barrasDias = conClase(conClase(arbol, 'dias')[0], 'b'), barrasMeses = conClase(conClase(arbol, 'meses')[0], 'b');
    R.eq('D4 una barra por dia de julio (31) y una por mes en la ganancia (12)', [barrasDias.length, barrasMeses.length], [31, 12]);
    // La comparacion con el mismo tramo del mes anterior, recalculada APARTE: junio del 1 al 30.
    let cajaJun = 0, ganJun = 0;
    pays.forEach(p => {
      X.cobrosDe(p).forEach(e => { if (mesDe(e.fecha) === '2026-06' && e.fecha <= '2026-06-30') cajaJun += e.cop; });
      const l = loanMap[p.prestamoId];
      X.gananciaDe(p, l && l.moneda === 'USD').eventos.forEach(e => { if (mesDe(e.fecha) === '2026-06' && e.fecha <= '2026-06-30') ganJun += e.ganancia; });
    });
    const chipDelta = (ahora, antes) => { const d = (ahora - antes) / antes * 100; return (d >= 0 ? '↗' : '↘') + '|' + (d >= 0 ? '+' : '') + Math.round(d) + ' %'; };
    const deltas = conClase(arbol, 'v4-chip').filter(n => conClase(n, 'flecha').length).map(n => textos(n).join('|'));
    R.eq('D4b el cobrado y la ganancia se comparan con junio del 1 al 30 (recalculado aparte con cobrosDe y gananciaDe)', deltas,
      [chipDelta(met.recibido, Math.round(cajaJun)), chipDelta(M.gananciaMes, Math.round(ganJun))]);
    R.check('D4b anti-vacio: junio tiene caja y ganancia', cajaJun > 0 && ganJun > 0, { cajaJun, ganJun });
    // Por cobrar: las dos listas con sus totales, una fila por persona y una por cuota de la semana.
    const cobrar = conClase(arbol, 'v4-cobrar')[0];
    const secs = conClase(cobrar, 'v4-pc-sec');
    const filasSec = i => conClase(secs[i], 'v4-fila');
    R.check('D5 "Por cobrar" trae "Para cobrar ya" con su total y una fila por persona, en una lista que se desplaza',
      secs.length === 2 && textos(secs[0]).indexOf('Para cobrar ya') !== -1 && textos(secs[0]).indexOf(X.fmt(totYa)) !== -1 &&
      conClase(secs[0], 'v4-pc-lista').length === 1 &&
      filasSec(0).length === ya.length && filasSec(0).every((f, i) => textos(f).indexOf(X.properCase(ya[i].nombre)) !== -1),
      secs.map(x => textos(x)));
    R.check('D5 y "Esta semana" con su total y una fila por cuota',
      textos(secs[1]).indexOf('Esta semana') !== -1 && textos(secs[1]).indexOf(X.fmt(suma(semana, f => f.pend))) !== -1 &&
      filasSec(1).length === Math.min(semana.length, 6));
    const usdC = nodosDe(cobrar, n => n.props && /\bdp-usd\b/.test(n.props.className || ''));
    R.check('D5 los dolares de "Por cobrar" van en gris, sin color en linea', usdC.length > 0 &&
      usdC.every(n => !(n.props.style && n.props.style.color)), usdC.map(n => n.props));
    // Meta del mes
    const metaCard = conClase(arbol, 'v4-meta')[0];
    R.check('D6 la meta marca 125% y muestra sus cuatro cifras', textos(metaCard).indexOf('125%') !== -1 &&
      [meta.esperado, meta.cobrado, meta.moraRec, meta.falta].every(v => textos(metaCard).indexOf(X.fmt(v)) !== -1));
    const listaMeta = conClase(metaCard, 'v4-meta-lista');
    R.check('D6 una fila por cuota pendiente, en una lista sin tope de alto en linea (regla de 3.4.1)',
      listaMeta.length === 1 && conClase(listaMeta[0], 'v4-li').length === meta.pend.length && !(listaMeta[0].props.style && listaMeta[0].props.style.maxHeight != null),
      listaMeta.map(l => l.props));
    // Ultimos movimientos: el total del mes = la caja de julio de los movimientos recientes.
    const movCard = conClase(arbol, 'v4-mov')[0];
    const totMov = suma(M.recientes.filter(e => mesDe(e.fecha) === '2026-07'), e => e.cop);
    const listaMov = conClase(movCard, 'v4-mov-lista');
    R.check('D7 "Últimos movimientos": "Entraron ' + X.fmt(totMov) + ' en julio" y hasta 16 movimientos, sin tope de alto en linea',
      textos(movCard).indexOf(X.fmt(totMov)) !== -1 && listaMov.length === 1 && conClase(listaMov[0], 'v4-mv').length === Math.min(16, M.recientes.length) &&
      !(listaMov[0].props.style && listaMov[0].props.style.maxHeight != null));
    // Rendimiento: la rentabilidad de la cartera es LA MISMA cifra de la pestaña Rendimiento.
    const rendCard = conClase(arbol, 'v4-rend')[0];
    const filasR = X.rdFilas(loans, pays, HOY);
    const rentR = X.rdPct(suma(filasR, r => r.m.gp.cop) / suma(filasR, r => r.m.orig));
    const rentV = conClase(rendCard, 'v4-rend-v').map(n => textos(n).join(''))[0];
    R.eq('D8 la rentabilidad del Resumen = la de Rendimiento (' + rentR + ')', rentV, rentR.replace(' %', '%'));
    R.check('D8 la caja de los últimos 12 meses: 12 columnas', conClase(rendCard, 'col').length === 12);
    // Ortografia: con tildes en toda la pestaña. Ningun rotulo vuelve a salir sin ellas.
    const conTilde = ['Últimos movimientos', 'Próximos 7 días', 'préstamos activos', 'Nuevo préstamo', 'ya volvió', 'Últimos 12 meses', 'Día a día',
      'Mejor día', 'Lo que vence en el mes frente a lo que ya entró', 'Ganancia histórica', 'rentabilidad de la cartera'];
    R.check('D9 ortografia completa: ' + conTilde.join(' · '),
      conTilde.every(s => todo.indexOf(s) !== -1), conTilde.filter(s => todo.indexOf(s) === -1));
    const sinTilde = t.filter(s => /\b(dias|posicion|ultimos|donde esta|proximos|prestamos?|creditos?|interes|historico|historica|unico|dolares|volvio|abono una|entro)\b/i.test(s));
    R.check('D9 ningun texto de la vista sale sin tilde', sinTilde.length === 0, sinTilde);
  }
  // A donde lleva cada cosa: las pastillas a Cobros en su tramo, las filas al deudor en Cartera, los
  // enlaces a Cobros, Historial y Rendimiento, y los botones del encabezado.
  {
    const navs = [], abre = [], nuevos = [];
    const a = render(Object.assign({}, props,
      { onNav: (v, d) => navs.push(d === undefined ? [v] : [v, d]), onNameClick: (n, l, p) => abre.push([n, l, p]), onNewLoan: () => nuevos.push(1) }));
    const conC = c => nodosDe(a, x => x.props && (' ' + (x.props.className || '') + ' ').indexOf(' ' + c + ' ') !== -1);
    conC('v4-pill').forEach(n => n.props.onClick && n.props.onClick());
    R.eq('D3b cada pastilla lleva a Cobros en su tramo', navs, [['cobros', 'hoy'], ['cobros', 'semana'], ['cobros', 'vencido']]);
    navs.length = 0;
    const conC2 = (n, c) => nodosDe(n, x => x.props && (' ' + (x.props.className || '') + ' ').indexOf(' ' + c + ' ') !== -1);
    conC('v4-acciones').forEach(n => conC2(n, 'v4-btn').forEach(b => b.props.onClick()));
    R.check('D3c los botones del encabezado: Calculadora, Cobros y Nuevo préstamo',
      JSON.stringify(navs) === JSON.stringify([['calculadora'], ['cobros']]) && nuevos.length === 1, { navs, nuevos });
    navs.length = 0;
    conC('v4-link').forEach(b => b.props.onClick());
    conC2(conC('v4-rend')[0], 'v4-btn').forEach(b => b.props.onClick());
    R.eq('D3d los enlaces: Cobros (en lo vencido), Historial y Ver Rendimiento', navs, [['cobros', 'vencido'], ['historial'], ['rendimiento']]);
    const filas = conC('v4-fila');
    abre.length = 0; filas[0].props.onClick();
    R.eq('D5b la primera fila de "Para cobrar ya" abre a esa persona en Cartera', abre, [[ya[0].nombre, ya[0].loanId, undefined]]);
    abre.length = 0; filas[ya.length].props.onClick();
    R.eq('D5b una fila de "Esta semana" abre ese prestamo con la cuota marcada', abre, [[semana[0].l.nombre, semana[0].l.id, semana[0].p.id]]);
  }
  // "Para cobrar ya" trae a TODAS las personas en una lista que se desplaza; "Esta semana" muestra hasta 6
  // cuotas y anuncia el resto. Construido: el fixture tiene 5 personas con algo vencido y 2 cuotas en la semana.
  {
    const clon = (f, i, sufijo) => Object.assign({}, f, { l: Object.assign({}, f.l, { nombre: 'Zz ' + sufijo + i, id: 'zz-' + sufijo + i }),
      p: Object.assign({}, f.p, { id: 'zz-' + sufijo + i }) });
    const extraYa = [1, 2, 3].map(i => clon(bandeja.filter(x => x.tramo === 'vencido')[0], i, 'v'));
    const extraSem = [1, 2, 3, 4, 5, 6].map(i => clon(bandeja.filter(x => x.tramo === 'semana')[0], i, 's'));
    const navs = [];
    const card = pintar({ type: X.V4PorCobrar, props: { filas: bandeja.concat(extraYa, extraSem), hoy: HOY, onNav: (v, d) => navs.push([v, d]), onNameClick: () => {} }, children: [] });
    const conCc = (n, c) => nodosDe(n, x => x.props && (' ' + (x.props.className || '') + ' ').indexOf(' ' + c + ' ') !== -1);
    const [sec0, sec1] = conCc(card, 'v4-pc-sec');
    const lista = conCc(sec0, 'v4-pc-lista');
    R.check('D5c con 8 personas, "Para cobrar ya" las muestra a las 8 dentro de la lista que se desplaza, sin "y N más"',
      /\bdesplaza\b/.test(sec0.props.className) && lista.length === 1 && conCc(lista[0], 'v4-fila').length === 8 && conCc(sec0, 'v4-mas').length === 0, textos(sec0));
    R.check('D5c y la lista no lleva tope de alto en linea (lo gobierna resumen.css, regla de 3.4.1)',
      lista.length === 1 && !(lista[0].props.style && lista[0].props.style.maxHeight != null));
    const mas = conCc(sec1, 'v4-mas');
    R.check('D5c con 8 cuotas en la semana, "Esta semana" muestra 6 y dice "y 2 cuotas más"',
      conCc(sec1, 'v4-fila').length === 6 && mas.length === 1 && textos(mas[0]).join('') === 'y 2 cuotas más', textos(sec1));
    if (mas[0]) mas[0].props.onClick();
    R.eq('D5c y ese enlace abre Cobros en la semana', navs, [['cobros', 'semana']]);
    const vacia = pintar({ type: X.V4PorCobrar, props: { filas: [], hoy: HOY, onNav: () => {}, onNameClick: () => {} }, children: [] });
    R.check('D5d sin nada por cobrar, las dos listas lo dicen', textos(vacia).join(' ').indexOf('Nada vencido ni nada que venza hoy.') !== -1 &&
      textos(vacia).join(' ').indexOf('Nada vence en los próximos 7 días.') !== -1);
  }
  // El movimiento: con la ventana visible las cifras cuentan desde 0 (el efecto las lleva a su valor) y
  // las tarjetas entran animadas (`anima`); oculta, la cifra final y sin animacion.
  {
    X.document.hidden = false;
    const visible = render();
    const ceroV = pintar({ type: X.V4Dinero, props: { v: 1234567, animar: true }, children: [] });
    X.document.hidden = true;
    const oculta = render();
    const finalV = pintar({ type: X.V4Dinero, props: { v: 1234567, animar: true }, children: [] });
    R.check('D10 ventana visible: la vista lleva la clase "anima" y la cifra arranca en 0',
      /\banima\b/.test(visible.props.className) && textos(ceroV).join('') === '$0', [visible.props.className, textos(ceroV)]);
    R.check('D10 ventana oculta: sin "anima" y la cifra muestra su valor final',
      !/\banima\b/.test(oculta.props.className) && textos(finalV).join('') === '$1.234.567', [oculta.props.className, textos(finalV)]);
  }
  let vacio = null;
  try { vacio = pintar({ type: X.DashView, props: Object.assign({}, props, { isEmpty: true, loans: [], pays: [] }), children: [] }); } catch (e) { error = e; }
  R.check('D12 sin prestamos: estado vacio con su llamado a crear el primero',
    !!vacio && textos(vacio).join(' ').indexOf('Tu cartera empieza aquí') !== -1, error && String(error));

  // ── R — RENDIMIENTO (3.7.0; rediseño v4) ──────────────────────────────────
  // Rediseno aprobado por el PO: cuatro cifras, la tabla de prestamos (filtros, orden, clic a Cartera) y
  // el analisis mudado del Resumen. En v4 el analisis se redibujo: el flujo de caja en barras (RdvFlujo)
  // y "Donde esta tu capital" como barra segmentada con su lista (RdvComposicion), con los mismos datos
  // de `modeloResumen`. Ninguna cifra nueva de dinero salvo el cociente de la rentabilidad.
  R.seccion('R — Rendimiento v4: cifras, tabla, rentabilidad y el analisis del negocio');
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
  const clsDe = n => ((n && n.props && n.props.className) || '').split(/\s+/);
  // Una cifra de V4Dinero, como se lee en pantalla: el "$" pegado al numero.
  const dinero = v => '$' + X.fmt(v).replace(/^-?\$\s*/, '');
  const lpDe = id => pays.filter(p => p.prestamoId === id);
  const recDe = l => Math.round(suma(lpDe(l.id), p => X.imputarCobros(p).totales.capital));
  const clicks = [];
  const propsR = { loans, pays, onNav: () => {}, onNameClick: (n, id) => clicks.push([n, id]) };
  let rend = null; error = null;
  try { rend = montarR(X.PortfolioView, propsR, []); } catch (e) { error = e; }
  R.check('R1 la vista se pinta sin excepciones', !!rend, error && (error.stack || String(error)));
  if (rend) {
    const tR = textos(rend), todoR = tR.join(' ');
    const filasDe = arbol => nodos(arbol, n => n.tag === 'tr' && /\brdv-fila\b/.test((n.props && n.props.className) || ''));
    R.check('R1 la raiz es la de Rendimiento v4 (`.v4r`)', clsDe(rend).indexOf('v4r') !== -1, rend.props.className);
    // Las cifras: la ganancia es la de la tarjeta del Resumen (Bug #68: tarjeta == Rendimiento), el saldo
    // es el "Capital en la calle" del Resumen y el colocado es el capital original de los activos.
    const vals = conClase(rend, 'rdv-cifra-v').map(n => textos(n).join(''));
    R.eq('R2 la franja tiene cuatro cifras', vals.length, 4);
    R.eq('R2 "Ganancia obtenida" = la ganancia historica de la app (' + X.fmt(met.totalInteresesRecibidos) + ')', vals[0], dinero(met.totalInteresesRecibidos));
    R.check('R2 y debajo, los ultimos 12 meses del Resumen (' + X.fmt(M.ganancia12) + ')',
      textos(conClase(rend, 'rdv-cifra-s')[0]).indexOf(X.fmt(M.ganancia12)) !== -1);
    R.eq('R3 "Saldo en la calle" = el "Capital en la calle" del Resumen (' + X.fmt(M.vivo) + ')', vals[3], dinero(M.vivo));
    R.eq('R3 "Capital colocado" = el capital original de los prestamos activos', vals[2], dinero(suma(activos, origCOP)));
    const prestadoTodo = suma(loans, origCOP);
    R.eq('R3 "Rentabilidad de la cartera" = ganancia obtenida / todo lo prestado', vals[1],
      X.rdPct(met.totalInteresesRecibidos / prestadoTodo).replace(' %', '') + '%');
    const pctRec = suma(activos, recDe) / suma(activos, origCOP) * 100;
    const meter = conClase(rend, 'rdv-cifra-meter')[0];
    R.eq('R3 la barra del capital colocado marca lo que ya volvio (' + Math.round(pctRec) + ' %)',
      meter && meter.kids[0].props.style.width, Math.max(0, Math.min(100, pctRec)) + '%');
    // La tabla: por defecto los activos, una fila cada uno, y los filtros (las pastillas de Cartera) con su conteo.
    const filasA = filasDe(rend);
    R.eq('R4 por defecto lista los prestamos activos', filasA.length, activos.length);
    const nUSD = loans.filter(l => l.moneda === 'USD').length;
    R.check('R4 los filtros en pastilla con su conteo: activos, finalizados, en dolares y todos',
      ['Activos' + activos.length, 'Finalizados' + (loans.length - activos.length), 'En dólares' + nUSD, 'Todos' + loans.length]
        .every(x => nodos(rend, n => n.tag === 'button' && /\bctv-filtro\b/.test(n.props.className || '')).some(b => textos(b).join('') === x)));
    // La rentabilidad, recalculada aparte: ganancia / capital, en dolares si el credito es en dolares.
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
      return t.indexOf(X.properCase(l.nombre)) !== -1 && celdas(f, 'rdv-col-mes').some(c => textos(c).join(' ').indexOf(X.rdPct(mensualR(l))) === 0); }))
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
    R.check('R5 debajo de la acumulada, cuanto lleva el prestamo', ana && filasA.some(f => celdas(f, 'rdv-col-rent').some(c => textos(c).join(' ').indexOf(X.rdMeses(ana.meses)) !== -1)));
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
    const celda = (f, col) => nodos(f, n => n.tag === 'td' && (n.props.className || '').split(' ').indexOf(col) !== -1)[0];
    const revisarRec = (arbol, esperadas) => esperadas.filter((r, i) => {
      const c = celda(filasDe(arbol)[i], 'rdv-col-recuperado'), t = c ? textos(c) : [];
      return !c || t.indexOf(X.fmt(recDe(r.l))) === -1 || t.indexOf(r.m.pct + ' %') === -1;
    }).map(r => r.l.nombre + ' ' + X.fmt(recDe(r.l)));
    const malRec = revisarRec(rend, ordenadas('mes', -1));
    R.check('R12 bajo la barra de "Recuperado", el % y el capital que ya volvio, en cada prestamo activo', malRec.length === 0, malRec);
    const malSum = ordenadas('mes', -1).filter((r, i) => textos(celda(filasDe(rend)[i], 'rdv-col-saldo')).indexOf(X.fmt(origCOP(r.l) - recDe(r.l))) === -1)
      .map(r => r.l.nombre);
    R.check('R12 en cada fila, capital = recuperado + saldo', malSum.length === 0, malSum);
    R.check('R12 anti-vacio: hay prestamos activos con capital recuperado y sin el', ordenadas('mes', -1).some(r => recDe(r.l) > 0) &&
      ordenadas('mes', -1).some(r => recDe(r.l) === 0));
    // En dolares: debajo, la misma cifra en dolares a la TRM pactada (la del saldo), en gris y sin color en linea.
    const usdRec = ordenadas('mes', -1).map((r, i) => ({ r, c: celda(filasDe(rend)[i], 'rdv-col-recuperado') })).filter(x => x.r.esUSD);
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
    // El analisis mudado: el flujo y la composicion viven aqui, redibujados en v4.
    const clsR = clases(rend).join(' ').split(/\s+/);
    R.check('R9 el analisis del negocio (flujo de caja y composicion) esta en Rendimiento, con las piezas v4',
      clsR.indexOf('rdv-flujo') !== -1 && clsR.indexOf('rdv-comp') !== -1 && todoR.indexOf('Dónde está tu capital') !== -1 && todoR.indexOf('Flujo de caja') !== -1);
    R.check('R9 sin la dona ni el grafico SVG de antes: ningun <circle>, <rect> ni <pattern> (los unicos <svg> son iconos)',
      nodos(rend, n => ['circle', 'rect', 'pattern', 'line', 'text'].indexOf(n.tag) !== -1).length === 0);
    const sinTildeR = tR.filter(s => /\b(dias|posicion|ultimos|donde esta|proximos|prestamos?|creditos?|interes|unico|dolares|perdida|analisis|condono)\b/i.test(s));
    R.check('R10 ningun texto de Rendimiento sale sin tilde', sinTildeR.length === 0, sinTildeR);

    // ── La tabla v4: estado en chip suave, avatar neutro o con su tono, barras sin color en linea ──
    const filasMod = ordenadas('mes', -1);
    const TONO = { mora: 'crit', hoy: 'warn', semana: 'warn', aldia: 'good', abierto: 'info', finalizado: 'neutral', cancelado: 'crit', condonado: 'warn' };
    const malChip = filasMod.filter((r, i) => { const ch = conClase(celda(filasDe(rend)[i], 'rdv-col-estado'), 'v4-chip');
      return ch.length !== 1 || clsDe(ch[0]).indexOf(TONO[r.m.estado]) === -1; }).map(r => r.l.nombre + ' ' + r.m.estado);
    R.check('R13 el estado de cada prestamo va en un chip suave con su tono (mora en rojo, al dia en verde...)', malChip.length === 0, malChip);
    R.check('R13 anti-vacio: entre los activos hay prestamos en mora y al dia',
      filasMod.some(r => r.m.estado === 'mora') && filasMod.some(r => r.m.estado === 'aldia'), filasMod.map(r => r.m.estado));
    const malAv = filasMod.filter((r, i) => { const av = conClase(celda(filasDe(rend)[i], 'rdv-col-nombre'), 'cbv-av')[0];
      const t = r.m.estado === 'mora' ? 'crit' : (r.m.estado === 'hoy' || r.m.estado === 'semana') ? 'warn' : r.m.estado === 'abierto' ? 'info' : null;
      return !av || (t ? clsDe(av).indexOf(t) === -1 : clsDe(av).length !== 1); }).map(r => r.l.nombre);
    R.check('R13 el avatar es neutro, salvo mora (rojo), cobro cercano (ambar) y credito abierto (azul)', malAv.length === 0, malAv);
    const tabla = conClase(rend, 'rdv-t')[0];
    const estilosT = nodos(tabla, n => n.props && n.props.style).map(n => Object.keys(n.props.style)).reduce((a, k) => a.concat(k), []);
    R.check('R13 la tabla no pinta colores en linea: solo anchos de barra y el retardo de entrada',
      estilosT.length > 0 && estilosT.every(k => k === 'width' || k === '--i'), Array.from(new Set(estilosT)));
    const barrasRent = col => filasDe(rend).map(f => conClase(celda(f, col), 'rdv-rent-b')[0]).filter(Boolean)
      .map(b => parseFloat(b.kids[0].props.style.width));
    const bm = barrasRent('rdv-col-mes'), ba = barrasRent('rdv-col-rent');
    R.check('R13 las barras de rentabilidad son relativas a su columna: la mas alta llega al 100 %',
      bm.length > 0 && Math.abs(Math.max.apply(null, bm) - 100) < 1e-9 && Math.abs(Math.max.apply(null, ba) - 100) < 1e-9 && bm.concat(ba).every(w => w >= 0 && w <= 100), { bm, ba });
    const malBarraRec = filasMod.filter((r, i) => { const b = conClase(celda(filasDe(rend)[i], 'rdv-col-recuperado'), 'rdv-barra')[0];
      return !b || b.kids[0].props.style.width !== r.m.pct + '%'; }).map(r => r.l.nombre);
    R.check('R13 la barra de "Recuperado" marca el % de cada prestamo', malBarraRec.length === 0, malBarraRec);

    // ── Flujo de caja: 12 meses + 3 proyectados, en barras (RdvFlujo) ─────────
    const flujo = modo => { const orig = X.useState;
      X.useState = init => (init === 'caja' ? [modo, () => {}] : orig(init));
      try { return pintar({ type: X.RdvFlujo, props: { M }, children: [] }); } finally { X.useState = orig; } };
    const fc = flujo('caja');
    const cols = conClase(fc, 'col');
    R.eq('R14 el flujo dibuja una columna por mes: 12 de historia + 3 proyectados', cols.length, M.meses.length);
    R.eq('R14 cada columna lleva su mes ("ene" con el año)', cols.map(c => textos(conClase(c, 'mes')[0]).join('')),
      M.meses.map(m => m.label + (m.label === 'ene' ? " '" + m.anio.slice(2) : '')));
    const topeC = Math.max.apply(null, M.meses.map(m => m.caja + m.proy).concat([1]));
    const altoEsperado = (v, tope) => (v > 0 ? Math.max(1.5, v / tope * 100) : 0) + '%';
    R.eq('R14 la altura de cada barra es su caja + lo por cobrar, sobre el mes mas alto',
      cols.map(c => conClase(c, 'barra')[0].props.style.height), M.meses.map(m => altoEsperado(m.caja + m.proy, topeC)));
    R.check('R14 el mes mas alto llega al 100 %', cols.some(c => conClase(c, 'barra')[0].props.style.height === '100%'));
    const partes = (c, k) => conClase(conClase(c, 'barra')[0], k).map(n => n.props.style.flexGrow);
    const malPartes = M.meses.filter((m, i) => {
      const c = cols[i];
      return JSON.stringify(partes(c, 'int')) !== JSON.stringify(m.interes > 0 ? [m.interes] : []) ||
        JSON.stringify(partes(c, 'cap')) !== JSON.stringify(m.capital > 0 ? [m.capital] : []) ||
        JSON.stringify(partes(c, 'proy')) !== JSON.stringify(m.proy > 0 ? [m.proy] : []);
    }).map(m => m.key);
    R.check('R14 cada barra se reparte en intereses (verde), capital (gris) y lo por cobrar (rayado), con sus montos', malPartes.length === 0, malPartes);
    R.check('R14 lo por cobrar solo va en el mes en curso y en los proyectados',
      M.meses.every((m, i) => partes(cols[i], 'proy').length === 0 || m.actual || m.futuro));
    R.check('R14 anti-vacio: hay meses con intereses y capital, y meses proyectados con cuotas por cobrar',
      M.meses.some(m => m.interes > 0 && m.capital > 0) && M.meses.some(m => m.futuro && m.proy > 0));
    R.check('R14 el mes en curso va resaltado y los proyectados atenuados',
      M.meses.every((m, i) => (clsDe(cols[i]).indexOf('on') !== -1) === !!m.actual && (clsDe(cols[i]).indexOf('futuro') !== -1) === !!m.futuro));
    const malTip = M.meses.filter((m, i) => {
      const tip = conClase(cols[i], 'v4-tip')[0];
      if (!(m.caja + m.proy > 0)) return !!tip;
      const t = tip ? textos(tip).join('|') : '';
      return !tip || (m.caja > 0 && (t.indexOf('Intereses|' + X.fmt(m.interes)) === -1 || t.indexOf('Capital|' + X.fmt(m.capital)) === -1 ||
        t.indexOf('Entró en caja|' + X.fmt(m.caja)) === -1)) || (m.proy > 0 && t.indexOf(X.fmt(m.proy)) === -1);
    }).map(m => m.key);
    R.check('R14 el globo de cada mes desglosa intereses, capital, lo que entro en caja y lo por cobrar', malTip.length === 0, malTip);
    const hist = M.meses.slice(0, 12);
    const tS = textos(conClase(fc, 'rdv-stats')[0]).join('|');
    R.check('R14 las cifras del flujo: cobrado y sus intereses en 12 meses, la ganancia de 12 meses y lo por cobrar',
      tS.indexOf('Cobrado en 12 meses|' + X.fmt(suma(hist, m => m.caja))) !== -1 && tS.indexOf('De eso, intereses|' + X.fmt(suma(hist, m => m.interes))) !== -1 &&
      tS.indexOf('Ganancia 12 meses|' + X.fmt(M.ganancia12)) !== -1 &&
      tS.indexOf('Por cobrar (este mes y 3 más)|' + X.fmt(suma(M.meses.slice(12), m => m.proy) + M.meses[11].proy)) !== -1, tS);
    R.eq('R14 el eje marca el tope, la mitad y el cero', conClase(fc, 'rdv-eje-l').map(n => textos(n).join('')),
      [1, .5, 0].map(f => X.rzCompacto(f * topeC)));
    const estilosF = nodos(fc, n => n.props && n.props.style).map(n => Object.keys(n.props.style)).reduce((a, k) => a.concat(k), []);
    R.check('R14 el flujo no pinta colores en linea (los colores vienen de la hoja)',
      estilosF.every(k => ['height', 'flexGrow', 'bottom', '--i', '--n', '--k'].indexOf(k) !== -1), Array.from(new Set(estilosF)));
    const fg = flujo('ganancia');
    const colsG = conClase(fg, 'col');
    const topeG = Math.max.apply(null, M.meses.map(m => m.ganancia).concat([1]));
    R.eq('R14 en modo Ganancia, cada barra es la ganancia real del mes',
      colsG.map(c => [conClase(c, 'barra')[0].props.style.height, partes(c, 'gan')]),
      M.meses.map(m => [altoEsperado(m.ganancia, topeG), m.ganancia > 0 ? [m.ganancia] : []]));
    R.check('R14 en modo Ganancia no hay intereses, capital ni proyeccion', colsG.every(c => !partes(c, 'int').length && !partes(c, 'cap').length && !partes(c, 'proy').length) &&
      textos(fg).join(' ').indexOf('Ganancia real (intereses netos de pérdida cambiaria)') !== -1);

    // ── Donde esta tu capital: barra segmentada + lista (RdvComposicion), en vez de la dona ──
    const compo = tab => { const orig = X.useState;
      X.useState = init => (init === 'deudor' ? [tab, () => {}] : orig(init));
      try { return pintar({ type: X.RdvComposicion, props: { M, onNameClick: n => clicks.push([n]) }, children: [] }); } finally { X.useState = orig; } };
    const vivoPor = f => { const g = {}; M.por.filter(x => x.vivo > 0).forEach(x => { g[f(x)] = (g[f(x)] || 0) + x.vivo; }); return g; };
    const cd = compo('deudor');
    const segs = conClase(conClase(cd, 'cbv-segbar')[0], 'seg');
    const filasC = conClase(cd, 'rdv-comp-f');
    const porDeudor = vivoPor(x => X.properCase(x.nombre));
    const grupos = Object.keys(porDeudor).map(k => ({ k, v: porDeudor[k] })).sort((a, b) => b.v - a.v);
    const esperadas = grupos.length > 6 ? grupos.slice(0, 5).concat([{ k: 'Otros ' + (grupos.length - 5), v: suma(grupos.slice(5), x => x.v) }]) : grupos;
    R.eq('R15 la barra segmentada reparte el capital en la calle (' + X.fmt(M.vivo) + ') entre los deudores',
      segs.map(s => s.props.style.flexGrow), esperadas.map(g => g.v));
    R.eq('R15 y suma exactamente el capital en la calle', suma(segs, s => s.props.style.flexGrow), M.vivo);
    R.eq('R15 la lista repite cada parte con su monto y su porcentaje',
      filasC.map(f => textos(f).join('|')), esperadas.map(g => g.k + '|' + X.fmt(g.v) + '|' + Math.round(g.v / M.vivo * 100) + '%'));
    R.check('R15 cada parte con su color de serie (s1, s2...), sin colores en linea',
      segs.every((s, i) => clsDe(s).indexOf('s' + (i + 1)) !== -1) && filasC.every((f, i) => clsDe(conClase(f, 'cbv-dot')[0]).indexOf('s' + (i + 1)) !== -1));
    R.check('R15 anti-vacio: mas de 6 deudores con capital, asi que los menores se agrupan en "Otros"', grupos.length > 6 && /^Otros \d+$/.test(esperadas[5].k), grupos.length);
    const otros = filasC[filasC.length - 1];
    R.check('R15 "Otros" no es clicable; cada deudor si (abre su panel en Cartera)',
      otros.tag === 'div' && !otros.props.onClick && filasC.slice(0, -1).every(f => f.tag === 'button' && typeof f.props.onClick === 'function'));
    clicks.length = 0;
    filasC[0].props.onClick();
    const mayor = M.por.find(x => X.properCase(x.nombre) === esperadas[0].k);
    R.check('R15 un clic en un deudor llama a Cartera con su nombre tal como esta guardado', clicks.length === 1 && clicks[0][0] === mayor.nombre, clicks);
    // Construido: el deudor mas grande del fixture ya esta guardado en Proper Case, asi que no distingue el
    // nombre guardado del rotulo. Con el nombre guardado en mayusculas, Cartera tiene que recibir ESE.
    const enMayus = mayor.nombre.toUpperCase();
    const M2 = Object.assign({}, M, { por: M.por.map(x => (x.nombre === mayor.nombre ? Object.assign({}, x, { nombre: enMayus }) : x)) });
    clicks.length = 0;
    conClase(pintar({ type: X.RdvComposicion, props: { M: M2, onNameClick: n => clicks.push([n]) }, children: [] }), 'rdv-comp-f')[0].props.onClick();
    R.check('R15 con el nombre guardado en mayusculas, Cartera recibe "' + enMayus + '" (no el rotulo en Proper Case)',
      enMayus !== X.properCase(enMayus) && clicks.length === 1 && clicks[0][0] === enMayus, clicks);
    const top3 = Math.round(suma(esperadas.slice(0, 3), g => g.v) / M.vivo * 100);
    R.check('R15 la nota dice cuanto capital esta en los 3 deudores mas grandes (' + top3 + '%)',
      textos(conClase(cd, 'rdv-nota')[0]).join('').indexOf(top3 + '% de tu capital está en los 3 deudores más grandes') !== -1);
    R.check('R15 el subtitulo nombra el capital en la calle', textos(cd).join('').indexOf('Capital en la calle · ' + X.fmt(M.vivo)) !== -1);
    const porMod = vivoPor(x => x.loan.modalidad);
    const tMod = textos(compo('modalidad')).join(' ');
    const ROT = { 'Prestamo': 'Préstamo', 'Pago Unico': 'Pago único', 'Interes Diario': 'Interés diario' };
    R.check('R15 por modalidad: cada modalidad con capital, rotulada con tildes',
      Object.keys(porMod).every(m => tMod.indexOf(ROT[m] || m) !== -1) && !/\b(Pago Unico|Interes Diario|Prestamo)\b/.test(tMod),
      { modalidades: Object.keys(porMod), texto: tMod });
    R.check('R15 anti-vacio: el fixture tiene capital vivo en una modalidad que lleva tilde', Object.keys(porMod).some(m => ROT[m]), Object.keys(porMod));
    const porMon = vivoPor(x => x.loan.moneda);
    const tMon = textos(compo('moneda')).join('');
    R.check('R15 por moneda: la parte en dolares con su porcentaje',
      tMon.indexOf('Dólares (USD)') !== -1 && tMon.indexOf(Math.round((porMon.USD || 0) / M.vivo * 100) + '% del capital en la calle está en dólares') !== -1, tMon);
    R.check('R15 por modalidad y por moneda ninguna fila es clicable (solo los deudores abren Cartera)',
      ['modalidad', 'moneda'].every(t => conClase(compo(t), 'rdv-comp-f').every(f => f.tag === 'div' && !f.props.onClick)));

    // ── El movimiento: con la ventana visible la vista entra animada y las cifras cuentan desde 0 ──
    X.document.hidden = false;
    const visibleR = montarR(X.PortfolioView, propsR, []);
    X.document.hidden = true;
    const ocultaR = montarR(X.PortfolioView, propsR, []);
    R.check('R16 ventana visible: la vista lleva la clase "anima" y las cifras en pesos arrancan en $0',
      clsDe(visibleR).indexOf('anima') !== -1 && conClase(visibleR, 'rdv-cifra-v').filter((n, i) => i !== 1).every(n => textos(n).join('') === '$0'));
    R.check('R16 ventana oculta: sin "anima" y las cifras con su valor final', clsDe(ocultaR).indexOf('anima') === -1 &&
      textos(conClase(ocultaR, 'rdv-cifra-v')[3]).join('') === dinero(M.vivo));
  }
  let rendVacio = null; error = null;
  try { rendVacio = montarR(X.PortfolioView, { loans: [], pays: [] }, []); } catch (e) { error = e; }
  R.check('R11 sin prestamos: un estado vacio, sin excepciones', !!rendVacio && textos(rendVacio).join(' ').indexOf('Todavía no hay préstamos') !== -1, error && String(error));

  // ── E — GUARDAS ESTATICAS ─────────────────────────────────────────────────
  // El layout no se puede medir en el arnes (no hay motor de CSS): se fijan las reglas que lo sostienen.
  // Se comparan sin comentarios y sin espacios, para que el formato de la hoja no las rompa.
  R.seccion('E — las hojas del rediseño v4, el marco y lo que salio del Resumen anterior');
  const leerRepo = p => fs.readFileSync(path.join(REPO, p), 'utf8');
  const compacto = c => c.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, '');
  const css = leerRepo('public/css/styles.css'), cssC = compacto(css);
  const base = compacto(leerRepo('public/css/base.css'));
  const rz = compacto(leerRepo('public/css/resumen.css'));
  const app = leerRepo('public/js/app.js');
  const index = leerRepo('public/index.html');
  R.check('E1 SparklineChart ya no existe (solo lo usaba el Inicio viejo)', !fs.existsSync(path.join(REPO, 'public/js/componentes/SparklineChart.js')));
  R.check('E1 index.html carga styles.css, base.css y resumen.css, en ese orden (cada una gana los empates de la anterior)',
    /href="\/css\/styles\.css">\s*<link[^>]*href="\/css\/base\.css">\s*<link[^>]*href="\/css\/resumen\.css">/.test(index));
  R.check('E1 y rendimiento.css va despues de cartera.css (reutiliza sus pastillas, y las de cobros.css)',
    /href="\/css\/cartera\.css">\s*<link[^>]*href="\/css\/rendimiento\.css">/.test(index));
  // Lo que salio: la version anterior del Resumen. Lo que queda: las tarjetas del analisis, que usa Rendimiento.
  const VIEJAS = /\.rz(\{|-(hero|puntos|cifras?|cifra-[a-z]+|cobrar|pc-[a-z]+|meta|meta-lista|mov|mov-lista|mov-dia|mv|mv-ico|li|li-[nsv]|lista|fila|filas|ring-wrap|mes-nav|analisis|analisis-[hs]|scroll|saludo|fecha|insight|acciones|btn|link|full)\b)/;
  R.check('E2 styles.css sin las clases .dash-* ni las del Resumen anterior', !/\.dash-(card|lists|container|list-body)/.test(css) && !VIEJAS.test(cssC),
    (cssC.match(new RegExp(VIEJAS.source, 'g')) || []).slice(0, 10));
  // Desde el rediseño v4 de Rendimiento, el analisis del negocio se dibuja alli (rendimiento.css): las
  // tarjetas viejas (`.rz-`) y la tabla vieja de Rendimiento (`.rd-`) salieron de styles.css y del codigo.
  R.check('E2 styles.css ya no tiene las tarjetas viejas del analisis (.rz-) ni la tabla vieja de Rendimiento (.rd-)',
    !/\.rz[-{]/.test(cssC) && !/\.rd[-{]/.test(cssC), (cssC.match(/\.r[dz][-{][a-z0-9-]*/g) || []).slice(0, 10));
  R.check('E2 ni el Resumen ni Rendimiento pintan ya clases rz- ni rd- (ni la dona ni el grafico SVG)',
    ['public/js/vistas/DashView.js', 'public/js/vistas/PortfolioView.js'].every(f => !/['" ]r[dz]-[a-z]/.test(leerRepo(f))) &&
    ['RzFlujo', 'RzComposicion', 'RzCard', 'RzSeg', 'RZ_PALETA'].every(n => leerRepo('public/js/vistas/DashView.js').indexOf(n) === -1));
  R.check('E3 la Posicion neta salio: App ya no le pasa las deudas propias al Resumen y la vista no las lee',
    /h\(DashView,\s*\{/.test(app) && !/h\(DashView,\s*\{[^}]*debts/.test(app) && !/debts/.test(leerRepo('public/js/vistas/DashView.js')));
  // La fila de tres tarjetas y sus listas (regla de 3.4.1: las listas parten de 0 con un minimo y llenan la tarjeta).
  R.check('E4 la fila de tres: Por cobrar 5 + Meta 4 + movimientos 3 columnas de la rejilla de 12',
    rz.indexOf('.v4{display:grid;grid-template-columns:repeat(12,minmax(0,1fr))') !== -1 &&
    rz.indexOf('.v4-cobrar{grid-column:span5;}.v4-meta{grid-column:span4;}.v4-mov{grid-column:span3;}') !== -1);
  R.check('E4 las listas llenan su tarjeta: parten de 0 con un minimo (250 / 150 / 250 px)',
    rz.indexOf('.v4-pc-lista{flex:110;min-height:250px;}') !== -1 && rz.indexOf('.v4-meta-lista{flex:110;min-height:150px;}') !== -1 &&
    rz.indexOf('.v4-mov-lista{flex:110;min-height:250px;}') !== -1);
  R.check('E4 a 1.439 px o menos, Por cobrar a lo ancho con sus dos listas lado a lado y tope de 320 px; Meta y movimientos mitad y mitad',
    /@media\(max-width:1439px\)\{\.v4-cobrar\{grid-column:1\/-1;\}\.v4-cobrar\.v4-pc\{flex-direction:row;[^}]*\}\.v4-cobrar\.v4-pc-sec\{flex:110;\}\.v4-cobrar\.v4-pc-lista\{max-height:320px;\}\.v4-meta,\.v4-mov\{grid-column:span6;\}/.test(rz));
  R.check('E4 a 1.180 px o menos, todo apilado y las listas con tope de 360 px',
    /@media\(max-width:1180px\)\{[^@]*\.v4-meta,\.v4-mov\{grid-column:1\/-1;\}\.v4-meta-lista,\.v4-mov-lista\{max-height:360px;\}/.test(rz));
  R.check('E4 "reducir movimiento" del sistema apaga las animaciones del Resumen',
    rz.indexOf('@media(prefers-reduced-motion:reduce){.v4*,.v4*::after,.v4*::before{animation:none!important;transition:none!important;}}') !== -1);
  // La base global: la paleta de Control TC, los tokens viejos re-mapeados, Inter local y la pildora.
  R.check('E5 base.css: negro real y blanco perla, y los tokens de siempre re-mapeados a la paleta nueva',
    base.indexOf('--page:#000000;') !== -1 && base.indexOf('--page:#f6f6f3;') !== -1 &&
    ['--bg:var(--page)', '--bg2:var(--surface)', '--text:var(--ink)', '--green:var(--good-text)', '--red:var(--crit-text)', '--blue:var(--accent)'].every(s => base.split(s).length === 3));
  const fuentes = (leerRepo('public/css/base.css').match(/url\((\/fonts\/[^)]+)\)/g) || []).map(u => u.slice(4, -1));
  R.check('E5 Inter se sirve desde public/fonts (las dos fuentes existen) con su licencia OFL',
    fuentes.length === 2 && fuentes.every(f => fs.existsSync(path.join(REPO, 'public', f))) && fs.existsSync(path.join(REPO, 'public/fonts/Inter-OFL.txt')), fuentes);
  R.check('E5 la barra de desplazamiento es una pildora, y nadie la devuelve a la del sistema (scrollbar-* a auto con !important)',
    base.indexOf('::-webkit-scrollbar-thumb{background-color:var(--scroll);background-clip:padding-box;border:3pxsolidtransparent;border-radius:999px;') !== -1 &&
    base.indexOf('@supportsselector(::-webkit-scrollbar){*,*::before,*::after{scrollbar-width:auto!important;scrollbar-color:auto!important;}}') !== -1);
  // El marco: toda clase que app.js le pone al menu y al encabezado tiene su regla en base.css.
  const marco = ['sidebar-marca', 'sidebar-nombre', 'sidebar-activos', 'nav-grupo', 'nav-seccion', 'nav-sep', 'mh-menu', 'mh-titulo', 'mh-acciones', 'mh-badge', 'mh-btn'];
  R.check('E6 el menu y el encabezado de app.js llevan sus clases y cada una tiene su regla en base.css',
    marco.every(c => app.indexOf("'" + c) !== -1 && base.indexOf('.' + c) !== -1), marco.filter(c => app.indexOf("'" + c) === -1 || base.indexOf('.' + c) === -1));
  R.check('E6 el marco ya no pinta colores en linea (los iconos toman el color de su boton)',
    !/sidebar-header[\s\S]{0,400}color:'var\(--green\)'/.test(app) && !/className:'nav-item'[^\n]*\n[^\n]*color:view===id/.test(app));
  // Compatibilidad: el panel del deudor (Cobros y Cartera, sin rediseñar) se pega bajo el encabezado nuevo.
  const pad = (base.match(/\.main-content\{padding:(\d+)px/) || [])[1], alto = (base.match(/\.main-header\{height:(\d+)px/) || [])[1];
  // Desde la fase 3 (Cartera) el panel del deudor de las dos pestañas se posiciona en panel.css, bajo `.v4p`.
  const panelCss = compacto(leerRepo('public/css/panel.css'));
  R.check('E7 el panel del deudor se ajusta al marco nuevo: sube lo que mide el relleno (' + pad + ' px) y ocupa el alto bajo el encabezado (' + alto + ' px)',
    !!pad && !!alto && panelCss.indexOf('.v4p.op-lado:not(.superpuesto){top:-' + pad + 'px;max-height:calc(100vh-' + alto + 'px);') !== -1 &&
    base.indexOf('.op-lado') === -1, { pad, alto });
  R.check('E7 App le pasa a Rendimiento la navegacion a Cartera', /h\(PortfolioView,\{[^}]*onNameClick:openDebtorByName/.test(app));
  // Desde el arranque v4 el fondo sale de la paleta del tema guardado (desktop/splash.js): #000000 en oscuro.
  R.check('E8 la ventana principal nace con el fondo del tema (#000000 en oscuro), sin el azul de antes',
    /async function createWindow\(\)\s*\{[\s\S]{0,300}backgroundColor:\s*PALETAS\[leerTemaArranque\(\)\]\.bg/.test(leerRepo('desktop/main.js')) &&
    require(require('path').join(__dirname, '..', 'desktop', 'splash.js')).PALETAS.dark.bg === '#000000');
  R.check('E9 nada del prototipo en produccion (ni ?anim=1 ni el chip de prototipo)',
    ['__V4_FORZAR_MOV', 'v4-forzar', 'proto-chip', 'rendimiento-actual', 'resumen-actual'].every(s => ['public/js/vistas/DashView.js', 'public/js/vistas/PortfolioView.js',
      'public/css/base.css', 'public/css/resumen.css', 'public/css/rendimiento.css'].every(f => leerRepo(f).indexOf(s) === -1)));
  // Rendimiento v4: las reglas de rendimiento.css que sostienen lo que aprobo el PO.
  const rd = compacto(leerRepo('public/css/rendimiento.css'));
  const pv = leerRepo('public/js/vistas/PortfolioView.js');
  // Salvo las que solo NOMBRAN una pieza (la tarjeta del flujo y las columnas de la tabla sin estilo propio:
  // las usan las pruebas y las reglas de ancho de las demas columnas).
  const RDV_SOLO_NOMBRE = ['rdv-flujo', 'rdv-col-ganancia', 'rdv-col-saldo', 'rdv-col-estado'];
  const rdvUsadas = Array.from(new Set((pv.match(/rdv-[a-z0-9-]+/g) || []).filter(c => !/-$/.test(c) && RDV_SOLO_NOMBRE.indexOf(c) === -1)));
  R.check('E10 cada clase rdv- que pinta Rendimiento tiene su regla en rendimiento.css (' + rdvUsadas.length + ' clases)',
    rdvUsadas.length > 20 && rdvUsadas.every(c => new RegExp('\\.' + c + '(?![a-z0-9-])').test(rd)), rdvUsadas.filter(c => !new RegExp('\\.' + c + '(?![a-z0-9-])').test(rd)));
  R.check('E10 todo lo propio vive bajo `.v4r` (la raiz) o con prefijo rdv-, y la cifra en dolares va en gris',
    rd.indexOf('.v4r{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));') !== -1 && rd.indexOf('.v4r.dp-usd{color:var(--ink-3);}') !== -1);
  R.check('E10 el flujo: intereses en verde, capital en gris y lo por cobrar rayado (sin degradados de color)',
    rd.indexOf('.rdv-barras.barrai.int,.rdv-leyi.int,.v4r.v4-tipi.int{background:var(--good-text);}') !== -1 &&
    rd.indexOf('.rdv-barras.barrai.cap,.rdv-leyi.cap,.v4r.v4-tipi.cap{background:var(--bar-muted);}') !== -1 &&
    rd.indexOf('.rdv-barras.barrai.proy,.rdv-leyi.proy,.v4r.v4-tipi.proy{background:repeating-linear-gradient(135deg,var(--bar-muted)02px,transparent2px5px);') !== -1);
  R.check('E10 las barras de rentabilidad van en gris y la de recuperado en azul',
    rd.indexOf('.rdv-rent-bi{display:block;height:100%;border-radius:inherit;background:var(--ink-3);') !== -1 &&
    rd.indexOf('.rdv-barrai{display:block;height:100%;border-radius:inherit;background:var(--accent);') !== -1);
  R.check('E10 a 1.640 px o menos los titulos de la tabla parten en dos lineas para que quepa sin desplazarse',
    /@media\(max-width:1640px\)\{\.rdv-tth\{white-space:normal;line-height:1\.3;\}/.test(rd));
  R.check('E10 a 1.170 px o menos se esconden capital y recuperado (estan a un clic, en el panel)',
    /@media\(max-width:1170px\)\{\.rdv-col-capital,\.rdv-col-recuperado\{display:none;\}/.test(rd));
  R.check('E10 "reducir movimiento" del sistema apaga las animaciones de Rendimiento',
    rd.indexOf('@media(prefers-reduced-motion:reduce){.v4r*,.v4r*::before,.v4r*::after{animation:none!important;transition:none!important;}}') !== -1);

  process.exit(R.finalizar());
})().catch(e => { console.error(e); process.exit(1); });
