// tests/periodo-irregular.js — la cuota TRANSITORIA derivada en el motor (3.2.0, Fase 1).
//
// Una cuota de periodo irregular (hoy: la primera despues de "Cambiar fecha") cobra el
// interes de sus DIAS REALES. Hasta 3.1.0 el prestamo guardaba el MONTO de ese ajuste
// (`proximaCuotaExtra`), calculado con el saldo del dia del cambio. Un abono posterior
// regeneraba la cuota sin el ajuste y el siguiente arranque de la app le sumaba el monto
// viejo: medido con el server real, 583.333 -> abono de 8M -> 100.000 -> al reabrir la app
// 183.333, cuando lo correcto era 116.667. Guardado como monto negativo (un periodo corto)
// el mismo camino llegaba a un interes NEGATIVO.
//
// Desde 3.2.0 el prestamo guarda la DECISION (`periodoIrregularN/Desde/Mora`) y el motor
// deriva el monto sobre el capital vivo cada vez que genera esa fila. Esta suite fija:
//
//   A. MOTOR PURO. Sobre un barrido de saldos, tasas, dias y mora, la cuota derivada es
//      EXACTAMENTE la que producia /cambiar-dia-pago con su formula de siempre; el capital
//      de la cuota y el resto del cronograma no se mueven; y la cifra sigue al capital vivo.
//   B. CONTRA EL SERVER REAL. El escenario del defecto y sus variantes: abono (mantener y
//      fijar cuota), reestructura, edicion, Intereses, mora consolidada, pagar y revertir,
//      deshacer. La transitoria es correcta INMEDIATAMENTE despues del abono y no cambia al
//      "reabrir la app" (/recalculate), que es donde vivia el defecto.
//   C. MIGRACION de los prestamos guardados con el modelo viejo: exacta sobre el fixture (que
//      trae dos) y sobre un caso armado con mora y cuotas pagadas; idempotente.
//   D. GUARDA ESTATICA: ninguna ruta vuelve a leer `proximaCuotaExtra`.
//   E. EL ESPEJO DEL FRONTEND: el preview del cobro y el paso "interes del mes" de la cascada
//      producen la misma transitoria que el motor, contra los modulos REALES.
//
// FASE 2 — el PRIMER PAGO elegido al crear (tiempos muertos incluidos):
//   F. RESOLVEDOR PURO (`resolverPrimerPago`): fecha regular = prestamo de siempre; periodos
//      cortos y largos; mes completo vs proporcional; validaciones; fin de mes; y un barrido de
//      "tiempos muertos" de 1 a 400 dias con paridad frontend/motor.
//   G. CONTRA EL SERVER REAL: alta, rechazos con la BD intacta, edicion sin pagos (la fecha
//      de inicio arrastra el periodo), edicion con actividad (calendario congelado) y el
//      defecto previo del dia de pago que una edicion devolvia al dia de inicio.
//   H. EL FORMULARIO REAL (`LoanModal`) renderizado con su estado sembrado.
//
// 3.3.0, FASE 1 — el periodo de cada frecuencia y la gracia:
//   K. La formula "interes de una cuota normal x dias / dias del periodo": mensual intacto bit a
//      bit, y un periodo entero de dias = la cuota normal del motor en semanal y quincenal. El
//      primer pago en las tres frecuencias, cobrando o perdonando los dias muertos, con
//      `fechaInicioIntereses`; su migracion; y el cambio de dia de pago respetando la gracia.
//
// FASE 4 — la MORA CONSOLIDADA en la liquidacion:
//   J. Cambiar el dia de cobro NO puede mover el valor de liquidacion. La mora que el
//      endpoint mete dentro de la cuota transitoria es deuda ya causada: entra en el total,
//      se explica en el modal y en los tres documentos, y llega a la caja al liquidar.
//
// Se ejecuta:
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron tests/periodo-irregular.js

const fs   = require('fs');
const path = require('path');
const { Reporter }                  = require('./lib/report');
const { copiaDeProduccion, bdVacia } = require('./lib/db');
const { REPO, FIXTURE_DB }          = require('./lib/paths');

const R = new Reporter('periodo-irregular');

// ── RELOJ: calendario CONGELADO, reloj de ids INTACTO ────────────────────────
// Mismo instante y misma razon que `pdf-render` y `cascada-cobro`: 31-jul-2026, la fecha de
// referencia del fixture. A esa fecha sus dos transitorias viejas siguen Pendientes (vencen el
// 15-ago), asi que /recalculate las REGENERA y la seccion C prueba algo de verdad. Y los
// escenarios de B arman sus fechas contra este dia: la suite no caduca con el calendario.
// `Date.now()` queda real a proposito: construye los ids de los abonos (INSERT OR REPLACE).
const RelojReal = Date;
const INSTANTE_FIJO = new RelojReal(2026, 6, 31, 12, 0, 0);
global.Date = class extends RelojReal {
  constructor(...args) { if (args.length === 0) super(INSTANTE_FIJO.getTime()); else super(...args); }
  static now() { return RelojReal.now(); }
};

const engine    = require('../backend/core/engine');
const createApp = require('../backend/server');
const Database  = require('better-sqlite3');
const { buildSchedule, buildScheduleFixedPMT, transitoriaDe, aplicarPeriodoIrregular, sumarDias } = engine;

// ── Utilidades ───────────────────────────────────────────────────────────────
// Dias entre dos fechas ISO calculados APARTE del motor (UTC puro), para no validar al motor
// con su propia funcion.
function diasISO(a, b) {
  const [ya, ma, da] = a.split('-').map(Number);
  const [yb, mb, db] = b.split('-').map(Number);
  return Math.round((RelojReal.UTC(yb, mb - 1, db) - RelojReal.UTC(ya, ma - 1, da)) / 864e5);
}
// La formula de siempre de /cambiar-dia-pago (v1.14.0), copiada tal cual: es el contrato.
function formulaVieja(fila, tasa, dias, mora) {
  const pro = Math.round(fila.saldoInicial * (tasa / 100) * dias / 30);
  const delta = fila.interesPeriodo - pro;
  return {
    interes: Math.round(pro + mora),
    cuota: Math.round(fila.cuotaTotal - delta + mora),
    extra: Math.round(mora - delta),
  };
}
const identidadOK = rows => rows.every(p => p.interesPeriodo + p.abonoCapital === p.cuotaTotal);

function arrancar(dbPath) {
  return new Promise((resolve, reject) => {
    let app;
    try { app = createApp(dbPath); } catch (e) { return reject(e); }
    const srv = app.listen(0, '127.0.0.1', () => resolve({ srv, base: 'http://127.0.0.1:' + srv.address().port, dbPath }));
    srv.on('error', reject);
  });
}
const cerrar = S => new Promise(r => S.srv.close(() => r()));
async function pedir(S, metodo, ruta, cuerpo) {
  const o = { method: metodo, headers: {} };
  if (cuerpo !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(cuerpo); }
  const r = await fetch(S.base + ruta, o);
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch (_) {}
  return { status: r.status, json: j };
}
function leer(dbPath, fn) {
  const d = new Database(dbPath, { readonly: true });
  try { return fn(d); } finally { d.close(); }
}
function escribir(dbPath, fn) {           // SOLO sobre copias de trabajo (lib/db.js)
  const d = new Database(dbPath);
  try { return fn(d); } finally { d.close(); }
}
const filasDe  = (S, id) => leer(S.dbPath, d => d.prepare('SELECT * FROM payments WHERE prestamoId = ? ORDER BY cuotaN').all(id));
const filaDe   = (S, id, n) => leer(S.dbPath, d => d.prepare('SELECT * FROM payments WHERE id = ?').get(id + '-' + n));
const loanDe   = (S, id) => leer(S.dbPath, d => d.prepare('SELECT * FROM loans WHERE id = ?').get(id));
const recalcular = S => pedir(S, 'POST', '/api/recalculate', {});   // lo que hace la app al abrirse
const clave = p => p && ({ n: p.cuotaN, vence: p.fechaPago, si: p.saldoInicial, int: p.interesPeriodo, cap: p.abonoCapital, cuota: p.cuotaTotal, x: p.extraConsolidado, est: p.estadoPago });

const BASE_LOAN = { cedula: '1', telefono: '1', moneda: 'COP', trmAcordada: 0, estado: 'Activo', notas: '',
  frecuencia: 'Mensual', comprasUSD: '', fechaDevolucion: '', gananciaFija: 0 };
async function crear(S, extra) {
  const r = await pedir(S, 'POST', '/api/loans', Object.assign({}, BASE_LOAN, extra));
  if (r.status !== 201) throw new Error('POST /api/loans ' + r.status + ' ' + JSON.stringify(r.json));
  return r.json.id;
}
const pagar = (S, id, n) => {
  const f = filaDe(S, id, n);
  return pedir(S, 'PUT', '/api/payments/' + f.id, { estadoPago: 'Pagado', fechaRecaudo: '2026-07-31', observaciones: '', montoCOPRecibido: f.cuotaTotal, montoUSDRecibido: 0 });
};

// ═════════════════════════════════════════════════════════════════════════════
// A — MOTOR PURO
// ═════════════════════════════════════════════════════════════════════════════
function seccionA() {
  R.seccion('A1 — la cuota derivada es EXACTAMENTE la del cambio de dia de siempre (barrido)');
  const saldos = [100000, 349660, 400000, 2345678, 10000000];
  const tasas  = [1, 3.5, 5, 9.8933, 11.165, 20];
  const dias   = [1, 15, 29, 31, 36, 46, 60, 90];
  const moras  = [0, 12345];
  const mods   = ['Capital + Intereses', 'Intereses'];
  let casos = 0, distintas = 0, capMovido = 0, otrasMovidas = 0, identidad = 0;
  const ejemplos = [];
  for (const mod of mods) for (const saldo of saldos) for (const tasa of tasas) for (const d of dias) for (const mora of moras) {
    casos++;
    const n = mod === 'Intereses' ? 3 : 6;
    const base = { id: 'X', nombre: 'x', tasaMensual: tasa, modalidad: mod, fechaInicio: '2026-01-15', diaPago: 15,
      frecuencia: 'Mensual', plazoMeses: 6, montoCOP: saldo };
    const plano = buildSchedule(base, 1, saldo, n);
    const desde = sumarDias(plano[0].fechaPago, -d);
    const conT = buildSchedule(Object.assign({}, base, { periodoIrregularN: 1, periodoIrregularDesde: desde, periodoIrregularMora: mora }), 1, saldo, n);
    const v = formulaVieja(plano[0], tasa, diasISO(desde, plano[0].fechaPago), mora);
    const t = conT[0];
    if (t.interesPeriodo !== v.interes || t.cuotaTotal !== v.cuota || t.extraConsolidado !== v.extra) {
      distintas++; if (ejemplos.length < 3) ejemplos.push({ mod, saldo, tasa, d, mora, nuevo: clave(t), viejo: v });
    }
    if (t.abonoCapital !== plano[0].abonoCapital || t.saldoFinal !== plano[0].saldoFinal || t.saldoInicial !== plano[0].saldoInicial) capMovido++;
    for (let i = 1; i < plano.length; i++) if (JSON.stringify(plano[i]) !== JSON.stringify(conT[i])) { otrasMovidas++; break; }
    if (!identidadOK(conT)) identidad++;
  }
  R.check('A1 barrido de ' + casos + ' casos (2 modalidades x 5 saldos x 6 tasas x 8 duraciones x 2 moras)', casos === 960, 'casos=' + casos);
  R.check('A1 interes, valor de la cuota y marca extraConsolidado identicos a la formula de /cambiar-dia-pago', distintas === 0,
    distintas + ' casos distintos. Ej: ' + JSON.stringify(ejemplos, null, 1));
  R.check('A1 el CAPITAL de la cuota transitoria no se toca (solo cambia su interes)', capMovido === 0, capMovido + ' casos');
  R.check('A1 el resto del cronograma queda byte a byte igual', otrasMovidas === 0, otrasMovidas + ' casos');
  R.check('A1 interes + capital == cuota en TODAS las filas', identidad === 0, identidad + ' cronogramas rotos');

  R.seccion('A2 — el monto sigue al CAPITAL VIVO (la raiz del defecto)');
  const cI = { id: 'Y', nombre: 'y', tasaMensual: 5, modalidad: 'Capital + Intereses', fechaInicio: '2026-07-15', diaPago: 20,
    frecuencia: 'Mensual', plazoMeses: 6, periodoIrregularN: 1, periodoIrregularDesde: '2026-07-15', periodoIrregularMora: 0 };
  const con10 = buildSchedule(cI, 1, 10000000, 6)[0];
  const con2  = buildSchedule(cI, 1, 2000000, 6)[0];
  R.eq('A2 36 dias sobre 10.000.000 al 5% = 600.000', con10.interesPeriodo, 600000);
  R.eq('A2 los MISMOS 36 dias sobre 2.000.000 = 120.000 (antes quedaba el ajuste de 10M pegado)', con2.interesPeriodo, 120000);
  R.eq('A2 marca extraConsolidado = interes transitorio - interes de mes completo (120.000 - 100.000)', con2.extraConsolidado, 20000);
  const moraFija = Object.assign({}, cI, { periodoIrregularMora: 55555 });
  R.eq('A2 la mora consolidada es deuda causada: NO escala con el capital',
    buildSchedule(moraFija, 1, 2000000, 6)[0].interesPeriodo - con2.interesPeriodo, 55555);

  R.seccion('A3 — no-op: sin transitoria el motor devuelve lo mismo que antes');
  const plano = buildSchedule(Object.assign({}, cI, { periodoIrregularN: null }), 1, 10000000, 6);
  const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  R.check('A3 periodoIrregularN NULL -> sin cambios', igual(buildSchedule(Object.assign({}, cI, { periodoIrregularN: null }), 1, 10000000, 6), plano));
  R.check('A3 sin fecha desde -> sin cambios', igual(buildSchedule(Object.assign({}, cI, { periodoIrregularDesde: null }), 1, 10000000, 6), plano));
  R.check('A3 la cuota N no esta en esta generacion (ya pagada) -> sin cambios',
    igual(buildSchedule(Object.assign({}, cI, { periodoIrregularN: 9 }), 1, 10000000, 6), plano));
  R.check('A3 una generacion que arranca DESPUES de la transitoria no la toca',
    igual(buildSchedule(cI, 2, 10000000, 5), buildSchedule(Object.assign({}, cI, { periodoIrregularN: null }), 2, 10000000, 5)));
  const plano2 = JSON.parse(JSON.stringify(plano));
  R.check('A3 en Prestamo / Pago Unico no aplica (no hay periodo que prorratear)',
    igual(aplicarPeriodoIrregular(Object.assign({}, cI, { modalidad: 'Prestamo' }), plano2), plano) &&
    igual(aplicarPeriodoIrregular(Object.assign({}, cI, { modalidad: 'Pago Unico' }), plano2), plano));
  R.check('A3 Interes Diario sigue sin cronograma', buildSchedule(Object.assign({}, cI, { modalidad: 'Interes Diario' }), 1, 10000000, 6).length === 0);

  R.seccion('A4 — tambien por el generador de cuota fija (abono o reestructura con "fijar cuota")');
  const fijo = buildScheduleFixedPMT(cI, 1, 8000000, 1500000);
  const fijoPlano = buildScheduleFixedPMT(Object.assign({}, cI, { periodoIrregularN: null }), 1, 8000000, 1500000);
  R.eq('A4 interes = 36 dias sobre 8.000.000 = 480.000', fijo[0].interesPeriodo, 480000);
  R.eq('A4 cuota = 1.500.000 + (480.000 - 400.000)', fijo[0].cuotaTotal, 1580000);
  R.eq('A4 capital intacto (1.100.000)', fijo[0].abonoCapital, fijoPlano[0].abonoCapital);
  R.check('A4 mismo numero de cuotas y resto identico', fijo.length === fijoPlano.length &&
    igual(fijo.slice(1), fijoPlano.slice(1)) && identidadOK(fijo));

  R.seccion('A5 — bordes');
  // Transitoria que es TAMBIEN la ultima cuota (queda 1): el ajuste del Bug #43 no puede deshacerla.
  const ultima = buildSchedule(Object.assign({}, cI, { periodoIrregularDesde: sumarDias('2026-08-20', -15) }), 1, 1000000, 1);
  R.check('A5 transitoria que es la ULTIMA cuota: interes de 15 dias (25.000), capital completo, identidad',
    ultima.length === 1 && ultima[0].interesPeriodo === 25000 && ultima[0].abonoCapital === 1000000 &&
    ultima[0].cuotaTotal === 1025000 && ultima[0].saldoFinal === 0, clave(ultima[0]));
  const alReves = buildSchedule(Object.assign({}, cI, { periodoIrregularDesde: '2026-09-30' }), 1, 3000000, 6);
  R.eq('A5 fecha desde POSTERIOR a la cuota -> 1 dia (nunca 0 ni negativo)', alReves[0].interesPeriodo, Math.round(3000000 * 0.05 / 30));
  const largo = buildSchedule(Object.assign({}, cI, { periodoIrregularDesde: sumarDias('2026-08-20', -90) }), 1, 1000000, 6);
  R.eq('A5 un periodo de 90 dias cobra 3 meses de interes (150.000)', largo[0].interesPeriodo, 150000);
  const t = transitoriaDe(cI, buildSchedule(Object.assign({}, cI, { periodoIrregularN: null }), 1, 10000000, 6)[0]);
  R.check('A5 transitoriaDe expone dias, prorrateo, mora y ajuste', t.dias === 36 && t.prorrateado === 600000 && t.mora === 0 && t.ajuste === 100000, t);
}

// ═════════════════════════════════════════════════════════════════════════════
// B — CONTRA EL SERVER REAL
// ═════════════════════════════════════════════════════════════════════════════
async function seccionB() {
  const S = await arrancar(bdVacia('periodo-irregular-b'));
  try {
    const CI = { montoOrigen: 10000000, montoCOP: 10000000, tasaMensual: 5, plazoMeses: 6, modalidad: 'Capital + Intereses', fechaInicio: '2026-07-15', diaPago: 15 };

    R.seccion('B1 — el escenario del defecto: cambio de dia -> abono -> reabrir la app');
    const L1 = await crear(S, Object.assign({ nombre: 'B1' }, CI));
    const c1 = await pedir(S, 'POST', '/api/loans/' + L1 + '/cambiar-dia-pago', { nuevoDia: 20 });
    R.check('B1 cambio de dia 15 -> 20 aceptado', c1.status === 200, c1.json);
    R.check('B1 la respuesta anuncia 36 dias y 600.000 de interes prorrateado', c1.json && c1.json.diasReales === 36 && c1.json.prorrateo === 600000, c1.json);
    const l1 = loanDe(S, L1);
    R.check('B1 el prestamo guarda la DECISION: cuota 1, desde el 15-jul, sin mora',
      l1.periodoIrregularN === 1 && l1.periodoIrregularDesde === '2026-07-15' && l1.periodoIrregularMora === 0, l1);
    R.check('B1 y ya no guarda el MONTO (proximaCuotaExtra en 0)', l1.proximaCuotaExtra === 0 && l1.proximaCuotaExtraN === 0, l1);
    R.eq('B1 cuota 1 tras el cambio: 600.000 de interes', filaDe(S, L1, 1).interesPeriodo, 600000);
    const ab = await pedir(S, 'POST', '/api/loans/' + L1 + '/abono', { monto: 8000000, fecha: '2026-07-31', observaciones: '', recalcMode: 'mantener' });
    R.check('B1 abono de 8.000.000 aceptado', ab.status === 200, ab.json);
    const trasAbono = filaDe(S, L1, 1);
    R.eq('B1 INMEDIATAMENTE despues del abono la cuota 1 ya cobra 36 dias sobre el capital vivo (120.000)', trasAbono.interesPeriodo, 120000);
    R.check('B1 (antes del arreglo: 100.000 aqui y 200.000 al reabrir la app)', trasAbono.interesPeriodo !== 100000 && trasAbono.interesPeriodo !== 200000);
    R.check('B1 identidad interes + capital == cuota tras el abono', identidadOK(filasDe(S, L1).filter(p => p.id.indexOf('-ab-') === -1)));
    await recalcular(S); await recalcular(S);
    R.eq('B1 reabrir la app (dos veces) no mueve la cuota', clave(filaDe(S, L1, 1)), clave(trasAbono));

    R.seccion('B2 — pagar la transitoria y revertir el pago');
    const p1 = await pagar(S, L1, 1);
    R.check('B2 pago de la cuota 1 aceptado', p1.status === 200, p1.json);
    R.eq('B2 la decision NO se borra al pagar (queda inerte)', loanDe(S, L1).periodoIrregularN, 1);
    await recalcular(S);
    R.check('B2 pagada, reabrir la app no la toca', filaDe(S, L1, 1).estadoPago === 'Pagado' && filaDe(S, L1, 1).interesPeriodo === 120000);
    const rv = await pedir(S, 'PUT', '/api/payments/' + L1 + '-1', { estadoPago: 'Pendiente', fechaRecaudo: null, observaciones: '', montoCOPRecibido: 0, montoUSDRecibido: 0 });
    R.check('B2 revertir a Pendiente aceptado', rv.status === 200, rv.json);
    await recalcular(S);
    R.check('B2 revertida, la cuota renace CON su prorrateo (antes renacia de mes completo)',
      filaDe(S, L1, 1).estadoPago === 'Pendiente' && filaDe(S, L1, 1).interesPeriodo === 120000, clave(filaDe(S, L1, 1)));

    R.seccion('B3 — abono con "fijar cuota" (generador de cuota fija)');
    const L3 = await crear(S, Object.assign({ nombre: 'B3' }, CI));
    await pedir(S, 'POST', '/api/loans/' + L3 + '/cambiar-dia-pago', { nuevoDia: 20 });
    const ab3 = await pedir(S, 'POST', '/api/loans/' + L3 + '/abono', { monto: 2000000, fecha: '2026-07-31', observaciones: '', recalcMode: 'fijarCuota', recalcValor: 1500000 });
    R.check('B3 abono con cuota fija aceptado', ab3.status === 200, ab3.json);
    const f3 = filaDe(S, L3, 1);
    R.check('B3 cuota 1: 36 dias sobre 8.000.000 (480.000) y cuota 1.580.000',
      f3.interesPeriodo === 480000 && f3.cuotaTotal === 1580000 && f3.abonoCapital === 1100000, clave(f3));
    await recalcular(S);
    R.eq('B3 reabrir la app (ruta de cuota fija pactada) no la mueve', clave(filaDe(S, L3, 1)), clave(f3));

    R.seccion('B4 — reestructurar');
    const re = await pedir(S, 'POST', '/api/loans/' + L3 + '/reestructurar', { recalcMode: 'modificarPlazo', recalcValor: 3 });
    R.check('B4 reestructura a 3 cuotas aceptada', re.status === 200, re.json);
    const f4 = filaDe(S, L3, 1);
    R.check('B4 la transitoria sobrevive con el mismo capital vivo (480.000) y la identidad intacta',
      f4.interesPeriodo === 480000 && f4.extraConsolidado === 80000 && identidadOK(filasDe(S, L3).filter(p => p.id.indexOf('-ab-') === -1)), clave(f4));

    R.seccion('B5 — editar el prestamo: la decision se lee de la BD, nunca del formulario');
    const cuerpo = Object.assign({}, loanDe(S, L3), { notas: 'editado' });
    delete cuerpo.periodoIrregularN; delete cuerpo.periodoIrregularDesde; delete cuerpo.periodoIrregularMora;
    const e1 = await pedir(S, 'PUT', '/api/loans/' + L3, cuerpo);
    R.check('B5 edicion sin las claves de la transitoria aceptada', e1.status === 200, e1.json);
    R.check('B5 la transitoria sigue: cuota 1 con 480.000 y la decision intacta',
      filaDe(S, L3, 1).interesPeriodo === 480000 && loanDe(S, L3).periodoIrregularN === 1 && loanDe(S, L3).notas === 'editado');
    const e2 = await pedir(S, 'PUT', '/api/loans/' + L3, Object.assign({}, loanDe(S, L3), { periodoIrregularN: null, periodoIrregularMora: 999999 }));
    R.check('B5 un body con valores VIEJOS no puede apagarla ni moverla',
      e2.status === 200 && filaDe(S, L3, 1).interesPeriodo === 480000 && loanDe(S, L3).periodoIrregularMora === 0, clave(filaDe(S, L3, 1)));

    R.seccion('B6 — modalidad Intereses');
    const L6 = await crear(S, { nombre: 'B6', montoOrigen: 5000000, montoCOP: 5000000, tasaMensual: 4, plazoMeses: 0, modalidad: 'Intereses', fechaInicio: '2026-07-15', diaPago: 15 });
    await pedir(S, 'POST', '/api/loans/' + L6 + '/cambiar-dia-pago', { nuevoDia: 20 });
    R.eq('B6 cuota 1: 36 dias sobre 5.000.000 al 4% = 240.000', filaDe(S, L6, 1).interesPeriodo, 240000);
    await pedir(S, 'POST', '/api/loans/' + L6 + '/abono', { monto: 1000000, fecha: '2026-07-31', observaciones: '', recalcMode: 'mantener' });
    R.eq('B6 tras abonar 1.000.000: 36 dias sobre 4.000.000 = 192.000', filaDe(S, L6, 1).interesPeriodo, 192000);
    await recalcular(S);
    R.eq('B6 reabrir la app no la mueve', filaDe(S, L6, 1).interesPeriodo, 192000);

    R.seccion('B7 — mora consolidada y cuotas ya pagadas');
    const L7 = await crear(S, { nombre: 'B7', montoOrigen: 3000000, montoCOP: 3000000, tasaMensual: 5, plazoMeses: 6, modalidad: 'Capital + Intereses', fechaInicio: '2026-04-10', diaPago: 10 });
    await recalcular(S);   // auto-mora: vencen 10-may, 10-jun y 10-jul
    R.check('B7 ANTI-VACIO: tres cuotas En Mora al 31-jul', filasDe(S, L7).filter(p => p.estadoPago === 'En Mora').length === 3);
    await pagar(S, L7, 1); await pagar(S, L7, 2);
    const moraEsperada = filaDe(S, L7, 3).interesPeriodo;
    const c7 = await pedir(S, 'POST', '/api/loans/' + L7 + '/cambiar-dia-pago', { nuevoDia: 5 });
    R.check('B7 cambio de dia 10 -> 5 aceptado (nunca adelantar: la cuota pasa al 5-ago)', c7.status === 200 && filaDe(S, L7, 3).fechaPago === '2026-08-05', c7.json);
    const l7 = loanDe(S, L7);
    R.check('B7 decision: cuota 3, desde la ultima pagada (10-jun), con la mora de la cuota vencida',
      l7.periodoIrregularN === 3 && l7.periodoIrregularDesde === '2026-06-10' && l7.periodoIrregularMora === moraEsperada, l7);
    const dias7 = diasISO('2026-06-10', '2026-08-05');
    const f7 = filaDe(S, L7, 3);
    R.eq('B7 cuota 3 = ' + dias7 + ' dias sobre su capital + la mora', f7.interesPeriodo, Math.round(f7.saldoInicial * 0.05 * dias7 / 30) + moraEsperada);
    await pedir(S, 'POST', '/api/loans/' + L7 + '/abono', { monto: 500000, fecha: '2026-07-31', observaciones: '', recalcMode: 'mantener' });
    const f7b = filaDe(S, L7, 3);
    R.check('B7 tras el abono: el prorrateo baja con el capital y la MORA se queda igual',
      f7b.saldoInicial === f7.saldoInicial - 500000 &&
      f7b.interesPeriodo === Math.round(f7b.saldoInicial * 0.05 * dias7 / 30) + moraEsperada, { antes: clave(f7), despues: clave(f7b) });
    await recalcular(S);
    R.eq('B7 reabrir la app no la mueve', clave(filaDe(S, L7, 3)), clave(f7b));

    R.seccion('B8 — deshacer devuelve el agregado entero, decision incluida');
    const L8 = await crear(S, Object.assign({ nombre: 'B8' }, CI));
    await pedir(S, 'POST', '/api/loans/' + L8 + '/cambiar-dia-pago', { nuevoDia: 20 });
    await pedir(S, 'POST', '/api/loans/' + L8 + '/abono', { monto: 8000000, fecha: '2026-07-31', observaciones: '', recalcMode: 'mantener' });
    const head = async () => ((await pedir(S, 'GET', '/api/undo?scopeTipo=loan&scopeId=' + L8)).json || []).filter(u => u.estado === 'disponible')[0];
    const u1 = await head();
    R.check('B8 el abono es el ultimo movimiento deshacible', u1 && u1.accion === 'abono', u1);
    await pedir(S, 'POST', '/api/undo/' + u1.id, {});
    R.check('B8 deshacer el abono: cuota 1 vuelve a 600.000 y la decision sigue', filaDe(S, L8, 1).interesPeriodo === 600000 && loanDe(S, L8).periodoIrregularN === 1);
    const u2 = await head();
    await pedir(S, 'POST', '/api/undo/' + u2.id, {});
    const l8 = loanDe(S, L8);
    R.check('B8 deshacer el cambio de dia: sin transitoria, dia 15 y cuota de mes completo (500.000)',
      u2.accion === 'cambio-fecha' && l8.periodoIrregularN === null && l8.diaPago === 15 && filaDe(S, L8, 1).interesPeriodo === 500000, { u2, l8: { n: l8.periodoIrregularN, dia: l8.diaPago }, f: clave(filaDe(S, L8, 1)) });

    R.seccion('B9 — un prestamo nuevo nace sin transitoria aunque el body la traiga');
    const L9 = await crear(S, Object.assign({ nombre: 'B9', periodoIrregularN: 1, periodoIrregularDesde: '2026-06-01', periodoIrregularMora: 7777 }, CI));
    R.check('B9 la cuota 1 es de mes completo y el prestamo no guarda nada',
      filaDe(S, L9, 1).interesPeriodo === 500000 && loanDe(S, L9).periodoIrregularN === null, clave(filaDe(S, L9, 1)));
  } finally { await cerrar(S); }
}

// ═════════════════════════════════════════════════════════════════════════════
// C — MIGRACION de las transitorias guardadas con el modelo viejo
// ═════════════════════════════════════════════════════════════════════════════
async function seccionC() {
  R.seccion('C1 — el fixture trae dos transitorias viejas: la conversion es EXACTA');
  const antes = leer(FIXTURE_DB, d => d.prepare("SELECT l.id, l.proximaCuotaExtra, l.proximaCuotaExtraN FROM loans l WHERE COALESCE(l.proximaCuotaExtra,0) <> 0").all()
    .map(l => Object.assign(l, { fila: d.prepare('SELECT * FROM payments WHERE id = ?').get(l.id + '-' + l.proximaCuotaExtraN) })));
  R.check('C1 ANTI-VACIO: el fixture tiene transitorias viejas Pendientes que /recalculate regenerara',
    antes.length >= 2 && antes.every(l => l.fila && l.fila.estadoPago === 'Pendiente' && l.fila.extraConsolidado === l.proximaCuotaExtra), antes.map(l => l.id));
  const ruta = copiaDeProduccion('periodo-irregular-c');
  let S = await arrancar(ruta);
  try {
    for (const a of antes) {
      const l = loanDe(S, a.id);
      const dias = diasISO(l.periodoIrregularDesde || '1900-01-01', a.fila.fechaPago);
      const obs = /interes de (\d+) dias/.exec(a.fila.observaciones || '');
      R.check('C1 ' + a.id + ': decision reconstruida (cuota ' + a.proximaCuotaExtraN + ', ' + dias + ' dias, sin mora) y monto viejo en 0',
        l.periodoIrregularN === a.proximaCuotaExtraN && l.periodoIrregularMora === 0 && l.proximaCuotaExtra === 0 && l.proximaCuotaExtraN === 0,
        { n: l.periodoIrregularN, desde: l.periodoIrregularDesde, mora: l.periodoIrregularMora, extra: l.proximaCuotaExtra });
      R.check('C1 ' + a.id + ': los dias coinciden con los que anoto el cambio de dia en la cuota ("' + (obs && obs[0]) + '")', obs && +obs[1] === dias);
    }
    await recalcular(S);
    for (const a of antes) {
      const f = filaDe(S, a.id, a.proximaCuotaExtraN);
      R.eq('C1 ' + a.id + ': tras regenerarla, la cuota es la MISMA del fixture, peso a peso',
        clave(f), clave(a.fila));
    }
    const loansTras = leer(ruta, d => JSON.stringify(d.prepare('SELECT * FROM loans ORDER BY id').all()));
    await cerrar(S);
    S = await arrancar(ruta);
    R.check('C2 idempotente: un segundo arranque no toca ningun prestamo',
      leer(ruta, d => JSON.stringify(d.prepare('SELECT * FROM loans ORDER BY id').all())) === loansTras);
  } finally { await cerrar(S); }

  R.seccion('C3 — caso armado con MORA consolidada y cuotas pagadas antes');
  const ruta3 = bdVacia('periodo-irregular-c3');
  S = await arrancar(ruta3);
  let id, decision, fila;
  try {
    id = await crear(S, { nombre: 'C3', montoOrigen: 3000000, montoCOP: 3000000, tasaMensual: 5, plazoMeses: 6, modalidad: 'Capital + Intereses', fechaInicio: '2026-04-10', diaPago: 10 });
    await recalcular(S);
    await pagar(S, id, 1); await pagar(S, id, 2);
    await pedir(S, 'POST', '/api/loans/' + id + '/cambiar-dia-pago', { nuevoDia: 5 });
    const l = loanDe(S, id);
    decision = { n: l.periodoIrregularN, desde: l.periodoIrregularDesde, mora: l.periodoIrregularMora };
    fila = filaDe(S, id, decision.n);
  } finally { await cerrar(S); }
  R.check('C3 ANTI-VACIO: la transitoria armada tiene mora y cuotas pagadas antes', decision.mora > 0 && decision.desde === '2026-06-10', decision);
  // Se lleva la BD al estado que habria dejado 3.1.0: la decision vacia y el MONTO en la columna vieja.
  escribir(ruta3, d => d.prepare('UPDATE loans SET periodoIrregularN = NULL, periodoIrregularDesde = NULL, periodoIrregularMora = 0, ' +
    'proximaCuotaExtra = ?, proximaCuotaExtraN = ? WHERE id = ?').run(fila.extraConsolidado, decision.n, id));
  S = await arrancar(ruta3);
  try {
    const l = loanDe(S, id);
    R.eq('C3 la migracion reconstruye la MISMA decision (cuota, desde, mora)',
      { n: l.periodoIrregularN, desde: l.periodoIrregularDesde, mora: l.periodoIrregularMora }, decision);
    await recalcular(S);
    R.eq('C3 y la cuota regenerada es la misma, peso a peso', clave(filaDe(S, id, decision.n)), clave(fila));

    R.seccion('C4 — una transitoria vieja que apunta a una cuota que no existe solo se limpia');
    escribir(ruta3, d => d.prepare('UPDATE loans SET periodoIrregularN = NULL, proximaCuotaExtra = 1234, proximaCuotaExtraN = 99 WHERE id = ?').run(id));
  } finally { await cerrar(S); }
  S = await arrancar(ruta3);
  try {
    const l = loanDe(S, id);
    R.check('C4 sin fila a la que aplicarla: monto viejo en 0 y sin decision inventada',
      l.proximaCuotaExtra === 0 && l.proximaCuotaExtraN === 0 && l.periodoIrregularN === null, l);
  } finally { await cerrar(S); }
}

// ═════════════════════════════════════════════════════════════════════════════
// E — EL ESPEJO DEL FRONTEND (preview del cobro y plan de la cascada)
// ═════════════════════════════════════════════════════════════════════════════
// El modal de cobro dibuja el cronograma que dejara un abono con `filasPreview`, una segunda
// implementacion del motor, y el paso "interes del mes" calcula el interes con el que el
// abono regenerara la proxima cuota. Si el motor re-deriva la transitoria y el espejo no, la
// pantalla (y la Propuesta de Abono que sale de ella) promete una cuota que no es la que se
// guarda. Se cargan los modulos REALES, aplanados, como en `cascada-cobro`.
const RE_IMPORT = /^[ \t]*import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]\s*;?[ \t]*$/gm;
function aplanar(entrada, vistos, orden) {
  const abs = path.resolve(entrada);
  if (vistos.has(abs)) return;
  vistos.add(abs);
  let src = fs.readFileSync(abs, 'utf8');
  const deps = [];
  let m; RE_IMPORT.lastIndex = 0;
  while ((m = RE_IMPORT.exec(src)) !== null) deps.push(m[1]);
  for (const d of deps) {
    if (!d.startsWith('.') && !d.startsWith('/')) continue;
    aplanar(path.resolve(path.dirname(abs), d), vistos, orden);
  }
  src = src.replace(RE_IMPORT, '')
    .replace(/^[ \t]*export\s+(?=(?:const|let|var|function|class|async)\b)/gm, '')
    .replace(/^[ \t]*export\s*\{[^}]*\}\s*;?[ \t]*$/gm, '');
  orden.push(src);
}
function cargarFront() {
  const vm = require('vm');
  const orden = [], vistos = new Set();
  aplanar(path.join(REPO, 'public', 'js', 'core', 'cascada.js'), vistos, orden);
  const sb = { console };
  sb.globalThis = sb;
  const ctx = vm.createContext(sb);
  vm.runInContext(orden.join('\n'), ctx);
  return vm.runInContext('({planCascada,cobrableTotal,filasPreview,aplicarTransitoriaPreview,interesTransitoria,esTransitoria,imputarCobros,_pmt,_tasaPeriodo,' +
    'fechaPagoMensual,fechaPagoFrecuencia,primerPagoRegular,primerPagoDe,inicioPeriodoRegular,infoPrimerPeriodo,tasaDelPeriodo,diasDelPeriodo,interesPeriodoParcial})', ctx);
}

async function seccionE() {
  const F = cargarFront();
  R.check('E los modulos reales del frontend se cargaron',
    typeof F.aplicarTransitoriaPreview === 'function' && typeof F.planCascada === 'function' && typeof F.interesTransitoria === 'function');

  R.seccion('E1 — el espejo produce la MISMA transitoria que el motor (mismo barrido de A1)');
  let casos = 0, difInteres = 0, difFilas = 0;
  const ej = [];
  for (const mod of ['Capital + Intereses', 'Intereses'])
  for (const saldo of [100000, 349660, 400000, 2345678, 10000000])
  for (const tasa of [1, 3.5, 5, 9.8933, 11.165, 20])
  for (const d of [1, 15, 29, 31, 36, 46, 60, 90])
  for (const mora of [0, 12345]) {
    casos++;
    const n = mod === 'Intereses' ? 3 : 6;
    const base = { id: 'X', nombre: 'x', tasaMensual: tasa, modalidad: mod, fechaInicio: '2026-01-15', diaPago: 15,
      frecuencia: 'Mensual', plazoMeses: 6, montoCOP: saldo };
    const plano = buildSchedule(base, 1, saldo, n);
    const loanT = Object.assign({}, base, { periodoIrregularN: 1, periodoIrregularDesde: sumarDias(plano[0].fechaPago, -d), periodoIrregularMora: mora });
    if (F.interesTransitoria(loanT, plano[0].saldoInicial, plano[0].fechaPago) !== transitoriaDe(loanT, plano[0]).interes) difInteres++;
    const motor = buildSchedule(loanT, 1, saldo, n);
    const r = F._tasaPeriodo(tasa / 100, 'Mensual');
    const filas = F.filasPreview(saldo, r, n, mod === 'Intereses', mod === 'Intereses' ? Math.round(saldo * r) : Math.round(F._pmt(r, n, saldo)));
    F.aplicarTransitoriaPreview(loanT, filas, 1, saldo, [{ id: 'X-1', fechaPago: plano[0].fechaPago }]);
    const malas = motor.filter((p, i) => !filas[i] || filas[i].interes !== p.interesPeriodo || filas[i].capital !== p.abonoCapital || filas[i].cuota !== p.cuotaTotal);
    if (malas.length) { difFilas++; if (ej.length < 2) ej.push({ mod, saldo, tasa, d, mora, motor: clave(malas[0]), filas: filas.slice(0, 2) }); }
  }
  R.check('E1 barrido de ' + casos + ' casos', casos === 960);
  R.check('E1 interesTransitoria (frontend) == transitoriaDe (motor) en todos', difInteres === 0, difInteres + ' casos');
  R.check('E1 preview == motor fila a fila (interes, capital y cuota) en todos', difFilas === 0, difFilas + ' casos. Ej: ' + JSON.stringify(ej));

  R.seccion('E2 — el modal REAL del cobro usa el espejo (la replica de cascada-cobro F no basta)');
  const modal = fs.readFileSync(path.join(REPO, 'public', 'js', 'modales', 'CobroModal.js'), 'utf8');
  R.check('E2 CobroModal aplica la transitoria sobre las filas del preview',
    /aplicarTransitoriaPreview\(loan,filas,ctx\.regularConsumed\+1,saldo,loanPays\);/.test(modal));

  R.seccion('E3 — "interes del mes" + abono sobre una transitoria: el plan cobra el interes que la cuota regenerada TIENE');
  const S = await arrancar(bdVacia('periodo-irregular-e'));
  try {
    const id = await crear(S, { nombre: 'E3', montoOrigen: 10000000, montoCOP: 10000000, tasaMensual: 5, plazoMeses: 6,
      modalidad: 'Capital + Intereses', fechaInicio: '2026-07-15', diaPago: 15 });
    await pedir(S, 'POST', '/api/loans/' + id + '/cambiar-dia-pago', { nuevoDia: 20 });
    const loan = loanDe(S, id);
    const pays = filasDe(S, id);
    const cob = F.cobrableTotal(loan, pays);
    const total = cob.interesMes + 3000000;
    const plan = F.planCascada(loan, pays, { obligacionCOP: total, cajaCOP: total, obligacionUSD: 0 }, { incluirInteresMes: true });
    const mes = plan.pasos.filter(p => p.esInteresMes)[0];
    R.check('E3 ANTI-VACIO: el plan trae el paso del interes del mes y un abono', plan.ok && !!mes && plan.pasos.some(p => p.tipo === 'abono'),
      plan.error || plan.pasos.map(p => p.tipo));
    for (const paso of plan.pasos) {
      const r = paso.tipo === 'partial'
        ? await pedir(S, 'POST', '/api/payments/' + paso.payId + '/partial', { monto: paso.cajaCOP, fecha: '2026-07-31', observaciones: '', montoUSD: 0 })
        : await pedir(S, 'POST', '/api/loans/' + id + '/abono', { monto: paso.obligacionCOP, fecha: '2026-07-31', observaciones: '', montoUSD: 0,
            montoCOPRecibido: paso.cajaCOP, liquidar: false, recalcMode: 'mantener', recalcValor: null, intExtra: 0 });
      R.check('E3 paso ' + paso.tipo + ' aplicado', r.status === 200, r.json);
    }
    const fila = filaDe(S, id, 1);
    const mesCompleto = Math.round(fila.saldoInicial * 0.05);
    R.check('E3 ANTI-TRIVIAL: la cuota regenerada es transitoria (sus 36 dias no valen un mes)',
      fila.interesPeriodo === Math.round(fila.saldoInicial * 0.05 * 36 / 30) && fila.interesPeriodo !== mesCompleto, clave(fila));
    R.eq('E3 el paso del mes cobro EXACTAMENTE el interes de la cuota regenerada', Math.round(mes.obligacionCOP), fila.interesPeriodo);
    const imp = F.imputarCobros(fila).totales;
    R.check('E3 y la base lo imputa todo a interes, nada a capital', imp.interes === fila.interesPeriodo && imp.capital === 0, imp);
  } finally { await cerrar(S); }
}

// ═════════════════════════════════════════════════════════════════════════════
// F — FASE 2: el resolvedor del primer pago (puro)
// ═════════════════════════════════════════════════════════════════════════════
const { ClientError } = require('../backend/core/errors');
// Las columnas que el resolvedor le pone al prestamo (sin su bandera `irregular`).
function conPrimerPago(loan, primerPago, modo) {
  const r = engine.resolverPrimerPago(loan, primerPago, modo);
  return Object.assign({}, loan, { diaPago: r.diaPago, fechaBaseCronograma: r.fechaBaseCronograma,
    periodoIrregularN: r.periodoIrregularN, periodoIrregularDesde: r.periodoIrregularDesde, periodoIrregularMora: r.periodoIrregularMora });
}
// El mes siguiente a una fecha, mismo dia acotado a fin de mes. Calculado APARTE del motor.
function mesSiguiente(iso, dia) {
  let [y, m] = iso.split('-').map(Number);
  m += 1; if (m > 12) { m = 1; y += 1; }
  const fin = new RelojReal(RelojReal.UTC(y, m, 0)).getUTCDate();
  return y + '-' + String(m).padStart(2, '0') + '-' + String(Math.min(dia, fin)).padStart(2, '0');
}
const sinFechas = rows => rows.map(p => ({ int: p.interesPeriodo, cap: p.abonoCapital, cuota: p.cuotaTotal }));

function seccionF() {
  const { resolverPrimerPago, primerPagoRegular, getPayDate } = engine;
  const Fr = cargarFront();
  const CI = { id: 'P', nombre: 'p', modalidad: 'Capital + Intereses', frecuencia: 'Mensual', tasaMensual: 5, plazoMeses: 6,
    montoCOP: 10000000, montoOrigen: 10000000, moneda: 'COP', fechaInicio: '2026-09-15', diaPago: 15 };

  R.seccion('F1 — elegir la fecha REGULAR deja el prestamo exactamente como antes');
  const reg = resolverPrimerPago(CI, '2026-10-15', 'proporcional');
  R.check('F1 un mes despues: sin base, sin transitoria, dia de pago = dia de inicio',
    !reg.irregular && reg.diaPago === 15 && reg.fechaBaseCronograma === null && reg.periodoIrregularN === null, reg);
  R.check('F1 cronograma byte a byte igual al de un prestamo sin fecha elegida',
    JSON.stringify(buildSchedule(conPrimerPago(CI, '2026-10-15'))) === JSON.stringify(buildSchedule(CI)));

  R.seccion('F2 — periodo CORTO: inicio 15-sep, primer pago 30-sep (15 dias)');
  const corto = conPrimerPago(CI, '2026-09-30', 'proporcional');
  R.check('F2 dia de pago 30, base = agosto, transitoria en la cuota 1 desde el inicio',
    corto.diaPago === 30 && corto.fechaBaseCronograma === '2026-08-01' && corto.periodoIrregularN === 1 && corto.periodoIrregularDesde === '2026-09-15', corto);
  const rc = buildSchedule(corto);
  R.check('F2 cuota 1 el 30-sep con 15 dias de interes (250.000 + capital 1.470.175)',
    rc[0].fechaPago === '2026-09-30' && rc[0].interesPeriodo === 250000 && rc[0].cuotaTotal === 1720175, clave(rc[0]));
  R.check('F2 cuota 2 el 30-oct de valor normal (1.970.175)', rc[1].fechaPago === '2026-10-30' && rc[1].cuotaTotal === 1970175, clave(rc[1]));

  R.seccion('F3 — TIEMPO MUERTO: primer pago a 3 meses (regla del PO)');
  const d91 = diasISO('2026-09-15', '2026-12-15');
  const muerto = buildSchedule(conPrimerPago(CI, '2026-12-15', 'proporcional'));
  const plano = buildSchedule(CI);
  R.eq('F3 del 15-sep al 15-dic hay 91 dias', d91, 91);
  R.check('F3 cuota 1 el 15-dic con el interes de los 91 dias (1.516.667) y su capital normal: 2.986.842',
    muerto[0].fechaPago === '2026-12-15' && muerto[0].interesPeriodo === 1516667 && muerto[0].abonoCapital === 1470175 && muerto[0].cuotaTotal === 2986842, clave(muerto[0]));
  R.check('F3 las otras 5 cuotas valen lo de siempre y caen el 15 de cada mes',
    JSON.stringify(sinFechas(muerto.slice(1))) === JSON.stringify(sinFechas(plano.slice(1))) &&
    muerto.slice(1).map(p => p.fechaPago).join() === '2027-01-15,2027-02-15,2027-03-15,2027-04-15,2027-05-15', muerto.map(p => p.fechaPago));
  R.eq('F3 la suma de capital es exactamente lo prestado', muerto.reduce((s, p) => s + p.abonoCapital, 0), 10000000);
  const completo = conPrimerPago(CI, '2026-12-15', 'completo');
  const rComp = buildSchedule(completo);
  R.check('F3 con "mes completo": vence el 15-dic pero cobra UN mes (500.000), sin transitoria',
    completo.periodoIrregularN === null && completo.fechaBaseCronograma === '2026-11-01' && rComp[0].fechaPago === '2026-12-15' && rComp[0].interesPeriodo === 500000, clave(rComp[0]));
  const ints = Object.assign({}, CI, { modalidad: 'Intereses', tasaMensual: 4, montoCOP: 5000000, montoOrigen: 5000000, plazoMeses: 0 });
  const rInt = buildSchedule(conPrimerPago(ints, '2026-12-15', 'proporcional'), 1, 5000000, 3);
  R.check('F3 modalidad Intereses: cuota 1 con 91 dias (606.667), las siguientes de 200.000',
    rInt[0].interesPeriodo === Math.round(5000000 * 0.04 * 91 / 30) && rInt[0].interesPeriodo === 606667 &&
    rInt[1].interesPeriodo === 200000 && rInt[1].fechaPago === '2027-01-15', rInt.map(clave));

  R.seccion('F4 — tasa 0: se respeta la fecha, no hay interes que prorratear');
  const cero = conPrimerPago(Object.assign({}, CI, { tasaMensual: 0 }), '2026-12-15', 'proporcional');
  R.check('F4 fecha aplicada (base y dia) y SIN transitoria', cero.fechaBaseCronograma === '2026-11-01' && cero.diaPago === 15 && cero.periodoIrregularN === null, cero);

  R.seccion('F5 — validaciones (4xx en las rutas)');
  const lanza = fn => { try { fn(); return null; } catch (e) { return e; } };
  const casos = [
    ['el mismo dia del inicio', CI, '2026-09-15'],
    ['antes del inicio', CI, '2026-09-01'],
    ['fecha inexistente (30-feb)', CI, '2027-02-30'],
    ['formato no ISO', CI, '15/12/2026'],
    // 3.3.0: Semanal y Quincenal ya se aceptan (seccion K); se sigue rechazando lo desconocido.
    ['frecuencia desconocida', Object.assign({}, CI, { frecuencia: 'Diaria' }), '2026-12-15'],
    ['modalidad Prestamo', Object.assign({}, CI, { modalidad: 'Prestamo' }), '2026-12-15'],
    ['modalidad Pago Unico', Object.assign({}, CI, { modalidad: 'Pago Unico' }), '2026-12-15'],
    ['modalidad Interes Diario', Object.assign({}, CI, { modalidad: 'Interes Diario' }), '2026-12-15'],
  ];
  for (const [desc, loan, pp] of casos) {
    const e = lanza(() => resolverPrimerPago(loan, pp, 'proporcional'));
    R.check('F5 rechaza: ' + desc, e instanceof ClientError, e ? e.message : 'no lanzo');
  }
  const eModo = lanza(() => resolverPrimerPago(CI, '2026-12-15', 'xyz'));
  R.check('F5 rechaza un primer periodo que no es "proporcional" ni "completo"', eModo instanceof ClientError, eModo && eModo.message);
  R.check('F5 sin modo explicito, proporcional (el default del PO)', resolverPrimerPago(CI, '2026-12-15').periodoIrregularN === 1);

  R.seccion('F6 — fin de mes');
  R.eq('F6 el primer pago regular de un inicio el 31-ene es el 28-feb', primerPagoRegular('2026-01-31'), '2026-02-28');
  const fin = Object.assign({}, CI, { fechaInicio: '2026-01-31', diaPago: 31 });
  const r6 = resolverPrimerPago(fin, '2026-02-28');
  R.check('F6 elegir ese 28-feb es la fecha regular: se conserva el dia 31', !r6.irregular && r6.diaPago === 31 && r6.fechaBaseCronograma === null, r6);
  const f6 = buildSchedule(conPrimerPago(fin, '2026-03-31'));
  R.eq('F6 primer pago 31-mar: las siguientes el 30-abr y el 31-may', f6.slice(0, 3).map(p => p.fechaPago), ['2026-03-31', '2026-04-30', '2026-05-31']);

  R.seccion('F7 — barrido de TIEMPOS MUERTOS: 8 fechas de inicio x 1..400 dias, motor y espejo');
  const inicios = ['2026-01-29', '2026-01-31', '2026-02-28', '2026-03-15', '2026-06-30', '2026-07-31', '2026-09-15', '2026-12-31'];
  let casosF7 = 0, irregulares = 0, lanzados = 0, malos = 0, paridad = 0, preview = 0;
  const ej = [];
  for (const ini of inicios) {
    const base = Object.assign({}, CI, { fechaInicio: ini, diaPago: +ini.slice(8, 10) });
    const planoIni = buildSchedule(base);
    if (Fr.primerPagoRegular(ini) !== primerPagoRegular(ini)) paridad++;
    for (let d = 1; d <= 400; d++) {
      casosF7++;
      const pp = sumarDias(ini, d);
      let r;
      try { r = resolverPrimerPago(base, pp, 'proporcional'); } catch (e) { lanzados++; if (ej.length < 3) ej.push(ini + ' -> ' + pp + ': ' + e.message); continue; }
      const loanPP = conPrimerPago(base, pp, 'proporcional');
      const rows = buildSchedule(loanPP);
      const info = Fr.infoPrimerPeriodo(10000000, 5, ini, pp);
      if (info.irregular !== r.irregular || Fr.fechaPagoMensual(r.fechaBaseCronograma || ini, 1, r.diaPago) !== getPayDate(r.fechaBaseCronograma || ini, 1, r.diaPago, 'Mensual')) paridad++;
      if (!r.irregular) {
        if (JSON.stringify(rows) !== JSON.stringify(planoIni)) malos++;
        continue;
      }
      irregulares++;
      const ok = rows[0].fechaPago === pp &&
        rows[0].interesPeriodo === Math.round(10000000 * 0.05 * d / 30) &&
        rows[1].fechaPago === mesSiguiente(pp, r.diaPago) &&
        identidadOK(rows) && rows.reduce((s, p) => s + p.abonoCapital, 0) === 10000000 &&
        JSON.stringify(sinFechas(rows.slice(1))) === JSON.stringify(sinFechas(planoIni.slice(1)));
      if (!ok) { malos++; if (ej.length < 3) ej.push({ ini, pp, fila: clave(rows[0]), sig: rows[1].fechaPago }); }
      if (info.interesProporcional !== rows[0].interesPeriodo || info.interesCompleto !== planoIni[0].interesPeriodo) paridad++;
      // El preview del formulario: filasPreview + la misma transitoria del motor.
      const r5 = Fr._tasaPeriodo(0.05, 'Mensual');
      const filas = Fr.filasPreview(10000000, r5, 6, false, Math.round(Fr._pmt(r5, 6, 10000000)));
      Fr.aplicarTransitoriaPreview({ id: 'nuevo', modalidad: 'Capital + Intereses', tasaMensual: 5, periodoIrregularN: 1, periodoIrregularDesde: ini, periodoIrregularMora: 0 },
        filas, 1, 10000000, [{ id: 'nuevo-1', fechaPago: pp }]);
      if (JSON.stringify(filas.map(f => ({ int: f.interes, cap: f.capital, cuota: f.cuota }))) !== JSON.stringify(sinFechas(rows))) preview++;
    }
  }
  R.check('F7 barrido de ' + casosF7 + ' fechas de primer pago (hasta 400 dias: sin tope)', casosF7 === 3200);
  R.check('F7 ANTI-VACIO: casi todas son irregulares', irregulares >= 3150, 'irregulares=' + irregulares);
  R.check('F7 ninguna fecha posterior al inicio es rechazada (no hay limite de 2 meses)', lanzados === 0, ej);
  R.check('F7 cuota 1 = dias reales / 30 sobre el capital, en su fecha; cuota 2 el mes siguiente; el resto como siempre', malos === 0, malos + ' casos. Ej: ' + JSON.stringify(ej));
  R.check('F7 el espejo del formulario coincide con el motor (fechas, interes completo y proporcional)', paridad === 0, paridad + ' casos');
  R.check('F7 el cronograma tentativo del formulario == motor, fila a fila', preview === 0, preview + ' casos');
}

// ═════════════════════════════════════════════════════════════════════════════
// G — FASE 2 contra el server real
// ═════════════════════════════════════════════════════════════════════════════
async function seccionG() {
  const S = await arrancar(bdVacia('periodo-irregular-g'));
  const CI = { montoOrigen: 10000000, montoCOP: 10000000, tasaMensual: 5, plazoMeses: 6, modalidad: 'Capital + Intereses', fechaInicio: '2026-07-20', diaPago: 20 };
  const huella = () => leer(S.dbPath, d => JSON.stringify([d.prepare('SELECT * FROM loans ORDER BY id').all(), d.prepare('SELECT * FROM payments ORDER BY id').all()]));
  const put = (id, cambios) => pedir(S, 'PUT', '/api/loans/' + id, Object.assign({}, loanDe(S, id), cambios));
  try {
    R.seccion('G1 — alta con tiempo muerto: inicio 20-jul, primer pago 20-oct (92 dias)');
    const L1 = await crear(S, Object.assign({ nombre: 'G1', primerPago: '2026-10-20', primerPeriodo: 'proporcional' }, CI));
    const l1 = loanDe(S, L1);
    R.check('G1 se guarda la decision: dia 20, base septiembre, cuota 1 prorrateada desde el inicio',
      l1.diaPago === 20 && l1.fechaBaseCronograma === '2026-09-01' && l1.periodoIrregularN === 1 &&
      l1.periodoIrregularDesde === '2026-07-20' && l1.periodoIrregularMora === 0, l1);
    const f1 = filasDe(S, L1);
    R.check('G1 cuota 1 el 20-oct: 92 dias de interes (1.533.333) + capital 1.470.175 = 3.003.508',
      f1[0].fechaPago === '2026-10-20' && f1[0].interesPeriodo === 1533333 && f1[0].cuotaTotal === 3003508, clave(f1[0]));
    R.check('G1 cuota 2 el 20-nov de valor normal, y la ultima el 20-mar-2027',
      f1[1].fechaPago === '2026-11-20' && f1[1].cuotaTotal === 1970175 && f1[5].fechaPago === '2027-03-20', f1.map(p => p.fechaPago));
    R.eq('G1 suma de capital exacta', f1.reduce((s, p) => s + p.abonoCapital, 0), 10000000);
    await recalcular(S); await recalcular(S);
    R.eq('G1 reabrir la app no mueve nada', filasDe(S, L1).map(clave), f1.map(clave));
    const act = (await pedir(S, 'GET', '/api/activity')).json || [];
    R.check('G1 el historial deja constancia del primer pago y sus dias',
      act.some(a => /G1 por .*\[primer pago 2026-10-20, interes de 92 dias\]/.test(a.mensaje)), act.slice(0, 3).map(a => a.mensaje));

    R.seccion('G2 — "mes completo": la fecha se respeta, la cuota 1 cobra un mes');
    const L2 = await crear(S, Object.assign({ nombre: 'G2', primerPago: '2026-10-20', primerPeriodo: 'completo' }, CI));
    R.check('G2 sin transitoria, con base; cuota 1 el 20-oct con 500.000',
      loanDe(S, L2).periodoIrregularN === null && loanDe(S, L2).fechaBaseCronograma === '2026-09-01' &&
      filaDe(S, L2, 1).fechaPago === '2026-10-20' && filaDe(S, L2, 1).interesPeriodo === 500000, clave(filaDe(S, L2, 1)));

    R.seccion('G3 — Intereses con tiempo muerto');
    const L3 = await crear(S, { nombre: 'G3', montoOrigen: 5000000, montoCOP: 5000000, tasaMensual: 4, plazoMeses: 0, modalidad: 'Intereses',
      fechaInicio: '2026-07-20', diaPago: 20, primerPago: '2026-10-20', primerPeriodo: 'proporcional' });
    await pedir(S, 'GET', '/api/payments');   // auto-extend + auto-mora, como la app
    const f3 = filasDe(S, L3);
    R.check('G3 cuota 1 el 20-oct con 92 dias (613.333); la 2 el 20-nov con 200.000',
      f3[0].fechaPago === '2026-10-20' && f3[0].interesPeriodo === 613333 && f3[1].fechaPago === '2026-11-20' && f3[1].interesPeriodo === 200000, f3.map(clave));
    R.check('G3 el auto-extend no la toca y sigue habiendo al menos 3 cuotas futuras',
      f3.filter(p => p.fechaPago > '2026-07-31' && p.estadoPago === 'Pendiente').length >= 3);

    R.seccion('G4 — la fecha regular explicita == no elegir fecha');
    const L4a = await crear(S, Object.assign({ nombre: 'G4a' }, CI));
    const L4b = await crear(S, Object.assign({ nombre: 'G4b', primerPago: '2026-08-20', primerPeriodo: 'proporcional' }, CI));
    const cal = l => ({ dia: l.diaPago, base: l.fechaBaseCronograma, n: l.periodoIrregularN });
    R.eq('G4 mismo calendario guardado', cal(loanDe(S, L4b)), cal(loanDe(S, L4a)));
    R.eq('G4 mismo cronograma', filasDe(S, L4b).map(clave), filasDe(S, L4a).map(clave));

    R.seccion('G5 — rechazos: 400 y la BD intacta');
    const malos = [
      ['primer pago el mismo dia del inicio', { primerPago: '2026-07-20' }],
      ['primer pago antes del inicio', { primerPago: '2026-07-01' }],
      ['fecha inexistente', { primerPago: '2026-02-30' }],
      ['frecuencia desconocida', { primerPago: '2026-10-20', frecuencia: 'Diaria' }],
      ['modalidad Prestamo', { primerPago: '2026-10-20', modalidad: 'Prestamo', tasaMensual: 0, plazoMeses: 1, fechaDevolucion: '2026-10-20' }],
      ['primer periodo invalido', { primerPago: '2026-10-20', primerPeriodo: 'xyz' }],
    ];
    for (const [desc, extra] of malos) {
      const antes = huella();
      const r = await pedir(S, 'POST', '/api/loans', Object.assign({}, BASE_LOAN, CI, { nombre: 'G5' }, extra));
      R.check('G5 ' + desc + ': 400 con mensaje y la BD intacta', r.status === 400 && r.json && r.json.error && huella() === antes,
        { status: r.status, json: r.json });
    }

    R.seccion('G6 — editar SIN pagos: la decision se recalcula');
    const L6 = await crear(S, Object.assign({ nombre: 'G6', primerPago: '2026-10-20', primerPeriodo: 'proporcional' }, CI));
    let e = await put(L6, { fechaInicio: '2026-07-25', primerPago: '2026-10-20', primerPeriodo: 'proporcional' });
    R.check('G6 cambiar la fecha de inicio mueve el periodo: desde 25-jul, 87 dias (1.450.000)',
      e.status === 200 && loanDe(S, L6).periodoIrregularDesde === '2026-07-25' && filaDe(S, L6, 1).interesPeriodo === 1450000, clave(filaDe(S, L6, 1)));
    e = await put(L6, { primerPago: '2026-11-20', primerPeriodo: 'proporcional' });
    const d118 = diasISO('2026-07-25', '2026-11-20');
    R.check('G6 cambiar el primer pago al 20-nov: base octubre, ' + d118 + ' dias',
      e.status === 200 && loanDe(S, L6).fechaBaseCronograma === '2026-10-01' && filaDe(S, L6, 1).fechaPago === '2026-11-20' &&
      filaDe(S, L6, 1).interesPeriodo === Math.round(10000000 * 0.05 * d118 / 30), clave(filaDe(S, L6, 1)));
    e = await put(L6, { primerPago: '2026-11-20', primerPeriodo: 'completo' });
    R.check('G6 pasar a "mes completo": sin transitoria, 500.000', e.status === 200 && loanDe(S, L6).periodoIrregularN === null && filaDe(S, L6, 1).interesPeriodo === 500000);
    e = await put(L6, { primerPago: '2026-08-25', primerPeriodo: 'proporcional' });
    R.check('G6 volver a la fecha regular: sin base, dia = dia de inicio, cuota 1 el 25-ago',
      e.status === 200 && loanDe(S, L6).fechaBaseCronograma === null && loanDe(S, L6).diaPago === 25 &&
      loanDe(S, L6).periodoIrregularN === null && filaDe(S, L6, 1).fechaPago === '2026-08-25', loanDe(S, L6));
    const antesMal = huella();
    e = await put(L6, { primerPago: '2026-07-01' });
    R.check('G6 un primer pago invalido al editar: 4xx y la BD intacta', e.status >= 400 && e.status < 500 && huella() === antesMal, e);
    const L6b = await crear(S, Object.assign({ nombre: 'G6b', primerPago: '2026-10-20', primerPeriodo: 'proporcional' }, CI));
    e = await put(L6b, { fechaInicio: '2026-07-22' });   // cliente de la API: sin primerPago
    R.check('G6 (API sin primerPago) la fecha de inicio arrastra el "desde": 90 dias',
      e.status === 200 && loanDe(S, L6b).periodoIrregularDesde === '2026-07-22' && filaDe(S, L6b, 1).fechaPago === '2026-10-20' &&
      filaDe(S, L6b, 1).interesPeriodo === Math.round(10000000 * 0.05 * 90 / 30), clave(filaDe(S, L6b, 1)));

    R.seccion('G7 — editar CON actividad: el calendario queda congelado');
    const L7 = await crear(S, Object.assign({ nombre: 'G7', primerPago: '2026-08-05', primerPeriodo: 'proporcional' }, CI));
    await pagar(S, L7, 1);
    const cal7 = cal(loanDe(S, L7)), filas7 = filasDe(S, L7).map(clave);
    e = await put(L7, { notas: 'nota', diaPago: 3, primerPago: '2026-12-01', primerPeriodo: 'completo', periodoIrregularN: null });
    R.check('G7 la edicion se acepta (la nota cambia) pero dia, base y transitoria no se mueven',
      e.status === 200 && loanDe(S, L7).notas === 'nota' && JSON.stringify(cal(loanDe(S, L7))) === JSON.stringify(cal7) &&
      loanDe(S, L7).periodoIrregularDesde === '2026-07-20', cal(loanDe(S, L7)));
    R.eq('G7 el cronograma sigue igual', filasDe(S, L7).map(clave), filas7);

    R.seccion('G8 — el defecto previo: editar una nota devolvia el dia de pago al dia de inicio');
    const L8 = await crear(S, { nombre: 'G8', montoOrigen: 3000000, montoCOP: 3000000, tasaMensual: 5, plazoMeses: 4, modalidad: 'Capital + Intereses', fechaInicio: '2026-07-20', diaPago: 20 });
    await pedir(S, 'POST', '/api/loans/' + L8 + '/cambiar-dia-pago', { nuevoDia: 28 });
    const antes8 = filasDe(S, L8).map(clave);
    R.check('G8 ANTI-VACIO: tras el cambio de dia las cuotas caen el 28', antes8.every(p => p.vence.slice(8) === '28'), antes8.map(p => p.vence));
    // El body que manda ahora el formulario sin actividad: su primer pago REAL y el dia de inicio en `diaPago`.
    e = await put(L8, { notas: 'solo la nota', diaPago: 20, primerPago: filaDe(S, L8, 1).fechaPago, primerPeriodo: 'proporcional' });
    R.eq('G8 (sin pagos) editar la nota no mueve ninguna cuota', filasDe(S, L8).map(clave), antes8);
    await pagar(S, L8, 1);
    // Se toma la foto tras "reabrir la app": regenerar despues de un pago re-amortiza las cuotas
    // que faltan (el PMT sobre el plazo restante puede moverse 1 peso). Es lo de siempre y lo hace
    // igual /recalculate; aqui se mide solo lo que la edicion cambia.
    await recalcular(S);
    const antes8b = filasDe(S, L8).map(clave);
    e = await put(L8, { notas: 'otra nota', diaPago: 20 });   // formulario bloqueado: no viaja primerPago
    R.eq('G8 (con pagos) tampoco: el dia 28 queda congelado', filasDe(S, L8).map(clave), antes8b);

    R.seccion('G9 — cambio de dia sobre un tiempo muerto sin pagos: el cambio manda');
    const L9 = await crear(S, Object.assign({ nombre: 'G9', primerPago: '2026-10-20', primerPeriodo: 'proporcional' }, CI));
    const c9 = await pedir(S, 'POST', '/api/loans/' + L9 + '/cambiar-dia-pago', { nuevoDia: 5 });
    const d9 = diasISO('2026-07-20', '2026-11-05');
    R.check('G9 la cuota 1 pasa al 5-nov (nunca adelantar) con ' + d9 + ' dias desde el inicio, sin duplicar el prorrateo',
      c9.status === 200 && filaDe(S, L9, 1).fechaPago === '2026-11-05' && loanDe(S, L9).periodoIrregularN === 1 &&
      filaDe(S, L9, 1).interesPeriodo === Math.round(10000000 * 0.05 * d9 / 30), { r: c9.json, f: clave(filaDe(S, L9, 1)) });
    const f9 = clave(filaDe(S, L9, 1));
    await recalcular(S);
    R.eq('G9 reabrir la app no la mueve', clave(filaDe(S, L9, 1)), f9);

    R.seccion('G10 — un abono antes de la primera cuota recalcula el tiempo muerto sobre el capital vivo');
    const L10 = await crear(S, Object.assign({ nombre: 'G10', primerPago: '2026-10-20', primerPeriodo: 'proporcional' }, CI));
    await pedir(S, 'POST', '/api/loans/' + L10 + '/abono', { monto: 5000000, fecha: '2026-07-31', observaciones: '', recalcMode: 'mantener' });
    R.eq('G10 92 dias sobre 5.000.000 = 766.667', filaDe(S, L10, 1).interesPeriodo, 766667);
    await recalcular(S);
    R.eq('G10 reabrir la app no la mueve', filaDe(S, L10, 1).interesPeriodo, 766667);
  } finally { await cerrar(S); }
}

// ═════════════════════════════════════════════════════════════════════════════
// H — FASE 2: el FORMULARIO real (LoanModal)
// ═════════════════════════════════════════════════════════════════════════════
// El arnes del formulario: el `LoanModal` REAL pintado con su estado sembrado. Lo comparten H y L.
function arnesLoanModal() {
  const { cargarFrontend } = require('./lib/load-frontend');
  const FE = cargarFrontend({ silenciarConsola: true });
  const X = FE.sandbox;
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
  const nodos = (n, tag, out) => {
    out = out || [];
    if (Array.isArray(n)) { n.forEach(x => nodos(x, tag, out)); return out; }
    if (n && n.kids) { if (n.tag === tag) out.push(n); n.kids.forEach(x => nodos(x, tag, out)); }
    return out;
  };
  const useStateOrig = X.useState;
  // Estado INICIAL que el formulario calcula solo (el primer useState es el del formulario).
  const inicial = props => {
    let f;
    X.useState = init => { const v = typeof init === 'function' ? init() : init; if (f === undefined) f = v; return [v, () => {}]; };
    try { pintar({ type: X.LoanModal, props: Object.assign({ loan: null, trm: 4000, pays: [], onSave: () => {}, onClose: () => {}, clientes: [] }, props), children: [] }); }
    finally { X.useState = useStateOrig; }
    return f;
  };
  const vista = (cambios, props) => {
    const f = Object.assign({}, inicial(props || {}), cambios);
    let i = 0;
    X.useState = init => { const v = i === 0 ? f : (typeof init === 'function' ? init() : init); i++; return [v, () => {}]; };
    const guardados = [];
    try {
      const arbol = pintar({ type: X.LoanModal, props: Object.assign({ loan: null, trm: 4000, pays: [], onSave: p => guardados.push(p), onClose: () => {}, clientes: [] }, props || {}), children: [] });
      const t = textos(arbol);
      const boton = nodos(arbol, 'button').filter(b => /Crear prestamo|Guardar cambios/.test(textos(b).join('')))[0];
      const fechas = nodos(arbol, 'input').filter(n => n.props && n.props.type === 'date');
      const radios = nodos(arbol, 'input').filter(n => n.props && n.props.type === 'radio' && n.props.name === 'primerPeriodo');
      return { t, todo: t.join(' '), boton, fechas, radios, guardados, enviar: () => { if (boton) boton.props.onClick(); return guardados; } };
    } finally { X.useState = useStateOrig; }
  };
  // Como `vista`, pero el setter del formulario SI aplica el cambio: `hacer` recibe el arbol y
  // dispara un evento (un select, un radio) y se devuelve el estado que deja.
  const accion = (cambios, props, hacer) => {
    let f = Object.assign({}, inicial(props || {}), cambios);
    let i = 0;
    X.useState = init => {
      const v = i === 0 ? f : (typeof init === 'function' ? init() : init);
      const set = i === 0 ? (u => { f = typeof u === 'function' ? u(f) : u; }) : (() => {});
      i++; return [v, set];
    };
    try { hacer(pintar({ type: X.LoanModal, props: Object.assign({ loan: null, trm: 4000, pays: [], onSave: () => {}, onClose: () => {}, clientes: [] }, props || {}), children: [] })); }
    finally { X.useState = useStateOrig; }
    return f;
  };
  return { X, pintar, textos, nodos, inicial, vista, accion };
}

function seccionH() {
  const { X, inicial, vista } = arnesLoanModal();
  const FORM ={ nombre: 'H', montoOrigen: '10000000', modalidad: 'Capital + Intereses', frecuencia: 'Mensual', tasaMensual: '5', plazoMeses: '6', fechaInicio: '2026-09-15' };

  R.seccion('H1 — alta: el primer pago nace un mes despues del inicio y lo sigue');
  const f0 = inicial({});
  // 3.3.0 (Fase 2): nadie eligio todavia -> `primerPeriodo` null, y vale la opcion por defecto
  // del caso (perdonar con dias de sobra, cobrar los dias si el periodo es corto).
  R.check('H1 primer pago = el mismo dia del mes siguiente, no elegido a mano, sin decision tomada',
    f0.primerPago === X.primerPagoRegular(f0.fechaInicio, 'Mensual') && f0.primerPagoManual === false &&
    f0.primerPeriodo === null && f0.primerPeriodoCaso === null, f0);

  R.seccion('H2 — el campo solo aparece donde aplica (desde 3.3.0, en las tres frecuencias)');
  const tieneCampo = v => v.t.indexOf('Primer pago') !== -1;
  for (const freq of ['Mensual', 'Semanal', 'Quincenal']) {
    R.check('H2 visible en Capital + Intereses ' + freq, tieneCampo(vista(Object.assign({}, FORM, { frecuencia: freq }))));
    R.check('H2 visible en Intereses ' + freq, tieneCampo(vista(Object.assign({}, FORM, { modalidad: 'Intereses', frecuencia: freq }))));
  }
  for (const [desc, c] of [['Prestamo', { modalidad: 'Prestamo' }], ['Pago Unico', { modalidad: 'Pago Unico' }], ['Interes Diario', { modalidad: 'Interes Diario' }]]) {
    R.check('H2 oculto en ' + desc, !tieneCampo(vista(Object.assign({}, FORM, c))));
  }

  R.seccion('H3 — la pregunta solo aparece con un periodo irregular y tasa');
  R.check('H3 fecha regular: sin bloque', vista(Object.assign({}, FORM, { primerPago: '2026-10-15' })).todo.indexOf('PRIMER PERIODO') === -1);
  const muerto = vista(Object.assign({}, FORM, { primerPago: '2026-12-15', primerPagoManual: true }));
  R.check('H3 tiempo muerto de 91 dias: el bloque aparece', muerto.todo.indexOf('PRIMER PERIODO: 91 DIAS') !== -1, muerto.todo.slice(0, 300));
  R.check('H3 tasa 0: se ve el campo pero no la pregunta',
    (v => tieneCampo(v) && v.todo.indexOf('PRIMER PERIODO') === -1)(vista(Object.assign({}, FORM, { tasaMensual: '0', primerPago: '2026-12-15' }))));

  // 3.3.0 (Fase 2): con dias de sobra la pregunta es que hacer con ellos, y la opcion por
  // defecto es PERDONARLOS (decision del PO). Los rotulos de 3.2.0 ("Cobrar mes completo",
  // "Cobrar proporcional - N dias") cambiaron a proposito: ver la seccion L.
  R.seccion('H4 — las dos opciones con sus cifras en vivo');
  R.check('H4 "Perdonar 61 dias (dar dias de gracia)" con el interes de un mes ($ 500.000)',
    muerto.t.indexOf('Perdonar 61 dias (dar dias de gracia)') !== -1 && muerto.t.indexOf('(interes ' + X.fmt(500000) + ')') !== -1, muerto.todo.slice(0, 600));
  R.check('H4 "Cobrar los 91 dias" ($ 1.516.667)', muerto.t.indexOf('Cobrar los 91 dias') !== -1 && muerto.t.indexOf('(interes ' + X.fmt(1516667) + ')') !== -1);
  const marcado = (v, n) => v.radios.filter(r => r.props.checked).length === 1 && v.radios[n].props.checked;
  R.check('H4 "Perdonar" preseleccionado y en primer lugar', muerto.radios.length === 2 && marcado(muerto, 0) && muerto.radios[0].props.checked);
  // La cuota 1 que anuncia la pantalla es la que el motor va a guardar, en las dos opciones.
  const motorDe = modo => buildSchedule(conPrimerPago({ id: 'x', nombre: 'x', modalidad: 'Capital + Intereses', frecuencia: 'Mensual', tasaMensual: 5, plazoMeses: 6,
    montoCOP: 10000000, fechaInicio: '2026-09-15', diaPago: 15 }, '2026-12-15', modo));
  R.check('H4 por defecto la primera cuota que muestra el formulario es la normal que guarda el motor (' + X.fmt(motorDe('completo')[0].cuotaTotal) + ')',
    motorDe('completo')[0].cuotaTotal === 1970175 && muerto.t.indexOf(X.fmt(1970175)) !== -1 && muerto.todo.indexOf('Primera cuota (15 de dic de 2026, 91 dias)') !== -1);
  const prop = vista(Object.assign({}, FORM, { primerPago: '2026-12-15', primerPagoManual: true, primerPeriodo: 'proporcional', primerPeriodoCaso: 'gracia' }));
  const motorP = motorDe('proporcional');
  R.check('H4 eligiendo cobrar los dias, la primera cuota es la que guarda el motor (' + X.fmt(motorP[0].cuotaTotal) + ')',
    marcado(prop, 1) && prop.t.indexOf(X.fmt(motorP[0].cuotaTotal)) !== -1);
  R.check('H4 el tiempo muerto cobrado se explica', prop.todo.indexOf('El interes de los 91 dias se cobra completo en la primera cuota.') !== -1);
  R.check('H4 ...y con perdonar no (no se cobra)', muerto.todo.indexOf('se cobra completo en la primera cuota') === -1);

  R.seccion('H5 — sin tope superior en el selector');
  const pp = muerto.fechas[1];
  R.check('H5 el campo de primer pago tiene minimo (el dia siguiente al inicio) y NO tiene maximo',
    !!pp && pp.props.min === '2026-09-16' && pp.props.max === undefined, pp && pp.props);
  const lejos = vista(Object.assign({}, FORM, { primerPago: '2027-12-15', primerPagoManual: true }));
  R.check('H5 a mas de un año: aviso suave, la pregunta sigue ahi', lejos.todo.indexOf('revisa la fecha') !== -1 && lejos.todo.indexOf('PRIMER PERIODO: 456 DIAS') !== -1);

  R.seccion('H6 — lo que viaja al backend');
  const env = vista(Object.assign({}, FORM, { primerPago: '2026-12-15', primerPagoManual: true })).enviar();
  R.check('H6 alta: viajan primerPago y la decision vigente (perdonar, la de por defecto), no el estado de pantalla',
    env.length === 1 && env[0].primerPago === '2026-12-15' && env[0].primerPeriodo === 'completo' &&
    !('primerPagoManual' in env[0]) && !('primerPeriodoCaso' in env[0]), env[0]);
  const envSem = vista(Object.assign({}, FORM, { frecuencia: 'Semanal', primerPago: '2026-12-15', primerPagoManual: true })).enviar();
  R.check('H6 Semanal: desde 3.3.0 tambien viajan primerPago y primerPeriodo', envSem.length === 1 && envSem[0].primerPago === '2026-12-15' &&
    envSem[0].primerPeriodo === 'completo' && envSem[0].frecuencia === 'Semanal', envSem[0]);
  const malo = vista(Object.assign({}, FORM, { primerPago: '2026-09-10', primerPagoManual: true }));
  R.check('H6 primer pago antes del inicio: se avisa y NO se envia', malo.enviar().length === 0 && malo.todo.indexOf('Debe ser posterior a la fecha de inicio') !== -1);

  R.seccion('H7 — edicion');
  const L = { id: 'L7', nombre: 'Ed', cedula: '', telefono: '', moneda: 'COP', montoOrigen: 10000000, trmAcordada: 0, montoCOP: 10000000, tasaMensual: 5,
    plazoMeses: 6, modalidad: 'Capital + Intereses', frecuencia: 'Mensual', fechaInicio: '2026-07-20', diaPago: 20, fechaBaseCronograma: '2026-09-01',
    periodoIrregularN: 1, periodoIrregularDesde: '2026-07-20', periodoIrregularMora: 0, estado: 'Activo', notas: '' };
  const fila1 = { id: 'L7-1', prestamoId: 'L7', cuotaN: 1, fechaPago: '2026-10-20', estadoPago: 'Pendiente' };
  const fe = inicial({ loan: L, pays: [fila1] });
  R.check('H7 sin actividad: muestra el primer pago REAL (20-oct), elegido, proporcional',
    fe.primerPago === '2026-10-20' && fe.primerPagoManual === true && fe.primerPeriodo === 'proporcional', fe);
  R.check('H7 una transitoria guardada como "mes completo" se reabre como tal',
    inicial({ loan: Object.assign({}, L, { periodoIrregularN: null }), pays: [fila1] }).primerPeriodo === 'completo');
  const cambioDia = Object.assign({}, L, { diaPago: 28, fechaBaseCronograma: null, periodoIrregularN: null });
  const pagada = Object.assign({}, fila1, { fechaPago: '2026-08-28', estadoPago: 'Pagado' });
  const conAct = vista({}, { loan: cambioDia, pays: [pagada] });
  R.check('H7 con actividad: fecha de inicio y primer pago bloqueados', conAct.fechas.length === 2 && conAct.fechas.every(n => n.props.disabled === true));
  const envAct = conAct.enviar();
  R.check('H7 con actividad: no viaja primerPago y el dia de pago es el del prestamo (28), no el de la fecha de inicio (20)',
    envAct.length === 1 && !('primerPago' in envAct[0]) && envAct[0].diaPago === 28, envAct[0]);
  R.check('H7 la mora consolidada de un cambio de dia cuenta como actividad',
    vista({}, { loan: Object.assign({}, L, { periodoIrregularMora: 5000 }), pays: [fila1] }).fechas.every(n => n.props.disabled === true));
}

// ═════════════════════════════════════════════════════════════════════════════
// L — 3.3.0, FASE 2: el formulario en las tres frecuencias
// ═════════════════════════════════════════════════════════════════════════════
// El campo "Primer pago" se ofrece tambien en Semanal y Quincenal, y la pregunta depende del
// caso: con dias de SOBRA se pregunta que hacer con ellos y "Perdonar (dar dias de gracia)"
// viene preseleccionado (decision del PO); con un periodo CORTO no hay nada que perdonar y sigue
// preseleccionado cobrar los dias. L1 fija el espejo contra el motor; L2-L7, el formulario
// real; L8, lo que el formulario envia contra el server real.
async function seccionL() {
  const { resolverPrimerPago, inicioPeriodoRegular, primerPagoRegular, tasaPeriodo } = engine;
  const Fr = cargarFront();
  const K4 = 4000000;
  const BASE = { id: 'L', nombre: 'l', modalidad: 'Capital + Intereses', tasaMensual: 10, plazoMeses: 8, montoCOP: K4, montoOrigen: K4, moneda: 'COP' };
  const filasCmp = filas => JSON.stringify(filas.map(x => ({ int: x.interes, cap: x.capital, cuota: x.cuota })));

  R.seccion('L1 — el espejo del formulario contra el motor: 3 frecuencias x 5 inicios x 1..120 dias');
  const INICIOS = ['2026-07-28', '2026-01-31', '2026-02-28', '2026-03-31', '2026-12-31'];
  const conteo = {};
  const malos = [];
  let n = 0;
  for (const f of ['Semanal', 'Quincenal', 'Mensual']) {
    conteo[f] = { regular: 0, gracia: 0, sinGracia: 0 };
    for (const ini of INICIOS) {
      const loan = Object.assign({}, BASE, { frecuencia: f, fechaInicio: ini, diaPago: +ini.slice(8, 10) });
      if (Fr.primerPagoRegular(ini, f) !== primerPagoRegular(ini, f)) malos.push({ f, ini, m: 'primer pago regular' });
      for (let d = 1; d <= 120; d++) {
        n++;
        const pp = sumarDias(ini, d);
        const info = Fr.infoPrimerPeriodo(K4, 10, ini, pp, f);
        const malo = m => { if (malos.length < 50) malos.push({ f, ini, d, m, info }); else malos.length++; };
        conteo[f][info.caso]++;
        const rC = resolverPrimerPago(loan, pp, 'completo');
        if (info.irregular !== rC.irregular) { malo('irregular'); continue; }
        if (Fr.inicioPeriodoRegular(pp, f) !== inicioPeriodoRegular(pp, f)) malo('inicio del periodo');
        // Lo que se guardaria perdonando: desde cuando corre el interes y cuantos dias se regalan.
        if (info.inicioIntereses !== rC.fechaInicioIntereses) malo('arranque del interes');
        if (info.graciaDias !== diasISO(ini, rC.fechaInicioIntereses)) malo('dias de gracia');
        if ((info.caso === 'gracia') !== (rC.fechaInicioIntereses > ini)) malo('caso');
        if (info.modoPorDefecto !== (info.caso === 'gracia' ? 'completo' : 'proporcional')) malo('opcion por defecto');
        // El primer pago de un prestamo ya guardado se reconstruye desde su base y su frecuencia.
        const conC = conPrimerPago(loan, pp, 'completo'), conP = conPrimerPago(loan, pp, 'proporcional');
        if (Fr.primerPagoDe(conC) !== pp || Fr.primerPagoDe(conP) !== pp) malo('primer pago guardado');
        if (!info.irregular) continue;
        const rowsC = buildSchedule(conC), rowsP = buildSchedule(conP);
        if (info.interesCompleto !== rowsC[0].interesPeriodo) malo('interes de un periodo');
        if (info.interesProporcional !== rowsP[0].interesPeriodo) malo('interes de los dias');
        // El cronograma tentativo del formulario, en las dos opciones, == el que guarda el motor.
        const r = tasaPeriodo(0.1, f);
        const filas = () => Fr.filasPreview(K4, r, 8, false, Math.round(Fr._pmt(r, 8, K4)));
        const prev = filas();
        Fr.aplicarTransitoriaPreview({ id: 'nuevo', modalidad: 'Capital + Intereses', frecuencia: f, tasaMensual: 10, periodoIrregularN: 1,
          periodoIrregularDesde: ini, periodoIrregularMora: 0 }, prev, 1, K4, [{ id: 'nuevo-1', fechaPago: pp }]);
        if (filasCmp(prev) !== JSON.stringify(sinFechas(rowsP))) malo('preview cobrando los dias');
        if (filasCmp(filas()) !== JSON.stringify(sinFechas(rowsC))) malo('preview perdonando');
      }
    }
  }
  R.check('L1 ' + n + ' primeros pagos: fecha regular, caso, arranque del interes, dias de gracia, opcion por defecto, primer pago guardado, ' +
    'interes de cada opcion y cronograma tentativo, frontend == motor', malos.length === 0 && n === 1800, malos.slice(0, 3));
  R.check('L1 ANTI-VACIO: en cada frecuencia hay primeros pagos regulares, con dias de sobra y cortos',
    ['Semanal', 'Quincenal', 'Mensual'].every(f => conteo[f].regular >= 5 && conteo[f].gracia >= 400 && conteo[f].sinGracia >= 5), conteo);
  R.check('L1 el borde de fin de mes (28-feb -> 31-mar) no tiene dias que perdonar: no es "gracia"',
    Fr.infoPrimerPeriodo(K4, 10, '2026-02-28', '2026-03-31', 'Mensual').caso === 'sinGracia' &&
    resolverPrimerPago(Object.assign({}, BASE, { frecuencia: 'Mensual', fechaInicio: '2026-02-28', diaPago: 28 }), '2026-03-31', 'completo').fechaInicioIntereses === '2026-02-28');

  const { X, vista, inicial, accion, nodos, textos } = arnesLoanModal();
  const FS = { nombre: 'L', montoOrigen: '4000000', modalidad: 'Capital + Intereses', frecuencia: 'Semanal', tasaMensual: '10', plazoMeses: '8',
    fechaInicio: '2026-07-28', primerPagoManual: true };
  const tiene = (v, s) => v.todo.indexOf(s) !== -1;
  const marcada = (v, i) => v.radios.length === 2 && v.radios.filter(r => r.props.checked).length === 1 && v.radios[i].props.checked;

  R.seccion('L2 — semanal con dias de sobra: "Perdonar" preseleccionado');
  const sg = vista(Object.assign({}, FS, { primerPago: '2026-08-09' }));
  R.check('L2 la pregunta habla de la semana', tiene(sg, 'PRIMER PERIODO: 12 DIAS') &&
    tiene(sg, 'El primer pago llega 12 dias despues del inicio: mas que una semana normal (7 dias). ¿Que hacer con los dias de mas?'), sg.todo.slice(0, 800));
  R.check('L2 primera opcion, MARCADA: "Perdonar 5 dias (dar dias de gracia)" con el interes de una semana ($ 92.379)',
    marcada(sg, 0) && sg.t.indexOf('Perdonar 5 dias (dar dias de gracia)') !== -1 && sg.t.indexOf('(interes ' + X.fmt(92379) + ')') !== -1 &&
    tiene(sg, 'La primera cuota cobra una semana de interes; los dias de gracia no se cobran nunca'));
  R.check('L2 segunda opcion: "Cobrar los 12 dias" ($ 158.364)', sg.t.indexOf('Cobrar los 12 dias') !== -1 && sg.t.indexOf('(interes ' + X.fmt(158364) + ')') !== -1);
  R.check('L2 la gracia a la vista: sin interes del 28-jul al 2-ago, con interes del 2-ago al 9-ago',
    tiene(sg, 'Sin interes: 28 de jul al 2 de ago') && tiene(sg, 'Con interes: 2 de ago al 9 de ago'), sg.todo.slice(0, 900));
  R.check('L2 la cadencia: "Primer periodo de 12 dias · despues, cada domingo"', tiene(sg, 'Primer periodo de 12 dias · despues, cada domingo'));
  const motorSem = modo => buildSchedule(conPrimerPago(Object.assign({}, BASE, { frecuencia: 'Semanal', fechaInicio: '2026-07-28', diaPago: 28 }), '2026-08-09', modo));
  R.check('L2 la primera cuota anunciada es la que guarda el motor perdonando (' + X.fmt(motorSem('completo')[0].cuotaTotal) + ')',
    tiene(sg, 'Primera cuota (09 de ago de 2026, 12 dias)') && sg.t.indexOf(X.fmt(motorSem('completo')[0].cuotaTotal)) !== -1);
  const sgP = vista(Object.assign({}, FS, { primerPago: '2026-08-09', primerPeriodo: 'proporcional', primerPeriodoCaso: 'gracia' }));
  R.check('L2 cobrando los dias: queda marcada, la primera cuota es la del motor (' + X.fmt(motorSem('proporcional')[0].cuotaTotal) + ') y no hay linea de gracia',
    marcada(sgP, 1) && sgP.t.indexOf(X.fmt(motorSem('proporcional')[0].cuotaTotal)) !== -1 && !tiene(sgP, 'Sin interes:') &&
    tiene(sgP, 'El interes de los 12 dias se cobra completo en la primera cuota.'));

  R.seccion('L3 — quincenal con dias de sobra');
  const qg = vista(Object.assign({}, FS, { frecuencia: 'Quincenal', primerPago: '2026-08-17' }));
  R.check('L3 "mas que una quincena normal (14 dias)"; "Perdonar 6 dias" marcado con una quincena ($ 200.000); "Cobrar los 20 dias" ($ 285.714)',
    tiene(qg, 'mas que una quincena normal (14 dias)') && marcada(qg, 0) && qg.t.indexOf('Perdonar 6 dias (dar dias de gracia)') !== -1 &&
    qg.t.indexOf('(interes ' + X.fmt(200000) + ')') !== -1 && qg.t.indexOf('Cobrar los 20 dias') !== -1 && qg.t.indexOf('(interes ' + X.fmt(285714) + ')') !== -1,
    qg.todo.slice(0, 800));
  R.check('L3 la cadencia: "un lunes de por medio (cada 14 dias)"; la gracia del 28-jul al 3-ago',
    tiene(qg, 'despues, un lunes de por medio (cada 14 dias)') && tiene(qg, 'Sin interes: 28 de jul al 3 de ago'));
  const mg = vista(Object.assign({}, FS, { frecuencia: 'Mensual', primerPago: '2026-10-15' }));
  R.check('L3 mensual: "mas que un mes normal", "Perdonar 49 dias" marcado con un mes ($ 400.000)',
    tiene(mg, 'mas que un mes normal. ¿Que hacer con los dias de mas?') && marcada(mg, 0) && mg.t.indexOf('Perdonar 49 dias (dar dias de gracia)') !== -1 &&
    mg.t.indexOf('(interes ' + X.fmt(400000) + ')') !== -1, mg.todo.slice(0, 800));

  R.seccion('L4 — periodo corto: no hay nada que perdonar y sigue preseleccionado cobrar los dias');
  const sc = vista(Object.assign({}, FS, { primerPago: '2026-08-01' }));
  R.check('L4 semanal a 4 dias: "antes de completar una semana"; "Cobrar solo los 4 dias" ($ 52.788) marcado y primero; "Cobrar la semana completa" ($ 92.379)',
    tiene(sc, 'antes de completar una semana (7 dias). ¿Cuanto interes cobra la primera cuota?') && marcada(sc, 0) &&
    sc.t.indexOf('Cobrar solo los 4 dias') !== -1 && sc.t.indexOf('(interes ' + X.fmt(52788) + ')') !== -1 &&
    sc.t.indexOf('Cobrar la semana completa') !== -1 && sc.t.indexOf('(interes ' + X.fmt(92379) + ')') !== -1, sc.todo.slice(0, 800));
  R.check('L4 ...sin rastro de "Perdonar" ni linea de gracia', !tiene(sc, 'Perdonar') && !tiene(sc, 'Sin interes:'));
  const qc = vista(Object.assign({}, FS, { frecuencia: 'Quincenal', primerPago: '2026-08-07' }));
  R.check('L4 quincenal a 10 dias: "Cobrar solo los 10 dias" marcado / "Cobrar la quincena completa"',
    marcada(qc, 0) && qc.t.indexOf('Cobrar solo los 10 dias') !== -1 && qc.t.indexOf('Cobrar la quincena completa') !== -1);
  const mc = vista(Object.assign({}, FS, { frecuencia: 'Mensual', primerPago: '2026-08-17' }));
  R.check('L4 mensual a 20 dias: "antes de completar un mes"; "Cobrar solo los 20 dias" marcado / "Cobrar el mes completo"',
    tiene(mc, 'antes de completar un mes. ') && marcada(mc, 0) && mc.t.indexOf('Cobrar solo los 20 dias') !== -1 && mc.t.indexOf('Cobrar el mes completo') !== -1);
  const borde = vista(Object.assign({}, FS, { frecuencia: 'Mensual', fechaInicio: '2026-02-28', primerPago: '2026-03-31' }));
  R.check('L4 borde de fin de mes (28-feb -> 31-mar): "no cae un mes despues", "Cobrar los 31 dias" (sin "solo"), sin "Perdonar"',
    tiene(borde, 'El primer pago no cae un mes despues del inicio.') && borde.t.indexOf('Cobrar los 31 dias') !== -1 && !tiene(borde, 'Perdonar'), borde.todo.slice(0, 800));

  R.seccion('L5 — primer pago regular: sin pregunta, con la cadencia de la frecuencia');
  for (const [f, pp, txt] of [['Semanal', '2026-08-04', 'Una semana despues del inicio · despues, cada martes'],
    ['Quincenal', '2026-08-11', 'Dos semanas despues del inicio · despues, un martes de por medio (cada 14 dias)'],
    ['Mensual', '2026-08-28', 'Un mes despues del inicio · despues, el 28 de cada mes']]) {
    const v = vista(Object.assign({}, FS, { frecuencia: f, primerPago: pp, primerPagoManual: false }));
    R.check('L5 ' + f + ': "' + txt + '"', tiene(v, txt) && !tiene(v, 'PRIMER PERIODO') && v.radios.length === 0, v.todo.slice(0, 600));
  }

  R.seccion('L6 — la frecuencia y la fecha arrastran al primer pago; la decision se recuerda por caso');
  const selFreq = a => nodos(a, 'select').filter(s => textos(s).indexOf('Quincenal') !== -1)[0];
  const radiosDe = a => nodos(a, 'input').filter(x => x.props && x.props.type === 'radio' && x.props.name === 'primerPeriodo');
  const aMen = Object.assign({}, FS, { frecuencia: 'Mensual', primerPago: '2026-08-28', primerPagoManual: false });
  const aSem = accion(aMen, {}, a => selFreq(a).props.onChange({ target: { value: 'Semanal' } }));
  const aQui = accion(aMen, {}, a => selFreq(a).props.onChange({ target: { value: 'Quincenal' } }));
  R.check('L6 cambiar a Semanal / Quincenal mueve el primer pago no elegido a 7 / 14 dias (4-ago / 11-ago)',
    aSem.frecuencia === 'Semanal' && aSem.primerPago === '2026-08-04' && aQui.frecuencia === 'Quincenal' && aQui.primerPago === '2026-08-11', { aSem, aQui });
  const aMan = accion(Object.assign({}, aMen, { primerPago: '2026-09-20', primerPagoManual: true }), {}, a => selFreq(a).props.onChange({ target: { value: 'Semanal' } }));
  R.check('L6 un primer pago elegido a mano no se mueve al cambiar la frecuencia', aMan.frecuencia === 'Semanal' && aMan.primerPago === '2026-09-20');
  const aIni = accion(Object.assign({}, FS, { primerPago: '2026-08-04', primerPagoManual: false }), {},
    a => nodos(a, 'input').filter(x => x.props && x.props.type === 'date')[0].props.onChange({ target: { value: '2026-08-01' } }));
  R.check('L6 en Semanal, cambiar la fecha de inicio arrastra el primer pago una semana despues (8-ago)', aIni.primerPago === '2026-08-08', aIni);
  const aEl = accion(Object.assign({}, FS, { primerPago: '2026-08-09' }), {}, a => radiosDe(a)[1].props.onChange());
  R.check('L6 elegir "Cobrar los 12 dias" guarda la decision Y el caso en que se tomo',
    aEl.primerPeriodo === 'proporcional' && aEl.primerPeriodoCaso === 'gracia', aEl);
  R.check('L6 ...y el formulario la respeta', marcada(vista(aEl), 1));
  const otro = vista(Object.assign({}, FS, { primerPago: '2026-08-01', primerPeriodo: 'completo', primerPeriodoCaso: 'gracia' }));
  R.check('L6 si la fecha pasa a un periodo corto, "perdonar" no se arrastra como "cobrar la semana completa": vuelve "Cobrar solo los 4 dias"',
    marcada(otro, 0) && otro.t.indexOf('Cobrar solo los 4 dias') !== -1);
  const envOtro = otro.enviar();
  R.check('L6 ...y es la que viaja', envOtro.length === 1 && envOtro[0].primerPeriodo === 'proporcional', envOtro[0]);

  R.seccion('L7 — edicion de un prestamo semanal');
  const LS = { id: 'LS', nombre: 'Sem', cedula: '', telefono: '', moneda: 'COP', montoOrigen: K4, trmAcordada: 0, montoCOP: K4, tasaMensual: 10, plazoMeses: 8,
    modalidad: 'Capital + Intereses', frecuencia: 'Semanal', fechaInicio: '2026-07-28', diaPago: 9, fechaBaseCronograma: '2026-08-02',
    periodoIrregularN: null, periodoIrregularDesde: null, periodoIrregularMora: 0, fechaInicioIntereses: '2026-08-02', estado: 'Activo', notas: '' };
  const fila1 = { id: 'LS-1', prestamoId: 'LS', cuotaN: 1, fechaPago: '2026-08-09', estadoPago: 'Pendiente' };
  const fl = inicial({ loan: LS, pays: [fila1] });
  R.check('L7 un semanal guardado perdonando se reabre con su primer pago (9-ago), elegido, en "Perdonar" y con su caso',
    fl.primerPago === '2026-08-09' && fl.primerPagoManual === true && fl.primerPeriodo === 'completo' && fl.primerPeriodoCaso === 'gracia', fl);
  R.check('L7 ...sin la fila 1 a mano, el primer pago sale de su base + una semana', inicial({ loan: LS, pays: [] }).primerPago === '2026-08-09');
  const fr = inicial({ loan: Object.assign({}, LS, { diaPago: 28, fechaBaseCronograma: null, fechaInicioIntereses: '2026-07-28' }), pays: [] });
  R.check('L7 un semanal regular se reabre con su primer pago a 7 dias, sin marcarlo como elegido', fr.primerPago === '2026-08-04' && fr.primerPagoManual === false && fr.primerPeriodo === null, fr);
  const env7 = vista({}, { loan: LS, pays: [fila1] }).enviar();
  R.check('L7 guardar sin tocar nada reenvia la misma decision (9-ago, perdonar)',
    env7.length === 1 && env7[0].primerPago === '2026-08-09' && env7[0].primerPeriodo === 'completo' && !('primerPeriodoCaso' in env7[0]), env7[0]);

  R.seccion('L8 — lo que el formulario envia, contra el server real');
  const S = await arrancar(bdVacia('periodo-irregular-l'));
  try {
    const casos = [
      ['semanal perdonando 5 dias', Object.assign({}, FS, { nombre: 'L8a', primerPago: '2026-08-09' }), '2026-08-02', 92379, null],
      ['semanal cobrando los 12 dias', Object.assign({}, FS, { nombre: 'L8b', primerPago: '2026-08-09', primerPeriodo: 'proporcional', primerPeriodoCaso: 'gracia' }), '2026-07-28', 158364, 1],
      ['quincenal perdonando 6 dias', Object.assign({}, FS, { nombre: 'L8c', frecuencia: 'Quincenal', primerPago: '2026-08-17' }), '2026-08-03', 200000, null],
      ['semanal corto (4 dias, por defecto)', Object.assign({}, FS, { nombre: 'L8d', primerPago: '2026-08-01' }), '2026-07-28', 52788, 1],
      ['mensual perdonando 49 dias', Object.assign({}, FS, { nombre: 'L8e', frecuencia: 'Mensual', primerPago: '2026-10-15' }), '2026-09-15', 400000, null],
      ['Intereses semanal perdonando', Object.assign({}, FS, { nombre: 'L8f', modalidad: 'Intereses', plazoMeses: '', primerPago: '2026-08-09' }), '2026-08-02', 92379, null],
    ];
    for (const [desc, estado, arranque, interes, transN] of casos) {
      const v = vista(estado);
      const env = v.enviar();
      const r = env.length === 1 ? await pedir(S, 'POST', '/api/loans', env[0]) : { status: 0 };
      const id = r.json && r.json.id;
      const L = id ? loanDe(S, id) : null, f1 = id ? filaDe(S, id, 1) : null;
      R.check('L8 ' + desc + ': cuota 1 el ' + estado.primerPago + ' con ' + X.fmt(interes) + ' de interes, interes desde el ' + arranque +
        ', y la primera cuota que anuncio el formulario es la guardada',
        r.status === 201 && !!L && !!f1 && f1.fechaPago === estado.primerPago && f1.interesPeriodo === interes && L.fechaInicioIntereses === arranque &&
        (L.periodoIrregularN === null ? null : +L.periodoIrregularN) === transN && L.frecuencia === estado.frecuencia &&
        v.t.indexOf(X.fmt(f1.cuotaTotal)) !== -1,
        { status: r.status, err: r.json && r.json.error, loan: L && { fii: L.fechaInicioIntereses, n: L.periodoIrregularN, f: L.frecuencia }, fila: clave(f1) });
    }
  } finally { await cerrar(S); }
}

// ═════════════════════════════════════════════════════════════════════════════
// M — 3.3.0, FASE 3: liquidar un semanal o quincenal, y liquidar dentro de la gracia
// ═════════════════════════════════════════════════════════════════════════════
// Hasta 3.2.0 la casilla "interes del mes en curso" cobraba un MES en cualquier frecuencia: un
// semanal de 4.000.000 al 10% ofrecia 400.000 cuando su cuota cobra 92.379. Ahora cobra un
// periodo de la frecuencia, y dentro de los dias perdonados al crear no cobra nada (0), porque
// el interes todavia no corre. El reloj de la suite esta en 31-jul-2026.
async function seccionM() {
  const { resolverPrimerPago, tasaPeriodo, interesPeriodoParcial } = engine;
  const { cargarFrontend } = require('./lib/load-frontend');
  const FE = cargarFrontend({ silenciarConsola: true });
  const X = FE.sandbox;
  X.Date = Date;                    // el reloj congelado de esta suite (31-jul-2026)
  const CAP = FE.captura;
  const K4 = 4000000;
  const SEM = { id: 'M', nombre: 'Sem', cedula: '', telefono: '', moneda: 'COP', trmAcordada: 0, montoOrigen: K4, montoCOP: K4, tasaMensual: 10,
    plazoMeses: 8, modalidad: 'Capital + Intereses', frecuencia: 'Semanal', fechaInicio: '2026-07-28', diaPago: 28, estado: 'Activo', notas: '' };
  // Como lo guarda el server: la decision del primer pago Y desde cuando corre el interes.
  const conDecision = (loan, pp, modo) => Object.assign(conPrimerPago(loan, pp, modo),
    { fechaInicioIntereses: resolverPrimerPago(loan, pp, modo).fechaInicioIntereses });
  const liq = (loan, o) => X.computeLiquidacion(loan, buildSchedule(loan), Object.assign({ hasta: '2026-07-31' }, o));

  R.seccion('M1 — la casilla cobra UN periodo de la frecuencia: la cuota normal del motor');
  const s = liq(SEM, { incluyeProxMes: true });
  R.check('M1 semanal: una semana (92.379), no un mes (400.000), y el total la suma',
    s.intProxMes === 92379 && s.intExtra === 92379 && s.total === K4 + 92379 && s.frecuencia === 'Semanal' && !s.periodoIrregular, s);
  R.eq('M1 ...es exactamente el interes de la cuota del motor', s.intProxMes, buildSchedule(SEM)[0].interesPeriodo);
  const QUI = Object.assign({}, SEM, { frecuencia: 'Quincenal' });
  R.eq('M1 quincenal: una quincena (200.000)', liq(QUI, { incluyeProxMes: true }).intExtra, 200000);
  const rowsS = buildSchedule(SEM);
  const pagadaS = rowsS.map(p => p.cuotaN === 1 ? Object.assign({}, p, { estadoPago: 'Pagado' }) : p);
  const tras1 = X.computeLiquidacion(SEM, pagadaS, { incluyeProxMes: true, hasta: '2026-08-05' });
  R.check('M1 tras pagar la cuota 1: el periodo en curso es el de la cuota 2, sobre el capital que queda',
    tras1.capitalPendiente === rowsS[1].saldoInicial && tras1.intProxMes === rowsS[1].interesPeriodo, { liq: tras1.intProxMes, motor: rowsS[1].interesPeriodo });
  let difCorto = 0, difMensual = 0, nM1 = 0;
  for (const f of ['Semanal', 'Quincenal', 'Mensual']) for (const cap of [1, 999, 50000, 349660, 1000000, 3333333, 4000000, 10000000, 87654321])
    for (const t of [1.5, 3, 5, 7.25, 10, 11.165, 12.93, 20]) {
      nM1++;
      const loan = Object.assign({}, SEM, { frecuencia: f, tasaMensual: t, montoOrigen: cap, montoCOP: cap });
      const v = liq(loan, {}).intProxMes;
      if (f === 'Mensual') { if (v !== Math.round(cap * t / 100)) difMensual++; }
      else if (v !== buildSchedule(loan)[0].interesPeriodo || v !== Math.round(cap * tasaPeriodo(t / 100, f))) difCorto++;
    }
  R.check('M1 barrido de ' + nM1 + ' casos: semanal y quincenal = la cuota normal del motor; mensual, la expresion de siempre bit a bit',
    difCorto === 0 && difMensual === 0, { difCorto, difMensual });

  R.seccion('M2 — periodo irregular en curso en un semanal: los dias con el periodo de la semana');
  const trS = conDecision(SEM, '2026-08-09', 'proporcional');
  const t3 = liq(trS, { incluyeProxMes: true });
  R.check('M2 van 3 de 12 dias: se cobran 3 con la formula por periodo (' + interesPeriodoParcial(K4, 10, 'Semanal', 3) + ', no dias/30)',
    t3.periodoIrregular && t3.diasPeriodo === 12 && t3.diasCobrados === 3 && t3.intExtra === interesPeriodoParcial(K4, 10, 'Semanal', 3) &&
    t3.intExtra !== Math.round(K4 * 0.1 * 3 / 30), t3);
  R.eq('M2 todo el periodo (12 dias) = el interes de la cuota transitoria del motor (158.364)',
    liq(trS, { incluyeProxMes: true, diasProxMes: 12 }).intExtra, buildSchedule(trS)[0].interesPeriodo);

  R.seccion('M3 — dentro de los dias perdonados no se cobra interes por adelantado');
  const grS = conDecision(SEM, '2026-08-09', 'completo');
  const g = liq(grS, { incluyeProxMes: true });
  R.check('M3 ANTI-VACIO: el semanal perdona del 28-jul al 2-ago', grS.fechaInicioIntereses === '2026-08-02' && grS.periodoIrregularN === null);
  R.check('M3 liquidar el 31-jul (en la gracia), aunque se marque la casilla: 0 de interes, total = capital',
    g.enGracia && g.graciaHasta === '2026-08-02' && g.intProxMes === 0 && g.intExtra === 0 && !g.incluyeProxMes && g.total === K4, g);
  R.check('M3 el ultimo dia de gracia (1-ago) tambien es 0', liq(grS, { incluyeProxMes: true, hasta: '2026-08-01' }).intExtra === 0);
  const g2 = liq(grS, { incluyeProxMes: true, hasta: '2026-08-02' });
  R.check('M3 desde el 2-ago corre el interes: la casilla vuelve a cobrar una semana', !g2.enGracia && g2.intExtra === 92379, g2);
  R.check('M3 dentro de la gracia no se pregunta por el interes antes de imprimir el cronograma',
    X.preguntaInteresMes(grS, buildSchedule(grS)) === false && X.preguntaInteresMes(SEM, buildSchedule(SEM)) === true);
  const fin = conDecision(Object.assign({}, SEM, { fechaInicio: '2026-07-01', diaPago: 1 }), '2026-08-05', 'completo');
  R.check('M3 con la gracia ya vencida (termino el 29-jul) se vuelve a preguntar',
    fin.fechaInicioIntereses === '2026-07-29' && X.preguntaInteresMes(fin, buildSchedule(fin)) === true && !liq(fin, {}).enGracia);
  const MEN = { id: 'MM', nombre: 'Men', moneda: 'COP', trmAcordada: 0, montoOrigen: 10000000, montoCOP: 10000000, tasaMensual: 5, plazoMeses: 6,
    modalidad: 'Capital + Intereses', frecuencia: 'Mensual', fechaInicio: '2026-07-20', diaPago: 20, estado: 'Activo' };
  const grM = conDecision(MEN, '2026-10-15', 'completo');
  R.check('M3 mensual perdonando hasta el 15-sep: 0 en la gracia (31-jul), un mes (500.000) despues (20-sep)',
    liq(grM, { incluyeProxMes: true }).intExtra === 0 && liq(grM, { incluyeProxMes: true, hasta: '2026-09-20' }).intExtra === 500000);
  // El escenario del Bug #73: dentro de la gracia se cambio el dia de cobro, y la transitoria
  // arranca donde arranca el interes. Mientras dure la gracia tampoco hay dias que cobrar.
  const cambio = Object.assign({}, grM, { diaPago: 25, fechaBaseCronograma: '2026-09-01', periodoIrregularN: 1, periodoIrregularDesde: '2026-09-15', periodoIrregularMora: 0 });
  const cEn = liq(cambio, { incluyeProxMes: true, diasProxMes: 20, hasta: '2026-08-10' });
  const cDes = liq(cambio, { incluyeProxMes: true, hasta: '2026-09-25' });
  R.check('M3 con el dia cambiado dentro de la gracia: 0 antes del 15-sep (aunque se pidan 20 dias); despues, los dias desde el 15-sep',
    cEn.enGracia && !cEn.periodoIrregular && cEn.intExtra === 0 && cDes.periodoIrregular && cDes.diasTranscurridos === 10 &&
    cDes.intExtra === 166667, { cEn: cEn.intExtra, cDes: [cDes.diasTranscurridos, cDes.intExtra] });
  R.check('M3 un prestamo sin gracia (interes desde el inicio) nunca esta "en gracia"',
    !liq(Object.assign({}, SEM, { fechaInicioIntereses: '2026-07-28' }), {}).enGracia &&
    !liq(Object.assign({}, SEM, { fechaInicioIntereses: '2026-07-28' }), { hasta: '2026-07-20' }).enGracia);

  // Render de un modal real con su estado sembrado por posicion (patron de la seccion I).
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
  const nodos = (n, tag, out) => {
    out = out || [];
    if (Array.isArray(n)) { n.forEach(x => nodos(x, tag, out)); return out; }
    if (n && n.kids) { if (n.tag === tag) out.push(n); n.kids.forEach(x => nodos(x, tag, out)); }
    return out;
  };
  const useStateOrig = X.useState;
  const montar = (Comp, props, estado) => {
    let i = 0;
    X.useState = init => { const k = i++; const v = (k < estado.length && estado[k] !== undefined) ? estado[k] : (typeof init === 'function' ? init() : init); return [v, () => {}]; };
    try {
      const arbol = pintar({ type: Comp, props, children: [] });
      return { t: textos(arbol), todo: textos(arbol).join(' '), inputs: nodos(arbol, 'input'), botones: nodos(arbol, 'button') };
    } finally { X.useState = useStateOrig; }
  };
  const boton = (v, re) => v.botones.filter(b => re.test(textos(b).join('')))[0];
  const pdfDe = fn => { CAP.pdfs.length = 0; fn(); return CAP.pdfs[0] ? CAP.pdfs[0].html : ''; };

  R.seccion('M4 — Liquidar deuda, el cronograma y el Estado de Liquidacion (REALES) en un semanal');
  const confirmados = [];
  const propsS = { loan: SEM, pays: buildSchedule(SEM), datosPago: '', onConfirm: (id, monto, intExtra) => { confirmados.push({ monto, intExtra }); }, onClose: () => {} };
  const lq = montar(X.LiquidarModal, propsS, [true, false, false, null]);      // [incluyeProxMes, liqSending, pdfBusy, dias]
  R.check('M4 la casilla: "Cobrar el interes de la semana en curso  + $ 92.379", explicando que esa semana aun no se facturo',
    lq.t.indexOf('Cobrar el interes de la semana en curso') !== -1 && lq.t.indexOf('+ ' + X.fmt(92379)) !== -1 &&
    lq.todo.indexOf('asi que esa semana aun no se ha facturado') !== -1 && lq.todo.indexOf('mes en curso') === -1, lq.todo.slice(0, 600));
  R.check('M4 el desglose: "Interes de la semana en curso", una semana al 10% mensual, y el total',
    lq.t.indexOf('Interes de la semana en curso') !== -1 && lq.t.indexOf('Una semana de interes al 10% mensual sobre el capital pendiente') !== -1 &&
    lq.t.indexOf(X.fmt(K4 + 92379)) !== -1);
  boton(lq, /Confirmar liquidacion/).props.onClick();
  await new Promise(r => setTimeout(r, 0));
  R.check('M4 confirmar manda el capital y UNA semana de interes', confirmados.length === 1 && confirmados[0].monto === K4 && confirmados[0].intExtra === 92379, confirmados);
  const est = pdfDe(() => boton(lq, /Generar PDF de liquidacion/).props.onClick());
  R.check('M4 el Estado de Liquidacion dice lo mismo', est.indexOf('Interes de la semana en curso') !== -1 &&
    est.indexOf('Una semana de interes al 10% mensual sobre el capital pendiente') !== -1 && est.indexOf(X.fmt(K4 + 92379)) !== -1 &&
    est.indexOf('mes en curso') === -1, est.length);
  const lqQ = montar(X.LiquidarModal, Object.assign({}, propsS, { loan: QUI, pays: buildSchedule(QUI) }), [true, false, false, null]);
  R.check('M4 quincenal: "Cobrar el interes de la quincena en curso  + $ 200.000"',
    lqQ.t.indexOf('Cobrar el interes de la quincena en curso') !== -1 && lqQ.t.indexOf('+ ' + X.fmt(200000)) !== -1 &&
    lqQ.t.indexOf('Una quincena de interes al 10% mensual sobre el capital pendiente') !== -1);
  const cr = montar(X.CronogramaPdfModal, { loan: SEM, pays: buildSchedule(SEM), onClose: () => {} }, [true, false, null]);
  R.check('M4 el modal del cronograma: misma casilla y la misma cifra en el valor que va al PDF',
    cr.t.indexOf('Cobrar el interes de la semana en curso') !== -1 && cr.todo.indexOf('+ interes de la semana en curso ' + X.fmt(92379)) !== -1, cr.todo.slice(0, 500));
  const crono = pdfDe(() => boton(cr, /Descargar PDF/).props.onClick());
  R.check('M4 el PDF del cronograma: "+ interes de la semana en curso" y el total con una semana',
    crono.indexOf('+ interes de la semana en curso') !== -1 && crono.indexOf(X.fmt(K4 + 92379)) !== -1, crono.length);

  R.seccion('M5 — en la gracia: el aviso en vez de la casilla, en pantalla y en el papel');
  const propsG = Object.assign({}, propsS, { loan: grS, pays: buildSchedule(grS) });
  const confG = [];
  propsG.onConfirm = (id, monto, intExtra) => { confG.push({ monto, intExtra }); };
  const lg = montar(X.LiquidarModal, propsG, [true, false, false, null]);   // aun con la casilla "marcada" en el estado
  R.check('M5 Liquidar deuda: sin casilla; el aviso dice que hay gracia y desde cuando corre el interes',
    lg.inputs.filter(n => n.props.type === 'checkbox').length === 0 && lg.t.indexOf('Dias de gracia: sin interes en curso') !== -1 &&
    lg.todo.indexOf('el interes empieza a correr el ' + X.fmtD('2026-08-02')) !== -1, lg.todo.slice(0, 600));
  R.check('M5 ...total = capital, sin fila de interes', lg.t.indexOf(X.fmt(K4)) !== -1 && lg.t.indexOf('Interes de la semana en curso') === -1);
  boton(lg, /Confirmar liquidacion/).props.onClick();
  await new Promise(r => setTimeout(r, 0));
  R.check('M5 confirmar manda 0 de interes adelantado', confG.length === 1 && confG[0].monto === K4 && confG[0].intExtra === 0, confG);
  const estG = pdfDe(() => boton(lg, /Generar PDF de liquidacion/).props.onClick());
  R.check('M5 el Estado de Liquidacion explica la gracia en la vigencia y no cobra interes',
    estG.indexOf('El credito esta en sus dias de gracia: el interes empieza a correr el ' + X.fmtD('2026-08-02')) !== -1 &&
    estG.indexOf('Interes de la semana en curso') === -1 && estG.indexOf(X.fmt(K4)) !== -1, estG.length);
  const crG = montar(X.CronogramaPdfModal, { loan: grS, pays: buildSchedule(grS), onClose: () => {} }, [true, false, null]);
  R.check('M5 si el modal del cronograma se abre igual, muestra el aviso y el valor sin interes',
    crG.t.indexOf('Dias de gracia: sin interes en curso') !== -1 && crG.todo.indexOf('interes de la semana') === -1 && crG.t.indexOf(X.fmt(K4)) !== -1);

  R.seccion('M6 — contra el server real: la caja cuadra con lo que mostro el modal');
  const S = await arrancar(bdVacia('periodo-irregular-m'));
  try {
    const BASE_S = { montoOrigen: K4, montoCOP: K4, tasaMensual: 10, plazoMeses: 8, modalidad: 'Capital + Intereses', frecuencia: 'Semanal',
      fechaInicio: '2026-07-28', diaPago: 28 };
    for (const [desc, extra, interes] of [['semanal sin gracia, con la casilla', {}, 92379],
      ['semanal dentro de la gracia', { primerPago: '2026-08-09', primerPeriodo: 'completo' }, 0]]) {
      const id = await crear(S, Object.assign({ nombre: 'M6' }, BASE_S, extra));
      const lDb = loanDe(S, id), pDb = filasDe(S, id);
      const Lb = X.computeLiquidacion(lDb, pDb, { incluyeProxMes: true, hasta: '2026-07-31' });
      const liqPre = X.computeLiquidacion(lDb, pDb, {});
      const r = await pedir(S, 'POST', '/api/loans/' + id + '/abono', { monto: Lb.capitalPendiente, fecha: '2026-07-31', observaciones: '',
        liquidar: true, intExtra: Lb.intExtra, recalcMode: 'mantener' });
      const tras = filasDe(S, id);
      const caja = tras.reduce((acc, p) => acc + X.cobrosDe(p).reduce((a, e) => a + e.cop, 0), 0);
      R.check('M6 ' + desc + ': interes ' + X.fmt(interes) + ', Finalizado, y la caja es EXACTAMENTE el total del modal (' + X.fmt(K4 + interes) + ')',
        r.status === 200 && Lb.intExtra === interes && loanDe(S, id).estado === 'Finalizado' && caja === Lb.total && Lb.total === K4 + interes,
        { st: r.status, intExtra: Lb.intExtra, caja, total: Lb.total });
      if (interes > 0) {
        const paz = pdfDe(() => X.generateReciboAbono(loanDe(S, id), tras, { monto: Lb.capitalPendiente, fecha: '2026-07-31', liquidar: true, intExtra: Lb.intExtra,
          pre: { saldo: K4, saldoCaja: K4, cuota: pDb[0].cuotaTotal, cuotas: pDb.length, intereses: 0, plazo: 8, liq: liqPre } }));
        R.check('M6 el Paz y Salvo rotula el interes como de la SEMANA en curso, con una semana de interes',
          paz.indexOf('Interes de la semana en curso') !== -1 && paz.indexOf('Una semana de interes al 10% mensual') !== -1 &&
          paz.indexOf('Interes del mes en curso') === -1 && paz.indexOf(X.fmt(K4 + interes)) !== -1, paz.length);
      }
    }
  } finally { await cerrar(S); }
}

// ═════════════════════════════════════════════════════════════════════════════
// I — FASE 3: liquidar durante un periodo irregular con DIAS VARIABLES
// ═════════════════════════════════════════════════════════════════════════════
// El caso: C+I de 10.000.000 al 5%, inicio 20-jul, primer pago 20-oct (tiempo muerto de 92
// dias, proporcional). El reloj esta en 31-jul: van 11 dias del periodo.
async function seccionI() {
  const { cargarFrontend } = require('./lib/load-frontend');
  const FE = cargarFrontend({ silenciarConsola: true });
  const X = FE.sandbox;
  X.Date = Date;                    // el reloj congelado de esta suite (31-jul-2026)
  const CAP = FE.captura;
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
  const nodos = (n, tag, out) => {
    out = out || [];
    if (Array.isArray(n)) { n.forEach(x => nodos(x, tag, out)); return out; }
    if (n && n.kids) { if (n.tag === tag) out.push(n); n.kids.forEach(x => nodos(x, tag, out)); }
    return out;
  };

  const base = { id: 'LQ1', nombre: 'Liq', cedula: '', telefono: '', moneda: 'COP', trmAcordada: 0, montoOrigen: 10000000, montoCOP: 10000000,
    tasaMensual: 5, plazoMeses: 6, modalidad: 'Capital + Intereses', frecuencia: 'Mensual', fechaInicio: '2026-07-20', diaPago: 20, estado: 'Activo', notas: '' };
  const loan = conPrimerPago(base, '2026-10-20', 'proporcional');
  const pays = buildSchedule(loan);
  const L = o => X.computeLiquidacion(loan, pays, Object.assign({ hasta: '2026-07-31' }, o));

  R.seccion('I1 — computeLiquidacion: el interes en curso son DIAS, no un mes');
  const sin = L({});
  R.check('I1 detecta el periodo irregular en curso: 92 dias del 20-jul al 20-oct, van 11',
    sin.periodoIrregular && sin.diasPeriodo === 92 && sin.diasTranscurridos === 11 && sin.periodoDesde === '2026-07-20' && sin.periodoHasta === '2026-10-20', sin);
  R.check('I1 sin marcar: la casilla ofrece los 11 dias corridos (183.333) y el total es solo el capital',
    sin.diasCobrados === 11 && sin.intProxMes === 183333 && sin.intExtra === 0 && sin.total === 10000000, sin);
  const def = L({ incluyeProxMes: true });
  R.check('I1 marcada, por defecto: 11 dias (183.333), valido hasta hoy', def.intExtra === 183333 && def.total === 10183333 && def.validoHasta === '2026-07-31', def);
  const c45 = L({ incluyeProxMes: true, diasProxMes: 45 });
  R.check('I1 el administrador elige 45 dias: 750.000, cubre hasta el 3-sep', c45.diasCobrados === 45 && c45.intExtra === 750000 && c45.total === 10750000 && c45.validoHasta === '2026-09-03', c45);
  const todo = L({ incluyeProxMes: true, diasProxMes: 92 });
  R.check('I1 el periodo completo (92) cobra EXACTAMENTE el interes de la cuota transitoria del motor, y vale hasta su vencimiento',
    todo.intExtra === pays[0].interesPeriodo && todo.intExtra === 1533333 && todo.validoHasta === '2026-10-20', { todo: todo.intExtra, motor: pays[0].interesPeriodo });
  R.check('I1 mas dias que el periodo se acotan al periodo (500 -> 92)', L({ incluyeProxMes: true, diasProxMes: 500 }).diasCobrados === 92);
  const cero = L({ incluyeProxMes: true, diasProxMes: -3 });
  R.check('I1 dias negativos -> 0, sin interes, vale para hoy', cero.diasCobrados === 0 && cero.intExtra === 0 && cero.validoHasta === '2026-07-31', cero);
  R.eq('I1 menos dias que los corridos: la cifra vale solo para hoy', L({ incluyeProxMes: true, diasProxMes: 5 }).validoHasta, '2026-07-31');
  R.check('I1 un valor vacio o no numerico cae al default (los corridos)',
    [null, '', 'abc', undefined].every(v => L({ incluyeProxMes: true, diasProxMes: v }).diasCobrados === 11));
  R.eq('I1 mas adelante en el periodo (30-ago) los dias corridos son 41', L({ hasta: '2026-08-30' }).diasTranscurridos, 41);

  R.seccion('I2 — fuera de un periodo irregular nada cambia (regla de 3.1.0)');
  const comp = conPrimerPago(base, '2026-10-20', 'completo');
  const Lc = X.computeLiquidacion(comp, buildSchedule(comp), { incluyeProxMes: true, hasta: '2026-07-31' });
  R.check('I2 primer periodo decidido como "mes completo": un mes (500.000), sin dias', !Lc.periodoIrregular && Lc.intExtra === 500000, Lc);
  const reg = Object.assign({}, base);
  const Lr = X.computeLiquidacion(reg, buildSchedule(reg), { incluyeProxMes: true, hasta: '2026-07-31', diasProxMes: 45 });
  R.check('I2 prestamo regular: un mes aunque llegue un numero de dias', !Lr.periodoIrregular && Lr.intExtra === 500000 && Lr.validoHasta === null, Lr);
  const pagada = pays.map(p => p.cuotaN === 1 ? Object.assign({}, p, { estadoPago: 'Pagado' }) : p);
  R.check('I2 con la transitoria ya pagada, la cuota en curso es un mes normal',
    !X.computeLiquidacion(loan, pagada, { incluyeProxMes: true, hasta: '2026-07-31' }).periodoIrregular);
  const ints = conPrimerPago(Object.assign({}, base, { modalidad: 'Intereses', tasaMensual: 4, montoOrigen: 5000000, montoCOP: 5000000, plazoMeses: 0 }), '2026-10-20', 'proporcional');
  const Li = X.computeLiquidacion(ints, buildSchedule(ints, 1, 5000000, 3), { incluyeProxMes: true, diasProxMes: 30, hasta: '2026-07-31' });
  R.check('I2 tambien en Intereses: 30 dias sobre 5.000.000 al 4% = 200.000', Li.periodoIrregular && Li.intExtra === 200000, Li);
  R.check('I2 Prestamo, tasa 0 e Interes Diario no entran',
    !X.computeLiquidacion(Object.assign({}, loan, { tasaMensual: 0 }), pays, { hasta: '2026-07-31' }).periodoIrregular &&
    !X.computeLiquidacion(Object.assign({}, loan, { modalidad: 'Prestamo' }), pays, { hasta: '2026-07-31' }).periodoIrregular &&
    !X.computeLiquidacion(Object.assign({}, loan, { modalidad: 'Interes Diario' }), [], { hasta: '2026-07-31' }).periodoIrregular);

  // Render de un modal real con su estado sembrado por posicion; los setters quedan registrados.
  const useStateOrig = X.useState;
  const montar = (Comp, props, estado) => {
    const llamadas = [];
    let i = 0;
    X.useState = init => {
      const k = i++;
      const v = (k < estado.length && estado[k] !== undefined) ? estado[k] : (typeof init === 'function' ? init() : init);
      return [v, nuevo => llamadas.push({ k, nuevo })];
    };
    try {
      const arbol = pintar({ type: Comp, props, children: [] });
      return { arbol, t: textos(arbol), todo: textos(arbol).join(' '), llamadas,
        inputs: nodos(arbol, 'input'), botones: nodos(arbol, 'button') };
    } finally { X.useState = useStateOrig; }
  };
  const boton = (v, re) => v.botones.filter(b => re.test(textos(b).join('')))[0];

  R.seccion('I3 — Liquidar deuda (modal REAL): el campo de dias');
  const confirmados = [];
  const props = { loan, pays, datosPago: '', onConfirm: (id, monto, intExtra) => { confirmados.push({ id, monto, intExtra }); }, onClose: () => {} };
  // Orden de useState en LiquidarModal: [incluyeProxMes, liqSending, pdfBusy, diasProxMes]
  const lq = montar(X.LiquidarModal, props, [true, false, false, 45]);
  const numero = lq.inputs.filter(n => n.props.type === 'number')[0];
  R.check('I3 la casilla habla del PERIODO en curso, con su cifra de 45 dias',
    lq.t.indexOf('Cobrar el interes del periodo en curso') !== -1 && lq.t.indexOf('+ ' + X.fmt(750000)) !== -1, lq.todo.slice(0, 400));
  R.check('I3 explica el periodo: del 20-jul al 20-oct, 92 dias, van 11',
    lq.todo.indexOf('va del ' + X.fmtD('2026-07-20') + ' al ' + X.fmtD('2026-10-20') + ' (92 dias) y hoy van 11') !== -1);
  R.check('I3 campo numerico de dias: vale 45, de 0 a 92', !!numero && numero.props.value === 45 && numero.props.min === 0 && numero.props.max === 92, numero && numero.props);
  R.check('I3 atajos "Hasta hoy (11)" y "Todo el periodo (92)"', !!boton(lq, /^Hasta hoy \(11\)$/) && !!boton(lq, /^Todo el periodo \(92\)$/));
  R.check('I3 el desglose dice cuantos dias y de que periodo',
    lq.t.indexOf('Interes de 45 dias del periodo en curso') !== -1 && lq.todo.indexOf('45 de 92 dias del periodo') !== -1);
  R.check('I3 TOTAL A LIQUIDAR = capital + 45 dias', lq.t.indexOf(X.fmt(10750000)) !== -1);
  numero.props.onChange({ target: { value: '30' } });
  boton(lq, /^Todo el periodo/).props.onClick();
  R.check('I3 el campo y los atajos escriben los dias (30 y 92) en el estado del modal',
    lq.llamadas.some(c => c.k === 3 && c.nuevo === 30) && lq.llamadas.some(c => c.k === 3 && c.nuevo === 92), lq.llamadas);
  boton(lq, /Confirmar liquidacion/).props.onClick();
  await new Promise(r => setTimeout(r, 0));
  R.check('I3 confirmar manda al backend el capital y el interes de los 45 dias', confirmados.length === 1 &&
    confirmados[0].monto === 10000000 && confirmados[0].intExtra === 750000, confirmados);
  CAP.pdfs.length = 0;
  boton(lq, /Generar PDF de liquidacion/).props.onClick();
  const est = CAP.pdfs[0] ? CAP.pdfs[0].html : '';
  R.check('I3 el Estado de Liquidacion imprime los mismos 45 dias, el mismo total y hasta cuando vale',
    CAP.pdfs.length === 1 && est.indexOf('Interes del periodo en curso') !== -1 && est.indexOf('45 de 92 dias') !== -1 &&
    est.indexOf(X.fmt(10750000)) !== -1 && est.indexOf('valido hasta el ' + X.fmtD('2026-09-03')) !== -1, est.length);
  const lqSin = montar(X.LiquidarModal, props, [false, false, false, null]);
  R.check('I3 sin marcar no aparece el campo, y la cifra ofrecida son los dias corridos',
    lqSin.inputs.filter(n => n.props.type === 'number').length === 0 && lqSin.t.indexOf('+ ' + X.fmt(183333)) !== -1);

  R.seccion('I4 — el modal del cronograma PDF (REAL): mismos dias, misma cifra');
  const cr = montar(X.CronogramaPdfModal, { loan, pays, onClose: () => {} }, [true, false, 45]);   // [incluyeProxMes, busy, dias]
  R.check('I4 en pantalla: el total con 45 dias y hasta cuando vale',
    cr.t.indexOf(X.fmt(10750000)) !== -1 && cr.todo.indexOf('+ interes de 45 dias') !== -1 &&
    cr.todo.indexOf('valido hasta el ' + X.fmtD('2026-09-03') + ', hasta donde cubren los 45 dias') !== -1, cr.todo.slice(0, 500));
  CAP.pdfs.length = 0;
  boton(cr, /Descargar PDF/).props.onClick();
  const crono = CAP.pdfs[0] ? CAP.pdfs[0].html : '';
  R.check('I4 el PDF del cronograma imprime el mismo total, los 45 dias y la misma vigencia',
    CAP.pdfs.length === 1 && crono.indexOf(X.fmt(10750000)) !== -1 && crono.indexOf('+ interes de 45 dias del periodo en curso') !== -1 &&
    crono.indexOf('Valido hasta el ' + X.fmtD('2026-09-03')) !== -1 && crono.indexOf('Incluye 45 dias de interes') !== -1, crono.length);
  const crReg = montar(X.CronogramaPdfModal, { loan: reg, pays: buildSchedule(reg), onClose: () => {} }, [true, false, null]);
  R.check('I4 prestamo regular: el modal sigue ofreciendo el mes (texto de 3.1.0)',
    crReg.t.indexOf('Cobrar el interes del mes en curso') !== -1 && crReg.inputs.filter(n => n.props.type === 'number').length === 0);

  R.seccion('I5 — contra el server real: la liquidacion con dias variables cierra y la caja cuadra');
  const S = await arrancar(bdVacia('periodo-irregular-i'));
  try {
    const id = await crear(S, { nombre: 'I5', montoOrigen: 10000000, montoCOP: 10000000, tasaMensual: 5, plazoMeses: 6, modalidad: 'Capital + Intereses',
      fechaInicio: '2026-07-20', diaPago: 20, primerPago: '2026-10-20', primerPeriodo: 'proporcional' });
    const lDb = loanDe(S, id), pDb = filasDe(S, id);
    const Lb = X.computeLiquidacion(lDb, pDb, { incluyeProxMes: true, diasProxMes: 45, hasta: '2026-07-31' });
    const liqPre = X.computeLiquidacion(lDb, pDb, {});
    R.check('I5 ANTI-VACIO: el prestamo del server trae el periodo irregular en curso', Lb.periodoIrregular && Lb.intExtra === 750000, Lb);
    const r = await pedir(S, 'POST', '/api/loans/' + id + '/abono', { monto: Lb.capitalPendiente, fecha: '2026-07-31', observaciones: '',
      liquidar: true, intExtra: Lb.intExtra, recalcMode: 'mantener' });
    const tras = filasDe(S, id);
    const ab = tras.filter(p => p.id.indexOf('-ab-') !== -1)[0];
    R.check('I5 liquidado: prestamo Finalizado y el abono lleva los 750.000 como interes', r.status === 200 && loanDe(S, id).estado === 'Finalizado' &&
      !!ab && ab.interesPeriodo === 750000, { st: r.status, ab: ab && clave(ab) });
    const caja = tras.reduce((s, p) => s + X.cobrosDe(p).reduce((a, e) => a + e.cop, 0), 0);
    R.eq('I5 la caja registrada es EXACTAMENTE el total que mostro el modal', caja, Lb.total);
    CAP.pdfs.length = 0;
    X.generateReciboAbono(loanDe(S, id), tras, { monto: Lb.capitalPendiente, fecha: '2026-07-31', liquidar: true, intExtra: Lb.intExtra,
      pre: { saldo: 10000000, saldoCaja: 10000000, cuota: pDb[0].cuotaTotal, cuotas: pDb.length, intereses: 0, plazo: 6, liq: liqPre } });
    const paz = CAP.pdfs[0] ? CAP.pdfs[0].html : '';
    R.check('I5 el Paz y Salvo titula con el total recibido y rotula el interes como del PERIODO en curso',
      CAP.pdfs.length === 1 && paz.indexOf(X.fmt(10750000)) !== -1 && paz.indexOf('Interes del periodo en curso') !== -1 && paz.indexOf('Interes del mes en curso') === -1, paz.length);
  } finally { await cerrar(S); }

  R.seccion('I6 — el cable: los dias viajan a los tres documentos');
  const fuente = f => fs.readFileSync(path.join(REPO, 'public', 'js', f), 'utf8');
  R.check('I6 LiquidarModal los usa en la cifra y en el Estado de Liquidacion',
    /computeLiquidacion\(cLoan,pays,\{incluyeProxMes:incluyeProxMes,diasProxMes:diasProxMes,hasta:hoyLiq\}\)/.test(fuente('modales/LiquidarModal.js')) &&
    /generateEstadoLiquidacion\(cLoan,pays,datosPago,\{incluyeProxMes:incluyeProxMes,diasProxMes:diasProxMes,hasta:hoyLiq\}\)/.test(fuente('modales/LiquidarModal.js')));
  R.check('I6 CronogramaPdfModal los manda al PDF',
    /\{incluyeProxMes:incluyeProxMes,diasProxMes:diasProxMes\}\)/.test(fuente('modales/CronogramaPdfModal.js')));
  R.check('I6 los generadores los pasan a computeLiquidacion',
    /diasProxMes: opts\.diasProxMes/.test(fuente('pdf/cronograma.js')) && /diasProxMes: opts\.diasProxMes/.test(fuente('pdf/estado-liquidacion.js')));
}

// ═════════════════════════════════════════════════════════════════════════════
// J — LA MORA CONSOLIDADA EN LA LIQUIDACION (Fase 4)
// ═════════════════════════════════════════════════════════════════════════════
// `/cambiar-dia-pago` BORRA las cuotas En Mora y consolida sus intereses dentro de la cuota
// transitoria (`periodoIrregularMora`). `computeLiquidacion` solo sumaba el `interesPeriodo`
// de las filas En Mora, asi que esa plata --deuda YA causada-- desaparecia del total, de los
// tres documentos y de la caja. Medido con el server real: 3.382.739 antes del cambio de dia
// y 3.000.000 despues. La propiedad que lo fija es simple y fuerte: cambiar el dia de cobro
// no puede mover el valor de liquidacion.
async function seccionJ() {
  const { cargarFrontend } = require('./lib/load-frontend');
  const FE = cargarFrontend({ silenciarConsola: true });
  const X = FE.sandbox;
  X.Date = Date;                      // el reloj congelado de esta suite (31-jul-2026)
  const CAP = FE.captura;
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
  const nodos = (n, tag, out) => {
    out = out || [];
    if (Array.isArray(n)) { n.forEach(x => nodos(x, tag, out)); return out; }
    if (n && n.kids) { if (n.tag === tag) out.push(n); n.kids.forEach(x => nodos(x, tag, out)); }
    return out;
  };
  const montar = (Comp, props, estado) => {
    const orig = X.useState;
    let i = 0;
    X.useState = init => {
      const k = i++;
      const v = (k < estado.length && estado[k] !== undefined) ? estado[k] : (typeof init === 'function' ? init() : init);
      return [v, () => {}];
    };
    try {
      const arbol = pintar({ type: Comp, props, children: [] });
      return { t: textos(arbol), todo: textos(arbol).join(' '), botones: nodos(arbol, 'button') };
    } finally { X.useState = orig; }
  };
  const boton = (v, re) => v.botones.filter(b => re.test(textos(b).join('')))[0];
  // El VALOR de una fila del desglose, no la cifra suelta: los dos documentos repiten el
  // capital en otros bloques (el Resumen imprime el monto original), asi que buscar el
  // numero por el documento entero deja pasar justo el defecto que importa --que el capital
  // se coma la mora-- . Verificado inyectando esa regresion.
  const valorDe = (html, rotulo) => {
    const i = html.indexOf('>' + rotulo + '<');
    if (i === -1) return '(sin fila ' + rotulo + ')';
    const m = /class="v"[^>]*>([^<]*)</.exec(html.slice(i));
    return m ? m[1].trim() : '(sin valor)';
  };
  const HOY = '2026-07-31';

  const S = await arrancar(bdVacia('periodo-irregular-j'));
  try {
    R.seccion('J1 — cambiar el dia de cobro NO mueve el valor de liquidacion');
    // Intereses 3.000.000 al 5%: cuotas redondas de 150.000 el 10 de cada mes. Al 31-jul hay
    // tres vencidas; se pagan las dos primeras para que la transitoria caiga en el FUTURO
    // (5-ago) y siga Pendiente, que es donde vivia el agujero.
    const id = await crear(S, { nombre: 'J', montoOrigen: 3000000, montoCOP: 3000000, tasaMensual: 5,
      plazoMeses: 0, modalidad: 'Intereses', fechaInicio: '2026-04-10', diaPago: 10 });
    await recalcular(S);
    await pagar(S, id, 1); await pagar(S, id, 2);
    const antesL = loanDe(S, id), antesP = filasDe(S, id);
    const A = X.computeLiquidacion(antesL, antesP, { hasta: HOY });
    R.check('J1 ANTI-VACIO: antes del cambio hay 1 cuota En Mora de 150.000 y el total la suma',
      A.moraCount === 1 && A.intMora === 150000 && A.total === 3150000, A);

    const cd = await pedir(S, 'POST', '/api/loans/' + id + '/cambiar-dia-pago', { nuevoDia: 5 });
    const l = loanDe(S, id), p = filasDe(S, id);
    const fila = filaDe(S, id, 3);
    R.check('J1 el endpoint consolido la mora dentro de la cuota transitoria y borro su fila',
      cd.status === 200 && l.periodoIrregularMora === 150000 && l.periodoIrregularN === 3 &&
      p.filter(x => x.estadoPago === 'En Mora').length === 0 && fila.fechaPago === '2026-08-05' &&
      fila.estadoPago === 'Pendiente', { mora: l.periodoIrregularMora, n: l.periodoIrregularN, fila: clave(fila) });

    const B = X.computeLiquidacion(l, p, { hasta: HOY });
    R.check('J1 el helper la ve: 150.000, fechada en la cuota que la lleva adentro',
      B.moraConsolidada === 150000 && B.moraConsolidadaFecha === '2026-08-05' && B.intMora === 0, B);
    R.eq('J1 LA PROPIEDAD: el total no se movio con el cambio de dia (antes: 3.382.739 -> 3.000.000)', B.total, A.total);
    R.eq('J1 total === capital + intMora + moraConsolidada - parciales', B.total,
      B.capitalPendiente + B.intMora + B.moraConsolidada - B.partialPend);

    R.seccion('J2 — la mora NO se cuenta dos veces, y no depende de la casilla');
    const dias = diasISO('2026-06-10', '2026-08-05');
    const todo = X.computeLiquidacion(l, p, { hasta: HOY, incluyeProxMes: true, diasProxMes: dias });
    R.check('J2 el periodo COMPLETO + la mora consolidada dan exactamente lo que pide la cuota transitoria',
      todo.intExtra + todo.moraConsolidada === fila.interesPeriodo && todo.moraConsolidada === 150000,
      { periodo: dias, intExtra: todo.intExtra, mora: todo.moraConsolidada, fila: fila.interesPeriodo });
    R.eq('J2 con la casilla marcada la mora sigue contando UNA vez', todo.total, B.total + todo.intExtra);
    const enMora = p.map(x => x.cuotaN === 3 ? Object.assign({}, x, { estadoPago: 'En Mora' }) : x);
    const M = X.computeLiquidacion(l, enMora, { hasta: HOY });
    R.check('J2 si la transitoria se VENCE, su interes ya la incluye: moraConsolidada 0 y el total no cambia',
      M.moraConsolidada === 0 && M.intMora === fila.interesPeriodo &&
      M.total === B.capitalPendiente + fila.interesPeriodo, M);
    const pagada = p.map(x => x.cuotaN === 3 ? Object.assign({}, x, { estadoPago: 'Pagado' }) : x);
    R.eq('J2 ya pagada, no se vuelve a cobrar (la columna no se limpia: queda inerte)',
      X.computeLiquidacion(l, pagada, { hasta: HOY }).moraConsolidada, 0);
    const conParcial = p.map(x => x.cuotaN === 3 ? Object.assign({}, x, { partialPaid: 100000 }) : x);
    const P = X.computeLiquidacion(l, conParcial, { hasta: HOY });
    R.check('J2 un parcial sobre la transitoria se resta UNA vez y la mora sigue entera',
      P.moraConsolidada === 150000 && P.partialPend === 100000 && P.total === B.total - 100000, P);
    R.eq('J2 sin mora consolidada el campo es 0 (no-op para todo prestamo normal)',
      X.computeLiquidacion(Object.assign({}, l, { periodoIrregularMora: 0 }), p, { hasta: HOY }).moraConsolidada, 0);
    R.eq('J2 en Prestamo / Pago Unico no hay transitoria que leer',
      X.computeLiquidacion(Object.assign({}, l, { modalidad: 'Prestamo' }), p, { hasta: HOY }).moraConsolidada +
      X.computeLiquidacion(Object.assign({}, l, { modalidad: 'Pago Unico' }), p, { hasta: HOY }).moraConsolidada, 0);

    R.seccion('J3 — el modal REAL y los tres documentos la dicen');
    // Orden de useState en LiquidarModal: [incluyeProxMes, liqSending, pdfBusy, diasProxMes]
    const lq = montar(X.LiquidarModal, { loan: l, pays: p, datosPago: '', onConfirm: () => {}, onClose: () => {} },
      [false, false, false, null]);
    R.check('J3 Liquidar deuda: su propia linea, con la fecha de la cuota que la lleva adentro',
      lq.t.indexOf('Intereses atrasados consolidados') !== -1 &&
      lq.todo.indexOf('quedaron dentro de la cuota del ' + X.fmtD('2026-08-05')) !== -1 &&
      lq.t.indexOf(X.fmt(150000)) !== -1, lq.todo.slice(0, 500));
    R.check('J3 el TOTAL A LIQUIDAR del modal la incluye', lq.t.indexOf(X.fmt(3150000)) !== -1);
    CAP.pdfs.length = 0;
    boton(lq, /Generar PDF de liquidacion/).props.onClick();
    const est = CAP.pdfs[0] ? CAP.pdfs[0].html : '';
    R.check('J3 el Estado de Liquidacion: fila propia de 150.000, capital intacto en 3.000.000 y total 3.150.000',
      CAP.pdfs.length === 1 && valorDe(est, 'Intereses atrasados consolidados') === X.fmt(150000) &&
      valorDe(est, 'Capital pendiente') === X.fmt(3000000) && est.indexOf(X.fmt(3150000)) !== -1,
      { mora: valorDe(est, 'Intereses atrasados consolidados'), cap: valorDe(est, 'Capital pendiente') });
    const cr = montar(X.CronogramaPdfModal, { loan: l, pays: p, onClose: () => {} }, [false, false, null]);
    R.check('J3 el modal del cronograma la nombra en su desglose y en el total',
      cr.todo.indexOf('+ mora consolidada ' + X.fmt(150000)) !== -1 && cr.t.indexOf(X.fmt(3150000)) !== -1,
      cr.todo.slice(0, 400));
    CAP.pdfs.length = 0;
    boton(cr, /Descargar PDF/).props.onClick();
    const crono = CAP.pdfs[0] ? CAP.pdfs[0].html : '';
    R.check('J3 el cronograma PDF imprime el mismo total y el mismo desglose',
      CAP.pdfs.length === 1 && crono.indexOf('+ mora consolidada ' + X.fmt(150000)) !== -1 &&
      crono.indexOf(X.fmt(3150000)) !== -1, crono.length);

    R.seccion('J4 — contra el server real: esa plata entra a la caja');
    const liqPre = X.computeLiquidacion(l, p, {});
    const r = await pedir(S, 'POST', '/api/loans/' + id + '/abono', { monto: B.capitalPendiente, fecha: HOY,
      observaciones: 'Liquidacion total', liquidar: true, recalcMode: 'mantener',
      intExtra: B.intExtra + B.moraConsolidada });          // lo que arma _doAbono
    const tras = filasDe(S, id);
    const ab = tras.filter(x => x.id.indexOf('-ab-') !== -1)[0];
    R.check('J4 liquidado: Finalizado, y el abono lleva la mora consolidada como interes',
      r.status === 200 && loanDe(S, id).estado === 'Finalizado' && !!ab && ab.interesPeriodo === 150000,
      { st: r.status, ab: ab && clave(ab) });
    const caja = tras.reduce((s, x) => s + X.cobrosDe(x).reduce((a, e) => a + e.cop, 0), 0);
    R.eq('J4 la caja del dia de la liquidacion es EXACTAMENTE el total que mostro el modal',
      caja - 300000, B.total);                              // 300.000 = las dos cuotas pagadas antes
    R.eq('J4 y se reconoce como ganancia (interes), no como capital',
      X.gananciaDePrestamo(loanDe(S, id), tras).cop, 450000);
    CAP.pdfs.length = 0;
    X.generateReciboAbono(loanDe(S, id), tras, { monto: B.capitalPendiente, fecha: HOY, liquidar: true,
      intExtra: B.intExtra, pre: { saldo: 3000000, saldoCaja: 3000000, cuota: fila.cuotaTotal, cuotas: 1,
        intereses: 0, plazo: 0, liq: liqPre } });
    const paz = CAP.pdfs[0] ? CAP.pdfs[0].html : '';
    // CUADRA AL CENTAVO: el capital del desglose se deriva RESTANDO los demas rubros del
    // titular, asi que si la mora no tuviera fila propia el capital se la comeria en silencio
    // (imprimiria 3.150.000). Por eso se lee el valor de CADA fila, no la cifra suelta.
    R.check('J4 el Paz y Salvo titula 3.150.000 y su desglose CUADRA: 3.000.000 de capital + 150.000 de mora',
      CAP.pdfs.length === 1 && paz.indexOf('Total recibido') !== -1 && paz.indexOf(X.fmt(3150000)) !== -1 &&
      valorDe(paz, 'Aplicado a capital') === X.fmt(3000000) &&
      valorDe(paz, 'Intereses atrasados consolidados') === X.fmt(150000),
      { cap: valorDe(paz, 'Aplicado a capital'), mora: valorDe(paz, 'Intereses atrasados consolidados') });
    R.seccion('J6 — las otras tres superficies que muestran el total');
    // Las tres imprimen la cifra con un subtitulo que la explica. Si la mora entra en el
    // total y el subtitulo no la nombra, queda un total que su propio desglose no explica:
    // el Bug #49, otra vez.
    const abm = montar(X.AbonoModal, { loan: l, pays: p, onSave: () => {}, onClose: () => {}, onRequestLiquidar: () => {} }, []);
    R.check('J6 AbonoModal sigue ofreciendo el valor de liquidacion sin filas En Mora, y dice de donde sale',
      abm.todo.indexOf('Valor de liquidacion: ' + X.fmt(3150000)) !== -1 &&
      abm.todo.indexOf('(incluye la mora consolidada en la cuota en curso)') !== -1, abm.todo.slice(0, 600));
    CAP.pdfs.length = 0;
    X.generateReciboAbono(l, p, { monto: 500000, fecha: HOY, liquidar: false,
      pre: { saldo: 3000000, saldoCaja: 3000000, cuota: fila.cuotaTotal, cuotas: 1, intereses: 0, plazo: 0,
             liq: X.computeLiquidacion(l, p, {}) } });
    const rec = CAP.pdfs[0] ? CAP.pdfs[0].html : '';
    R.check('J6 el Recibo de Abono: su bloque "liquidar hoy" la nombra y su cifra la incluye',
      CAP.pdfs.length === 1 && rec.indexOf('Quieres liquidar la deuda hoy') !== -1 &&
      rec.indexOf('+ mora consolidada ' + X.fmt(150000)) !== -1 && rec.indexOf(X.fmt(3150000)) !== -1, rec.length);
    // La tarjeta del perfil vive dentro de un componente grande con su propio estado; se fija
    // por guarda estatica, en la linea que arma su subtitulo.
    const dm = fs.readFileSync(path.join(REPO, 'public', 'js', 'modales', 'DebtorModal.js'), 'utf8');
    R.check('J6 la tarjeta "Liquidacion total" del perfil la nombra en su subtitulo',
      /moraConsTotal>0\?' \+ mora consolidada':''/.test(dm) && /var moraConsTotal=_Lq\.moraConsolidada/.test(dm));
  } finally { await cerrar(S); }

  R.seccion('J5 — el cable: la mora viaja al backend, pero no se suma dos veces en el papel');
  const app = fs.readFileSync(path.join(REPO, 'public', 'js', 'app.js'), 'utf8');
  R.check('J5 _doAbono la saca de `pre.liq` (el mismo objeto que vio el modal) y solo al liquidar',
    /var moraCons=\(liquidar&&pre\.liq\)\?Math\.max\(0,Math\.round\(pre\.liq\.moraConsolidada\|\|0\)\)/.test(app));
  R.check('J5 la peticion de abono la suma al interes', /intExtra:\(intExtra\|\|0\)\+moraCons/.test(app));
  R.check('J5 al recibo se le pasa `intExtra` a secas: `pre.liq.total` ya la lleva dentro',
    /liquidar:!!liquidar,intExtra:intExtra\|\|0\}\)/.test(app));
}

// ═════════════════════════════════════════════════════════════════════════════
// K — 3.3.0, FASE 1: EL PERIODO DE CADA FRECUENCIA Y LA GRACIA
// ═════════════════════════════════════════════════════════════════════════════
// El prorrateo se mide con el periodo del prestamo: `interes de una cuota normal x dias / dias del
// periodo` (7 en semanal, 14 en quincenal, 30 en mensual). En MENSUAL tiene que quedar intacto
// bit a bit: es la formula de los prestamos ya publicados. En semanal y quincenal, cobrar
// exactamente un periodo de dias tiene que costar la cuota normal del motor, al peso.
// Y la gracia: perdonar los dias muertos no cambia el cronograma (la cuota 1 sale normal), pero
// se guarda desde cuando corre el interes, y el cambio de dia de pago tiene que respetarlo.
async function seccionK() {
  const { resolverPrimerPago, interesPeriodoParcial, diasDelPeriodo, inicioPeriodoRegular, interesDeTramo,
    primerPagoRegular, tasaPeriodo } = engine;
  const Fr = cargarFront();
  const CORTAS = ['Semanal', 'Quincenal'];
  const SALDOS = [1, 999, 50000, 349660, 1000000, 3333333, 4000000, 10000000, 87654321];
  const TASAS = [1.5, 3, 5, 7.25, 10, 11.165, 12.93, 20];

  R.seccion('K1 — la formula: interes de una cuota normal x dias / dias del periodo');
  let mensualDistinto = 0, nM = 0;
  for (const s of SALDOS) for (const t of [0].concat(TASAS)) for (let d = 0; d <= 120; d++) {
    nM++;
    const base = interesDeTramo(s, t, d);
    if (interesPeriodoParcial(s, t, 'Mensual', d) !== base || interesPeriodoParcial(s, t, undefined, d) !== base) mensualDistinto++;
  }
  R.check('K1 MENSUAL intacto: identico a la formula de siempre en ' + nM + ' casos (tambien sin frecuencia)', mensualDistinto === 0, mensualDistinto);
  let periodoDistinto = 0, nP = 0, propMal = [];
  for (const f of CORTAS) for (const s of SALDOS) for (const t of TASAS) {
    const fila = buildSchedule({ id: 'K', nombre: 'k', modalidad: 'Capital + Intereses', frecuencia: f, tasaMensual: t, plazoMeses: 6,
      montoCOP: s, fechaInicio: '2026-08-01', diaPago: 1 })[0];
    nP++;
    const P = diasDelPeriodo(f);
    if (interesPeriodoParcial(fila.saldoInicial, t, f, P) !== fila.interesPeriodo) periodoDistinto++;
    for (const k of [2, 3]) {
      const v = interesPeriodoParcial(fila.saldoInicial, t, f, k * P);
      if (Math.abs(v - k * fila.interesPeriodo) > 1) propMal.push({ f, s, t, k, v, cuota: fila.interesPeriodo });
    }
  }
  R.check('K1 SEMANAL y QUINCENAL: un periodo entero de dias = la cuota normal del motor, al peso (' + nP + ' casos)', periodoDistinto === 0, periodoDistinto);
  R.check('K1 dos y tres periodos de dias = dos y tres cuotas normales (a 1 peso de redondeo)', propMal.length === 0, propMal.slice(0, 3));
  R.check('K1 la semana son 7 dias, la quincena 14 (el calendario del motor) y el mes 30',
    diasDelPeriodo('Semanal') === 7 && diasDelPeriodo('Quincenal') === 14 && diasDelPeriodo('Mensual') === 30 && diasDelPeriodo(undefined) === 30);
  const K4 = 4000000;
  R.eq('K1 semanal, 7 dias sobre 4.000.000 al 10% = 1 semana normal', interesPeriodoParcial(K4, 10, 'Semanal', 7), 92379);
  R.eq('K1 semanal, 12 dias = 158.364 (con dias/30 eran 160.000)', interesPeriodoParcial(K4, 10, 'Semanal', 12), 158364);
  R.eq('K1 quincenal, 14 dias = 1 quincena normal', interesPeriodoParcial(K4, 10, 'Quincenal', 14), 200000);
  R.eq('K1 quincenal, 20 dias = 285.714 (con dias/30 eran 266.667)', interesPeriodoParcial(K4, 10, 'Quincenal', 20), 285714);
  R.eq('K1 mensual, 45 dias = 600.000 (sin cambios)', interesPeriodoParcial(K4, 10, 'Mensual', 45), 600000);
  R.eq('K1 la tasa del periodo del motor es la que usa la formula', tasaPeriodo(0.1, 'Semanal'), 0.1 / 4.33);

  R.seccion('K2 — el primer pago en Semanal y Quincenal (resolvedor puro)');
  const SEM = { id: 'S', nombre: 's', modalidad: 'Capital + Intereses', frecuencia: 'Semanal', tasaMensual: 10, plazoMeses: 8,
    montoCOP: K4, montoOrigen: K4, moneda: 'COP', fechaInicio: '2026-07-28', diaPago: 28 };
  const regS = resolverPrimerPago(SEM, '2026-08-04', 'completo');
  R.check('K2 semanal a 7 dias es el pago regular: sin base, sin transitoria, interes desde el inicio',
    !regS.irregular && regS.fechaBaseCronograma === null && regS.periodoIrregularN === null && regS.fechaInicioIntereses === '2026-07-28', regS);
  R.check('K2 ...y el cronograma queda byte a byte como el de siempre',
    JSON.stringify(buildSchedule(conPrimerPago(SEM, '2026-08-04', 'completo'))) === JSON.stringify(buildSchedule(SEM)));
  const normalS = buildSchedule(Object.assign({}, SEM, { fechaBaseCronograma: '2026-08-02' }));
  const pS = resolverPrimerPago(SEM, '2026-08-09', 'proporcional');
  const rowsP = buildSchedule(conPrimerPago(SEM, '2026-08-09', 'proporcional'));
  R.check('K2 semanal a 12 dias, COBRAR los dias: base una semana antes, transitoria e interes desde el inicio',
    pS.irregular && pS.fechaBaseCronograma === '2026-08-02' && pS.periodoIrregularN === 1 && pS.periodoIrregularDesde === '2026-07-28' &&
    pS.fechaInicioIntereses === '2026-07-28', pS);
  R.check('K2 la cuota 1 vence el 9-ago con 12 dias de interes (158.364) y el mismo capital de una cuota normal',
    rowsP[0].fechaPago === '2026-08-09' && rowsP[0].interesPeriodo === 158364 && rowsP[0].abonoCapital === normalS[0].abonoCapital, clave(rowsP[0]));
  R.check('K2 las demas cuotas caen cada 7 dias e identicas a las de un cronograma normal',
    rowsP.slice(1).every((p, i) => p.fechaPago === sumarDias('2026-08-09', 7 * (i + 1)) &&
      JSON.stringify(clave(p)) === JSON.stringify(clave(normalS[i + 1]))), rowsP.map(clave));
  R.eq('K2 el capital suma exactamente lo prestado', rowsP.reduce((s, p) => s + p.abonoCapital, 0), K4);
  const cS = resolverPrimerPago(SEM, '2026-08-09', 'completo');
  const rowsC = buildSchedule(conPrimerPago(SEM, '2026-08-09', 'completo'));
  R.check('K2 semanal a 12 dias, PERDONAR: sin transitoria, y el interes arranca una semana antes del pago (5 dias de gracia)',
    cS.irregular && cS.periodoIrregularN === null && cS.fechaBaseCronograma === '2026-08-02' && cS.fechaInicioIntereses === '2026-08-02', cS);
  R.check('K2 ...la cuota 1 cobra UNA semana normal (92.379) y el cronograma es el normal, byte a byte',
    rowsC[0].interesPeriodo === 92379 && JSON.stringify(rowsC) === JSON.stringify(normalS), clave(rowsC[0]));
  R.eq('K2 lo que se perdona es exactamente la diferencia (65.985)', rowsP[0].interesPeriodo - rowsC[0].interesPeriodo, 65985);
  const corto = resolverPrimerPago(SEM, '2026-08-01', 'completo');
  R.check('K2 semanal a 4 dias con "periodo completo": cobra la semana, pero el interes corre desde el inicio (sin gracia)',
    corto.fechaInicioIntereses === '2026-07-28' && buildSchedule(conPrimerPago(SEM, '2026-08-01', 'completo'))[0].interesPeriodo === 92379, corto);
  R.eq('K2 semanal a 4 dias proporcional: 52.788', buildSchedule(conPrimerPago(SEM, '2026-08-01', 'proporcional'))[0].interesPeriodo, 52788);
  const QUI = Object.assign({}, SEM, { frecuencia: 'Quincenal' });
  R.check('K2 quincenal a 14 dias es el pago regular', !resolverPrimerPago(QUI, '2026-08-11', 'proporcional').irregular);
  const qP = buildSchedule(conPrimerPago(QUI, '2026-08-17', 'proporcional'));
  const qC = resolverPrimerPago(QUI, '2026-08-17', 'completo');
  const qCrows = buildSchedule(conPrimerPago(QUI, '2026-08-17', 'completo'));
  R.check('K2 quincenal a 20 dias: cobrar = 285.714; la cuota 2 cae 14 dias despues',
    qP[0].fechaPago === '2026-08-17' && qP[0].interesPeriodo === 285714 && qP[1].fechaPago === '2026-08-31', qP.slice(0, 2).map(clave));
  R.check('K2 quincenal a 20 dias, perdonar: quincena normal (200.000) y el interes desde el 3-ago (6 dias de gracia)',
    qCrows[0].interesPeriodo === 200000 && qC.fechaInicioIntereses === '2026-08-03' && qC.fechaBaseCronograma === '2026-08-03', qC);
  const INT = Object.assign({}, SEM, { modalidad: 'Intereses', plazoMeses: 0 });
  const iP = buildSchedule(conPrimerPago(INT, '2026-08-09', 'proporcional'));
  R.check('K2 tambien en Intereses semanal: 12 dias (158.364) y sin capital', iP[0].interesPeriodo === 158364 && iP[0].abonoCapital === 0, clave(iP[0]));
  const MEN = Object.assign({}, SEM, { frecuencia: 'Mensual' });
  R.eq('K2 mensual, perdonar con 79 dias muertos: el interes arranca un mes antes del pago', resolverPrimerPago(MEN, '2026-10-15', 'completo').fechaInicioIntereses, '2026-09-15');
  R.eq('K2 mensual, cobrar los dias: el interes corre desde el inicio', resolverPrimerPago(MEN, '2026-10-15', 'proporcional').fechaInicioIntereses, '2026-07-28');
  R.check('K2 el mes anterior se acota a fin de mes (31-mar -> 28-feb; bisiesto 29-feb)',
    inicioPeriodoRegular('2027-03-31', 'Mensual') === '2027-02-28' && inicioPeriodoRegular('2028-03-31', 'Mensual') === '2028-02-29' &&
    inicioPeriodoRegular('2026-12-15', 'Mensual') === '2026-11-15');

  // Barrido: 3 frecuencias x primer pago de 1 a 120 dias x las dos opciones, contra el motor y
  // contra el espejo del frontend.
  const fallas = [];
  let nB = 0;
  for (const f of ['Semanal', 'Quincenal', 'Mensual']) for (let d = 1; d <= 120; d++) for (const modo of ['proporcional', 'completo']) {
    nB++;
    const loan = Object.assign({}, SEM, { frecuencia: f });
    const pp = sumarDias(loan.fechaInicio, d);
    let r;
    try { r = resolverPrimerPago(loan, pp, modo); } catch (e) { fallas.push({ f, d, modo, e: e.message }); continue; }
    const conD = conPrimerPago(loan, pp, modo);
    const rows = buildSchedule(conD);
    const P = diasDelPeriodo(f);
    const normal = Math.round(K4 * tasaPeriodo(0.1, f));
    const malo = m => fallas.push({ f, d, modo, m, fila: clave(rows[0]), r });
    if (rows[0].fechaPago !== pp) { malo('fecha'); continue; }
    const siguiente = f === 'Mensual' ? mesSiguiente(pp, +pp.slice(8, 10)) : sumarDias(pp, P);
    if (rows[1].fechaPago !== siguiente) malo('segunda cuota');
    if (!r.irregular) {
      if (pp !== primerPagoRegular(loan.fechaInicio, f) || r.fechaInicioIntereses !== loan.fechaInicio || rows[0].interesPeriodo !== normal) malo('regular');
      continue;
    }
    if (modo === 'proporcional') {
      if (rows[0].interesPeriodo !== interesPeriodoParcial(K4, 10, f, d)) malo('interes de los dias');
      if (Fr.interesTransitoria(conD, rows[0].saldoInicial, pp) !== rows[0].interesPeriodo) malo('espejo del frontend');
      if (r.fechaInicioIntereses !== loan.fechaInicio) malo('arranque proporcional');
    } else {
      const arranque = inicioPeriodoRegular(pp, f);
      if (rows[0].interesPeriodo !== normal) malo('periodo normal');
      if (r.fechaInicioIntereses !== (arranque > loan.fechaInicio ? arranque : loan.fechaInicio)) malo('arranque perdonar');
    }
  }
  R.check('K2 barrido: ' + nB + ' primeros pagos (3 frecuencias, 1 a 120 dias, cobrar y perdonar) con fecha, cuota siguiente, interes, arranque y espejo correctos',
    fallas.length === 0 && nB === 720, fallas.slice(0, 3));

  R.seccion('K3 — el espejo del frontend: la misma formula y la misma tasa del periodo');
  let espejoMal = 0, nE = 0;
  for (const f of ['Semanal', 'Quincenal', 'Mensual', undefined]) for (const s of SALDOS) for (const t of TASAS) for (const d of [1, 4, 7, 12, 14, 20, 45, 90]) {
    nE++;
    if (Fr.interesPeriodoParcial(s, t, f, d) !== interesPeriodoParcial(s, t, f, d)) espejoMal++;
  }
  R.check('K3 interesPeriodoParcial: frontend == motor en ' + nE + ' casos', espejoMal === 0, espejoMal);
  R.check('K3 _tasaPeriodo (calculo.js) delega en la tasa del periodo de dominio y coincide con el motor',
    ['Semanal', 'Quincenal', 'Mensual'].every(f => Fr._tasaPeriodo(0.1, f) === tasaPeriodo(0.1, f) && Fr.tasaDelPeriodo(0.1, f) === tasaPeriodo(0.1, f)) &&
    Fr.diasDelPeriodo('Quincenal') === 14);
  const filas = Fr.filasPreview(K4, tasaPeriodo(0.1, 'Semanal'), 8, false, Fr._pmt(tasaPeriodo(0.1, 'Semanal'), 8, K4));
  const conDS = Object.assign({}, conPrimerPago(SEM, '2026-08-09', 'proporcional'), { id: 'S' });
  Fr.aplicarTransitoriaPreview(conDS, filas, 1, K4, [{ id: 'S-1', fechaPago: '2026-08-09' }]);
  R.check('K3 el preview del cobro aplica la transitoria semanal igual que el motor (interes y cuota)',
    filas[0].interes === rowsP[0].interesPeriodo && filas[0].cuota === rowsP[0].cuotaTotal, { preview: filas[0], motor: clave(rowsP[0]) });

  R.seccion('K4 — la columna fechaInicioIntereses: migracion');
  const pFix = copiaDeProduccion('periodo-irregular-k');
  let S0 = await arrancar(pFix);
  await cerrar(S0);
  const conteo = () => leer(pFix, d => d.prepare("SELECT COUNT(*) n, SUM(CASE WHEN fechaInicioIntereses = fechaInicio THEN 1 ELSE 0 END) igual, " +
    "SUM(CASE WHEN fechaInicioIntereses IS NULL OR fechaInicioIntereses = '' THEN 1 ELSE 0 END) vacio FROM loans").get());
  const c1 = conteo();
  R.check('K4 ANTI-VACIO + migracion: los ' + c1.n + ' prestamos del fixture arrancan su interes en su fecha de inicio, ninguno vacio',
    c1.n >= 20 && c1.igual === c1.n && c1.vacio === 0, c1);
  const victima = leer(pFix, d => d.prepare('SELECT id, fechaInicio FROM loans ORDER BY id LIMIT 1').get());
  escribir(pFix, d => d.prepare('UPDATE loans SET fechaInicioIntereses = NULL WHERE id = ?').run(victima.id));
  S0 = await arrancar(pFix);
  await cerrar(S0);
  const c2 = conteo();
  R.check('K4 idempotente, y rellena la fila que una version anterior de la app dejara vacia', c2.igual === c1.n && c2.vacio === 0 &&
    leer(pFix, d => d.prepare('SELECT fechaInicioIntereses f FROM loans WHERE id = ?').get(victima.id)).f === victima.fechaInicio, c2);

  const S = await arrancar(bdVacia('periodo-irregular-k'));
  try {
    R.seccion('K5 — contra el server real: alta y edicion');
    const BASE_S = { montoOrigen: K4, montoCOP: K4, tasaMensual: 10, plazoMeses: 8, modalidad: 'Capital + Intereses',
      frecuencia: 'Semanal', fechaInicio: '2026-07-28', diaPago: 28 };
    const idP = await crear(S, Object.assign({ nombre: 'K5p', primerPago: '2026-08-09', primerPeriodo: 'proporcional' }, BASE_S));
    const idC = await crear(S, Object.assign({ nombre: 'K5c', primerPago: '2026-08-09', primerPeriodo: 'completo' }, BASE_S));
    const idN = await crear(S, Object.assign({ nombre: 'K5n' }, BASE_S));
    R.check('K5 semanal cobrando los dias: guarda la transitoria y el interes desde el inicio; cuota 1 de 158.364',
      loanDe(S, idP).fechaInicioIntereses === '2026-07-28' && loanDe(S, idP).periodoIrregularN === 1 && filaDe(S, idP, 1).interesPeriodo === 158364, loanDe(S, idP));
    R.check('K5 semanal perdonando: sin transitoria, interes desde el 2-ago y cuota 1 de una semana (92.379)',
      loanDe(S, idC).fechaInicioIntereses === '2026-08-02' && loanDe(S, idC).periodoIrregularN === null && filaDe(S, idC, 1).interesPeriodo === 92379 &&
      filaDe(S, idC, 1).fechaPago === '2026-08-09', loanDe(S, idC));
    R.check('K5 sin primer pago elegido: el interes corre desde el inicio', loanDe(S, idN).fechaInicioIntereses === '2026-07-28');
    const logs = ((await pedir(S, 'GET', '/api/activity')).json || []).map(a => a.mensaje);
    R.check('K5 el historial deja constancia de la gracia', logs.some(m => /K5c.*5 dias de gracia/.test(m)), logs.slice(0, 4));
    const todos = (await pedir(S, 'GET', '/api/loans')).json || [];
    R.check('K5 GET /api/loans expone la columna', todos.length >= 3 && todos.every(l => typeof l.fechaInicioIntereses === 'string'));
    const editar = (id, extra) => pedir(S, 'PUT', '/api/loans/' + id, Object.assign({}, BASE_LOAN, BASE_S, { nombre: 'K5e' }, extra));
    await editar(idP, { primerPago: '2026-08-09', primerPeriodo: 'completo' });
    R.check('K5 editar sin actividad recalcula la decision: ahora perdona (interes desde el 2-ago, cuota de una semana)',
      loanDe(S, idP).fechaInicioIntereses === '2026-08-02' && loanDe(S, idP).periodoIrregularN === null && filaDe(S, idP, 1).interesPeriodo === 92379, loanDe(S, idP));
    await editar(idN, { fechaInicio: '2026-07-29' });
    R.check('K5 sin gracia, cambiar la fecha de inicio arrastra el arranque del interes', loanDe(S, idN).fechaInicioIntereses === '2026-07-29');
    await editar(idC, { fechaInicio: '2026-07-30' });
    R.check('K5 con gracia, la conserva (sigue el 2-ago, despues del nuevo inicio)', loanDe(S, idC).fechaInicioIntereses === '2026-08-02');
    await editar(idC, { fechaInicio: '2026-08-05' });
    R.check('K5 ...pero el interes nunca arranca antes del prestamo', loanDe(S, idC).fechaInicioIntereses === '2026-08-05');
    const idA = await crear(S, Object.assign({ nombre: 'K5a', primerPago: '2026-08-09', primerPeriodo: 'completo' }, BASE_S));
    await pagar(S, idA, 1);
    const r = await editar(idA, { primerPago: '2026-08-09', primerPeriodo: 'proporcional' });
    R.check('K5 con actividad el calendario queda congelado, incluido el arranque del interes',
      r.status === 200 && loanDe(S, idA).fechaInicioIntereses === '2026-08-02' && loanDe(S, idA).periodoIrregularN === null, loanDe(S, idA));

    R.seccion('K6 — cambiar el dia de pago respeta la gracia (Bug #73)');
    const BASE_M = { montoOrigen: 10000000, montoCOP: 10000000, tasaMensual: 5, plazoMeses: 6, modalidad: 'Capital + Intereses',
      frecuencia: 'Mensual', fechaInicio: '2026-07-20', diaPago: 20 };
    const idG = await crear(S, Object.assign({ nombre: 'K6g', primerPago: '2026-10-15', primerPeriodo: 'completo' }, BASE_M));
    R.check('K6 ANTI-VACIO: prestamo mensual con gracia (interes desde el 15-sep) y cuota 1 de un mes el 15-oct',
      loanDe(S, idG).fechaInicioIntereses === '2026-09-15' && filaDe(S, idG, 1).fechaPago === '2026-10-15' && filaDe(S, idG, 1).interesPeriodo === 500000, loanDe(S, idG));
    const cd = await pedir(S, 'POST', '/api/loans/' + idG + '/cambiar-dia-pago', { nuevoDia: 25 });
    const lG = loanDe(S, idG), fG = filaDe(S, idG, 1);
    R.check('K6 el periodo de la nueva cuota 1 corre desde el arranque del interes (15-sep), no desde el prestamo (20-jul)',
      cd.status === 200 && lG.periodoIrregularDesde === '2026-09-15' && fG.fechaPago === '2026-10-25', { st: cd.status, desde: lG.periodoIrregularDesde, fila: clave(fG) });
    R.eq('K6 ...y cobra 40 dias (666.667), no los 97 que incluian la gracia (1.616.667)', fG.interesPeriodo, 666667);
    const idSin = await crear(S, Object.assign({ nombre: 'K6s', primerPago: '2026-10-15', primerPeriodo: 'proporcional' }, BASE_M));
    await pedir(S, 'POST', '/api/loans/' + idSin + '/cambiar-dia-pago', { nuevoDia: 25 });
    R.check('K6 control sin gracia: como siempre, el periodo corre desde el prestamo', loanDe(S, idSin).periodoIrregularDesde === '2026-07-20');
    const head = async id => ((await pedir(S, 'GET', '/api/undo?scopeTipo=loan&scopeId=' + id)).json || []).filter(u => u.estado === 'disponible')[0];
    const u = await head(idG);
    await pedir(S, 'POST', '/api/undo/' + u.id, {});
    const lU = loanDe(S, idG);
    R.check('K6 deshacer el cambio de dia devuelve el prestamo con su gracia intacta y la cuota de un mes',
      u.accion === 'cambio-fecha' && lU.periodoIrregularN === null && lU.fechaInicioIntereses === '2026-09-15' &&
      filaDe(S, idG, 1).interesPeriodo === 500000 && filaDe(S, idG, 1).fechaPago === '2026-10-15', { u: u && u.accion, l: lU });
  } finally { await cerrar(S); }
}


// ═════════════════════════════════════════════════════════════════════════════
// D — GUARDA ESTATICA
// ═════════════════════════════════════════════════════════════════════════════
function seccionD() {
  R.seccion('D — ninguna ruta vuelve a leer el monto viejo');
  const sinComentarios = s => s.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).filter(l => !/^\s*\/\//.test(l)).join('\n');
  const dirs = ['backend/routes', 'backend/core'];
  const lecturas = [];
  for (const dir of dirs) {
    for (const f of fs.readdirSync(path.join(REPO, dir)).filter(x => x.endsWith('.js'))) {
      const src = sinComentarios(fs.readFileSync(path.join(REPO, dir, f), 'utf8'));
      // Lo unico permitido es ponerla en 0 al guardar la decision nueva.
      const resto = src.replace(/proximaCuotaExtra = 0, proximaCuotaExtraN = 0/g, '');
      if (/proximaCuotaExtra/.test(resto)) lecturas.push(dir + '/' + f);
    }
  }
  R.check('D rutas y motor: `proximaCuotaExtra` solo aparece para ponerla en 0', lecturas.length === 0, lecturas);
  const eng = sinComentarios(fs.readFileSync(path.join(REPO, 'backend/core/engine.js'), 'utf8'));
  R.check('D los DOS generadores del motor aplican la transitoria',
    (eng.match(/return aplicarPeriodoIrregular\(loan, rows\);/g) || []).length === 2);
}

// Una seccion que lanza (p.ej. el motor rechaza una fecha que deberia aceptar) no puede tumbar
// la corrida: queda como FALLO con su mensaje, y las demas secciones siguen midiendo.
async function seccion(nombre, fn) {
  try { await fn(); }
  catch (e) { R.check('seccion ' + nombre + ' termino sin excepciones', false, (e && e.stack) || String(e)); }
}

(async () => {
  await seccion('A', seccionA);
  await seccion('B', seccionB);
  await seccion('C', seccionC);
  await seccion('E', seccionE);
  await seccion('F', seccionF);
  await seccion('G', seccionG);
  await seccion('H', seccionH);
  await seccion('I', seccionI);
  await seccion('J', seccionJ);
  await seccion('K', seccionK);
  await seccion('L', seccionL);
  await seccion('M', seccionM);
  await seccion('D', seccionD);
  process.exit(R.finalizar());
})().catch(e => { console.error(e); process.exit(1); });
