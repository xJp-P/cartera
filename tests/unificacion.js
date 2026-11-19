// tests/unificacion.js — UNIFICAR los prestamos de un deudor (post-4.0.0), contra el server REAL.
//
// Unificar = liquidar cada prestamo, pero en vez de entrar dinero entra un prestamo NUEVO. Lo que
// esta suite fija, en orden de importancia:
//   A. EL CALCULO: el del modal (`public/js/core/unificacion.js`) y el del server
//      (`backend/core/unificacion.js`) dan las mismas cifras, prestamo por prestamo, en varias
//      fechas, opciones y deudores (pesos y dolares); y sin opciones, lo que pasa al nuevo es
//      EXACTAMENTE la suma de "Liquidar hoy" de cada prestamo.
//   B. EL CRONOGRAMA del nuevo que promete el modal es el que genera el motor (con la carga de
//      los intereses trasladados), fila por fila.
//   C. EL FLUJO COMPLETO: ni un peso de caja se crea ni se pierde; la cuota con un abono en
//      vuelo se cierra por lo abonado y conserva su ledger; los viejos quedan unificados con lo
//      que trasladaron; el nuevo vale lo que se debia ("sin perder dinero": liquidarlo al dia
//      siguiente da la misma cifra); el Historial lo registra; un movimiento viejo no se puede
//      deshacer mientras exista la unificacion; deshacerla devuelve todo BYTE A BYTE.
//   D. DOLARES y FECHA RETROACTIVA, intereses sumados al capital: el capital en pesos sale
//      exacto, la ganancia del capitalizado se reconoce en proporcion a lo cobrado y el capital
//      refinanciado no cuenta como prestado.
//   E. LA CARGA sobrevive a las rutas que regeneran (editar, recalcular, abono que acorta el
//      plazo) y la liquidacion la cobra.
//   F. EL CIERRE FORZOSO ya no borra la caja de un abono en vuelo.
//   G. EL MODAL y H. LOS DOCUMENTOS (propuesta y constancia), renderizados de verdad.
//
// Se ejecuta:
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron tests/unificacion.js

const path = require('path');
const Database = require('better-sqlite3');
const { Reporter }          = require('./lib/report');
const { copiaDeProduccion } = require('./lib/db');

const R = new Reporter('unificacion');

// ── RELOJ: calendario CONGELADO en la fecha del fixture, reloj de ids INTACTO ────
const RelojReal = Date;
const INSTANTE_FIJO = new RelojReal(2026, 6, 31, 12, 0, 0);
global.Date = class extends RelojReal {
  constructor(...args) { if (args.length === 0) super(INSTANTE_FIJO.getTime()); else super(...args); }
  static now() { return RelojReal.now(); }
};
const HOY = '2026-07-31';

const createApp = require('../backend/server');
const E = require('../backend/core/engine');
const B = require('../backend/core/unificacion');
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
  const opts = { method: metodo, headers: {} };
  if (cuerpo !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(cuerpo); }
  const r = await fetch(S.base + ruta, opts);
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (_) {}
  return { status: r.status, json, text };
}
const leerBD = (ruta, fn) => { const d = new Database(ruta, { readonly: true }); try { return fn(d); } finally { d.close(); } };

// ── Arnes de render (el de `modales`: estado sembrado por posicion) ──────────────
const pintar = n => {
  if (n === null || n === undefined || typeof n === 'boolean') return null;
  if (typeof n === 'string' || typeof n === 'number') return String(n);
  if (Array.isArray(n)) return n.map(pintar).filter(x => x !== null);
  if (typeof n.type === 'function') return pintar(n.type(Object.assign({}, n.props, { children: n.children })));
  return { tag: n.type, props: n.props, kids: (n.children || []).map(pintar).filter(x => x !== null) };
};
const textos = (n, out) => { out = out || []; if (typeof n === 'string') { out.push(n); return out; }
  if (Array.isArray(n)) { n.forEach(x => textos(x, out)); return out; } if (n && n.kids) n.kids.forEach(x => textos(x, out)); return out; };
const nodos = (n, pred, out) => { out = out || []; if (Array.isArray(n)) { n.forEach(x => nodos(x, pred, out)); return out; }
  if (n && n.kids) { if (pred(n)) out.push(n); n.kids.forEach(x => nodos(x, pred, out)); } return out; };
const clsDe = n => ((n && n.props && n.props.className) || '').split(/\s+/).filter(Boolean);
const conClase = (a, c) => nodos(a, n => clsDe(n).indexOf(c) !== -1);
const unir = n => textos(n).join('');

// ── Lo que el modal le manda al server (el mismo `cuerpoPeticion` de UnificarModal) ─
function cuerpoDe(plan, loans, opc) {
  const N = plan.nuevo;
  return { loanIds: loans.map(l => l.id), fecha: plan.fecha, corridos: opc.corridos || {}, ganancias: opc.ganancias || {},
    destino: plan.destino, cuotasReparto: opc.cuotasReparto || 6,
    nuevo: { modalidad: N.modalidad, frecuencia: N.frecuencia, tasaMensual: N.tasaMensual, plazo: N.plazo,
      primerPago: N.primerPago, primerPeriodo: N.modoPP || 'proporcional' },
    esperado: { capital: plan.capital, interes: plan.interes } };
}
// El prestamo nuevo tal como lo arma la ruta, para comparar el cronograma del motor.
function cronogramaMotor(plan, body) {
  const n = body.nuevo;
  const loan = { id: 'nuevo', nombre: 'x', modalidad: plan.nuevo.modalidad, montoCOP: plan.nuevo.monto, tasaMensual: plan.nuevo.tasaMensual,
    plazoMeses: plan.nuevo.modalidad === 'Capital + Intereses' ? plan.nuevo.plazo : 0, frecuencia: plan.nuevo.frecuencia,
    fechaInicio: plan.fecha, diaPago: +plan.fecha.slice(8, 10), cargaTrasladada: plan.carga,
    cargaCuotas: plan.carga > 0 ? (plan.destino === 'primera' ? 1 : (plan.nuevo.modalidad === 'Intereses' ? (body.cuotasReparto || 6) : plan.nuevo.plazo)) : 0 };
  Object.assign(loan, E.resolverPrimerPago(loan, n.primerPago, n.primerPeriodo));
  return plan.nuevo.modalidad === 'Capital + Intereses' ? E.buildSchedule(loan, 1, plan.nuevo.monto, plan.nuevo.plazo) : E.buildSchedule(loan);
}
const mismaFila = (f, r) => f.fecha === r.fechaPago && f.interes === r.interesPeriodo && f.capital === r.abonoCapital && f.cuota === r.cuotaTotal && f.saldo === r.saldoFinal;

(async () => {
  const dbPath = copiaDeProduccion('unificacion');
  const S = await arrancar(dbPath);
  try {
    const { cargarFrontend } = require('./lib/load-frontend');
    const FE = cargarFrontend({ silenciarConsola: true });
    const X = FE.sandbox;
    X.Date = Date;
    const traer = async () => ({ loans: (await pedir(S, 'GET', '/api/loans')).json, pays: (await pedir(S, 'GET', '/api/payments')).json });
    let { loans, pays } = await traer();
    // El estado INICIAL del fixture (el modal y los documentos se renderizan sobre el, al final).
    const loans0 = loans.slice(), pays0 = pays.slice();
    const activosDe = nombre => loans.filter(l => l.nombre === nombre && l.estado === 'Activo');
    const paysDe = id => pays.filter(p => String(p.prestamoId) === String(id));
    const cajaTotal = ps => ps.reduce((s, p) => s + X.cobrosDe(p).reduce((a, e) => a + e.cop, 0), 0);
    const BRUNO = 'Bruno Salgado', GABRIELA = 'Gabriela Rios';

    // ── 0 — el fixture trae los casos ─────────────────────────────────────────────
    R.seccion('0 — el arnes ve el modulo y el fixture trae los casos');
    R.check('0 el modal, los documentos y el calculo estan en el frontend cargado',
      ['planUnificacion', 'trasladoDe', 'limitesFecha', 'UnificarModal', 'generatePropuestaUnificacion', 'generateConstanciaUnificacion',
        'ratioCapitalizado', 'capitalRefinanciadoDe', 'aplicarCargaPreview'].every(k => typeof X[k] === 'function'));
    R.check('0 anti-vacio: Bruno tiene 3 prestamos activos en pesos con interes ya corrido, Gabriela 2 en dolares con intereses vencidos',
      activosDe(BRUNO).length === 3 && activosDe(BRUNO).every(l => l.moneda === 'COP') && activosDe(GABRIELA).length === 2 &&
      activosDe(GABRIELA).every(l => l.moneda === 'USD') &&
      X.planUnificacion(activosDe(BRUNO), pays, HOY, { nuevo: { plazo: 6 } }).corridoTotal > 0 &&
      X.planUnificacion(activosDe(GABRIELA), pays, HOY, { nuevo: { plazo: 6 } }).interes > 0);

    // ── A — el calculo: modal == server ───────────────────────────────────────────
    R.seccion('A — el calculo del modal y el del server dan lo mismo; sin opciones = Liquidar hoy');
    let casosA = 0; const difA = [];
    for (const nombre of [BRUNO, GABRIELA]) {
      const ls = activosDe(nombre);
      const lim = X.limitesFecha(ls, pays, HOY);
      const fechas = [HOY, lim.min, E.sumarDias(HOY, -3)].filter((f, i, a) => f && f >= lim.min && a.indexOf(f) === i);
      for (const fecha of fechas) for (const corrido of [false, true]) for (const destino of ['repartir', 'primera', 'capital', 'condonar'])
      for (const modalidad of ['Capital + Intereses', 'Intereses', 'Interes Diario']) {
        const corridos = {}; if (corrido) ls.forEach(l => { corridos[l.id] = true; });
        const opc = { fecha, corridos, destino, nuevo: { modalidad, plazo: 6 } };
        const pf = X.planUnificacion(ls, pays, HOY, opc);
        const pb = B.planUnificacion(ls, paysDe, HOY, { fecha, corridos, destino, nuevo: { modalidad, plazo: 6 } });
        casosA++;
        const a = [pf.capital, pf.interes, pf.destino, pf.nuevo.monto, pf.carga, Math.round(pf.tasaPonderada * 1e6)].concat(pf.traslados.map(t => t.capital + '/' + t.interes)).join(',');
        const b = [pb.capital, pb.interes, pb.destino, pb.monto, pb.carga, Math.round(pb.tasaPonderada * 1e6)].concat(pb.traslados.map(t => t.capital + '/' + t.interes)).join(',');
        if (a !== b) difA.push(nombre + ' ' + fecha + ' ' + destino + ' ' + modalidad + ' ' + corrido + ': ' + a + ' | ' + b);
      }
    }
    R.check('A1 modal == server en ' + casosA + ' casos (2 deudores, varias fechas, con y sin interes corrido, 4 destinos, 3 modalidades)',
      casosA >= 48 && difA.length === 0, difA.slice(0, 4));
    const planB = X.planUnificacion(activosDe(BRUNO), pays, HOY, { nuevo: { plazo: 6 } });
    const liqB = activosDe(BRUNO).reduce((s, l) => s + X.computeLiquidacion(l, paysDe(l.id), { hasta: HOY }).total, 0);
    R.eq('A2 sin opciones, lo que pasa al nuevo es la suma de "Liquidar hoy" de los tres', planB.total, liqB);
    const conCorr = X.planUnificacion(activosDe(BRUNO), pays, HOY, { corrido: true, nuevo: { plazo: 6 } });
    R.check('A3 marcar el interes corrido suma justo ese interes (y nada mas)',
      conCorr.corridoTotal > 0 && conCorr.total === planB.total + conCorr.corridoTotal && conCorr.capital === planB.capital);
    R.check('A4 el server rechaza una fecha futura, una anterior al ultimo movimiento y deudores distintos',
      ['2026-08-01', '2000-01-01'].every(f => { try { B.planUnificacion(activosDe(BRUNO), paysDe, HOY, { fecha: f, nuevo: { plazo: 6 } }); return false; } catch (e) { return e.code >= 400; } }) &&
      (() => { try { B.planUnificacion([activosDe(BRUNO)[0], activosDe(GABRIELA)[0]], paysDe, HOY, { nuevo: { plazo: 6 } }); return false; } catch (e) { return /mismo deudor/.test(e.message); } })());

    // Un prestamo cuyo plazo ya termino no tiene periodo en curso: el motor no cobra interes despues
    // de la ultima cuota (las vencidas quedan congeladas). Se mide en una fecha posterior a su final.
    {
      const lFin = activosDe(BRUNO)[0], ultima = paysDe(lFin.id).map(p => p.fechaPago).sort().pop();
      const despues = E.sumarDias(ultima, 40);
      const tf = X.trasladoDe(lFin, pays, despues, { corrido: true }), tb = B.trasladoDe(lFin, paysDe(lFin.id), despues, { corrido: true });
      const ta = X.trasladoDe(lFin, pays, HOY, { corrido: true });
      R.check('A5 sin cuotas por vencer no corre interes (modal y server); con cuotas por vencer si (anti-vacio)',
        tf.corrido.sinCuotas === true && tf.corrido.monto === 0 && tb.corrido.monto === 0 && tf.interes === tb.interes && ta.corrido.monto > 0,
        [tf.corrido, tb.corrido.monto, ta.corrido.monto]);
    }

    // Lo corrido nunca supera lo que la propia cuota cobra por su periodo (la base es el capital
    // de esa cuota: el de una cuota vencida queda congelado en el motor).
    {
      const malos = [];
      let medidos = 0;
      loans.filter(l => l.estado === 'Activo' && l.modalidad !== 'Interes Diario').forEach(l => {
        const t = X.trasladoDe(l, pays, HOY, { corrido: true });
        if (t.corrido.monto > 0) { medidos++; if (t.corrido.monto > t.corrido.interesCuota + 1) malos.push(l.id + ': ' + t.corrido.monto + ' > ' + t.corrido.interesCuota); }
      });
      R.check('A6 en cada prestamo activo, lo corrido <= el interes de su cuota en curso (' + medidos + ' medidos)', medidos >= 5 && malos.length === 0, malos);
    }

    // ── B — el cronograma del nuevo: modal == motor ───────────────────────────────
    R.seccion('B — el cronograma que promete el modal es el que genera el motor (con la carga)');
    let casosB = 0; const difB = [];
    const lsB = activosDe(BRUNO), limB = X.limitesFecha(lsB, pays, HOY);
    for (const fecha of [HOY, limB.min].filter((f, i, a) => a.indexOf(f) === i))
    for (const modalidad of ['Capital + Intereses', 'Intereses']) for (const frecuencia of ['Mensual', 'Quincenal', 'Semanal'])
    for (const destino of ['repartir', 'primera', 'capital', 'condonar']) for (const pp of [0, -3, 11]) for (const modo of ['proporcional', 'completo'])
    for (const plazo of [1, 6, 12]) {
      const reg = E.primerPagoRegular(fecha, frecuencia);
      const primerPago = pp ? E.sumarDias(reg, pp) : reg;
      const opc = { fecha, destino, cuotasReparto: 4, nuevo: { modalidad, frecuencia, plazo, primerPago, primerPeriodo: modo } };
      const pf = X.planUnificacion(lsB, pays, HOY, opc);
      const body = cuerpoDe(pf, lsB, opc);
      const rows = cronogramaMotor(pf, body);
      const n = Math.min(rows.length, pf.nuevo.filas.length);
      casosB++;
      const ok = n > 0 && (modalidad !== 'Capital + Intereses' || rows.length === pf.nuevo.filas.length) &&
        pf.nuevo.filas.slice(0, n).every((f, i) => mismaFila(f, rows[i]));
      if (!ok) difB.push(fecha + ' ' + modalidad + ' ' + frecuencia + ' ' + destino + ' pp' + pp + ' ' + modo + ' n' + plazo);
    }
    R.check('B1 modal == motor fila a fila (fecha, interes, capital, cuota, saldo) en ' + casosB + ' combinaciones', casosB >= 400 && difB.length === 0, difB.slice(0, 5));
    const conCarga = X.planUnificacion(lsB, pays, HOY, { corrido: true, nuevo: { plazo: 6 } });
    R.check('B2 repartir: la carga suma exacto los intereses trasladados y va dentro del interes de cada cuota',
      conCarga.carga > 0 && conCarga.carga === conCarga.interes && conCarga.nuevo.filas.reduce((s, f) => s + f.carga, 0) === conCarga.interes &&
      conCarga.nuevo.filas.every(f => f.interes === f.interesPropio + f.carga && f.interes + f.capital === f.cuota));

    // ── C — el flujo completo contra el server ────────────────────────────────────
    R.seccion('C — unificar los 3 de Bruno: caja intacta, abono cerrado por lo pagado, deshacer exacto');
    // Un abono en vuelo sobre la proxima cuota sin saldar: el caso del defecto del cierre forzoso.
    const filaAb = lsB.map(l => paysDe(l.id).filter(p => p.estadoPago !== 'Pagado' && p.id.indexOf('-ab-') === -1)).reduce((a, b) => a.concat(b), [])
      .sort((a, b) => a.fechaPago < b.fechaPago ? -1 : 1)[0];
    R.check('C0 anti-vacio: hay una cuota sin saldar donde registrar un abono parcial', !!filaAb);
    const rPar = await pedir(S, 'POST', '/api/payments/' + filaAb.id + '/partial', { monto: 50000, fecha: HOY, observaciones: 'prueba' });
    R.check('C0 el abono parcial se registra', rPar.status === 200, rPar.text.slice(0, 150));
    ({ loans, pays } = await traer());
    const idsB = activosDe(BRUNO).map(l => l.id);
    const antesB = leerBD(dbPath, d => ({ loans: idsB.map(id => d.prepare('SELECT * FROM loans WHERE id=?').get(id)),
      pays: d.prepare('SELECT * FROM payments WHERE prestamoId IN (' + idsB.map(() => '?').join(',') + ') ORDER BY id').all(...idsB) }));
    const cajaAntes = cajaTotal(pays);
    // Con el interes ya corrido de los tres (asi hay intereses que repartir y el abono los cubre primero).
    const corrB = {}; idsB.forEach(id => { corrB[id] = true; });
    const opcC = { corridos: corrB, nuevo: { plazo: 6 } };
    const planC = X.planUnificacion(activosDe(BRUNO), pays, HOY, opcC);
    const bodyC = cuerpoDe(planC, activosDe(BRUNO), opcC);
    const rC = await pedir(S, 'POST', '/api/unificaciones', bodyC);
    R.check('C1 la unificacion responde 200 con el id del nuevo y su entrada de deshacer', rC.status === 200 && !!rC.json.nuevoId && !!rC.json.undoId, rC.text.slice(0, 200));
    ({ loans, pays } = await traer());
    const nuevoC = loans.find(l => l.id === rC.json.nuevoId);
    R.eq('C2 NI UN PESO de caja se crea ni se pierde (suma de cobrosDe de toda la cartera)', cajaTotal(pays), cajaAntes);
    const viejos = idsB.map(id => loans.find(l => l.id === id));
    R.check('C3 anti-vacio: hay intereses que repartir y el abono cubrio parte de ellos', planC.interes > 0 && planC.traslados.some(t => t.aInteres > 0));
    R.check('C3 los tres viejos: Finalizados, unificados en el nuevo, con su capital e interes trasladados',
      viejos.every((l, i) => l.estado === 'Finalizado' && l.unificadoEn === nuevoC.id &&
        Math.round(l.capitalTrasladado) === planC.traslados[i].capital && Math.round(l.interesTrasladado) === planC.traslados[i].interes));
    const consCapital = viejos.every((l, i) => {
      const orig = Math.round(l.montoOrigen), pag = paysDe(l.id).filter(p => p.estadoPago === 'Pagado').reduce((s, p) => s + p.abonoCapital, 0);
      return orig - pag === Math.round(l.capitalTrasladado);
    });
    R.check('C3 capital conservado: prestado - capital ya cobrado = capital trasladado, en cada viejo', consCapital);
    const pagadasAntes = antesB.pays.filter(p => p.estadoPago === 'Pagado');
    R.check('C4 a los viejos no les queda ninguna cuota sin saldar, y sus cuotas Pagadas no se tocaron',
      idsB.every(id => paysDe(id).every(p => p.estadoPago === 'Pagado')) &&
      pagadasAntes.every(p => JSON.stringify(pays.find(q => q.id === p.id)) === JSON.stringify(Object.assign({}, p))));
    const cerrada = pays.find(p => p.id === filaAb.id), abAntes = antesB.pays.find(p => p.id === filaAb.id);
    R.check('C5 la cuota con abono en vuelo se cierra POR LO ABONADO y conserva su caja (ledger, montos recibidos)',
      !!cerrada && cerrada.estadoPago === 'Pagado' && cerrada.cuotaTotal === abAntes.partialPaid && cerrada.recibos === abAntes.recibos &&
      cerrada.montoCOPRecibido === abAntes.montoCOPRecibido && cerrada.interesPeriodo + cerrada.abonoCapital === cerrada.cuotaTotal,
      JSON.stringify(cerrada).slice(0, 300));
    R.check('C6 el nuevo: capital, capital refinanciado, carga y de donde viene',
      Math.round(nuevoC.montoCOP) === planC.nuevo.monto && Math.round(nuevoC.capitalRefinanciado) === planC.capital &&
      Math.round(nuevoC.cargaTrasladada) === planC.carga && nuevoC.cargaCuotas === 6 && JSON.parse(nuevoC.unificaDe).join() === idsB.join() &&
      nuevoC.estado === 'Activo' && nuevoC.fechaInicio === HOY);
    const filasN = paysDe(nuevoC.id).sort((a, b) => a.cuotaN - b.cuotaN);
    R.check('C7 el cronograma persistido es el que prometio el modal, fila por fila, con su carga anotada',
      filasN.length === 6 && planC.nuevo.filas.every((f, i) => mismaFila(f, filasN[i]) && f.carga === filasN[i].cargaTrasladada));
    R.eq('C8 SIN PERDER DINERO: liquidar el nuevo ese mismo dia da exactamente lo que se debia', X.computeLiquidacion(nuevoC, filasN, { hasta: HOY }).total, planC.total);
    const actC = (await pedir(S, 'GET', '/api/activity')).json.find(a => a.undo_id === rC.json.undoId);
    R.check('C9 el Historial lo registra como "unificacion", enlazado a su entrada de deshacer', !!actC && actC.tipo === 'unificacion', JSON.stringify(actC));
    // Candado U: el abono parcial era un movimiento del prestamo viejo.
    const undos = (await pedir(S, 'GET', '/api/undo')).json;
    const undoPar = undos.find(u => u.scope_id === filaAb.prestamoId && u.estado === 'disponible');
    const rU = undoPar ? await pedir(S, 'POST', '/api/undo/' + undoPar.id) : { status: 0 };
    R.eq('C10 un movimiento de un prestamo unificado no se puede deshacer mientras exista la unificacion (409)', rU.status, 409);
    const rDes = await pedir(S, 'POST', '/api/undo/' + rC.json.undoId);
    R.check('C11 deshacer la unificacion responde 200 sin advertencia de deriva', rDes.status === 200 && !rDes.json.warning, rDes.text.slice(0, 200));
    const despuesB = leerBD(dbPath, d => ({ loans: idsB.map(id => d.prepare('SELECT * FROM loans WHERE id=?').get(id)),
      pays: d.prepare('SELECT * FROM payments WHERE prestamoId IN (' + idsB.map(() => '?').join(',') + ') ORDER BY id').all(...idsB),
      nuevo: d.prepare('SELECT count(*) c FROM loans WHERE id=?').get(nuevoC.id).c + d.prepare('SELECT count(*) c FROM payments WHERE prestamoId=?').get(nuevoC.id).c }));
    R.check('C12 deshacer devuelve los tres prestamos y sus cuotas BYTE A BYTE, y el nuevo desaparece',
      JSON.stringify(despuesB.loans) === JSON.stringify(antesB.loans) && JSON.stringify(despuesB.pays) === JSON.stringify(antesB.pays) && despuesB.nuevo === 0);
    ({ loans, pays } = await traer());
    R.eq('C13 y la caja sigue identica', cajaTotal(pays), cajaAntes);

    // ── D — dolares, fecha retroactiva, intereses sumados al capital ──────────────
    R.seccion('D — Gabriela (dolares), unificacion retroactiva sumando los intereses al capital');
    const lsG = activosDe(GABRIELA), limG = X.limitesFecha(lsG, pays, HOY);
    const fechaG = limG.min < HOY ? (E.sumarDias(HOY, -2) >= limG.min ? E.sumarDias(HOY, -2) : limG.min) : HOY;
    const corrG = {}; lsG.forEach(l => { corrG[l.id] = true; });
    const opcG = { fecha: fechaG, corridos: corrG, destino: 'capital', nuevo: { plazo: 8 } };
    const planG = X.planUnificacion(lsG, pays, HOY, opcG);
    R.check('D0 anti-vacio: la fecha es retroactiva y hay intereses que sumar al capital', fechaG < HOY && planG.interes > 0, [fechaG, limG.min, planG.interes]);
    const rG = await pedir(S, 'POST', '/api/unificaciones', cuerpoDe(planG, lsG, opcG));
    R.check('D1 responde 200', rG.status === 200, rG.text.slice(0, 200));
    ({ loans, pays } = await traer());
    const nuevoG = loans.find(l => l.id === rG.json.nuevoId);
    const origG = Math.round(nuevoG.montoOrigen * nuevoG.trmAcordada);
    R.check('D2 en dolares: el capital en pesos del nuevo es EXACTO (montoOrigen x TRM), incluye los intereses capitalizados',
      nuevoG.moneda === 'USD' && origG === planG.nuevo.monto && planG.nuevo.monto === planG.capital + planG.interes &&
      Math.round(nuevoG.interesCapitalizado) === planG.interes && nuevoG.fechaInicio === fechaG && Math.round(nuevoG.cargaTrasladada) === 0);
    // D2b — el Historial nombra el capital del NUEVO (con los intereses sumados), no el de antes. Hasta
    // el punto 5 decia "capital $<lo de antes> (incluye $<intereses>...)", que se contradecia.
    const actG = (await pedir(S, 'GET', '/api/activity')).json || [];
    const msgG = (actG.find(a => a.tipo === 'unificacion' && a.mensaje.indexOf(nuevoG.nombre) !== -1) || {}).mensaje || '';
    const pesoG = v => '$' + Math.round(v).toLocaleString('es-CO');
    R.check('D2b el Historial dice el capital del préstamo nuevo e incluye los intereses sumados',
      msgG.indexOf('capital ' + pesoG(planG.nuevo.monto) + ' (incluye ' + pesoG(planG.interes) + ' de intereses sumados al capital)') !== -1, msgG);
    const filasG = paysDe(nuevoG.id).sort((a, b) => a.cuotaN - b.cuotaN);
    R.check('D3 el cronograma retroactivo es el del modal', filasG.length === planG.nuevo.filas.length && planG.nuevo.filas.every((f, i) => mismaFila(f, filasG[i])));
    R.eq('D4 el capital refinanciado no cuenta como prestado (dinero nuevo = 0)', origG - X.capitalRefinanciadoDe(nuevoG), 0);
    const ratio = X.ratioCapitalizado(nuevoG);
    const ganSin = X.gananciaDePrestamo(nuevoG, pays).cop;
    // Se cobra la primera cuota completa.
    const f1 = filasG[0];
    const rPago = await pedir(S, 'PUT', '/api/payments/' + f1.id, { estadoPago: 'Pagado', fechaRecaudo: HOY, observaciones: '',
      montoCOPRecibido: f1.cuotaTotal, montoUSDRecibido: Math.round(f1.cuotaTotal / nuevoG.trmAcordada * 100) / 100 });
    ({ loans, pays } = await traer());
    const ganCon = X.gananciaDePrestamo(nuevoG, pays).cop;
    const esperadaG = f1.interesPeriodo + Math.round(f1.abonoCapital * ratio);
    R.check('D5 la ganancia reconoce el interes capitalizado en proporcion al capital cobrado (interes + capital x ' + ratio.toFixed(4) + ')',
      rPago.status === 200 && ratio > 0 && ganSin === 0 && Math.abs(ganCon - esperadaG) <= 1, [ganSin, ganCon, esperadaG]);

    // ── E — la carga en las rutas que regeneran, y la liquidacion la cobra ─────────
    R.seccion('E — la carga sobrevive a editar, recalcular y a un abono que acorta el plazo; liquidar la cobra');
    const opcE = { corridos: corrB, nuevo: { plazo: 6 } };
    const planE = X.planUnificacion(activosDe(BRUNO), pays, HOY, opcE);
    const rE = await pedir(S, 'POST', '/api/unificaciones', cuerpoDe(planE, activosDe(BRUNO), opcE));
    ({ loans, pays } = await traer());
    const idE = rE.json && rE.json.nuevoId;
    const nE = loans.find(l => l.id === idE);
    const C = Math.round(nE.cargaTrasladada);
    const sumaCarga = () => paysDe(idE).filter(p => p.id.indexOf('-ab-') === -1).reduce((s, p) => s + (p.cargaTrasladada || 0), 0);
    R.check('E0 anti-vacio: el nuevo lleva carga repartida en 6 cuotas', rE.status === 200 && C > 0 && sumaCarga() === C);
    const filasE0 = JSON.stringify(paysDe(idE).map(p => [p.id, p.interesPeriodo, p.cuotaTotal, p.cargaTrasladada]));
    const rEd = await pedir(S, 'PUT', '/api/loans/' + idE, Object.assign({}, nE, { notas: 'editado', montoOrigen: 1, tasaMensual: 1, primerPago: null }));
    ({ loans, pays } = await traer());
    const nE2 = loans.find(l => l.id === idE);
    R.check('E1 editar los datos no toca la carga ni las cifras atadas a la unificacion (el form las bloquea; el server tambien)',
      rEd.status === 200 && nE2.notas === 'editado' && nE2.montoOrigen === nE.montoOrigen && nE2.tasaMensual === nE.tasaMensual &&
      JSON.stringify(paysDe(idE).map(p => [p.id, p.interesPeriodo, p.cuotaTotal, p.cargaTrasladada])) === filasE0);
    await pedir(S, 'POST', '/api/recalculate', {});
    ({ loans, pays } = await traer());
    R.check('E2 recalcular (lo que pasa en cada arranque) deja el cronograma y la carga identicos',
      JSON.stringify(paysDe(idE).map(p => [p.id, p.interesPeriodo, p.cuotaTotal, p.cargaTrasladada])) === filasE0);
    const rAb = await pedir(S, 'POST', '/api/loans/' + idE + '/abono', { monto: 100000, fecha: HOY, observaciones: '', recalcMode: 'modificarPlazo', recalcValor: 2 });
    ({ loans, pays } = await traer());
    const regsE = paysDe(idE).filter(p => p.id.indexOf('-ab-') === -1).sort((a, b) => a.cuotaN - b.cuotaN);
    R.check('E3 un abono que acorta el plazo a 2 cuotas: la ultima absorbe las partes que ya no tienen cuota (la carga no se pierde)',
      rAb.status === 200 && regsE.length === 2 && sumaCarga() === C && regsE[1].cargaTrasladada === C - Math.floor(C / 6), [rAb.status, regsE.length, sumaCarga(), C]);
    const nE3 = loans.find(l => l.id === idE);
    const L = X.computeLiquidacion(nE3, paysDe(idE), { hasta: HOY });
    R.check('E4 liquidar suma los intereses trasladados aun sin cobrar', L.cargaPendiente === C && L.total === L.capitalPendiente + C - L.partialPend);
    const rLiq = await pedir(S, 'POST', '/api/loans/' + idE + '/abono', { monto: L.capitalPendiente, fecha: HOY, observaciones: 'liquidacion', liquidar: true, intExtra: L.cargaPendiente });
    ({ loans, pays } = await traer());
    const abLiq = paysDe(idE).filter(p => p.id.indexOf('-ab-') !== -1).sort((a, b) => a.id < b.id ? 1 : -1)[0];
    R.check('E5 la liquidacion cierra el prestamo y registra la carga como interes cobrado',
      rLiq.status === 200 && loans.find(l => l.id === idE).estado === 'Finalizado' && !!abLiq && Math.round(abLiq.interesPeriodo) === C, rLiq.text.slice(0, 200));

    // ── F — el cierre forzoso ya no borra la caja de un abono en vuelo ──────────────
    R.seccion('F — cierre forzoso con un abono en vuelo: la caja se conserva y la perdida es la neta');
    const lF = loans.find(l => l.id === '1773655076017');
    const moraF = paysDe(lF.id).filter(p => p.estadoPago === 'En Mora' && p.id.indexOf('-ab-') === -1).sort((a, b) => a.fechaPago < b.fechaPago ? -1 : 1);
    R.check('F0 anti-vacio: el prestamo de prueba tiene cuotas en mora', !!lF && lF.estado === 'Activo' && moraF.length > 0);
    await pedir(S, 'POST', '/api/payments/' + moraF[0].id + '/partial', { monto: 30000, fecha: HOY, observaciones: '' });
    ({ loans, pays } = await traer());
    const cajaF = cajaTotal(paysDe(lF.id));
    const moraF2 = paysDe(lF.id).filter(p => p.estadoPago === 'En Mora' && p.id.indexOf('-ab-') === -1);
    const intMoraF = moraF2.reduce((s, p) => s + p.interesPeriodo, 0);
    const iCubierto = Math.min(30000, moraF[0].interesPeriodo);
    const rF = await pedir(S, 'POST', '/api/loans/' + lF.id + '/force-close', {});
    ({ loans, pays } = await traer());
    const cerradaF = pays.find(p => p.id === moraF[0].id);
    R.check('F1 la cuota con abono queda Pagada por lo abonado y la caja del prestamo no se mueve',
      rF.status === 200 && !!cerradaF && cerradaF.estadoPago === 'Pagado' && cerradaF.cuotaTotal === 30000 && cajaTotal(paysDe(lF.id)) === cajaF,
      [rF.status, cerradaF && cerradaF.estadoPago, cajaTotal(paysDe(lF.id)), cajaF]);
    R.eq('F2 los intereses perdidos descuentan lo que el abono ya cubrio', Math.round(rF.json.interesesPerdidos), intMoraF - iCubierto);

    // ── G — el modal ────────────────────────────────────────────────────────────────
    R.seccion('G — el modal renderizado con el fixture');
    ({ loans, pays } = await traer());
    const useStateOrig = X.useState;
    const montar = (props, estado) => {
      let i = 0;
      X.useState = init => { const k = i++; const v = (estado && k < estado.length && estado[k] !== undefined) ? estado[k] : (typeof init === 'function' ? init() : init); return [v, () => {}]; };
      try { return pintar({ type: X.UnificarModal, props, children: [] }); } finally { X.useState = useStateOrig; }
    };
    const lsGm = loans.filter(l => l.nombre === 'ZZ No existe');   // (vacio, para el caso sin prestamos)
    const brunoIni = loans0.filter(l => l.nombre === BRUNO && l.estado === 'Activo');
    const propsM = { deudor: 'Bruno Salgado', hoy: HOY, pays: pays0, loans: brunoIni, onClose: () => {}, onPropuesta: () => {}, onConfirmar: () => Promise.resolve() };
    let arbol = null, errG = null;
    try { arbol = montar(propsM); } catch (e) { errG = e.message; }
    const planM = X.planUnificacion(brunoIni, pays0, HOY, { nuevo: { plazo: 6 } });
    R.check('G1 se renderiza sin excepciones: titulo, fecha, un renglon por prestamo y el total que pasa al nuevo',
      !errG && unir(conClase(arbol, 'v4m-tit')[0]) === 'Unificar préstamos' && conClase(arbol, 'un-fecha').length === 1 &&
      conClase(arbol, 'un-prest').length === 3 && unir(conClase(arbol, 'un-total-v')[0]) === X.fmt(planM.total), errG);
    R.check('G2 el interes corrido credito por credito: una casilla por prestamo con interes corrido, todas desmarcadas',
      conClase(arbol, 'un-corr').length >= 1 && nodos(conClase(arbol, 'un-corridos')[0], n => n.tag === 'input' && n.props.type === 'checkbox').every(n => !n.props.checked));
    R.check('G3 sin intereses que decidir (nada vencido ni marcado) el bloque de los intereses no aparece', conClase(arbol, 'un-op').length === 0);
    const corr0 = {}; brunoIni.forEach(l => { corr0[l.id] = true; });
    const arbolI = montar(propsM, [undefined, undefined, undefined, corr0]);
    R.check('G3 con el interes corrido marcado: las cuatro opciones, "repartir" elegida por defecto, y las casillas marcadas',
      conClase(arbolI, 'un-op').length === 4 && unir(conClase(arbolI, 'v4m-elegida-info')[0]).indexOf('Repartirlos entre todas las cuotas') === 0 &&
      nodos(conClase(arbolI, 'un-corridos')[0], n => n.tag === 'input' && n.props.type === 'checkbox').every(n => n.props.checked));
    const arbolMal = montar(propsM, [undefined, undefined, '2000-01-01']);
    const btnU = nodos(arbolMal, n => n.tag === 'button' && /Unificar \d/.test(unir(n)))[0];
    R.check('G4 con una fecha fuera de rango: el motivo a la vista y el boton apagado',
      /No puede ser antes del/.test(unir(conClase(arbolMal, 'un-error')[0])) && !!btnU && btnU.props.disabled === true);
    void lsGm;

    // ── H — los documentos ──────────────────────────────────────────────────────────
    R.seccion('H — la propuesta y la constancia');
    FE.captura.pdfs.length = 0;
    X.generatePropuestaUnificacion(planM, 'Bruno Salgado', { dark: false });
    X.generateConstanciaUnificacion(planM, 'Bruno Salgado', { dark: true, datosPago: 'Nequi <300>', nuevoId: '123abc' });
    const [prop, cons] = FE.captura.pdfs;
    R.check('H1 la propuesta: condicional, con su codigo y su aviso de que no cambia nada',
      !!prop && /Si unificamos tus 3 préstamos, pagarías/.test(prop.html) && /PU-Br-3107/.test(prop.html) && /Esto es una propuesta/.test(prop.html) &&
      prop.fname === 'Propuesta de unificación - Bruno Salgado - ' + HOY && prop.html.indexOf('Cómo pagar') === -1);
    R.check('H2 la constancia: en pasado, codigo del nuevo, "Cómo pagar" escapado y el tema oscuro del papel',
      !!cons && /Unificamos tus 3 préstamos: ahora pagas/.test(cons.html) && /UN-Br-abc-3107/.test(cons.html) &&
      cons.html.indexOf('Nequi &lt;300&gt;') !== -1 && cons.html.indexOf('--r-bg:#000000') !== -1);
    R.check('H3 el total de lo que se une y el cronograma son los del plan',
      prop.html.indexOf(X.fmt(planM.total).replace(/\s/g, ' ')) !== -1 || prop.html.replace(/ /g, ' ').indexOf(X.fmt(planM.total).replace(/ /g, ' ')) !== -1);
    const filasDoc = (prop.html.match(/<tr><td>\d+<\/td><td>/g) || []).length;
    R.eq('H4 el cronograma del documento tiene una fila por cuota', filasDoc, planM.nuevo.filas.length);
  } catch (e) {
    R.check('la suite corrio sin excepciones', false, e && e.stack ? e.stack : String(e));
  } finally {
    await cerrar(S);
  }
  process.exit(R.finalizar());
})();
