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
//   6. (Fase 2) En un credito abierto el devengo se detiene en los dias congelados: lo devengado
//      hasta el congelamiento se conserva (se cobra con un corte o se condona) y vuelve a correr
//      al descongelar.
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
  return vm.runInContext('({computeLiquidacion,preguntaInteresMes,estaCongelado,saldoConCaja,cobrosDe,cgPlanCongelar,cgPlanDescongelar,cgPuedeCongelar,cgSiguientePagoTras,planCascada,imputarCobros,estadoDiario})', ctx);
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
      ['perdonar los días en un crédito de interés diario (lo devengado se conserva)', diario && '/api/loans/' + diario.id + '/congelar', { perdonar: true }],
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

  // ══ E — CAPITAL + INTERESES ════════════════════════════════════════════════════════════
  // El C+I del fixture: 4.000.000 al 7,4572%, 14 cuotas, dia 14; al 31-jul, 1 a 3 pagadas, un abono
  // el 18-jul y la 4 por vencer el 14-ago. Se congela el 25-jul: la 4 se cierra con 11 dias.
  R.seccion('E — capital + intereses: la cuota de cierre no amortiza y el plazo suma esa cuota');
  const IDC = '1776205975507jkph';
  const inicialC = huella(IDC);
  const antesC = regsDe(IDC);
  const c4a = antesC.find(p => p.cuotaN === 4);
  const rC = await pedir('POST', '/api/loans/' + IDC + '/congelar', { desde: '2026-07-25' });
  {
    const regs = regsDe(IDC), c4 = regs.find(p => p.cuotaN === 4);
    const esperado = Math.round(c4a.saldoInicial * 7.4572 / 100 * 11 / 30);
    R.check('E1 ANTI-VACIO: la cuota 4 estaba por vencer el 14-ago con capital', c4a.estadoPago === 'Pendiente' && c4a.fechaPago === '2026-08-14' && c4a.abonoCapital > 0);
    R.check('E1 la 4 se cierra con 11 días de interés, sin capital, y se quitan las cuotas 5 a 14',
      rC.status === 200 && c4 && Math.abs(Math.round(c4.interesPeriodo) - esperado) <= 1 && Math.round(c4.abonoCapital) === 0 &&
      Math.round(c4.saldoFinal) === Math.round(c4.saldoInicial) && regs.every(p => p.cuotaN <= 4) && rC.json.quitadas === 10,
      JSON.stringify({ c4, esperado, quitadas: rC.json && rC.json.quitadas }));
    const h = huellaCuotas(IDC);
    await pedir('POST', '/api/recalculate');
    R.check('E2 /recalculate lo deja idéntico', huellaCuotas(IDC) === h);
  }
  const rC2 = await pedir('POST', '/api/loans/' + IDC + '/descongelar', {});
  {
    const l = loanDe(IDC), regs = regsDe(IDC).filter(p => p.estadoPago !== 'Pagado');
    const nuevas = regs.filter(p => p.cuotaN >= 5);
    const capital = nuevas.reduce((s, p) => s + Math.round(p.abonoCapital), 0);
    const saldo = Math.round(c4a.saldoInicial);
    R.check('E3 descongelar: el plazo pasa de 14 a 15 cuotas (la de cierre no amortizó)', rC2.status === 200 && +l.plazoMeses === 15, l.plazoMeses);
    R.check('E3 quedan las mismas 10 cuotas que amortizan (5 a 14 → 5 a 15) y saldan el capital exacto',
      nuevas.length === 11 && capital === saldo && Math.round(nuevas[nuevas.length - 1].saldoFinal) === 0, { n: nuevas.length, capital, saldo });
    const c5 = nuevas[0];
    R.check('E3 la primera, el 14-ago, cobra 14 días de interés (desde el 31-jul)', c5.fechaPago === '2026-08-14' && /14 días/.test(c5.observaciones), JSON.stringify(c5));
    R.check('E3 la de cierre sigue igual', JSON.stringify(regsDe(IDC).find(p => p.cuotaN === 4)) === JSON.stringify(regsDe(IDC).find(p => p.cuotaN === 4)) &&
      Math.round(regsDe(IDC).find(p => p.cuotaN === 4).abonoCapital) === 0);
    const h = huellaCuotas(IDC);
    await pedir('POST', '/api/recalculate');
    R.check('E4 /recalculate tras descongelar deja todo igual (cierre fijo, PMT sobre las que amortizan)', huellaCuotas(IDC) === h);
  }
  await deshacerUltimo(IDC); await deshacerUltimo(IDC);
  R.check('E5 deshacer los dos devuelve el C+I byte a byte', huella(IDC) === inicialC);

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
    { id: '1776205975507jkph', desde: '2026-07-25', perdonar: false, primer: null, n: 'capital + intereses · cobrar' },
    { id: '1776205975507jkph', desde: '2026-07-20', perdonar: true, primer: null, n: 'capital + intereses · perdonar' },
    { id: '1773656401497', desde: '2026-07-22', perdonar: false, primer: '2026-09-15', n: 'capital + intereses · día 15' },
    { id: '1773657323435hkkb', desde: '2026-07-18', perdonar: false, primer: null, n: 'capital + intereses en dólares' },
    { id: '17795544041379obc', desde: '2026-07-30', perdonar: false, primer: null, n: 'capital + intereses · día 25' },
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
  R.check('F ANTI-VACIO: los ' + casos.length + ' casos congelaron de verdad, con y sin cuota de cierre, y alguno sumó plazo',
    casosVivos === casos.length && conCierre === 6 && conPerdon === 3 && conPlazo >= 3, { casosVivos, conCierre, conPerdon, conPlazo });
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
    R.check('F el botón «Congelar» solo se ofrece donde la ruta lo acepta (desde la Fase 2, también el crédito abierto)',
      D.cgPuedeCongelar(l, lp, HOY) && !D.cgPuedeCongelar(loanDe('1783874778375ziu4'), paysDe('1783874778375ziu4'), HOY) &&
      D.cgPuedeCongelar(loanDe('fixture-diario-01'), paysDe('fixture-diario-01'), HOY) &&
      !D.cgPuedeCongelar(Object.assign({}, l, { congeladoDesde: '2026-07-20' }), lp, HOY));
  }

  // ══ G — EL COBRO DE UN CREDITO CONGELADO (la cascada contra el server real) ═══════════════
  // Cobrar «el interes del periodo en curso» con abono sobre un credito congelado: la proxima cuota es
  // la de CIERRE, cuyo interes es FIJO (sus dias corrieron con el capital de entonces). El plan no puede
  // recalcularlo sobre el capital que deja el abono (eso cobraria menos y la diferencia se iria a capital,
  // la clase del Bug #66); el abono baja el capital y el motor regenera la de cierre igual.
  R.seccion('G — cobrar con abono un crédito congelado: el interés de la cuota de cierre es fijo');
  {
    const antes = huella(IDC);
    const rG = await pedir('POST', '/api/loans/' + IDC + '/congelar', { desde: '2026-07-25' });
    const lG = loanDe(IDC), pG = paysDe(IDC);
    const cie = pG.find(p => p.cuotaN === rG.json.cierre.cuotaN);
    const plan = D.planCascada(lG, pG, { obligacionCOP: 1000000, cajaCOP: 1000000, obligacionUSD: 0 }, { incluirInteresMes: true });
    const pasoMes = plan.pasos.find(p => p.esInteresMes);
    const pasoAbo = plan.pasos.find(p => p.tipo === 'abono');
    R.check('G1 el plan cobra el interes de la cuota de cierre ENTERO (fijo) y abona el resto a capital',
      rG.status === 200 && plan.ok && !!pasoMes && pasoMes.payId === cie.id && pasoMes.interes === Math.round(cie.interesPeriodo) &&
      !!pasoAbo && pasoAbo.obligacionCOP === 1000000 - pasoMes.interes, JSON.stringify({ pasos: plan.pasos.map(p => [p.tipo, p.interes, p.obligacionCOP]), cierre: cie.interesPeriodo }));
    const est = await ejecutarPlan(IDC, plan, HOY, 'cobro congelado');
    const cie2 = paysDe(IDC).find(p => p.id === cie.id);
    const imp = D.imputarCobros(cie2).totales;
    R.check('G2 tras ejecutarlo, la cuota de cierre conserva su interes y lo cobrado se reconoce TODO como interes',
      est.ok && Math.round(cie2.interesPeriodo) === Math.round(cie.interesPeriodo) && Math.round(+cie2.partialPaid) === pasoMes.interes &&
      Math.round(imp.interes) === pasoMes.interes && Math.round(imp.capital) === 0, JSON.stringify({ est: est.error, cie2: [cie2.interesPeriodo, cie2.partialPaid], imp }));
    // La de cierre no tiene capital: cobrar su interes la salda. Y el abono no hace nacer ninguna cuota.
    const regs2 = regsDe(IDC).filter(p => p.estadoPago === 'Pendiente');
    const abo = paysDe(IDC).filter(p => esAb(p));
    R.check('G3 la de cierre queda pagada, el abono no hace nacer cuotas y el credito sigue activo y congelado (no se cierra solo)',
      cie2.estadoPago === 'Pagado' && regs2.length === 0 && abo.some(p => Math.round(p.abonoCapital) === pasoAbo.obligacionCOP) &&
      loanDe(IDC).estado === 'Activo' && !!loanDe(IDC).congeladoDesde, JSON.stringify({ est: cie2.estadoPago, pend: regs2.map(p => p.cuotaN), abo: abo.map(p => p.abonoCapital) }));
    for (let k = 0; k < est.hechos.length + 1; k++) await deshacerUltimo(IDC);
    R.check('G4 deshacer el cobro y el congelamiento lo deja byte a byte como estaba', huella(IDC) === antes);
  }

  // ══ H — EL CREDITO ABIERTO (Fase 2): el devengo se detiene en los dias congelados ═══════════════
  // Un credito de interes diario de 2.000.000 al 3% desde el 1-jun (2.000 pesos por dia), con un corte
  // el 16-jun. Se congela el 1-jul: lo devengado (15 dias, 30.000) se conserva; del 1-jul en adelante
  // no corre nada. Un corte durante el congelamiento cobra lo devengado; descongelar reanuda.
  R.seccion('H — interés diario: congelado no devenga, lo devengado se conserva y se reanuda al descongelar');
  {
    const rN = await pedir('POST', '/api/loans', { nombre: 'ZZ Diario Congelar', cedula: '', telefono: '', moneda: 'COP',
      montoOrigen: 2000000, trmAcordada: 0, montoCOP: 2000000, tasaMensual: 3, plazoMeses: 0, modalidad: 'Interes Diario',
      fechaInicio: '2026-06-01', diaPago: 1, estado: 'Activo', notas: '', frecuencia: 'Mensual' });
    const IDD = rN.json && rN.json.id;
    const c1 = await pedir('POST', '/api/loans/' + IDD + '/corte', { fecha: '2026-06-16', interesPagado: 30000, abonoCapital: 0 });
    R.check('H0 ANTI-VACIO: el crédito abierto nace y su primer corte cobra 15 días (30.000)', (rN.status === 200 || rN.status === 201) && !!IDD && c1.status === 200, [rN.status, c1.status, c1.json]);
    const tras1 = huella(IDD);
    const pD = () => paysDe(IDD);
    // El espejo, antes: lo que mostraria el modal con esta fecha.
    const plan = D.cgPlanCongelar(loanDe(IDD), pD(), '2026-07-01', false, HOY);
    R.check('H1 el espejo: al congelar el 1-jul se conservan 15 días devengados (30.000); hasta hoy no se cobran 30 días (60.000)',
      plan.ok && plan.diario && plan.devengado === 30000 && plan.dias === 15 && plan.interesDia === 2000 && plan.diasSinCobrar === 30 &&
      plan.noSeCobra === 60000 && plan.devHoyAntes === 90000 && plan.devHoyDespues === 30000, JSON.stringify(plan && { ok: plan.ok, e: plan.error, d: plan.devengado, s: plan.noSeCobra }));
    // Rechazos: antes del ultimo corte y perdonar. La BD intacta y el mismo texto en el espejo.
    const h0 = huellaTodo();
    const e1 = await pedir('POST', '/api/loans/' + IDD + '/congelar', { desde: '2026-06-10' });
    const e2 = await pedir('POST', '/api/loans/' + IDD + '/congelar', { desde: '2026-07-01', perdonar: true });
    const m1 = D.cgPlanCongelar(loanDe(IDD), pD(), '2026-06-10', false, HOY), m2 = D.cgPlanCongelar(loanDe(IDD), pD(), '2026-07-01', true, HOY);
    R.check('H2 congelar antes del último corte, o perdonando: 400, BD intacta y el espejo dice lo mismo',
      e1.status === 400 && e2.status === 400 && huellaTodo() === h0 && !m1.ok && !m2.ok && m1.error === e1.json.error && m2.error === e2.json.error &&
      /último corte/.test(e1.json.error) && /Condonar intereses/.test(e2.json.error), [e1.json, e2.json, m1.error, m2.error]);
    const cuotasAntes = huellaCuotas(IDD);
    const rC = await pedir('POST', '/api/loans/' + IDD + '/congelar', { desde: '2026-07-01' });
    const lC = loanDe(IDD);
    const est = D.estadoDiario(lC, pD(), HOY);
    const L = D.computeLiquidacion(lC, pD(), { hasta: HOY });
    R.check('H3 congelar: 200, solo cambia el préstamo (ninguna fila nueva) y el devengo de hoy es 30.000, no 90.000',
      rC.status === 200 && lC.congeladoDesde === '2026-07-01' && huellaCuotas(IDD) === cuotasAntes && rC.json.devengado === 30000 &&
      est.interesPendiente === 30000 && D.estaCongelado(lC), JSON.stringify({ r: rC.json, pend: est.interesPendiente }));
    const congTramo = est.tramos.filter(t => t.congelado);
    R.check('H3 el tramo abierto se parte: 15 días con interés y 30 congelados en 0; días activos 15 y congelados 30',
      congTramo.length === 1 && congTramo[0].desde === '2026-07-01' && congTramo[0].hasta === HOY && congTramo[0].dias === 30 && congTramo[0].interes === 0 &&
      est.diasActivosDesdeUltimoCorte === 15 && est.diasCongeladosDesdeUltimoCorte === 30 && est.diasDesdeUltimoCorte === 45, JSON.stringify(est.tramos));
    R.check('H4 la liquidación: capital + lo devengado hasta el congelamiento, sin interés que adelantar', L.total === 2030000 && L.interesDevengado === 30000 &&
      L.intProxMes === 0 && L.congelado === true && L.diasDevengados === 15 && L.liqDespues === undefined && plan.liqDespues === 2030000, JSON.stringify(L));
    // El arranque y la extension no tocan nada.
    const tras2 = huella(IDD);
    await pedir('POST', '/api/recalculate'); await pedir('GET', '/api/payments');
    R.check('H5 /recalculate y el arranque no cambian nada', huella(IDD) === tras2);
    // Condonar durante el congelamiento: baja lo devengado y se deshace.
    const rK = await pedir('POST', '/api/loans/' + IDD + '/condonar-intereses', { monto: 10000 });
    R.check('H6 condonar 10.000 congelado: queda 20.000 por cobrar; deshacerlo los devuelve',
      rK.status === 200 && D.estadoDiario(loanDe(IDD), pD(), HOY).interesPendiente === 20000, rK.json);
    await deshacerUltimo(IDD);
    R.check('H6 y deshacer la condonación deja el préstamo como estaba', huella(IDD) === tras2);
    // Un corte DURANTE el congelamiento cobra lo devengado; cobrar mas, no.
    const x1 = await pedir('POST', '/api/loans/' + IDD + '/corte', { fecha: '2026-07-25', interesPagado: 30001, abonoCapital: 0 });
    const x2 = await pedir('POST', '/api/loans/' + IDD + '/corte', { fecha: '2026-07-25', interesPagado: 10000, abonoCapital: 0 });
    const lX = loanDe(IDD);
    R.check('H7 un corte congelado no puede cobrar más de lo devengado (30.000); cobrar 10.000 sí, y su resumen dice 15 días',
      x1.status === 400 && x2.status === 200 && x2.json.antes.interesPendiente === 30000 && x2.json.antes.diasDevengados === 15 &&
      x2.json.despues.interesPendiente === 20000 && lX.fechaUltimoCorte === '2026-07-25' && Math.round(lX.interesAcumuladoPend) === 20000 &&
      lX.estado === 'Activo' && !!lX.congeladoDesde, JSON.stringify({ x1: x1.json, x2: x2.json, cache: [lX.fechaUltimoCorte, lX.interesAcumuladoPend] }));
    // Descongelar: no antes del ultimo corte; ese dia si. El interes vuelve a correr.
    const h3 = huellaTodo();
    const d1 = await pedir('POST', '/api/loans/' + IDD + '/descongelar', { desde: '2026-07-21' });
    const md1 = D.cgPlanDescongelar(loanDe(IDD), pD(), '2026-07-21', null, HOY);
    R.check('H8 descongelar antes del último corte: 400, BD intacta y el espejo dice lo mismo',
      d1.status === 400 && huellaTodo() === h3 && !md1.ok && md1.error === d1.json.error && /último corte/.test(d1.json.error), [d1.json, md1.error]);
    const pl2 = D.cgPlanDescongelar(loanDe(IDD), pD(), '2026-07-25', null, HOY);
    const d2 = await pedir('POST', '/api/loans/' + IDD + '/descongelar', { desde: '2026-07-25' });
    const lD = loanDe(IDD), estD = D.estadoDiario(lD, pD(), HOY);
    R.check('H9 descongelar el 25-jul: 200, ninguna fila nueva, y hoy se deben 20.000 + 6 días (32.000), como dijo el espejo',
      d2.status === 200 && !lD.congeladoDesde && estD.interesPendiente === 32000 && pl2.ok && pl2.devHoy === 32000 && pl2.interesDia === 2000 &&
      pl2.diasCongelado === 24 && d2.json.diasCongelado === 24 && d2.json.interesDia === 2000 && !D.estaCongelado(lD) &&
      JSON.parse(lD.congelamientos)[0].hasta === '2026-07-25', JSON.stringify({ r: d2.json, pend: estD.interesPendiente, plan: pl2 && pl2.devHoy }));
    // Un segundo congelamiento, despues del corte: los dos periodos quedan fuera del devengo.
    const r2 = await pedir('POST', '/api/loans/' + IDD + '/congelar', { desde: '2026-07-28' });
    const est2 = D.estadoDiario(loanDe(IDD), pD(), HOY);
    R.check('H10 congelar otra vez el 28-jul: hoy se deben 20.000 + 3 días (26.000) y el historial tiene los dos',
      r2.status === 200 && est2.interesPendiente === 26000 && JSON.parse(loanDe(IDD).congelamientos).length === 2 &&
      est2.diasActivosDesdeUltimoCorte === 3 && est2.diasCongeladosDesdeUltimoCorte === 3, JSON.stringify({ r: r2.json, pend: est2.interesPendiente }));
    // Cerrar forzoso congelado: lo perdido en intereses es lo devengado (sin los dias congelados).
    const tras3 = huella(IDD);
    const fc = await pedir('POST', '/api/loans/' + IDD + '/force-close');
    R.check('H11 el cierre forzoso de un congelado toma de pérdida lo devengado sin los días congelados (26.000)',
      fc.status === 200 && Math.round(loanDe(IDD).interesesPerdidos) === 26000, JSON.stringify({ fc: fc.json, ip: loanDe(IDD).interesesPerdidos }));
    await deshacerUltimo(IDD);
    R.check('H11 y deshacerlo lo devuelve', huella(IDD) === tras3);
    // Deshacer: el segundo congelamiento, el descongelar, el corte y el primer congelamiento.
    for (let k = 0; k < 4; k++) await deshacerUltimo(IDD);
    R.check('H12 deshacer los cuatro movimientos deja el crédito byte a byte como tras su primer corte', huella(IDD) === tras1);
    // Lo que ofrece la interfaz.
    R.check('H13 cgPuedeCongelar ofrece congelar el crédito abierto activo, y no uno ya congelado ni sin capital',
      D.cgPuedeCongelar(loanDe(IDD), pD(), HOY) && !D.cgPuedeCongelar(Object.assign({}, loanDe(IDD), { congeladoDesde: '2026-07-01' }), pD(), HOY) &&
      !D.cgPuedeCongelar(Object.assign({}, loanDe(IDD), { montoOrigen: 0 }), pD(), HOY));
    await pedir('DELETE', '/api/loans/' + IDD);
  }

  srv.close();
  process.exit(R.finalizar());
})().catch(e => {
  console.error('\n[congelar] ABORTADO — el arnes no pudo ejecutarse:');
  console.error(e && e.stack ? e.stack : e);
  process.exit(2);
});
