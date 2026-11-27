// tests/congelar.js — CONGELAR PRESTAMO (post-4.1.6) contra el server REAL.
//
// Un prestamo congelado sigue Activo: lo vencido se sigue debiendo y se cobra, se condona y se
// liquida; desde la fecha del congelamiento NO corren intereses ni nacen cuotas, hasta que se
// descongela a mano. La cuota en curso se cierra con los dias corridos (fija). Esta suite fija,
// en orden de importancia:
//   1. Lo que escribe congelar es EXACTAMENTE lo que el motor regenera: /recalculate (el arranque
//      de la app), la extension automatica y un abono no lo deshacen ni lo cambian.
//   2. Mientras esta congelado no nace ninguna cuota y el prestamo no se cierra solo aunque se
//      pague todo lo vencido (el capital se sigue debiendo).
//   3. Descongelar reanuda en el dia de pago con la transitoria del motor, y la cuota de cierre
//      conserva su fecha y su monto (tambien tras /recalculate).
//   4. La liquidacion ofrece los dias hasta el congelamiento, no un mes.
//   5. Los rechazos dejan la BD intacta y deshacer devuelve todo byte a byte.
//
// El reloj se congela en la fecha de referencia del fixture (31-jul-2026), como e2e-api: la suite
// no puede depender del dia en que se corre.
//
// Se ejecuta:
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron tests/congelar.js

const RelojReal = Date;
const INSTANTE_FIJO = new RelojReal(2026, 6, 31, 12, 0, 0);   // 31-jul-2026 12:00 local
global.Date = class extends RelojReal {
  constructor(...args) { if (args.length === 0) super(INSTANTE_FIJO.getTime()); else super(...args); }
  static now() { return RelojReal.now(); }   // ids unicos: NO se congela
};

const fs   = require('fs');
const vm   = require('vm');
const path = require('path');
const http = require('http');
const { Reporter }          = require('./lib/report');
const { copiaDeProduccion } = require('./lib/db');
const { REPO }              = require('./lib/paths');

const R = new Reporter('congelar');
const PORT = 3978;   // NUNCA 3420 (la app real); 3971-3974 son de otras suites

// ── El dominio REAL del frontend (la liquidacion que ve el usuario) ──────────────
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
function cargarDominio() {
  const orden = [], vistos = new Set();
  aplanar(path.join(REPO, 'public', 'js', 'core', 'dominio.js'), vistos, orden);
  aplanar(path.join(REPO, 'public', 'js', 'core', 'congelar.js'), vistos, orden);
  aplanar(path.join(REPO, 'public', 'js', 'core', 'cascada.js'), vistos, orden);
  const sb = { console, Date: global.Date };
  sb.globalThis = sb;
  const ctx = vm.createContext(sb);
  vm.runInContext(orden.join('\n'), ctx);
  return vm.runInContext('({computeLiquidacion,preguntaInteresMes,estaCongelado,saldoConCaja,cobrosDe,cgPlanCongelar,cgPlanDescongelar,cgPuedeCongelar,cgSiguientePagoTras,planCascada,imputarCobros})', ctx);
}

function pedir(method, ruta, body) {
  return new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: ruta, method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
    }, x => {
      let b = '';
      x.on('data', c => b += c);
      x.on('end', () => { let j = null; try { j = JSON.parse(b || '{}'); } catch (_) {} res({ status: x.statusCode, json: j }); });
    });
    r.on('error', rej);
    if (data) r.write(data);
    r.end();
  });
}

// Los pasos del plan EN SERIE contra el server (lo que hace `_doCobroCascada`), como en cascada-cobro.
async function ejecutarPlan(loanId, plan, fecha, obs) {
  const estado = { ok: true, hechos: [], error: null };
  for (const paso of plan.pasos) {
    const r = paso.tipo === 'partial'
      ? await pedir('POST', '/api/payments/' + paso.payId + '/partial', { monto: paso.cajaCOP, fecha, observaciones: obs, montoUSD: paso.obligacionUSD || 0 })
      : await pedir('POST', '/api/loans/' + loanId + '/abono', { monto: paso.obligacionCOP, fecha, observaciones: obs, montoUSD: paso.obligacionUSD || 0,
          montoCOPRecibido: paso.cajaCOP, liquidar: false, recalcMode: 'mantener', recalcValor: null, intExtra: 0 });
    if (r.status >= 400 || !r.json || r.json.error) { estado.ok = false; estado.error = (r.json && r.json.error) || ('HTTP ' + r.status); break; }
    estado.hechos.push(paso);
  }
  return estado;
}

(async function main() {
  const D = cargarDominio();
  const DB = copiaDeProduccion('congelar');
  const app = require(path.join(REPO, 'backend', 'server.js'))(DB);
  const srv = http.createServer(app);
  await new Promise(ok => srv.listen(PORT, '127.0.0.1', ok));
  const Database = require(path.join(REPO, 'node_modules', 'better-sqlite3'));
  const conDb = fn => { const d = new Database(DB, { readonly: true }); try { return fn(d); } finally { d.close(); } };
  const loanDe = id => conDb(d => d.prepare('SELECT * FROM loans WHERE id = ?').get(id));
  const paysDe = id => conDb(d => d.prepare('SELECT * FROM payments WHERE prestamoId = ? ORDER BY cuotaN, id').all(id));
  // Huella de un prestamo: su fila y sus cuotas, para comparar estados byte a byte.
  const huella = id => JSON.stringify({ l: loanDe(id), p: paysDe(id) });
  const huellaCuotas = id => JSON.stringify(paysDe(id));
  const huellaTodo = () => conDb(d => JSON.stringify([d.prepare('SELECT * FROM loans ORDER BY id').all(), d.prepare('SELECT * FROM payments ORDER BY id').all()]));
  const esAb = p => p.id.indexOf('-ab-') !== -1;
  const regsDe = id => paysDe(id).filter(p => !esAb(p));
  const deshacerUltimo = async id => {
    const r = await pedir('GET', '/api/undo?scopeTipo=loan&scopeId=' + encodeURIComponent(id));
    const e = (r.json || []).find(x => x.estado === 'disponible');
    return e ? pedir('POST', '/api/undo/' + e.id) : { status: 0 };
  };

  await pedir('GET', '/api/payments');   // auto-mora y extension, como al abrir la app

  // ══ A — SOLO INTERESES: congelar, mantener, abonar, descongelar ══════════════════════
  // El credito de solo intereses del fixture: 3.000.000 al 10%, dia 7; al 31-jul, 4 a 8 vencidas y
  // 9 a 12 por vencer (la 9 el 7-ago). Se congela el 20-jul: la cuota 9 se cierra con 13 dias.
  R.seccion('A — solo intereses: la cuota en curso se cierra con los días corridos y no nacen cuotas');
  const ID = '1773655076017';
  const inicial = huella(ID);
  {
    const regs = regsDe(ID);
    R.check('A0 ANTI-VACIO: 5 vencidas (4 a 8) y la 9 por vencer el 7-ago', regs.filter(p => p.estadoPago === 'En Mora').length === 5 &&
      regs.some(p => p.cuotaN === 9 && p.estadoPago === 'Pendiente' && p.fechaPago === '2026-08-07' && Math.round(p.cuotaTotal) === 300000),
      regs.map(p => p.cuotaN + ':' + p.estadoPago).join(' '));
  }
  const antes = paysDe(ID);
  const r1 = await pedir('POST', '/api/loans/' + ID + '/congelar', { desde: '2026-07-20', observaciones: 'acuerdo de prueba' });
  R.eq('A1 el endpoint congela', r1.status, 200);
  R.check('A1 informa la cuota de cierre: la 9, 13 días, $130.000, y quita 3 cuotas',
    r1.json && r1.json.cierre && r1.json.cierre.cuotaN === 9 && r1.json.cierre.dias === 13 && r1.json.cierre.interes === 130000 && r1.json.quitadas === 3,
    JSON.stringify(r1.json));
  {
    const l = loanDe(ID), regs = regsDe(ID), c9 = regs.find(p => p.cuotaN === 9);
    R.eq('A2 el préstamo sigue Activo, congelado desde el 20-jul', [l.estado, l.congeladoDesde], ['Activo', '2026-07-20']);
    R.check('A2 la cuota 9 es la de cierre: $130.000 de interés, sin capital, en su fecha (7-ago)',
      c9 && Math.round(c9.interesPeriodo) === 130000 && Math.round(c9.cuotaTotal) === 130000 && Math.round(c9.abonoCapital) === 0 &&
      c9.fechaPago === '2026-08-07' && c9.estadoPago === 'Pendiente' && /^Cierre por congelamiento: 13 días/.test(c9.observaciones), JSON.stringify(c9));
    R.check('A2 no queda ninguna cuota después de la de cierre', regs.every(p => p.cuotaN <= 9), regs.map(p => p.cuotaN));
    R.check('A2 lo vencido y lo pagado (1 a 8) quedó EXACTAMENTE igual',
      JSON.stringify(antes.filter(p => p.cuotaN <= 8)) === JSON.stringify(paysDe(ID).filter(p => p.cuotaN <= 8)));
  }
  // Lo que escribio congelar es lo que el motor regenera: el arranque y la extension no lo tocan.
  const congelado = huellaCuotas(ID);
  await pedir('POST', '/api/recalculate');
  R.check('A3 /recalculate (el arranque) deja el cronograma congelado idéntico', huellaCuotas(ID) === congelado);
  await pedir('GET', '/api/payments');
  R.check('A3 la extensión automática no crea cuotas mientras está congelado', huellaCuotas(ID) === congelado);
  {
    const l = loanDe(ID), lp = paysDe(ID);
    const L = D.computeLiquidacion(l, lp, { hasta: '2026-07-31' });
    const Lc = D.computeLiquidacion(l, lp, { hasta: '2026-07-31', incluyeProxMes: true });
    R.check('A4 liquidar: capital + lo vencido; la casilla ofrece los 13 días del cierre ($130.000), no un mes',
      L.congelado && L.total === 3000000 + 1500000 && L.intProxMes === 130000 && Lc.total === 3000000 + 1500000 + 130000 && L.cierreDias === 13,
      JSON.stringify({ total: L.total, prox: L.intProxMes, conCasilla: Lc.total, dias: L.cierreDias }));
    R.check('A4 la pregunta del interés en curso sigue en pie (queda la cuota de cierre)', D.preguntaInteresMes(l, lp) === true);
    R.check('A4 estaCongelado lo reconoce', D.estaCongelado(l) === true);
  }
  // Bloqueos mientras esta congelado.
  {
    const h0 = huellaTodo();
    const b1 = await pedir('POST', '/api/loans/' + ID + '/congelar', {});
    const b2 = await pedir('POST', '/api/loans/' + ID + '/cambiar-dia-pago', { nuevoDia: 15 });
    const b3 = await pedir('POST', '/api/loans/' + ID + '/abono', { monto: 100000, fecha: '2026-07-31', recalcMode: 'modificarPlazo', recalcValor: 3 });
    R.check('A5 congelar dos veces, cambiar el día o reestructurar con un abono: 400', b1.status === 400 && b2.status === 400 && b3.status === 400 &&
      /congelado/.test(b1.json.error) && /descongélalo/.test(b2.json.error) && /descongélalo/.test(b3.json.error), [b1.status, b2.status, b3.status, b2.json && b2.json.error]);
    R.check('A5 y la BD quedó intacta', huellaTodo() === h0);
  }
  // Un abono a capital mientras esta congelado: baja el capital, no nacen cuotas y el cierre no cambia.
  const rAb = await pedir('POST', '/api/loans/' + ID + '/abono', { monto: 500000, fecha: '2026-07-31', recalcMode: 'mantener' });
  R.eq('A6 el abono a capital se registra congelado', rAb.status, 200);
  {
    const regs = regsDe(ID), c9 = regs.find(p => p.cuotaN === 9), l = loanDe(ID);
    R.check('A6 la cuota de cierre conserva su monto y su fecha; su saldo es el capital nuevo',
      c9 && Math.round(c9.cuotaTotal) === 130000 && c9.fechaPago === '2026-08-07' && Math.round(c9.saldoInicial) === 2500000, JSON.stringify(c9));
    R.check('A6 tampoco nacen cuotas por el abono', regs.every(p => p.cuotaN <= 9), regs.map(p => p.cuotaN));
    R.eq('A6 el capital bajó a $2.500.000', D.saldoConCaja(l, paysDe(ID)), 2500000);
  }
  const conAbono = huellaCuotas(ID);
  await pedir('POST', '/api/recalculate');
  R.check('A6 /recalculate tras el abono deja todo igual', huellaCuotas(ID) === conAbono);

  // ── Descongelar el 31-jul: primer pago el 7-ago (el día 7 siguiente), 7 días de interés.
  const rD = await pedir('POST', '/api/loans/' + ID + '/descongelar', {});
  R.eq('A7 el endpoint descongela', rD.status, 200);
  {
    const l = loanDe(ID), regs = regsDe(ID);
    const c9 = regs.find(p => p.cuotaN === 9), c10 = regs.find(p => p.cuotaN === 10), c11 = regs.find(p => p.cuotaN === 11);
    const hist = JSON.parse(l.congelamientos);
    R.check('A7 ya no está congelado y el historial guarda desde y hasta', !l.congeladoDesde && hist.length === 1 && hist[0].desde === '2026-07-20' && hist[0].hasta === '2026-07-31');
    R.check('A7 la cuota de cierre sigue igual (130.000, 7-ago)', c9 && Math.round(c9.cuotaTotal) === 130000 && c9.fechaPago === '2026-08-07');
    R.check('A7 la primera cuota tras descongelar: la 10, el 7-ago, con 7 días de interés sobre 2.500.000 ($58.333)',
      c10 && c10.fechaPago === '2026-08-07' && Math.round(c10.interesPeriodo) === 58333 && /Cuota transitoria: interés de 7 días/.test(c10.observaciones), JSON.stringify(c10));
    R.check('A7 y después, cuotas normales de $250.000 el día 7', c11 && c11.fechaPago === '2026-09-07' && Math.round(c11.cuotaTotal) === 250000, JSON.stringify(c11));
    R.eq('A7 la reactivación es la transitoria del motor (N=10 desde el 31-jul)', [l.periodoIrregularN, l.periodoIrregularDesde, l.diaPago], [10, '2026-07-31', 7]);
  }
  const descongelado = huellaCuotas(ID);
  await pedir('POST', '/api/recalculate');
  R.check('A8 /recalculate tras descongelar: la cuota de cierre conserva su fecha y su monto y nada cambia', huellaCuotas(ID) === descongelado);
  await pedir('GET', '/api/payments');
  R.check('A8 la extensión automática tampoco lo cambia', huellaCuotas(ID) === descongelado);

  // Deshacer: descongelar, el abono y congelar, en orden; el prestamo vuelve byte a byte.
  const u1 = await deshacerUltimo(ID);
  R.check('A9 deshacer descongelar lo deja congelado como estaba', u1.status === 200 && huellaCuotas(ID) === conAbono && !!loanDe(ID).congeladoDesde);
  const u2 = await deshacerUltimo(ID);
  const u3 = await deshacerUltimo(ID);
  R.check('A9 deshacer el abono y el congelamiento lo devuelve byte a byte al principio', u2.status === 200 && u3.status === 200 && huella(ID) === inicial);

  // ══ B — perdonar los dias corridos y elegir el primer pago ═════════════════════════════
  R.seccion('B — perdonar los días corridos: no hay cuota de cierre; descongelar con otro primer pago');
  const rB = await pedir('POST', '/api/loans/' + ID + '/congelar', { desde: '2026-07-20', perdonar: true });
  {
    const regs = regsDe(ID), l = loanDe(ID), lp = paysDe(ID);
    R.check('B1 perdonando: la cuota 9 se quita y no queda nada después de lo vencido', rB.status === 200 && rB.json.perdona === true &&
      rB.json.quitadas === 4 && regs.every(p => p.cuotaN <= 8), regs.map(p => p.cuotaN));
    const L = D.computeLiquidacion(l, lp, { hasta: '2026-07-31' });
    R.check('B1 la liquidación no ofrece interés en curso y no hay pregunta', L.intProxMes === 0 && D.preguntaInteresMes(l, lp) === false, L.intProxMes);
  }
  const rB2 = await pedir('POST', '/api/loans/' + ID + '/descongelar', { primerPago: '2026-09-07' });
  {
    const regs = regsDe(ID), c9 = regs.find(p => p.cuotaN === 9), c10 = regs.find(p => p.cuotaN === 10);
    R.check('B2 descongelar el 31-jul con primer pago el 7-sep: la 9 cobra 38 días ($380.000) y la 10 es normal',
      rB2.status === 200 && c9 && c9.fechaPago === '2026-09-07' && Math.round(c9.interesPeriodo) === 380000 && c10 && c10.fechaPago === '2026-10-07' &&
      Math.round(c10.cuotaTotal) === 300000, JSON.stringify([c9, c10].map(p => p && [p.fechaPago, p.interesPeriodo])));
    const h = huellaCuotas(ID);
    await pedir('POST', '/api/recalculate');
    R.check('B2 /recalculate lo deja igual', huellaCuotas(ID) === h);
  }
  await deshacerUltimo(ID); await deshacerUltimo(ID);
  R.check('B3 deshacer los dos devuelve el préstamo byte a byte', huella(ID) === inicial);

  // ══ C — pagar todo lo vencido congelado no cierra el prestamo ═══════════════════════════
  R.seccion('C — con todo lo vencido pagado, un préstamo congelado no se cierra solo');
  await pedir('POST', '/api/loans/' + ID + '/congelar', { desde: '2026-07-20' });
  for (const p of regsDe(ID).filter(x => x.estadoPago !== 'Pagado')) {
    await pedir('PUT', '/api/payments/' + p.id, { estadoPago: 'Pagado', fechaRecaudo: '2026-07-31', montoCOPRecibido: p.cuotaTotal });
  }
  {
    const l = loanDe(ID), regs = regsDe(ID);
    R.check('C1 ANTI-VACIO: todas sus cuotas quedaron Pagadas', regs.length === 9 && regs.every(p => p.estadoPago === 'Pagado'), regs.length);
    R.eq('C1 sigue Activo: el capital (3.000.000) se sigue debiendo', [l.estado, D.saldoConCaja(l, paysDe(ID))], ['Activo', 3000000]);
  }
  for (let k = 0; k < 7; k++) await deshacerUltimo(ID);
  R.check('C2 deshacer los pagos y el congelamiento lo devuelve byte a byte', huella(ID) === inicial);

  // ══ D — los rechazos dejan la base intacta ═════════════════════════════════════════════
  R.seccion('D — los rechazos dejan la base de datos intacta');
  {
    const todos = conDb(d => d.prepare('SELECT * FROM loans').all());
    const prestamo = todos.find(l => (l.modalidad === 'Prestamo' || l.modalidad === 'Pago Unico') && l.estado === 'Activo');
    const diario = todos.find(l => l.modalidad === 'Interes Diario' && l.estado === 'Activo');
    const h0 = huellaTodo();
    const casos = [
      ['un préstamo sin intereses o de pago único', prestamo && '/api/loans/' + prestamo.id + '/congelar', {}],
      ['un crédito de interés diario (fase 2)', diario && '/api/loans/' + diario.id + '/congelar', {}],
      ['una fecha futura', '/api/loans/' + ID + '/congelar', { desde: '2026-08-15' }],
      ['antes del inicio del período en curso (7-jul)', '/api/loans/' + ID + '/congelar', { desde: '2026-07-01' }],
      ['una fecha inválida', '/api/loans/' + ID + '/congelar', { desde: '2026-02-30' }],
      ['descongelar uno que no está congelado', '/api/loans/' + ID + '/descongelar', {}],
    ];
    const res = [];
    for (const [n, ruta, body] of casos) { const r = ruta ? await pedir('POST', ruta, body) : { status: 0 }; res.push(n + '=' + r.status); }
    R.check('D1 ANTI-VACIO: el fixture trae un préstamo sin intereses (o de pago único) y un crédito diario activos', !!prestamo && !!diario);
    R.check('D1 todos responden 400', res.every(x => /=400$/.test(x)), res);
    R.check('D1 y la BD quedó intacta', huellaTodo() === h0);
    // Con el prestamo congelado: descongelar antes de congelar, o con el primer pago el mismo dia.
    await pedir('POST', '/api/loans/' + ID + '/congelar', { desde: '2026-07-25' });
    const h1 = huellaTodo();
    const d1 = await pedir('POST', '/api/loans/' + ID + '/descongelar', { desde: '2026-07-24' });
    const d2 = await pedir('POST', '/api/loans/' + ID + '/descongelar', { primerPago: '2026-07-31' });
    R.check('D2 descongelar antes de congelar, o con el primer pago el mismo día: 400 y BD intacta', d1.status === 400 && d2.status === 400 && huellaTodo() === h1, [d1.status, d2.status]);
    await deshacerUltimo(ID);
    R.check('D3 deshacer deja el préstamo como al principio', huella(ID) === inicial);
  }
  // Dinero en la cuota en curso: perdonar sus dias lo perderia.
  {
    const c9 = regsDe(ID).find(p => p.cuotaN === 9);
    await pedir('POST', '/api/payments/' + c9.id + '/partial', { monto: 50000, fecha: '2026-07-31' });
    const h0 = huellaTodo();
    const e1 = await pedir('POST', '/api/loans/' + ID + '/congelar', { desde: '2026-07-20', perdonar: true });
    R.check('D4 perdonar los días de una cuota que ya tiene un abono: 400 y BD intacta', e1.status === 400 && /abono/.test(e1.json.error) && huellaTodo() === h0, e1.json);
    const e2 = await pedir('POST', '/api/loans/' + ID + '/congelar', { desde: '2026-07-20' });
    const c9b = regsDe(ID).find(p => p.cuotaN === 9);
    R.check('D4 cobrándolos sí: el abono se conserva en la cuota de cierre', e2.status === 200 && Math.round(c9b.partialPaid) === 50000 &&
      Math.round(c9b.cuotaTotal) === 130000 && c9b.recibos.indexOf('50000') !== -1, JSON.stringify(c9b));
    await deshacerUltimo(ID); await deshacerUltimo(ID);
    R.check('D5 deshacer el congelamiento y el abono lo devuelve byte a byte', huella(ID) === inicial);
  }

  // ══ F — EL ESPEJO DEL MODAL: la vista previa dice lo mismo que el servidor ════════════
  // Las dos ventanas calculan EN VIVO (cgPlanCongelar / cgPlanDescongelar, public/js/core/congelar.js)
  // lo que el servidor va a hacer. Aqui se arma el plan sobre la BD, se ejecuta la ruta real y se
  // exige que coincidan: la cuota de cierre, las cuotas que se quitan, cada fila rehecha y la
  // liquidacion; tambien los mensajes de rechazo. Luego se deshace todo.
  R.seccion('F — el espejo de los modales coincide con el servidor (congelar y descongelar)');
  const HOY = '2026-07-31';
  const camposFila = p => [p.id, p.cuotaN, p.fechaPago, p.estadoPago, Math.round(p.saldoInicial), Math.round(p.interesPeriodo),
    Math.round(p.abonoCapital), Math.round(p.cuotaTotal), Math.round(p.saldoFinal), Math.round(+p.partialPaid || 0)].join('|');
  const filasDe = lista => lista.slice().sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(camposFila);
  const difFilas = (a, b) => { const x = filasDe(a), y = filasDe(b); const d = []; for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) d.push((x[i] || '∅') + '  ≠  ' + (y[i] || '∅')); return d; };
  const casos = [
    { id: '1773655076017', desde: '2026-07-20', perdonar: false, primer: null, n: 'solo intereses · cobrar 13 días' },
    { id: '1773655076017', desde: '2026-07-25', perdonar: true, primer: '2026-09-07', n: 'solo intereses · perdonar, primer pago elegido' },
    { id: '1773651755465', desde: '2026-07-31', perdonar: false, primer: null, n: 'solo intereses · el mismo día del vencimiento: 0 días, nada que cobrar' },
    { id: '1773656070840', desde: '2026-07-16', perdonar: false, primer: '2026-08-20', n: 'solo intereses · día 15, primer pago corrido' },
  ];
  let casosVivos = 0, conCierre = 0, conPerdon = 0, conPlazo = 0;
  for (const k of casos) {
    const antes = huella(k.id);
    const plan = D.cgPlanCongelar(loanDe(k.id), paysDe(k.id), k.desde, k.perdonar, HOY);
    const r = await pedir('POST', '/api/loans/' + k.id + '/congelar', { desde: k.desde, perdonar: k.perdonar });
    if (!plan.ok) {
      R.check('F ' + k.n + ': el rechazo es el mismo', r.status === 400 && r.json && r.json.error === plan.error, { plan: plan.error, srv: r.json });
      continue;
    }
    casosVivos++; if (plan.cierre) conCierre++; if (plan.perdona) conPerdon++;
    const pc = plan.cierre, sc = r.json && r.json.cierre;
    R.check('F ' + k.n + ': congelar — misma cuota de cierre y mismas cuotas quitadas',
      r.status === 200 && (pc ? !!sc && sc.cuotaN === pc.cuotaN && sc.fecha === pc.fecha && sc.dias === pc.dias && sc.interes === pc.interes : !sc) &&
      r.json.quitadas === plan.quitadas.length && r.json.perdona === plan.perdona,
      JSON.stringify({ plan: pc, srv: sc, q: [plan.quitadas.length, r.json && r.json.quitadas] }));
    const d1 = difFilas(plan.paysN, paysDe(k.id));
    R.check('F ' + k.n + ': congelar — el cronograma de la vista previa es el que queda, fila a fila', d1.length === 0, d1.slice(0, 4));
    const Ld = D.computeLiquidacion(loanDe(k.id), paysDe(k.id), {});
    R.check('F ' + k.n + ': congelar — la liquidación anunciada es la que queda', Ld.total === plan.liqDespues && (Ld.intProxMes || 0) === plan.intCursoDespues,
      { plan: [plan.liqDespues, plan.intCursoDespues], real: [Ld.total, Ld.intProxMes] });
    const plan2 = D.cgPlanDescongelar(loanDe(k.id), paysDe(k.id), HOY, k.primer, HOY);
    const r2 = await pedir('POST', '/api/loans/' + k.id + '/descongelar', { desde: HOY, primerPago: k.primer || undefined });
    R.check('F ' + k.n + ': descongelar — misma primera cuota (fecha, cuota, interés) y mismo plazo',
      plan2.ok && r2.status === 200 && r2.json.primerPago === plan2.primer && (plan2.primera ? r2.json.primera && r2.json.primera.fecha === plan2.primera.fechaPago &&
        r2.json.primera.cuota === plan2.primera.cuotaTotal && r2.json.primera.interes === plan2.primera.interesPeriodo : !r2.json.primera) &&
        +r2.json.plazoMeses === +plan2.loanN.plazoMeses,
      JSON.stringify({ plan: plan2.primera && [plan2.primera.fechaPago, plan2.primera.cuotaTotal, plan2.primera.interesPeriodo], srv: r2.json && r2.json.primera, err: plan2.error }));
    if (plan2.masPlazo) conPlazo++;
    const d2 = difFilas(plan2.paysN, paysDe(k.id));
    R.check('F ' + k.n + ': descongelar — el cronograma de la vista previa es el que queda, fila a fila', d2.length === 0, d2.slice(0, 4));
    await deshacerUltimo(k.id); await deshacerUltimo(k.id);
    R.check('F ' + k.n + ': deshacer los dos lo deja como estaba', huella(k.id) === antes);
  }
  R.check('F ANTI-VACIO: los ' + casos.length + ' casos congelaron de verdad, con y sin cuota de cierre',
    casosVivos === casos.length && conCierre === 2 && conPerdon === 2 && conPlazo === 0, { casosVivos, conCierre, conPerdon, conPlazo });
  {
    const antes = huellaTodo();
    const r = await pedir('POST', '/api/loans/1776205975507jkph/congelar', { desde: '2026-07-25' });
    R.check('F capital + intereses todavía no se congela (llega en el siguiente commit): 400 y BD intacta',
      r.status === 400 && /capital \+ intereses todavía no se pueden congelar/.test(r.json && r.json.error) && huellaTodo() === antes, r.json);
  }
  // Los rechazos dicen lo mismo en la vista previa y en el servidor (y no escriben).
  const rechazos = [
    { id: '1773655076017', desde: '2026-08-02', n: 'fecha futura' },
    { id: '1773655076017', desde: '2026-07-01', n: 'antes del inicio del período en curso' },
    { id: '1773655076017', desde: '2026-02-30', n: 'fecha imposible' },
  ];
  for (const k of rechazos) {
    const antes = huellaTodo();
    const plan = D.cgPlanCongelar(loanDe(k.id), paysDe(k.id), k.desde, false, HOY);
    const r = await pedir('POST', '/api/loans/' + k.id + '/congelar', { desde: k.desde });
    R.check('F rechazo (' + k.n + '): mismo mensaje en la vista previa y en el servidor, BD intacta',
      !plan.ok && r.status === 400 && r.json && r.json.error === plan.error && huellaTodo() === antes, { plan: plan.error, srv: r.json && r.json.error });
  }
  {
    const l = loanDe('1773655076017'), lp = paysDe('1773655076017');
    R.check('F el botón «Congelar» solo se ofrece donde la ruta lo acepta',
      D.cgPuedeCongelar(l, lp, HOY) && !D.cgPuedeCongelar(loanDe('1783874778375ziu4'), paysDe('1783874778375ziu4'), HOY) &&
      !D.cgPuedeCongelar(loanDe('fixture-diario-01'), paysDe('fixture-diario-01'), HOY) &&
      !D.cgPuedeCongelar(Object.assign({}, l, { congeladoDesde: '2026-07-20' }), lp, HOY));
  }


  srv.close();
  process.exit(R.finalizar());
})().catch(e => {
  console.error('\n[congelar] ABORTADO — el arnes no pudo ejecutarse:');
  console.error(e && e.stack ? e.stack : e);
  process.exit(2);
});
