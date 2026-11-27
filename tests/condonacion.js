// tests/condonacion.js — CONDONACION DE INTERESES contra el server REAL.
//
// El escenario que motiva el endpoint: "devuelveme el capital y te perdono los
// intereses". Antes de v2.9.0 no habia herramienta y los tres caminos disponibles
// mentian de formas distintas — el peor, `Liquidar`, FABRICA CAJA: registra como
// recibido el interes que se perdono. Esta suite fija que la via nueva no lo haga.
//
// Que se verifica, en orden de importancia:
//   1. CAJA CERO. Una condonacion no puede producir ni un evento de flujo. Es la
//      propiedad central: si la produjera, seria el mismo defecto que se vino a
//      corregir, solo que por otro camino.
//   2. La OBLIGACION baja y el CAPITAL no se toca (interes -> 0, cuotaTotal ->
//      capital), con la invariante `interes + capital == cuota` intacta.
//   3. El ESCENARIO COMPLETO: condonar -> cobrar el capital -> el credito cierra
//      como 'Finalizado' (no 'Cancelado'), con capital recuperado == prestado y la
//      caja registrada == exactamente lo que entro.
//   4. Los 4xx dejan la BD INTACTA (doctrina de atomicidad).
//   5. El undo restaura el interes condonado byte a byte.
//
// Se ejecuta:
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron tests/condonacion.js

const fs   = require('fs');
const vm   = require('vm');
const path = require('path');
const http = require('http');
const { Reporter }          = require('./lib/report');
const { copiaDeProduccion } = require('./lib/db');
const { REPO }              = require('./lib/paths');

const R = new Reporter('condonacion');
const PORT = 3974;   // NUNCA 3420 (la app real) ni 3971-3973 (cascada-cobro)

// ── Modulos reales del frontend que hacen falta para medir ───────────────────
// `cobrosDe` es la fuente de verdad del flujo de caja en TODA la app (KPI, grafico,
// transacciones y panel del deudor). Se carga el REAL en vez de replicarlo: si el
// helper cambiara, la propiedad 1 tiene que seguir midiendo lo que la app muestra.
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
  aplanar(path.join(REPO, 'public', 'js', 'core', 'cascada.js'), vistos, orden);
  const sb = { console };
  sb.globalThis = sb;
  const ctx = vm.createContext(sb);
  vm.runInContext(orden.join('\n'), ctx);
  return vm.runInContext('({cobrosDe,imputarCobros,saldoConCaja,planCascada,cobrableTotal,planCondonacion,estadoDiario,computeLiquidacion,esCondonada})', ctx);
}

function pedir(method, ruta, body) {
  return new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: ruta, method,
      headers: Object.assign({ 'Content-Type': 'application/json' },
        data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
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

(async function main() {
  const { cobrosDe, saldoConCaja, planCascada, cobrableTotal, planCondonacion, estadoDiario, computeLiquidacion, esCondonada } = cargarDominio();
  R.check('los helpers reales del frontend se cargaron',
    typeof cobrosDe === 'function' && typeof saldoConCaja === 'function' && typeof planCascada === 'function');

  const DB = copiaDeProduccion('condonacion');
  const app = require(path.join(REPO, 'backend', 'server.js'))(DB);
  const srv = http.createServer(app);
  await new Promise(ok => srv.listen(PORT, '127.0.0.1', ok));

  const Database = require(path.join(REPO, 'node_modules', 'better-sqlite3'));
  const conDb = fn => { const d = new Database(DB, { readonly: true }); try { return fn(d); } finally { d.close(); } };
  const cargar = () => ({
    loans: conDb(d => d.prepare('SELECT * FROM loans').all()),
    pays:  conDb(d => d.prepare('SELECT * FROM payments').all()),
  });
  const esAbono = p => p.id.indexOf('-ab-') !== -1;
  // La fecha LOCAL, la misma de `hoyStr` del backend. Con `toISOString` (UTC) la suite fallaba cada
  // noche desde las 19:00 hora de Colombia: el backend ya devengaba un dia menos que el que la prueba
  // esperaba (hallado el 2026-11-26 a las 20:26).
  const _h = new Date();
  const hoy = _h.getFullYear() + '-' + String(_h.getMonth() + 1).padStart(2, '0') + '-' + String(_h.getDate()).padStart(2, '0');
  await pedir('GET', '/api/payments');   // auto-mora, como en la app real

  // Caja TOTAL de un prestamo segun `cobrosDe` (la misma que ve el usuario).
  const cajaDe = (pays, loanId) => pays.filter(p => p.prestamoId === loanId)
    .reduce((s, p) => s + cobrosDe(p).reduce((a, e) => a + e.cop, 0), 0);
  const moraDe = (pays, loanId) => pays.filter(p =>
    p.prestamoId === loanId && p.estadoPago === 'En Mora' && !esAbono(p));
  const origDe = l => l.moneda === 'USD'
    ? Math.round(l.montoOrigen * l.trmAcordada) : Math.round(l.montoOrigen);

  // ── A — MODALIDAD INTERESES: la mora es puro interes ──────────────────────
  R.seccion('A — Intereses: condonar apaga la mora entera y no mueve un peso de caja');
  let loanA = null;
  {
    const { loans, pays } = cargar();
    loanA = loans.filter(l => l.estado === 'Activo' && l.modalidad === 'Intereses')
                 .filter(l => moraDe(pays, l.id).length > 0)[0];
    R.check('A ANTI-VACIO: hay un credito Intereses con mora', !!loanA, loanA ? loanA.id : 'NINGUNO');
    if (loanA) {
      const moraAntes = moraDe(pays, loanA.id);
      const intAntes  = Math.round(moraAntes.reduce((s, p) => s + p.interesPeriodo, 0));
      const cajaAntes = cajaDe(pays, loanA.id);
      const saldoAntes = saldoConCaja(loanA, pays.filter(p => p.prestamoId === loanA.id));
      R.check('A ANTI-VACIO: hay intereses en mora que condonar', intAntes > 0,
        moraAntes.length + ' cuotas, $' + intAntes);

      const r = await pedir('POST', '/api/loans/' + loanA.id + '/condonar-intereses', {});
      R.eq('A el endpoint acepta la condonacion', r.status, 200);
      R.eq('A informa exactamente el interes condonado', Math.round(r.json.condonado || 0), intAntes);

      const post = cargar();
      const lPost = post.loans.find(l => l.id === loanA.id);
      const lpPost = post.pays.filter(p => p.prestamoId === loanA.id);
      const tocadas = lpPost.filter(p => moraAntes.some(m => m.id === p.id));

      R.eq('A el interes de esas cuotas quedo en 0',
        tocadas.filter(p => Math.round(p.interesPeriodo) !== 0).length, 0);
      R.eq('A su cuotaTotal bajo al capital (que en Intereses es 0)',
        tocadas.filter(p => Math.round(p.cuotaTotal) !== Math.round(p.abonoCapital)).length, 0);
      R.eq('A sin nada que cobrar, su estado terminal es Pagado',
        tocadas.filter(p => p.estadoPago !== 'Pagado').length, 0);
      R.eq('A ya no queda ninguna cuota En Mora', moraDe(post.pays, loanA.id).length, 0);

      // ── LA PROPIEDAD CENTRAL ──
      R.eq('A CAJA CERO: la condonacion no produjo ningun evento de flujo',
        cajaDe(post.pays, loanA.id), cajaAntes);
      R.eq('A ninguna cuota condonada emite evento de caja',
        tocadas.reduce((s, p) => s + cobrosDe(p).length, 0), 0);

      R.eq('A el capital no se movio',
        saldoConCaja(lPost, lpPost), saldoAntes);
      R.eq('A se acumulo en interesesCondonados', Math.round(lPost.interesesCondonados || 0), intAntes);
      R.check('A el credito sigue Activo: el capital todavia se debe',
        lPost.estado === 'Activo' || saldoAntes === 0,
        'estado=' + lPost.estado + ' saldo=' + saldoAntes);
    }
  }

  // ── B — EL ESCENARIO COMPLETO: condonar y cobrar el capital ───────────────
  R.seccion('B — escenario completo: tras condonar, el capital cierra el credito como Finalizado');
  {
    if (loanA) {
      const { loans, pays } = cargar();
      const l = loans.find(x => x.id === loanA.id);
      const lp = pays.filter(p => p.prestamoId === l.id);
      const capitalPend = saldoConCaja(l, lp);
      const cajaAntes = cajaDe(pays, l.id);
      R.check('B ANTI-VACIO: queda capital por cobrar', capitalPend > 0, '$' + capitalPend);

      if (capitalPend > 0) {
        // Se cobra por la via NORMAL — el cobro en cascada —, que es justo lo que
        // hace valiosa a la Opcion C: despues de condonar no hace falta nada especial.
        const plan = planCascada(l, pays, { obligacionCOP: capitalPend, cajaCOP: capitalPend, obligacionUSD: 0 });
        R.check('B el plan es un unico abono (ya no hay mora que cobrar)',
          plan.ok && plan.pasos.length === 1 && plan.pasos[0].tipo === 'abono',
          (plan.error || '') + ' | ' + plan.pasos.map(p => p.tipo).join(' -> '));

        for (const paso of plan.pasos) {
          const rr = await pedir('POST', '/api/loans/' + l.id + '/abono', {
            monto: paso.obligacionCOP, fecha: hoy, observaciones: 'test condonacion',
            montoUSD: 0, montoCOPRecibido: paso.cajaCOP, liquidar: false,
            recalcMode: 'mantener', recalcValor: null, intExtra: 0 });
          R.eq('B el cobro del capital se aplico', rr.status, 200);
        }

        const post = cargar();
        const lPost = post.loans.find(x => x.id === l.id);
        const lpPost = post.pays.filter(p => p.prestamoId === l.id);

        R.eq('B el credito quedo FINALIZADO (no Cancelado, que seria "perdida total")',
          lPost.estado, 'Finalizado');
        R.eq('B no queda saldo de capital', saldoConCaja(lPost, lpPost), 0);
        const capRecuperado = Math.round(lpPost.filter(p => p.estadoPago === 'Pagado')
          .reduce((s, p) => s + p.abonoCapital, 0));
        R.eq('B el capital recuperado es EXACTAMENTE el prestado', capRecuperado, origDe(lPost));
        // El corazon del escenario: `Liquidar` habria declarado tambien el interes.
        R.eq('B la caja registrada es exactamente el capital que entro',
          cajaDe(post.pays, l.id) - cajaAntes, capitalPend);
      }
    }
  }

  // ── C — CAPITAL + INTERESES: el capital de la mora SIGUE debiendose ───────
  R.seccion('C — Capital + Intereses: se perdona el interes, el capital sigue vivo');
  {
    const { loans, pays } = cargar();
    const l = loans.filter(x => x.estado === 'Activo' && x.modalidad === 'Capital + Intereses')
                   .filter(x => moraDe(pays, x.id).some(p => p.abonoCapital > 0))[0];
    R.check('C ANTI-VACIO: hay un C+I con capital dentro de la mora', !!l, l ? l.id : 'NINGUNO');
    if (l) {
      const moraAntes = moraDe(pays, l.id);
      const intAntes  = Math.round(moraAntes.reduce((s, p) => s + p.interesPeriodo, 0));
      const capMora   = Math.round(moraAntes.reduce((s, p) => s + p.abonoCapital, 0));
      const cajaAntes = cajaDe(pays, l.id);
      const saldoAntes = saldoConCaja(l, pays.filter(p => p.prestamoId === l.id));

      const r = await pedir('POST', '/api/loans/' + l.id + '/condonar-intereses', {});
      R.eq('C el endpoint acepta la condonacion', r.status, 200);
      R.eq('C informa el interes condonado', Math.round(r.json.condonado || 0), intAntes);
      R.eq('C informa el capital que sigue en mora', Math.round(r.json.capitalEnMora || 0), capMora);

      const post = cargar();
      const lpPost = post.pays.filter(p => p.prestamoId === l.id);
      const tocadas = lpPost.filter(p => moraAntes.some(m => m.id === p.id));

      R.eq('C el interes quedo en 0', tocadas.filter(p => Math.round(p.interesPeriodo) !== 0).length, 0);
      R.eq('C la cuota ahora vale exactamente su capital',
        tocadas.filter(p => Math.round(p.cuotaTotal) !== Math.round(p.abonoCapital)).length, 0);
      R.check('C las cuotas con capital SIGUEN En Mora (el capital no se perdona)',
        tocadas.filter(p => p.abonoCapital > 0).every(p => p.estadoPago === 'En Mora'),
        tocadas.map(p => '#' + p.cuotaN + ':' + p.estadoPago).join(' '));
      R.eq('C CAJA CERO tambien aqui', cajaDe(post.pays, l.id), cajaAntes);
      // El saldo del MOTOR (origCOP - capital de las Pagadas) es el que gobierna las
      // DECISIONES: techo del abono y valor de liquidacion. `saldoConCaja` no sirve para
      // vigilar esto — imputa por `partialPaid`, asi que marcar Pagado una cuota sin
      // dinero encima lo deja igual mientras el motor SI da el capital por recuperado.
      // Verificado inyectando esa regresion: `saldoConCaja` seguia en verde.
      const motorAntes = origDe(l) - Math.round(pays.filter(p => p.prestamoId === l.id &&
        p.estadoPago === 'Pagado').reduce((s, p) => s + p.abonoCapital, 0));
      const motorPost = origDe(l) - Math.round(lpPost.filter(p => p.estadoPago === 'Pagado')
        .reduce((s, p) => s + p.abonoCapital, 0));
      R.eq('C el saldo del MOTOR tampoco se movio (el capital no se da por recuperado)',
        motorPost, motorAntes);
      R.eq('C el saldo de capital no se movio',
        saldoConCaja(post.loans.find(x => x.id === l.id), lpPost), saldoAntes);
      // La invariante se mide sobre las filas QUE LA CONDONACION ESCRIBIO. Medirla sobre
      // todo el credito daria rojo por datos legacy: el fixture arrastra 7 filas Pagadas
      // con +-1 peso, residuo del Bug #43 anterior a la aritmetica de enteros de v2.2.0.
      // Ese ruido no lo introduce este endpoint y taparlo con una tolerancia esconderia
      // justo lo que si hay que vigilar, asi que ademas se comprueba que el CONJUNTO de
      // filas rotas no crecio.
      R.eq('C invariante interes + capital == cuota en las filas condonadas',
        tocadas.filter(p => Math.round(p.interesPeriodo) + Math.round(p.abonoCapital) !== Math.round(p.cuotaTotal)).length, 0);
      const rotasAntes = pays.filter(p => p.prestamoId === l.id && !esAbono(p) &&
        Math.round(p.interesPeriodo) + Math.round(p.abonoCapital) !== Math.round(p.cuotaTotal)).map(p => p.id).sort();
      const rotasPost = lpPost.filter(p => !esAbono(p) &&
        Math.round(p.interesPeriodo) + Math.round(p.abonoCapital) !== Math.round(p.cuotaTotal)).map(p => p.id).sort();
      R.eq('C la condonacion no rompio la invariante en ninguna fila nueva', rotasPost, rotasAntes);

      // La cascada ahora ve solo capital: es el efecto que hace cobrable el acuerdo.
      const cob = cobrableTotal(post.loans.find(x => x.id === l.id), post.pays);
      R.eq('C lo que queda por cobrar de la mora es solo el capital', Math.round(cob.mora), capMora);
    }
  }

  // ── D — SELECCION POR CUOTA ───────────────────────────────────────────────
  R.seccion('D — se puede condonar solo algunas cuotas vencidas');
  {
    const { loans, pays } = cargar();
    const l = loans.filter(x => x.estado === 'Activo' &&
                 ['Intereses', 'Capital + Intereses'].indexOf(x.modalidad) !== -1)
               .filter(x => moraDe(pays, x.id).filter(p => p.interesPeriodo > 0).length >= 2)[0];
    R.check('D ANTI-VACIO: hay un credito con 2+ cuotas vencidas con interes', !!l, l ? l.id : 'NINGUNO');
    if (l) {
      const mora = moraDe(pays, l.id).filter(p => p.interesPeriodo > 0);
      const elegida = mora[0];
      const intactas = mora.slice(1);
      const r = await pedir('POST', '/api/loans/' + l.id + '/condonar-intereses', { cuotas: [elegida.id] });
      R.eq('D el endpoint acepta la seleccion parcial', r.status, 200);
      R.eq('D condona solo el interes de la cuota elegida',
        Math.round(r.json.condonado || 0), Math.round(elegida.interesPeriodo));

      const post = cargar().pays.filter(p => p.prestamoId === l.id);
      R.eq('D la cuota elegida quedo sin interes',
        Math.round(post.find(p => p.id === elegida.id).interesPeriodo), 0);
      R.eq('D las NO elegidas conservan su interes intacto',
        intactas.filter(m => Math.round(post.find(p => p.id === m.id).interesPeriodo) !== Math.round(m.interesPeriodo)).length, 0);
    }
  }

  // ── E — RECHAZOS: 4xx con la BD INTACTA ───────────────────────────────────
  R.seccion('E — los rechazos dejan la base de datos intacta');
  {
    const antes = cargar();
    const huella = JSON.stringify(antes.pays.map(p => [p.id, p.interesPeriodo, p.cuotaTotal, p.estadoPago]));

    const r404 = await pedir('POST', '/api/loans/no-existe/condonar-intereses', {});
    R.eq('E id inexistente -> 404', r404.status, 404);

    const prestamo = antes.loans.filter(l => l.estado === 'Activo' && l.modalidad === 'Prestamo')[0];
    if (prestamo) {
      const r = await pedir('POST', '/api/loans/' + prestamo.id + '/condonar-intereses', {});
      R.eq('E modalidad Prestamo (0%) -> 4xx', Math.floor(r.status / 100), 4);
      R.check('E y lo explica: no genera intereses', /0%|intereses/i.test(r.json.error || ''), r.json.error);
    }
    const pagoUnico = antes.loans.filter(l => l.estado === 'Activo' && l.modalidad === 'Pago Unico')[0];
    if (pagoUnico) {
      const r = await pedir('POST', '/api/loans/' + pagoUnico.id + '/condonar-intereses', {});
      R.eq('E modalidad Pago Unico -> 4xx', Math.floor(r.status / 100), 4);
    }
    const finalizado = antes.loans.filter(l => l.estado !== 'Activo')[0];
    if (finalizado) {
      const r = await pedir('POST', '/api/loans/' + finalizado.id + '/condonar-intereses', {});
      R.eq('E credito no activo -> 4xx', Math.floor(r.status / 100), 4);
    }
    const sinMora = antes.loans.filter(l => l.estado === 'Activo' &&
        ['Intereses', 'Capital + Intereses'].indexOf(l.modalidad) !== -1 &&
        moraDe(antes.pays, l.id).length === 0)[0];
    if (sinMora) {
      const r = await pedir('POST', '/api/loans/' + sinMora.id + '/condonar-intereses', {});
      R.eq('E sin cuotas en mora -> 4xx', Math.floor(r.status / 100), 4);
    }
    // Id de cuota ajeno: no puede colarse aunque el cliente lo mande.
    const conMora = antes.loans.filter(l => l.estado === 'Activo' &&
        ['Intereses', 'Capital + Intereses'].indexOf(l.modalidad) !== -1 &&
        moraDe(antes.pays, l.id).length > 0)[0];
    if (conMora) {
      const r = await pedir('POST', '/api/loans/' + conMora.id + '/condonar-intereses',
        { cuotas: ['cuota-inventada-999'] });
      R.eq('E id de cuota ajeno -> 4xx', Math.floor(r.status / 100), 4);
      R.check('E y nombra la cuota rechazada', /cuota-inventada-999/.test(r.json.error || ''), r.json.error);
    }

    const despues = cargar();
    R.eq('E ANTI-REGRESION: ningun rechazo escribio en la BD',
      JSON.stringify(despues.pays.map(p => [p.id, p.interesPeriodo, p.cuotaTotal, p.estadoPago])), huella);
  }

  // ── F — UNDO: la condonacion es reversible ────────────────────────────────
  R.seccion('F — deshacer restaura el interes condonado');
  {
    const { loans, pays } = cargar();
    const l = loans.filter(x => x.estado === 'Activo' &&
                 ['Intereses', 'Capital + Intereses'].indexOf(x.modalidad) !== -1)
               .filter(x => moraDe(pays, x.id).filter(p => p.interesPeriodo > 0).length > 0)[0];
    R.check('F ANTI-VACIO: queda un credito con interes en mora para revertir', !!l, l ? l.id : 'NINGUNO');
    if (l) {
      const antes = JSON.stringify(cargar().pays.filter(p => p.prestamoId === l.id)
        .map(p => [p.id, p.interesPeriodo, p.cuotaTotal, p.estadoPago, p.fechaRecaudo]).sort());
      const r = await pedir('POST', '/api/loans/' + l.id + '/condonar-intereses', {});
      R.eq('F la condonacion se aplico', r.status, 200);
      R.check('F devuelve el undoId del journal', !!r.json.undoId, JSON.stringify(r.json.undoId));

      const entradas = await pedir('GET', '/api/undo?scopeTipo=loan&scopeId=' + l.id);
      const head = (entradas.json || []).filter(e => e.estado === 'disponible')[0];
      R.eq('F la condonacion es el head LIFO de ese credito', head && head.accion, 'condonacion');
      R.eq('F se marca como que NO afecta caja (sin falsa alarma de recibo)',
        head && head.afecta_caja, 0);

      const und = await pedir('POST', '/api/undo/' + r.json.undoId, {});
      R.eq('F el undo se acepta', und.status, 200);
      const despues = JSON.stringify(cargar().pays.filter(p => p.prestamoId === l.id)
        .map(p => [p.id, p.interesPeriodo, p.cuotaTotal, p.estadoPago, p.fechaRecaudo]).sort());
      R.eq('F el cronograma volvio EXACTAMENTE a su estado previo', despues, antes);
      R.eq('F interesesCondonados volvio a su valor previo',
        Math.round(cargar().loans.find(x => x.id === l.id).interesesCondonados || 0),
        Math.round(l.interesesCondonados || 0));
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // post-4.1.5 — CONDONAR ESCRIBIENDO UN MONTO (aprobado por el PO sobre un prototipo)
  // ════════════════════════════════════════════════════════════════════════════
  // Copia y servidor PROPIOS: las secciones A-F ya condonaron la mora de varios creditos, y estas
  // necesitan cuotas vencidas intactas. El caso es el credito de solo intereses del fixture con
  // cuotas de $300.000 (el de un recibo real del PO, anonimizado).
  const DB2 = copiaDeProduccion('condonacion-monto');
  const app2 = require(path.join(REPO, 'backend', 'server.js'))(DB2);
  const srv2 = http.createServer(app2);
  const PORT2 = 3980;
  await new Promise(ok => srv2.listen(PORT2, '127.0.0.1', ok));
  const pedir2 = (method, ruta, body) => new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : null;
    const rq = http.request({ host: '127.0.0.1', port: PORT2, path: ruta, method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, data ? { 'Content-Length': Buffer.byteLength(data) } : {}) }, x => {
      let b = ''; x.on('data', c => b += c);
      x.on('end', () => { let j = null; try { j = JSON.parse(b || '{}'); } catch (_) {} res({ status: x.statusCode, json: j }); });
    });
    rq.on('error', rej); if (data) rq.write(data); rq.end();
  });
  const conDb2 = fn => { const d = new Database(DB2, { readonly: true }); try { return fn(d); } finally { d.close(); } };
  const cargar2 = () => ({ loans: conDb2(d => d.prepare('SELECT * FROM loans').all()), pays: conDb2(d => d.prepare('SELECT * FROM payments').all()) });
  await pedir2('GET', '/api/payments');   // auto-mora, como en la app real

  // ── G — EL MONTO: de la cuota mas vieja a la mas nueva; la ultima, en parte ──
  R.seccion('G — condonar escribiendo un monto: se reparte de la cuota más vieja a la más nueva');
  {
    const { loans, pays } = cargar2();
    const l = loans.filter(x => x.estado === 'Activo' && x.modalidad === 'Intereses')
      .find(x => moraDe(pays, x.id).filter(p => p.interesPeriodo > 0 && !(p.partialPaid > 0)).length >= 4);
    R.check('G ANTI-VACIO: un credito de solo intereses con 4+ cuotas vencidas', !!l, l ? l.id : 'NINGUNO');
    if (l) {
      const mora = moraDe(pays, l.id).sort((a, b) => a.fechaPago.localeCompare(b.fechaPago));
      const i0 = Math.round(mora[0].interesPeriodo), i1 = Math.round(mora[1].interesPeriodo), i2 = Math.round(mora[2].interesPeriodo);
      const monto = i0 + i1 + Math.floor(i2 / 3);              // dos cuotas enteras y un tercio de la tercera
      const plan = planCondonacion(mora, monto);
      const cajaAntes = cajaDe(pays, l.id);
      const liqAntes = computeLiquidacion(l, pays.filter(p => p.prestamoId === l.id), {}).total;

      const r = await pedir2('POST', '/api/loans/' + l.id + '/condonar-intereses', { monto });
      R.eq('G1 el endpoint acepta el monto', r.status, 200);
      R.eq('G1 y condona exactamente lo escrito', Math.round(r.json.condonado), monto);
      R.eq('G2 PARIDAD: el backend reparte igual que el modal (planCondonacion), cuota por cuota',
        (r.json.cuotas || []).map(c => [c.id, c.condonado]), plan.filas.filter(f => f.condonar > 0).map(f => [f.p.id, f.condonar]));

      const post = cargar2();
      const fila = id => post.pays.find(p => p.id === id);
      const lPost = post.loans.find(x => x.id === l.id);
      R.check('G3 las dos mas viejas quedan saldadas sin dinero: estado Pagado, rotulo «Condonada»',
        [mora[0], mora[1]].every(m => { const f = fila(m.id); return f.estadoPago === 'Pagado' && Math.round(f.cuotaTotal) === 0 && Math.round(f.interesCondonado) === Math.round(m.interesPeriodo) && esCondonada(f) && !f.fechaRecaudo; }),
        [mora[0], mora[1]].map(m => fila(m.id)));
      const f2 = fila(mora[2].id);
      R.check('G4 la tercera queda condonada EN PARTE: sigue En Mora por lo que falta y guarda lo condonado',
        f2.estadoPago === 'En Mora' && Math.round(f2.interesPeriodo) === i2 - Math.floor(i2 / 3) && Math.round(f2.cuotaTotal) === i2 - Math.floor(i2 / 3) &&
        Math.round(f2.interesCondonado) === Math.floor(i2 / 3) && !esCondonada(f2) && /de \$/.test(f2.observaciones || ''), f2);
      R.check('G5 las demas vencidas no se tocan', mora.slice(3).every(m => { const f = fila(m.id); return f.estadoPago === 'En Mora' && Math.round(f.cuotaTotal) === Math.round(m.cuotaTotal) && !(f.interesCondonado > 0); }));
      R.eq('G6 loans.interesesCondonados acumula lo escrito', Math.round(lPost.interesesCondonados || 0), Math.round(l.interesesCondonados || 0) + monto);
      R.eq('G6 CAJA CERO: no entra ni sale dinero', cajaDe(post.pays, l.id), cajaAntes);
      R.eq('G6 "Debes hoy" baja exactamente lo condonado',
        computeLiquidacion(lPost, post.pays.filter(p => p.prestamoId === l.id), {}).total, liqAntes - monto);
      const hist = conDb2(d => d.prepare("SELECT mensaje FROM activity_log WHERE tipo = 'condonacion' ORDER BY rowid DESC LIMIT 1").get());
      R.check('G7 el Historial dice cuantas completas y cuanto de la que quedo en parte',
        !!hist && /2 cuotas vencidas y \$[\d.]+ de la cuota #\d+ \(queda debiendo \$[\d.]+\)/.test(hist.mensaje), hist && hist.mensaje);

      // Montos invalidos: 4xx con la BD intacta.
      const huella = JSON.stringify(cargar2().pays.filter(p => p.prestamoId === l.id).map(p => [p.id, p.cuotaTotal, p.estadoPago, p.interesCondonado]));
      const total = planCondonacion(moraDe(cargar2().pays, l.id), null).total;
      const rMas = await pedir2('POST', '/api/loans/' + l.id + '/condonar-intereses', { monto: total + 1 });
      R.check('G8 un monto mayor que lo condonable se rechaza y dice cuanto hay', rMas.status === 400 && /solo tienen \$/.test(rMas.json.error || ''), rMas.json);
      const rCero = await pedir2('POST', '/api/loans/' + l.id + '/condonar-intereses', { monto: 0 });
      R.check('G8 un monto en cero se rechaza', rCero.status === 400 && /mayor que cero/.test(rCero.json.error || ''), rCero.json);
      R.eq('G8 ANTI-REGRESION: los rechazos no escribieron nada', JSON.stringify(cargar2().pays.filter(p => p.prestamoId === l.id).map(p => [p.id, p.cuotaTotal, p.estadoPago, p.interesCondonado])), huella);

      // Deshacer: todo vuelve, tambien lo condonado de cada cuota.
      const und = await pedir2('POST', '/api/undo/' + r.json.undoId, {});
      R.eq('G9 el deshacer se acepta', und.status, 200);
      const back = cargar2();
      R.check('G9 deshacer devuelve las cuotas y su interesCondonado a 0',
        mora.every(m => { const f = back.pays.find(p => p.id === m.id); return f.estadoPago === 'En Mora' && Math.round(f.cuotaTotal) === Math.round(m.cuotaTotal) && !(f.interesCondonado > 0); }));
      R.eq('G9 y loans.interesesCondonados', Math.round(back.loans.find(x => x.id === l.id).interesesCondonados || 0), Math.round(l.interesesCondonados || 0));
    }
  }

  // ── H — UNA CUOTA CON UN ABONO A MEDIAS: se condona solo lo que falta ──
  R.seccion('H — una cuota con abono: solo se condona lo que falta, y su dinero se conserva');
  {
    const { loans, pays } = cargar2();
    const l = loans.filter(x => x.estado === 'Activo' && x.modalidad === 'Intereses')
      .find(x => moraDe(pays, x.id).filter(p => p.interesPeriodo > 0 && !(p.partialPaid > 0)).length >= 1);
    if (l) {
      const c = moraDe(pays, l.id).sort((a, b) => a.fechaPago.localeCompare(b.fechaPago)).find(p => !(p.partialPaid > 0));
      const abono = Math.round(c.cuotaTotal / 3);
      const rp = await pedir2('POST', '/api/payments/' + c.id + '/partial', { monto: abono, fecha: hoy, observaciones: '' });
      R.eq('H ANTI-VACIO: el abono a medias se registro', rp.status, 200);
      const cajaAntes = cajaDe(cargar2().pays, l.id);
      const max = Math.round(c.cuotaTotal) - abono;
      const rMas = await pedir2('POST', '/api/loans/' + l.id + '/condonar-intereses', { cuotas: [c.id], monto: max + 1 });
      R.check('H1 condonar mas de lo que falta se rechaza (antes la cuota entera se rechazaba)', rMas.status === 400, rMas.json);
      const r = await pedir2('POST', '/api/loans/' + l.id + '/condonar-intereses', { cuotas: [c.id], monto: max });
      R.eq('H2 condonar lo que falta se acepta', r.status, 200);
      const f = cargar2().pays.find(p => p.id === c.id);
      R.check('H2 la cuota queda saldada por el abono + lo condonado, sin rotulo «Condonada» (si entro dinero)',
        f.estadoPago === 'Pagado' && Math.round(f.cuotaTotal) === abono && Math.round(f.interesCondonado) === max && !esCondonada(f), f);
      R.check('H3 el dinero del abono se conserva: su evento de caja sigue', cobrosDe(f).reduce((s, e) => s + e.cop, 0) === abono && cajaDe(cargar2().pays, l.id) === cajaAntes,
        { recibos: f.recibos, caja: cajaDe(cargar2().pays, l.id), antes: cajaAntes });
    } else R.check('H ANTI-VACIO: un credito de solo intereses con una cuota vencida', false);
  }

  // ── I — EL CREDITO ABIERTO: la condonacion SE SOSTIENE (antes reaparecia al instante) ──
  R.seccion('I — interés diario: lo condonado sale del devengo y no se puede condonar dos veces');
  {
    const { loans, pays } = cargar2();
    const l = loans.find(x => x.estado === 'Activo' && x.modalidad === 'Interes Diario');
    R.check('I ANTI-VACIO: un credito abierto activo', !!l, l ? l.id : 'NINGUNO');
    if (l) {
      const lp = () => cargar2().pays.filter(p => p.prestamoId === l.id);
      const pend0 = Math.round(estadoDiario(l, pays.filter(p => p.prestamoId === l.id), hoy).interesPendiente);
      R.check('I ANTI-VACIO: tiene interes devengado', pend0 > 0, pend0);
      const mitad = Math.floor(pend0 / 2);
      const r1 = await pedir2('POST', '/api/loans/' + l.id + '/condonar-intereses', { monto: mitad });
      R.check('I1 condona una parte del devengo', r1.status === 200 && Math.round(r1.json.condonado) === mitad && Math.round(r1.json.quedaDebiendo) === pend0 - mitad, r1.json);
      const l1 = cargar2().loans.find(x => x.id === l.id);
      R.eq('I2 SE SOSTIENE: el devengo pendiente bajo exactamente lo condonado', Math.round(estadoDiario(l1, lp(), hoy).interesPendiente), pend0 - mitad);
      R.eq('I2 la fecha del ultimo corte no se mueve (no hubo corte)', l1.fechaUltimoCorte, l.fechaUltimoCorte);
      const r2 = await pedir2('POST', '/api/loans/' + l.id + '/condonar-intereses', {});
      R.eq('I3 condonar el resto deja el devengo en cero', Math.round(r2.json.condonado), pend0 - mitad);
      const l2 = cargar2().loans.find(x => x.id === l.id);
      R.eq('I3 pendiente 0 tras condonar todo', Math.round(estadoDiario(l2, lp(), hoy).interesPendiente), 0);
      const r3 = await pedir2('POST', '/api/loans/' + l.id + '/condonar-intereses', {});
      R.check('I4 ya no se puede condonar otra vez (antes si: se contaba dos veces)', r3.status === 400, r3.json);
      R.eq('I4 interesesCondonados = lo devengado, una sola vez', Math.round(l2.interesesCondonados || 0), Math.round(l.interesesCondonados || 0) + pend0);
      R.eq('I5 "Debes hoy" del credito abierto = su capital', computeLiquidacion(l2, lp(), {}).total, Math.round(estadoDiario(l2, lp(), hoy).capitalVivo));
    }
  }

  // ── J — LA MIGRACION: las condonaciones de antes de la columna se reconstruyen de su marca ──
  R.seccion('J — migración: la marca en las observaciones llena interesCondonado (una vez)');
  {
    const c = cargar2().pays.find(p => p.estadoPago === 'En Mora' && p.id.indexOf('-ab-') === -1 && !(p.interesCondonado > 0));
    if (c) {
      const d = new Database(DB2);
      d.prepare('UPDATE payments SET observaciones = ?, interesCondonado = 0 WHERE id = ?').run('Algo previo | Intereses condonados: $123.456 (2026-10-01)', c.id);
      d.close();
      require(path.join(REPO, 'backend', 'server.js'))(DB2);   // el arranque aplica el esquema
      R.eq('J1 la marca vieja se convierte en interesCondonado', Math.round(cargar2().pays.find(p => p.id === c.id).interesCondonado), 123456);
      require(path.join(REPO, 'backend', 'server.js'))(DB2);
      R.eq('J2 idempotente: un segundo arranque no suma otra vez', Math.round(cargar2().pays.find(p => p.id === c.id).interesCondonado), 123456);
    } else R.check('J ANTI-VACIO: una cuota En Mora para marcar', false);
  }
  srv2.close();

  srv.close();
  process.exit(R.finalizar());
})().catch(e => {
  console.error('\n[condonacion] ABORTADO — el arnes no pudo ejecutarse:');
  console.error(e && e.stack ? e.stack : e);
  process.exit(2);
});
