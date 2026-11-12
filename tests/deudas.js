// tests/deudas.js — la pestaña Mis deudas (rediseño v4) contra el fixture y el server real.
//
// Mis deudas no tiene motor financiero: el saldo de cada deuda lo recalcula el backend desde su ledger
// (`monto_original + Σcargos − Σabonos`, v1.12.0). Lo que hace la VISTA es agregarlo (por acreedor y en
// total), sintetizar la fila de apertura que no vive en `pagos_deudas` (Bug #54) y llevar el saldo
// corrido fila a fila. Ahi es donde se puede equivocar sin que `e2e-api` lo note. Esta suite fija:
//
//   A. LAS FUNCIONES PURAS: `dbvPctAbonado` (blindado contra datos corruptos: nunca NaN ni Infinity) y
//      `dbvMovimientos` contra el ledger REAL de cada deuda del fixture: el saldo corrido termina
//      EXACTAMENTE en el saldo que guarda el backend, con la apertura solo si hubo monto de apertura.
//   B. EL ENCABEZADO: lo que debes en total, lo abonado de lo cargado y "A quien le debes" (la barra
//      segmentada por acreedor), recalculados aparte desde la API; con mas de 6 acreedores, "Otros".
//   C. LOS ACREEDORES: Activos e Inactivos, el orden por la deuda mas antigua, la agrupacion sin
//      distinguir mayusculas (construida: el fixture no la trae) y lo que dice cada tarjeta.
//   D. CADA DEUDA COMO CUENTA CORRIENTE: Cargado − Abonado = Saldo, el avance, los movimientos con su
//      etiqueta y su saldo corrido, la barra fina de la tarjeta cerrada (su gate de tres condiciones),
//      "Cargando" / "Reintentar" y las acciones cableadas a la deuda correcta.
//   E. LA PRESENTACION v4: sin colores en linea ni el amarillo de antes, las etiquetas suaves, el
//      movimiento (cifras que cuentan desde 0 con la ventana visible) y el estado vacio.
//   F. CONTRA EL SERVER REAL: un abono, un cargo y la reactivacion de una deuda pagada; la cuenta de la
//      vista sigue cuadrando con el saldo nuevo y la deuda reactivada pasa a Activos.
//   G. GUARDAS ESTATICAS: deudas.css (sus reglas, el acordeon mudado de styles.css), el orden de las
//      hojas en index.html, y que styles.css no conserva nada de la vista anterior.
//
// Se ejecuta:
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron tests/deudas.js

const fs   = require('fs');
const path = require('path');
const { Reporter }          = require('./lib/report');
const { copiaDeProduccion } = require('./lib/db');
const { REPO }              = require('./lib/paths');

const R = new Reporter('deudas');

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
async function traer(S, ruta) {
  const r = await pedir(S, 'GET', ruta);
  if (r.status !== 200) throw new Error('GET ' + ruta + ' ' + r.status);
  return r.body;
}

// ── Arnes de render (el de `resumen`) ────────────────────────────────────────
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
const suma = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
const unir = n => textos(n).join('');

// ═════════════════════════════════════════════════════════════════════════════
(async () => {
  const dbPath = copiaDeProduccion('deudas');
  const S = await arrancar(dbPath);
  let debts, ledger = {};
  try {
    debts = await traer(S, '/api/debts');
    for (const d of debts) ledger[d.id] = (await traer(S, '/api/debts/' + d.id)).pagos;
  } catch (e) { await cerrar(S); throw e; }

  const { cargarFrontend } = require('./lib/load-frontend');
  const FE = cargarFrontend({ silenciarConsola: true });
  const X = FE.sandbox;
  X.Date = Date;
  X.document.hidden = true;             // sin animacion: las cifras muestran su valor final

  // El estado de la vista, en orden: acreedores abiertos, ledger por deuda, deudas abiertas, anima.
  const montar = (props, estado) => {
    const orig = X.useState; let i = 0;
    X.useState = init => { const k = i++;
      const v = (estado && k < estado.length && estado[k] !== undefined) ? estado[k] : (typeof init === 'function' ? init() : init);
      return [v, () => {}]; };
    try { return pintar({ type: X.DebtsView, props, children: [] }); } finally { X.useState = orig; }
  };
  const llamadas = [];
  const nada = () => {};
  const props = ds => ({ debts: ds, onReload: () => llamadas.push(['reload']), onNew: () => llamadas.push(['new']),
    onPay: (d, t) => llamadas.push(['pay', d.id, t]), onEdit: d => llamadas.push(['edit', d.id]), onDelete: d => llamadas.push(['delete', d.id]) });
  // La vista con TODO abierto y los ledgers ya cargados (lo que haria el efecto al abrir).
  const firma = d => [d.id, d.saldo_pendiente, d.total_cargos, d.total_abonos, d.monto_original].join('|');
  const todoAbierto = (ds, led) => {
    const exp = {}, abiertas = {}, movs = {};
    ds.forEach(d => { exp[(d.acreedor || '').trim().toLowerCase()] = true; abiertas[d.id] = true; movs[d.id] = { firma: firma(d), pagos: led[d.id] || [], error: false }; });
    return [exp, movs, abiertas];
  };

  R.seccion('0 — el arnes ve la vista y el fixture trae deudas con movimientos');
  R.check('0 la vista expone DebtsView, dbvPctAbonado y dbvMovimientos',
    ['DebtsView', 'dbvPctAbonado', 'dbvMovimientos'].every(k => typeof X[k] === 'function'));
  const conCargos = debts.filter(d => +d.total_cargos > 0), conAbonos = debts.filter(d => +d.total_abonos > 0);
  const pagadas = debts.filter(d => d.estado !== 'Activa'), activas = debts.filter(d => d.estado === 'Activa');
  R.check('0 anti-vacio: hay deudas activas y pagadas, con cargos y con abonos, y una que arranco en $0',
    activas.length > 0 && pagadas.length > 0 && conCargos.length > 0 && conAbonos.length > 0 && debts.some(d => +d.monto_original === 0),
    { activas: activas.length, pagadas: pagadas.length, cargos: conCargos.length, abonos: conAbonos.length });

  // ── A — LAS FUNCIONES PURAS ───────────────────────────────────────────────
  R.seccion('A — el avance y el ledger de una deuda, contra el saldo del backend');
  const CORRUPTOS = [{}, { monto_original: null }, { monto_original: 'x', total_abonos: 'y' }, { monto_original: -5, total_abonos: 3 },
    { monto_original: NaN, total_abonos: 1 }, { monto_original: Infinity, total_abonos: 1 }, { monto_original: 0, total_abonos: 100 },
    { monto_original: 0, total_cargos: 0, total_abonos: 0 }, { monto_original: 100, total_abonos: -50 }, { monto_original: 100, total_abonos: 500 },
    { monto_original: '1000', total_cargos: '500', total_abonos: '750' }, { monto_original: undefined, total_cargos: 200, total_abonos: 50 }, { total_abonos: Infinity }];
  const pcts = CORRUPTOS.map(d => X.dbvPctAbonado(d));
  R.check('A1 el avance nunca es NaN ni Infinity, y siempre queda entre 0 y 100 (13 entradas corruptas)',
    pcts.every(p => typeof p === 'number' && isFinite(p) && p >= 0 && p <= 100), pcts);
  R.eq('A1 una cuenta sin nada cargado no tiene avance que medir: 0 (no 100 ni Infinity, aunque traiga abonos)',
    [X.dbvPctAbonado({ monto_original: 0, total_abonos: 100 }), X.dbvPctAbonado({ total_abonos: Infinity }), X.dbvPctAbonado({ monto_original: -5, total_abonos: 3 })], [0, 0, 0]);
  R.eq('A1 y mide lo abonado sobre lo cargado (apertura + cargos), redondeado', [X.dbvPctAbonado({ monto_original: 1000, total_cargos: 500, total_abonos: 750 }),
    X.dbvPctAbonado({ monto_original: 0, total_cargos: 3, total_abonos: 1 }), X.dbvPctAbonado({ monto_original: 1000, total_abonos: 1000 })], [50, 33, 100]);
  const malLedger = debts.filter(d => {
    const filas = X.dbvMovimientos(d, ledger[d.id]);
    const ultimo = filas.length ? filas[filas.length - 1].saldo : 0;
    return Math.round(ultimo) !== Math.round(+d.saldo_pendiente);
  }).map(d => d.titulo);
  R.check('A2 en CADA deuda del fixture el saldo corrido termina en el saldo que guarda el backend', malLedger.length === 0, malLedger);
  R.check('A2 la apertura se sintetiza solo si hubo monto de apertura, y es la primera fila', debts.every(d => {
    const filas = X.dbvMovimientos(d, ledger[d.id]);
    const conApertura = filas.length > 0 && filas[0].m.tipo === 'apertura';
    return conApertura === (+d.monto_original > 0) && filas.length === (ledger[d.id] || []).length + (conApertura ? 1 : 0) &&
      (!conApertura || (filas[0].m.monto_pagado === +d.monto_original && filas[0].m.notas === (d.concepto || '')));
  }));
  R.check('A2 las filas van del movimiento mas viejo al mas nuevo', debts.every(d => {
    const f = X.dbvMovimientos(d, ledger[d.id]).map(x => String(x.m.fecha_pago).slice(0, 10));
    return f.every((x, i) => i === 0 || f[i - 1] <= x);
  }));
  // Construido: dos movimientos del MISMO dia. La API los devuelve del mas nuevo al mas viejo (B, A);
  // la cuenta tiene que leerlos en el orden en que ocurrieron (A, B), o el saldo corrido intermedio miente.
  const mismoDia = X.dbvMovimientos({ id: 'z', monto_original: 1000, concepto: '', fecha_creacion: '2026-07-01' },
    [{ id: 'B', tipo: 'cargo', monto_pagado: 500, fecha_pago: '2026-07-10' }, { id: 'A', tipo: 'abono', monto_pagado: 300, fecha_pago: '2026-07-10' }]);
  R.eq('A2 dos movimientos del mismo dia se leen en el orden en que ocurrieron, con su saldo corrido',
    mismoDia.map(x => x.m.id + ':' + x.saldo), ['apertura-z:1000', 'A:700', 'B:1200']);
  const larga = debts.find(d => (ledger[d.id] || []).length > 10);
  R.check('A2 anti-vacio: una cuenta con mas de 10 movimientos que arranco en $0 (sin fila de apertura)',
    !!larga && +larga.monto_original === 0 && X.dbvMovimientos(larga, ledger[larga.id])[0].m.tipo !== 'apertura');

  // ── B — EL ENCABEZADO ─────────────────────────────────────────────────────
  R.seccion('B — lo que debes y a quien se lo debes');
  const cerrada = montar(props(debts), []);
  const totalAct = suma(activas, d => +d.saldo_pendiente);
  const cargadoAct = suma(activas, d => +d.monto_original + +d.total_cargos), abonadoAct = suma(activas, d => +d.total_abonos);
  const hero = conClase(cerrada, 'dbv-hero')[0];
  R.eq('B1 "Debes en total" = la suma del saldo de las deudas activas', unir(conClase(hero, 'dbv-hero-v')[0]), '$' + X.fmt(totalAct).replace(/^\$\s*/, ''));
  const acreAct = Array.from(new Set(activas.map(d => d.acreedor.trim().toLowerCase())));
  R.eq('B1 y debajo, cuantas deudas activas, con cuantos acreedores y cuantas pagadas', unir(conClase(hero, 'cbv-hero-s')[0]),
    activas.length + ' deudas activas con ' + acreAct.length + ' acreedores · ' + pagadas.length + ' pagada' + (pagadas.length === 1 ? '' : 's'));
  const pctAct = Math.round(abonadoAct / cargadoAct * 100);
  R.check('B2 el avance del total: lo abonado de lo cargado en las activas (' + pctAct + '%)',
    textos(conClase(hero, 'dbv-avance')[0]).join('|') === 'Llevas abonado ' + X.fmt(abonadoAct) + ' de ' + X.fmt(cargadoAct) + '|' + pctAct + '%' &&
    conClase(hero, 'dbv-barra')[0].kids[0].props.style.width === pctAct + '%');
  const porAcre = {}; activas.forEach(d => { const k = d.acreedor.trim().toLowerCase(); porAcre[k] = (porAcre[k] || 0) + +d.saldo_pendiente; });
  const esperadoAcre = Object.keys(porAcre).map(k => ({ k, v: porAcre[k] })).sort((a, b) => b.v - a.v);
  const segs = conClase(conClase(hero, 'cbv-segbar')[0], 'seg');
  R.eq('B3 "A quién le debes": la barra segmentada reparte el saldo activo entre los acreedores', segs.map(s => s.props.style.flexGrow), esperadoAcre.map(x => x.v));
  R.eq('B3 y suma exactamente lo que debes en total', suma(segs, s => s.props.style.flexGrow), totalAct);
  R.eq('B3 la lista repite cada acreedor con su saldo y su porcentaje', conClase(hero, 'rdv-comp-f').map(f => textos(f).join('|')),
    esperadoAcre.map(x => X.properCase(x.k) + '|' + X.fmt(x.v) + '|' + Math.round(x.v / totalAct * 100) + '%'));
  R.check('B3 cada acreedor con su color de serie (s1, s2...)', segs.every((s, i) => clsDe(s).indexOf('s' + (i + 1)) !== -1) &&
    conClase(hero, 'rdv-comp-f').every((f, i) => clsDe(conClase(f, 'cbv-dot')[0]).indexOf('s' + (i + 1)) !== -1));
  // Construido: el fixture tiene 3 acreedores con saldo. Con 8, los cinco mayores y "Otros 3".
  const ocho = [1, 2, 3, 4, 5, 6, 7, 8].map(n => ({ id: 'x' + n, titulo: 'T' + n, acreedor: 'Acreedor ' + n, concepto: '', monto_original: n * 1000,
    saldo_pendiente: n * 1000, estado: 'Activa', fecha_creacion: '2026-07-0' + n, total_cargos: 0, total_abonos: 0 }));
  const vOcho = conClase(montar(props(ocho), []), 'rdv-comp-f').map(f => textos(f)[0]);
  R.eq('B4 con mas de 6 acreedores, los cinco mayores y el resto en "Otros"', vOcho, ['Acreedor 8', 'Acreedor 7', 'Acreedor 6', 'Acreedor 5', 'Acreedor 4', 'Otros 3']);
  const soloPagadas = montar(props(pagadas), []);
  R.check('B5 sin deudas activas: el encabezado lo dice y no dibuja barra', unir(soloPagadas).indexOf('No tienes deudas activas: todo está saldado.') !== -1 &&
    conClase(soloPagadas, 'cbv-segbar').length === 0 && unir(conClase(soloPagadas, 'dbv-hero-v')[0]) === '$0');

  // ── C — LOS ACREEDORES ────────────────────────────────────────────────────
  R.seccion('C — los acreedores: Activos e Inactivos, orden y agrupacion');
  const tarjetas = conClase(cerrada, 'dbv-acreedor');
  const nombresT = tarjetas.map(t => unir(conClase(t, 'dbv-acreedor-c')[0].kids[0]));
  const ts = s => new Date(String(s || '').replace(' ', 'T')).getTime() || 0;
  const grupos = {}; debts.forEach(d => { const k = d.acreedor.trim().toLowerCase(); (grupos[k] = grupos[k] || []).push(d); });
  const orden = Object.keys(grupos).map(k => ({ k, act: grupos[k].some(d => d.estado === 'Activa'), viejo: Math.min.apply(null, grupos[k].map(d => ts(d.fecha_creacion))) }))
    .sort((a, b) => b.viejo - a.viejo || X.properCase(a.k).localeCompare(X.properCase(b.k)));
  const esperadoOrden = orden.filter(g => g.act).concat(orden.filter(g => !g.act)).map(g => X.properCase(g.k));
  R.eq('C1 una tarjeta por acreedor: primero los Activos y luego los Inactivos, cada bloque de la deuda mas reciente a la mas antigua', nombresT, esperadoOrden);
  R.eq('C1 los separadores con su conteo', conClase(cerrada, 'dbv-grupo').map(g => textos(g).join('|')),
    ['Activos|' + orden.filter(g => g.act).length, 'Inactivos|' + orden.filter(g => !g.act).length]);
  const malSub = tarjetas.map((t, i) => ({ t, i })).filter(({ t, i }) => {
    const ds = grupos[esperadoOrden[i].toLowerCase()] || grupos[Object.keys(grupos).find(k => X.properCase(k) === esperadoOrden[i])];
    const a = ds.filter(d => d.estado === 'Activa'), p = ds.length - a.length;
    const sub = a.length ? a.length + ' deuda' + (a.length === 1 ? ' activa' : 's activas') + (p ? ' · ' + p + ' pagada' + (p === 1 ? '' : 's') : '')
      : p + ' deuda' + (p === 1 ? ' pagada' : 's pagadas');
    const v = textos(conClase(t, 'dbv-acreedor-v')[0]);
    return unir(conClase(t, 'dbv-acreedor-c')[0].kids[1]) !== sub ||
      v[0] !== (a.length ? 'Le debes' : 'Saldado') || v[1] !== X.fmt(suma(a, d => +d.saldo_pendiente));
  }).map(({ i }) => esperadoOrden[i]);
  R.check('C2 cada tarjeta dice cuantas deudas activas y pagadas tiene, y "Le debes" o "Saldado" con su saldo', malSub.length === 0, malSub);
  R.check('C2 el avatar de un acreedor saldado va en verde suave; el de uno con saldo, neutro',
    tarjetas.every((t, i) => (clsDe(conClase(t, 'dbv-av')[0]).indexOf('saldada') !== -1) === !orden.filter(g => g.act).concat(orden.filter(g => !g.act))[i].act));
  // Construido: el mismo acreedor escrito de dos formas es UNA tarjeta, en Proper Case.
  const dos = [Object.assign({}, activas[0], { id: 'm1', acreedor: 'banco ÁGIL' }), Object.assign({}, activas[0], { id: 'm2', acreedor: '  BANCO ágil ' })];
  const vDos = conClase(montar(props(dos), []), 'dbv-acreedor');
  R.check('C3 el mismo acreedor con otras mayusculas o espacios es UNA tarjeta, rotulada en Proper Case',
    vDos.length === 1 && unir(conClase(vDos[0], 'dbv-acreedor-c')[0].kids[0]) === X.properCase('banco ÁGIL') &&
    unir(conClase(vDos[0], 'dbv-acreedor-c')[0].kids[1]) === '2 deudas activas', vDos.map(unir));
  R.check('C4 cerrado, el acreedor no muestra sus deudas: su panel nace en altura 0 (data-open="0")',
    tarjetas.every(t => conClase(t, 'acc')[0].props['data-open'] === '0'));

  // ── D — CADA DEUDA COMO CUENTA CORRIENTE ──────────────────────────────────
  R.seccion('D — la deuda como cuenta corriente: Cargado − Abonado = Saldo y sus movimientos');
  const abierta = montar(props(debts), todoAbierto(debts, ledger));
  const tarjetaDe = (arbol, d) => conClase(arbol, 'dbv-deuda').find(n => n.key === d.id || unir(conClase(n, 'dbv-deuda-c')[0].kids[0]) === d.titulo);
  const conCuenta = debts.filter(d => +d.total_cargos > 0 || +d.total_abonos > 0);
  const malCuenta = conCuenta.filter(d => {
    const c = conClase(tarjetaDe(abierta, d), 'dbv-cuenta')[0];
    if (!c) return true;
    const t = textos(c);
    const cargado = +d.monto_original + +d.total_cargos;
    return t.join('|') !== ['Cargado', X.fmt(cargado), '−', 'Abonado', X.fmt(+d.total_abonos), '=', 'Saldo', X.fmt(+d.saldo_pendiente)].join('|') ||
      cargado - +d.total_abonos !== +d.saldo_pendiente;
  }).map(d => d.titulo);
  R.check('D1 cada deuda con movimientos muestra Cargado − Abonado = Saldo, y la resta cuadra', malCuenta.length === 0, malCuenta);
  R.check('D1 anti-vacio: ' + conCuenta.length + ' deudas con movimientos (una activa con cargos y una pagada)',
    conCuenta.some(d => d.estado === 'Activa' && +d.total_cargos > 0) && conCuenta.some(d => d.estado !== 'Activa'));
  const triviales = debts.filter(d => !(+d.total_cargos > 0) && !(+d.total_abonos > 0));
  R.check('D1 una deuda de un solo cargo y sin abonos no repite su cifra: sin cuenta ni avance', triviales.length > 0 &&
    triviales.every(d => conClase(tarjetaDe(abierta, d), 'dbv-cuenta').length === 0 && conClase(tarjetaDe(abierta, d), 'dbv-avance').length === 0));
  const malAvance = conCuenta.filter(d => {
    const a = conClase(tarjetaDe(abierta, d), 'dbv-avance')[0];
    const p = X.dbvPctAbonado(d), cargado = +d.monto_original + +d.total_cargos;
    return textos(a).join('|') !== (+d.total_abonos > 0 ? 'Abonado ' + X.fmt(+d.total_abonos) + ' de ' + X.fmt(cargado) : 'Sin abonos todavía') + '|' + p + '%';
  }).map(d => d.titulo);
  R.check('D2 el avance de cada deuda: lo abonado de lo cargado y su porcentaje', malAvance.length === 0, malAvance);
  const TONO = { apertura: ['Apertura', 'info'], cargo: ['Cargo', 'crit'], abono: ['Abono', 'good'] };
  const malMovs = debts.filter(d => {
    const filas = X.dbvMovimientos(d, ledger[d.id]).slice().reverse();
    const vistas = conClase(tarjetaDe(abierta, d), 'dbv-mov');
    if (vistas.length !== filas.length) return true;
    return vistas.some((v, i) => {
      const f = filas[i], tag = conClase(v, 'v4-tag')[0], val = textos(conClase(v, 'dbv-mov-v')[0]);
      return unir(tag) !== TONO[f.m.tipo][0] || clsDe(tag).indexOf(TONO[f.m.tipo][1]) === -1 ||
        val[0] !== (f.m.tipo === 'abono' ? '− ' : '+ ') + X.fmt(f.m.monto_pagado) || val[1] !== 'saldo ' + X.fmt(f.saldo);
    });
  }).map(d => d.titulo);
  R.check('D3 los movimientos, del mas nuevo al mas viejo, cada uno con su etiqueta suave, su monto y el saldo que dejo', malMovs.length === 0, malMovs);
  R.check('D3 el primero de la lista (el mas reciente) deja el saldo de la deuda, y el titulo cuenta los movimientos', debts.every(d => {
    const t = tarjetaDe(abierta, d), n = X.dbvMovimientos(d, ledger[d.id]).length;
    const primera = conClase(t, 'dbv-mov')[0];
    return unir(conClase(t, 'dbv-sec-t')[0]) === n + ' movimiento' + (n === 1 ? '' : 's') &&
      (!primera || textos(conClase(primera, 'dbv-mov-v')[0])[1] === 'saldo ' + X.fmt(+d.saldo_pendiente));
  }));
  R.check('D3 anti-vacio: entre las deudas abiertas aparecen las tres etiquetas (Apertura, Cargo y Abono)',
    ['Apertura', 'Cargo', 'Abono'].every(t => conClase(abierta, 'v4-tag').some(n => unir(n) === t)));
  // La barra fina de la tarjeta cerrada: `activa && !trivial && !open`.
  const finaDe = (arbol, d) => tarjetaDe(arbol, d).kids.filter(k => k && k.props && clsDe(k).indexOf('fina') !== -1);
  const soloAcreedores = (() => { const e = todoAbierto(debts, ledger); return [e[0], e[1], {}]; })();
  const conAcreedores = montar(props(debts), soloAcreedores);
  const conFina = debts.filter(d => finaDe(conAcreedores, d).length === 1).map(d => d.id).sort();
  const esperaFina = debts.filter(d => d.estado === 'Activa' && (+d.total_cargos > 0 || +d.total_abonos > 0)).map(d => d.id).sort();
  R.eq('D4 cerrada, la barra fina va solo en las activas que no son triviales', conFina, esperaFina);
  R.check('D4 abierta, la barra fina desaparece (el detalle ya trae la rotulada)', debts.every(d => finaDe(abierta, d).length === 0));
  R.check('D4 la barra fina marca el mismo avance que el detalle', esperaFina.length > 0 && esperaFina.every(id => {
    const d = debts.find(x => x.id === id), b = finaDe(conAcreedores, d)[0], p = X.dbvPctAbonado(d);
    return p > 0 ? b.kids[0].props.style.width === p + '%' : b.kids.length === 0;
  }));
  // Cargando y error con su salida.
  const primeraConMovs = conCuenta[0];
  const estCargando = todoAbierto(debts, ledger); delete estCargando[1][primeraConMovs.id];
  R.check('D5 mientras llega el ledger, la deuda dice "Cargando movimientos…"',
    unir(tarjetaDe(montar(props(debts), estCargando), primeraConMovs)).indexOf('Cargando movimientos…') !== -1);
  const estError = todoAbierto(debts, ledger); estError[1][primeraConMovs.id] = { firma: firma(primeraConMovs), pagos: [], error: true };
  const tErr = tarjetaDe(montar(props(debts), estError), primeraConMovs);
  R.check('D5 si falla, lo dice y ofrece "Reintentar"', unir(tErr).indexOf('No se pudieron cargar los movimientos.') !== -1 &&
    nodos(tErr, n => n.tag === 'button' && unir(n) === 'Reintentar').length === 1);
  // Las acciones, cableadas a la deuda correcta.
  const act0 = activas.find(d => +d.total_cargos > 0), pag0 = pagadas[0];
  const botones = (arbol, d) => nodos(tarjetaDe(arbol, d), n => n.tag === 'button');
  llamadas.length = 0;
  botones(abierta, act0).forEach(b => b.props.onClick());
  R.eq('D6 una deuda activa: editar, eliminar, cargo y abonar, todos sobre ESA deuda', llamadas,
    [['edit', act0.id], ['delete', act0.id], ['pay', act0.id, 'cargo'], ['pay', act0.id, 'abono']]);
  llamadas.length = 0;
  botones(abierta, pag0).forEach(b => b.props.onClick());
  R.eq('D6 una deuda pagada: sin "Abonar", pero con "Cargo" (un cargo la reactiva)', llamadas,
    [['edit', pag0.id], ['delete', pag0.id], ['pay', pag0.id, 'cargo']]);
  R.check('D7 el estado en chip suave: Activa en ambar, Pagada en verde', debts.every(d => {
    const ch = conClase(conClase(tarjetaDe(abierta, d), 'dbv-deuda-h')[0], 'v4-chip')[0];
    return unir(ch) === d.estado && clsDe(ch).indexOf(d.estado === 'Activa' ? 'warn' : 'good') !== -1;
  }));
  llamadas.length = 0;
  nodos(cerrada, n => n.tag === 'button' && /Actualizar|Nueva deuda/.test(unir(n))).forEach(b => b.props.onClick());
  R.eq('D8 "Actualizar" y "Nueva deuda" en la cabecera', llamadas, [['reload'], ['new']]);

  // ── E — LA PRESENTACION v4 ────────────────────────────────────────────────
  R.seccion('E — sin colores en linea, etiquetas suaves, movimiento y vacio');
  const estilos = nodos(abierta, n => n.props && n.props.style).map(n => Object.keys(n.props.style)).reduce((a, k) => a.concat(k), []);
  R.check('E1 la vista no pinta colores en linea: solo anchos de barra, crecimiento de segmentos y retardos',
    estilos.length > 0 && estilos.every(k => ['width', 'flexGrow', '--i'].indexOf(k) !== -1), Array.from(new Set(estilos)));
  const fuente = fs.readFileSync(path.join(REPO, 'public/js/vistas/DebtsView.js'), 'utf8');
  R.check('E1 ni el amarillo de antes ni colores de tema en el codigo de la vista', !/var\(--(yellow|green|red|blue|gold)\)/.test(fuente) && !/background:\s*'/.test(fuente));
  R.eq('E2 la raiz es la de Mis deudas v4 (`.v4d`), sin animar con la ventana oculta', abierta.props.className, 'v4d');
  X.document.hidden = false;
  const viva = montar(props(debts), []);
  X.document.hidden = true;
  R.check('E2 con la ventana visible la vista entra animada y la cifra del total arranca en $0',
    clsDe(viva).indexOf('anima') !== -1 && unir(conClase(viva, 'dbv-hero-v')[0]) === '$0');
  const vacia = montar(props([]), []);
  R.check('E3 sin deudas: un estado vacio que invita a registrar la primera, sin encabezado ni lista',
    unir(vacia).indexOf('No tienes deudas registradas') !== -1 && conClase(vacia, 'dbv-hero').length === 0 && conClase(vacia, 'dbv-lista').length === 0);
  const sinTilde = textos(abierta).filter(s => /\b(quien|todavia|aqui|dias|quedara)\b/.test(s));
  R.check('E4 ningun texto de la vista sale sin tilde', sinTilde.length === 0, sinTilde);

  // ── F — CONTRA EL SERVER REAL ─────────────────────────────────────────────
  R.seccion('F — un abono, un cargo y la reactivacion de una pagada, contra el server real');
  try {
    const d = activas.find(x => +x.total_cargos > 0);
    const rA = await pedir(S, 'POST', '/api/debts/' + d.id + '/pay', { tipo: 'abono', monto_pagado: 123456, fecha_pago: '2026-07-30', notas: 'Abono de la suite' });
    const rC = await pedir(S, 'POST', '/api/debts/' + d.id + '/pay', { tipo: 'cargo', monto_pagado: 50000, fecha_pago: '2026-07-31', notas: 'Cargo de la suite' });
    const rR = await pedir(S, 'POST', '/api/debts/' + pag0.id + '/pay', { tipo: 'cargo', monto_pagado: 70000, fecha_pago: '2026-07-31', notas: '' });
    R.check('F1 el backend acepta el abono, el cargo y el cargo sobre la pagada', [rA, rC, rR].every(r => r.status === 200), [rA.status, rC.status, rR.status]);
    const debts2 = await traer(S, '/api/debts');
    const ledger2 = {}; for (const x of debts2) ledger2[x.id] = (await traer(S, '/api/debts/' + x.id)).pagos;
    const d2 = debts2.find(x => x.id === d.id), p2 = debts2.find(x => x.id === pag0.id);
    R.eq('F2 el saldo nuevo = el de antes − el abono + el cargo', +d2.saldo_pendiente, +d.saldo_pendiente - 123456 + 50000);
    const vista2 = montar(props(debts2), todoAbierto(debts2, ledger2));
    const t2 = tarjetaDe(vista2, d2);
    R.check('F2 la cuenta de la vista cuadra con el saldo nuevo', textos(conClase(t2, 'dbv-cuenta')[0]).join('|') ===
      ['Cargado', X.fmt(+d2.monto_original + +d2.total_cargos), '−', 'Abonado', X.fmt(+d2.total_abonos), '=', 'Saldo', X.fmt(+d2.saldo_pendiente)].join('|'));
    const movs2 = conClase(t2, 'dbv-mov');
    R.check('F2 los dos movimientos nuevos encabezan la lista, con su etiqueta y el saldo que dejaron',
      unir(conClase(movs2[0], 'v4-tag')[0]) === 'Cargo' && textos(conClase(movs2[0], 'dbv-mov-v')[0])[1] === 'saldo ' + X.fmt(+d2.saldo_pendiente) &&
      unir(conClase(movs2[1], 'v4-tag')[0]) === 'Abono' && textos(conClase(movs2[1], 'dbv-mov-v')[0])[1] === 'saldo ' + X.fmt(+d2.saldo_pendiente - 50000) &&
      unir(movs2[0]).indexOf('Cargo de la suite') !== -1);
    R.check('F2 la firma del cache cambio, asi que la vista volveria a pedir el ledger', firma(d2) !== firma(d));
    R.eq('F3 el cargo REACTIVA la deuda pagada', [p2.estado, +p2.saldo_pendiente], ['Activa', 70000]);
    const nombreP = X.properCase(pag0.acreedor);
    const ordenT2 = conClase(montar(props(debts2), []), 'dbv-acreedor').map(t => unir(conClase(t, 'dbv-acreedor-c')[0].kids[0]));
    const vistaR = montar(props(debts2), []);
    R.check('F3 y su acreedor pasa de Inactivos a Activos (y aparece en "A quién le debes")',
      ordenT2.indexOf(nombreP) !== -1 && conClase(vistaR, 'dbv-grupo').length === 1 &&
      conClase(conClase(vistaR, 'dbv-hero')[0], 'rdv-comp-f').some(f => textos(f)[0] === nombreP), { ordenT2, grupos: conClase(vistaR, 'dbv-grupo').map(unir) });
  } finally { await cerrar(S); }

  // ── G — GUARDAS ESTATICAS ─────────────────────────────────────────────────
  R.seccion('G — deudas.css, el acordeon mudado y lo que salio de styles.css');
  const leer = p => fs.readFileSync(path.join(REPO, p), 'utf8');
  const compacto = c => c.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, '');
  const dcss = compacto(leer('public/css/deudas.css')), scss = compacto(leer('public/css/styles.css'));
  R.check('G1 index.html carga deudas.css despues de rendimiento.css (reutiliza su lista de composicion)',
    /href="\/css\/rendimiento\.css">\s*<link[^>]*href="\/css\/deudas\.css">/.test(leer('public/index.html')));
  const usadas = Array.from(new Set((fuente.match(/dbv-[a-z0-9-]+/g) || []).filter(c => !/-$/.test(c))));
  const sinRegla = usadas.filter(c => !new RegExp('\\.' + c + '(?![A-Za-z0-9_-])').test(dcss));
  R.check('G2 cada clase dbv- que pinta la vista tiene su regla en deudas.css (' + usadas.length + ' clases)', usadas.length > 25 && sinRegla.length === 0, sinRegla);
  R.check('G2 la disposicion aprobada: el encabezado en dos mitades, la cuenta en una fila y cada movimiento en su rejilla',
    dcss.indexOf('.dbv-hero{display:grid;grid-template-columns:minmax(0,1fr)minmax(0,1fr);') !== -1 &&
    dcss.indexOf('.dbv-cuenta{display:flex;align-items:flex-end;') !== -1 &&
    dcss.indexOf('.dbv-mov{display:grid;grid-template-columns:82pxminmax(0,1fr)auto;') !== -1 &&
    /@media\(max-width:1180px\)\{\.dbv-hero\{grid-template-columns:1fr;\}/.test(dcss));
  R.check('G2 todo lo propio vive bajo `.v4d`, con la etiqueta del Cargo en rojo suave',
    dcss.indexOf('.v4d{display:flex;flex-direction:column;') !== -1 && dcss.indexOf('.v4d.v4-tag.crit{background:var(--crit-soft);color:var(--crit-text);}') !== -1);
  R.check('G3 el acordeon (`.acc`, `.acc-chev`) se mudo a deudas.css y salio de styles.css',
    dcss.indexOf('.acc{height:0;overflow:hidden;}') !== -1 && dcss.indexOf('.acc-chev.open{transform:rotate(90deg);}') !== -1 && !/\.acc[{-]/.test(scss));
  R.check('G3 el acordeon solo lo usa Mis deudas (si otra vista lo usara, no podria vivir en deudas.css)',
    fs.readdirSync(path.join(REPO, 'public/js/vistas')).concat(fs.readdirSync(path.join(REPO, 'public/js/componentes')).map(f => '../componentes/' + f))
      .filter(f => f !== 'DebtsView.js' && /\.js$/.test(f)).every(f => !/'acc(-chev)?['\s]|data-acc/.test(leer('public/js/vistas/' + f))));
  R.check('G4 la animacion de los paneles solo toca los de Mis deudas', fuente.indexOf("document.querySelectorAll('.v4d [data-acc]')") !== -1);
  R.check('G4 "reducir movimiento" del sistema apaga las animaciones de Mis deudas',
    dcss.indexOf('@media(prefers-reduced-motion:reduce){.acc-chev{transition:none;}.v4d*,.v4d*::before,.v4d*::after{animation:none!important;transition:none!important;}}') !== -1);
  R.check('G5 nada del prototipo en produccion', ['v4-forzar', 'proto-chip', 'PROTOTIPO'].every(s => leer('public/css/deudas.css').indexOf(s) === -1 && fuente.indexOf(s) === -1));

  process.exit(R.finalizar());
})().catch(e => { console.error(e); process.exit(1); });
