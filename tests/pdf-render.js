// tests/pdf-render.js — BASELINE DE REGRESION DE LOS GENERADORES DE PDF.
//
// Que hace: ejecuta los generadores REALES de `public/js/pdf/` (via cargarFrontend,
// que los evalua en un contexto `vm`) alimentados con datos REALES de una COPIA de la BD
// de produccion, captura el HTML que emiten por `window.electronAPI.printPDF` y comprueba
// que la ESTRUCTURA del documento no cambio.
//
// Que NO hace: no valida correccion financiera (de eso se ocupa props-dominio.js). Aca la
// pregunta es "¿el refactor movio el documento sin que nos enteremos?".
//
// Como se ejecuta:
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron tests/pdf-render.js
//
// ── Tres decisiones de diseno que conviene entender antes de tocar este archivo ──────────
//
// 1. RELOJ CONGELADO. Los 5 generadores leen `new Date()` (fecha de emision, dias de
//    atraso, hero de la factura). Sin congelarlo, la huella cambiaria sola cada dia y el
//    golden master seria inservible. Se sustituye el `Date` del sandbox por una subclase
//    que devuelve un instante fijo cuando se construye sin argumentos. `new Date(iso)`
//    sigue funcionando igual.
//
// 2. EL GOLDEN NO GUARDA DATOS DE PRODUCCION. El repo es PUBLICO. Los importes y el
//    nombre de archivo (que lleva el nombre del deudor) se guardan como DIGESTO sha1, no
//    en claro; las etiquetas de seccion se normalizan reemplazando digitos por '#'. Lo que
//    queda en `tests/golden/` son literales del codigo y conteos, nunca plata ni personas.
//
// 3. LA BD DE PRODUCCION SE MUEVE. Si el usuario cobra una cuota, la huella de VALORES
//    cambia legitimamente. Por eso el golden guarda ademas un hash de la ENTRADA:
//      - entrada igual  -> se comparan estructura Y valores (comparacion fuerte);
//      - entrada distinta -> se compara solo la estructura (que es codigo, no datos) y los
//        valores se re-establecen, avisando en pantalla. Asi el paso del tiempo no produce
//        rojos falsos, pero un cambio de estructura sigue saltando.
//    Independiente del golden, cada caso se genera DOS VECES y se exige huella identica:
//    ese aserto vale aunque el golden se acabe de crear.
//
// ── Tres reglas que hacen que el golden no se pueda "ganar" borrandolo ────────────────────
// (agregadas tras la verificacion adversarial; cada una cierra un verde falso REPRODUCIDO)
//
// A. NUNCA se re-establece una linea base cuya comparacion acaba de FALLAR. Antes, la rama
//    de datos-cambiados reescribia el archivo con la huella NUEVA aunque la estructura
//    hubiera fallado: el fallo se reportaba una vez y la corrida siguiente salia verde con la
//    regresion ya absorbida. Verificado: renombrar una cabecera del cronograma daba rojo en
//    la 1a corrida y verde en la 2a.
//
// B. CREAR una linea base es un ACTO EXPLICITO (`PDF_GOLDEN_INIT=1`). Sin eso, un golden que
//    falta o esta corrupto es un FALLO, no un aviso: antes, `rm tests/golden/*` era la forma
//    mas rapida de poner la suite en verde (21 casos "creados", 0 comparados, exit 0).
//    Las lineas base SI se commitean —el comentario original afirmaba lo contrario, pero los
//    ficheros `pdf-*.json` estan trackeados—, de modo que un clone limpio compara desde la
//    primera corrida en vez de auto-establecerse en vacio. Al agregar un caso hay que crear
//    su linea base con PDF_GOLDEN_INIT=1 y commitearla junto al caso.
//
// C. La huella incluye un DIGESTO DEL TEXTO COMPLETO del documento. La extraccion por lista
//    de clases (`CLASES_ETIQUETA`) es un allowlist: todo lo que no este en la lista solo
//    estaba cubierto por el conteo de bytes. Verificado: cambiar el texto de un badge
//    ("Pagado" -> "PAGADO") o del hero de la factura por otro del MISMO largo pasaba con
//    246/246 OK.

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const LIB = path.join(__dirname, 'lib');
const { Reporter }        = require(path.join(LIB, 'report'));
const { copiaDeProduccion } = require(path.join(LIB, 'db'));
const { cargarFrontend }  = require(path.join(LIB, 'load-frontend'));
const { REPO }            = require(path.join(LIB, 'paths'));

const GOLDEN = path.join(__dirname, 'golden');
const R = new Reporter('pdf-render');

// Establecer lineas base tiene que ser un acto deliberado (regla B de la cabecera).
const INIT_GOLDEN = process.env.PDF_GOLDEN_INIT === '1';
const COMO_INICIAR =
  'Para establecer la linea base a proposito:\n' +
  '  PDF_GOLDEN_INIT=1 ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron tests/pdf-render.js';

// Salida dura para las condiciones que invalidan la suite entera. PROHIBIDO EL VERDE EN
// VACIO: si no se pudo afirmar nada, esto sale con codigo != 0 y dice por que.
function abortar(motivo) {
  console.log('\n########################################################################');
  console.log('ABORTADO — la suite no pudo afirmar nada:');
  console.log(String(motivo).split('\n').map(l => '  ' + l).join('\n'));
  console.log('########################################################################');
  process.exit(2);
}

// ── Carga de datos reales (COPIA de la BD; nunca la productiva) ──────────────────────────

let loans, pays, config;
try {
  const Database = require(path.join(REPO, 'node_modules', 'better-sqlite3'));
  const ruta = copiaDeProduccion('pdf-render');
  const db = new Database(ruta, { readonly: true });
  loans  = db.prepare('SELECT * FROM loans').all();
  pays   = db.prepare('SELECT * FROM payments').all();
  config = {};
  for (const r of db.prepare('SELECT * FROM config').all()) config[r.key] = r.value;
  db.close();
} catch (e) {
  abortar('No se pudo abrir la copia de la BD de produccion.\n' +
          'Recorda que better-sqlite3 esta compilado para el ABI de Electron:\n' +
          '  ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron tests/pdf-render.js\n' +
          (e && e.stack ? e.stack : e));
}
if (!loans || !loans.length || !pays || !pays.length) {
  abortar(`La BD copiada no trae datos (loans=${loans && loans.length}, payments=${pays && pays.length}).`);
}

// ── Carga del frontend real + reloj congelado ────────────────────────────────────────────

let FE;
try { FE = cargarFrontend({ silenciarConsola: true }); }
catch (e) { abortar('cargarFrontend() fallo:\n' + (e && e.stack ? e.stack : e)); }

const S   = FE.simbolos;
const CAP = FE.captura;

const GENERADORES = ['generateCronogramaPDF', 'generateReportePrestamosPDF',
                     'generateRecibo', 'generateFacturaCobro', 'generateReciboAbono',
                     'generateEstadoLiquidacion', 'generateReciboCobro',
                     'generatePropuestaAbono', 'generateReciboGeneral'];
const faltantes = GENERADORES.filter(n => typeof S[n] !== 'function');
if (faltantes.length) {
  abortar('El frontend no expone estos generadores como funciones top-level: ' + faltantes.join(', ') +
          '\nSi el refactor los movio a un modulo, hay que actualizar tests/lib/load-frontend.js.');
}

// Reloj de referencia del arnes. Fijo a proposito (ver nota 1 de la cabecera).
const RelojReal = Date;
const INSTANTE_FIJO = new RelojReal(2026, 6, 31, 12, 0, 0);   // 31-jul-2026 12:00 local
class DateCongelado extends RelojReal {
  constructor(...args) { if (args.length === 0) super(INSTANTE_FIJO.getTime()); else super(...args); }
  static now() { return INSTANTE_FIJO.getTime(); }
}
FE.sandbox.Date = DateCongelado;

// generateRecibo / generateFacturaCobro / generateReciboAbono NO reciben el tema por
// parametro: lo leen de `document.documentElement`. Los otros dos si lo reciben.
function ponerTema(t) { FE.sandbox.document.documentElement.setAttribute('data-theme', t); }

// ── Datos de los casos ───────────────────────────────────────────────────────────────────

const L = id => loans.find(x => x.id === id);
const cuota = (loanId, n, arr) => (arr || pays).find(p => p.prestamoId === loanId && p.cuotaN === n);

// Un PAGO PARCIAL EN VUELO (partialPaid > 0 sobre una cuota que sigue Pendiente) es el caso
// que el sprint v2.3.0 acaba de arreglar y el que mas facil se rompe en un refactor. Hoy la
// BD de produccion no tiene ninguno vivo (las 32 filas con partialPaid > 0 ya estan Pagadas),
// asi que se inyecta sobre una cuota REAL, en memoria y sobre una copia profunda del array:
// la BD no se toca y los demas casos no se contaminan.
const paysParcial = JSON.parse(JSON.stringify(pays));
const LOAN_PARCIAL = '17795544041379obc';                       // Nicolas Duarte, C+I COP
const cuotaParcial = cuota(LOAN_PARCIAL, 3, paysParcial);
if (!cuotaParcial) {
  abortar(`No se encontro la cuota 3 del prestamo ${LOAN_PARCIAL} para inyectar el parcial en vuelo.\n` +
          'Los datos de produccion cambiaron: elegi otra cuota Pendiente de un Capital + Intereses.');
}
cuotaParcial.partialPaid      = 300000;                         // interes del periodo: 209.459
cuotaParcial.montoCOPRecibido = 300000;                         // -> 90.541 imputados a capital
cuotaParcial.recibos          = '[{"fecha":"2026-07-28","cop":300000}]';

// Un parcial sobre una cuota PENDIENTE no alcanza: el Reporte de Activos descuenta lo abonado
// con helpers PROPIOS (`saldoMora` / `saldoMoraUSD`, Bugs #42 y #45) que solo corren sobre las
// sub-filas de cuotas EN MORA. Sin un parcial ahi, esa rama no se ejercita y una regresion que
// vuelva a cobrarle al deudor lo que ya pago pasa desapercibida (verificado: neutralizar
// `saldoMora` daba 246/246 OK). Se inyectan dos, para cubrir las dos monedas:
//   - COP: Ana Restrepo, modalidad Intereses (cuota de puro interes).
//   - USD: Elena Vargas, Capital + Intereses, con `montoUSDRecibido` para que `saldoMoraUSD` mida
//     dolares contra dolares en vez de reconvertir los COP (doctrina del Bug #23).
const moraParcialCOP = cuota('1773655076017', 4, paysParcial);
const moraParcialUSD = cuota('1782151590658w66y', 2, paysParcial);
if (!moraParcialCOP || !moraParcialUSD) {
  abortar('No se encontraron las cuotas En Mora sobre las que se inyecta el parcial\n' +
          '(1773655076017-4 en COP, 1782151590658w66y-2 en USD). Los datos de produccion\n' +
          'cambiaron: elegi otras dos cuotas En Mora, una COP y una USD.');
}
moraParcialCOP.partialPaid      = 120000;                       // cuota 300.000 -> faltan 180.000
moraParcialCOP.montoCOPRecibido = 120000;
moraParcialCOP.recibos          = '[{"fecha":"2026-07-26","cop":120000}]';

moraParcialUSD.partialPaid      = 700000;                       // cuota 1.472.407 COP / USD 400
moraParcialUSD.montoCOPRecibido = 700000;
moraParcialUSD.montoUSDRecibido = 190;                          // -> saldoMoraUSD = 400 - 190
moraParcialUSD.recibos          = '[{"fecha":"2026-07-27","cop":700000}]';

// Replica de `_snapshotAbono` (funcion interna de App, no accesible desde aca). Devuelve el
// estado PREVIO al abono, que es lo que el recibo imprime como "Saldo anterior".
function snapshotPrevio(loan, arrPays, monto) {
  const lp = arrPays.filter(p => p.prestamoId === loan.id);
  const esUSD = loan.moneda === 'USD', trm = loan.trmAcordada || 1;
  const orig = esUSD ? Math.round(loan.montoOrigen * trm) : Math.round(loan.montoOrigen);
  const capPag = lp.filter(p => p.estadoPago === 'Pagado').reduce((s, p) => s + p.abonoCapital, 0);
  const pend = lp.filter(p => p.id.indexOf('-ab-') === -1 && p.estadoPago === 'Pendiente')
                 .sort((a, b) => a.cuotaN - b.cuotaN);
  return {
    saldo:     Math.max(0, orig - capPag) + monto,
    saldoCaja: S.saldoConCaja(loan, lp) + monto,
    cuota:     pend.length ? pend[0].cuotaTotal : 0,
    cuotas:    pend.length,
    intereses: pend.reduce((s, p) => s + p.interesPeriodo, 0),
    plazo:     loan.plazoMeses,
  };
}

// Arma el `opts` de una LIQUIDACION: el Paz y Salvo que sale tras confirmar "Liquidar deuda".
// Lo que lo separa de un abono normal son `liquidar:true` y `pre.liq` — el MISMO objeto de
// `computeLiquidacion` que `LiquidarModal` tenia en pantalla al cobrar. Sin el, el generador
// solo recibe `monto` (= capital pendiente) y titula con eso, callando los intereses de mora
// que el deudor SI pago. El `intExtra` va aparte porque es una decision del momento del cobro
// (el checkbox del mes en curso), no un dato del estado previo.
function optsLiquidacion(loan, arrPays, intExtra) {
  const liq = S.computeLiquidacion(loan, arrPays, {});
  return {
    monto: liq.capitalPendiente, fecha: '2026-07-31', liquidar: true, intExtra: intExtra || 0,
    pre: Object.assign(snapshotPrevio(loan, arrPays, liq.capitalPendiente), { liq }),
  };
}

// El prestamo tal como lo recibe el generador DESPUES del POST: la ruta `liquidar` deja
// `estado='Finalizado'`, y es eso lo que dispara la variante Paz y Salvo.
const finalizado = loan => Object.assign({}, loan, { estado: 'Finalizado' });

// Arma el argumento `cobro` del Recibo de Cobro usando el planificador REAL. Se cobra toda
// la mora mas una parte del capital amortizable, que es el caso que obliga al documento a
// explicar los dos tipos de movimiento. En USD la caja se aparta a proposito de la
// obligacion (TRM del dia por debajo de la pactada) para que el recibo declare ambas.
// Variante del anterior con el override `incluirInteresMes` activo. Existe porque el
// documento cambia de forma: aparece un paso "por adelantado" y un rubro propio, y el
// recibo NO debe llamar "vencida" a una cuota que aun no vence. En la prueba real que
// destapo el defecto, un cobro del 3 de sept declaraba atrasada una cuota del 19.
function cobroConInteresMes(loan, arrPays) {
  const esUSD = loan.moneda === 'USD';
  const cob = S.cobrableTotal(loan, arrPays);
  if (!(cob.interesMes > 0)) {
    abortar('cobroConInteresMes(' + loan.id + '): el credito no tiene interes del mes por cobrar. ' +
            'Sin eso este caso no ejercita nada: elegi otro prestamo.');
  }
  const objetivo = Math.round(cob.mora + cob.interesMes + Math.max(100000, cob.abonable * 0.2));
  const plan = S.planCascada(loan, arrPays, esUSD
    ? { obligacionUSD: Math.round(objetivo / loan.trmAcordada * 100) / 100,
        cajaCOP: Math.round(objetivo * 0.96), obligacionCOP: 0 }
    : { obligacionCOP: objetivo, cajaCOP: objetivo, obligacionUSD: 0 },
    { incluirInteresMes: true });
  if (!plan.ok || !plan.pasos.some(p => p.esInteresMes)) {
    abortar('cobroConInteresMes(' + loan.id + '): el plan no incluyo el paso del interes del mes (' +
            (plan.error || 'sin error') + ').');
  }
  const lp = arrPays.filter(p => p.prestamoId === loan.id);
  const pend = lp.filter(p => p.id.indexOf('-ab-') === -1 && p.estadoPago === 'Pendiente')
                 .sort((a, b) => a.cuotaN - b.cuotaN);
  return {
    fecha: '2026-07-20', pasos: plan.pasos, observaciones: 'Cobro con interes del mes',
    pre: { saldoCaja: S.saldoConCaja(loan, lp), cuota: pend.length ? pend[0].cuotaTotal : 0 },
  };
}

// La Propuesta de Abono necesita, ademas del plan, la PROYECCION que el modal dibuja:
// el preview del cronograma y el total por pagar. Se arma con los mismos helpers
// (`previewRecalculo`, `filasPreview`, `proyeccionCobro`), que es lo que el modal usa.
function propuestaDe(loan, arrPays) {
  const cob = S.cobrableTotal(loan, arrPays);
  const esUSD = loan.moneda === 'USD';
  const objetivo = Math.round(cob.mora + Math.max(100000, cob.abonable * 0.3));
  const plan = S.planCascada(loan, arrPays, esUSD
    ? { obligacionUSD: Math.round(objetivo / loan.trmAcordada * 100) / 100,
        cajaCOP: Math.round(objetivo * 0.97), obligacionCOP: 0 }
    : { obligacionCOP: objetivo, cajaCOP: objetivo, obligacionUSD: 0 }, {});
  if (!plan.ok || !plan.pasos.some(p => p.tipo === 'abono')) {
    abortar('propuestaDe(' + loan.id + '): el plan no produjo abono (' + (plan.error || 'sin error') +
            '). Sin abono no hay cronograma proyectado y el caso no probaria nada.');
  }
  const lp = arrPays.filter(p => p.prestamoId === loan.id);
  const pend = lp.filter(p => p.id.indexOf('-ab-') === -1 && p.estadoPago === 'Pendiente')
                 .sort((a, b) => a.cuotaN - b.cuotaN);
  const nAct = Math.max(0, (+loan.plazoMeses || 0) - plan.ctx.regularConsumed);
  const r = S._tasaPeriodo((+loan.tasaMensual || 0) / 100, loan.frecuencia || 'Mensual');
  const pv = S.previewRecalculo(plan.saldoTrasCascada, r, nAct, 'mantener', null);
  const filas = S.filasPreview(plan.saldoTrasCascada, r, pv.nCuotas, false, pv.cuota);
  filas.forEach((f, i) => { f.cuotaN = plan.ctx.regularConsumed + 1 + i;
                            f.fecha = pend[i] ? pend[i].fechaPago : null; });
  const proy = S.proyeccionCobro(loan, arrPays, plan, filas, pend);
  return {
    fecha: '2026-07-20', plan,
    cajaCOP: esUSD ? Math.round(objetivo * 0.97) : objetivo,
    proyeccion: { filas, n: pv.nCuotas, saldado: false,
                  totalAntes: proy.totalAntes, totalDespues: proy.totalDespues,
                  abonadoProxima: proy.abonadoProxima,
                  cuotaAntes: pend.length ? Math.round(pend[0].cuotaTotal) : 0 },
  };
}

// Variante con el interes del mes adelantado: es la UNICA forma de que la cuota proyectada
// quede con dinero encima, que es lo que dispara la sub-linea de la tabla. Sin este caso, esa
// rama no la ejercitaba nadie (verificado: la suite quedaba verde con la sub-linea intacta).
function propuestaConInteresMes(loan, arrPays, modo, valor) {
  const cob = S.cobrableTotal(loan, arrPays);
  if (!(cob.interesMes > 0 && cob.abonable > 0)) {
    abortar('propuestaConInteresMes(' + loan.id + '): el credito no tiene interes del mes y ' +
            'capital amortizable a la vez. Sin las dos cosas no hay abono NI sub-linea.');
  }
  const esUSD = loan.moneda === 'USD';
  const objetivo = Math.round(cob.mora + cob.interesMes + Math.max(100000, cob.abonable * 0.25));
  const plan = S.planCascada(loan, arrPays, esUSD
    ? { obligacionUSD: Math.round(objetivo / loan.trmAcordada * 100) / 100,
        cajaCOP: Math.round(objetivo * 0.97), obligacionCOP: 0 }
    : { obligacionCOP: objetivo, cajaCOP: objetivo, obligacionUSD: 0 },
    { incluirInteresMes: true });
  if (!plan.ok || !plan.pasos.some(p => p.esInteresMes) || !plan.pasos.some(p => p.tipo === 'abono')) {
    abortar('propuestaConInteresMes(' + loan.id + '): el plan necesita el paso del interes del ' +
            'mes Y un abono (' + (plan.error || 'sin error') + ').');
  }
  const lp = arrPays.filter(p => p.prestamoId === loan.id);
  const pend = lp.filter(p => p.id.indexOf('-ab-') === -1 && p.estadoPago === 'Pendiente')
                 .sort((a, b) => a.cuotaN - b.cuotaN);
  const nAct = Math.max(0, (+loan.plazoMeses || 0) - plan.ctx.regularConsumed);
  const r = S._tasaPeriodo((+loan.tasaMensual || 0) / 100, loan.frecuencia || 'Mensual');
  const pv = S.previewRecalculo(plan.saldoTrasCascada, r, nAct, modo || 'mantener',
                                (modo === 'modificarPlazo' || modo === 'fijarCuota') ? valor : null);
  const filas = S.filasPreview(plan.saldoTrasCascada, r, pv.nCuotas, false, pv.cuota);
  filas.forEach((f, i) => { f.cuotaN = plan.ctx.regularConsumed + 1 + i;
                            f.fecha = pend[i] ? pend[i].fechaPago : null; });
  const proy = S.proyeccionCobro(loan, arrPays, plan, filas, pend);
  if (!(Math.round(proy.abonadoProxima || 0) > 0)) {
    abortar('propuestaConInteresMes(' + loan.id + '): la proxima cuota no quedo con abono ' +
            'encima, que es justo lo que este caso viene a fijar.');
  }
  return {
    fecha: '2026-07-20', plan,
    cajaCOP: esUSD ? Math.round(objetivo * 0.97) : objetivo,
    proyeccion: { filas, n: pv.nCuotas, saldado: false,
                  totalAntes: proy.totalAntes, totalDespues: proy.totalDespues,
                  abonadoProxima: proy.abonadoProxima, moraTras: proy.moraTras,
                  cuotaAntes: pend.length ? Math.round(pend[0].cuotaTotal) : 0 },
  };
}

function cobroDe(loan, arrPays) {
  const esUSD = loan.moneda === 'USD';
  const cob = S.cobrableTotal(loan, arrPays);
  const objetivo = Math.round(cob.mora + Math.min(cob.abonable, Math.max(100000, cob.abonable * 0.2)));
  const plan = S.planCascada(loan, arrPays, esUSD
    ? { obligacionUSD: Math.round(objetivo / loan.trmAcordada * 100) / 100,
        cajaCOP: Math.round(objetivo * 0.96), obligacionCOP: 0 }
    : { obligacionCOP: objetivo, cajaCOP: objetivo, obligacionUSD: 0 });
  if (!plan.ok || !plan.pasos.length) {
    abortar('cobroDe(' + loan.id + '): planCascada no produjo pasos (' + (plan.error || 'sin error') + '). ' +
            'Los datos del fixture cambiaron: elegi otro prestamo para el caso del Recibo de Cobro.');
  }
  const lp = arrPays.filter(p => p.prestamoId === loan.id);
  const pend = lp.filter(p => p.id.indexOf('-ab-') === -1 && p.estadoPago === 'Pendiente')
                 .sort((a, b) => a.cuotaN - b.cuotaN);
  return {
    fecha: '2026-07-20', pasos: plan.pasos, observaciones: 'Cobro de prueba',
    pre: { saldoCaja: S.saldoConCaja(loan, lp), cuota: pend.length ? pend[0].cuotaTotal : 0 },
  };
}

// ── Definicion de los casos ──────────────────────────────────────────────────────────────
//
// `celdas`: cuantas celdas debe tener CADA <tr> del documento (contando colspan).
//           null = el documento no lleva tablas y no debe haber ningun <tr>.
// `contiene`: literales que DEBEN aparecer. Son la prueba de que el caso ejercito de verdad
//           la rama que dice ejercitar (un caso "USD" que no imprime dolares no cubre nada).

// Estado para el caso HERO: UNA sola cuota viva con un parcial encima que ya cubrio su
// interes. Se construye sobre una copia profunda (la BD y los demas casos no se tocan)
// marcando como Pagadas todas las cuotas regulares menos la ultima.
const LOAN_HERO = '1782151590658w66y';
const paysHero = JSON.parse(JSON.stringify(pays));
(function () {
  const reg = paysHero.filter(p => p.prestamoId === LOAN_HERO && p.id.indexOf('-ab-') === -1)
                      .sort((a, b) => a.cuotaN - b.cuotaN);
  if (reg.length < 2) {
    abortar(`El prestamo ${LOAN_HERO} ya no tiene 2+ cuotas regulares para armar el caso HERO.`);
  }
  const ultima = reg[reg.length - 1];
  reg.slice(0, -1).forEach(p => {
    p.estadoPago = 'Pagado';
    p.partialPaid = p.cuotaTotal;
    p.fechaRecaudo = p.fechaPago;
    p.montoCOPRecibido = p.cuotaTotal;
    p.recibos = JSON.stringify([{ fecha: p.fechaPago, cop: Math.round(p.cuotaTotal) }]);
  });
  // El parcial tiene que SUPERAR el interes del periodo: por debajo, `imputarCobros` no
  // llega a capital, el saldo no se mueve y la identidad que dispara el hero no se cumple.
  const abono = Math.round(ultima.interesPeriodo * 1.4);
  ultima.estadoPago = 'Pendiente';
  ultima.partialPaid = abono;
  ultima.montoCOPRecibido = abono;
  ultima.fechaRecaudo = null;
  ultima.recibos = JSON.stringify([{ fecha: '2026-07-28', cop: abono }]);
})();

const CASOS = [
  // ── generateCronogramaPDF — 4 modalidades, COP y USD, mora, abono, parcial ────────────
  { nombre: 'crono-capint-cop-abono', gen: 'generateCronogramaPDF', tema: 'light', celdas: 7,
    entrada: () => ({ loanId: '1776205975507jkph', tema: 'light', dark: false }),
    ejecutar: () => S.generateCronogramaPDF(L('1776205975507jkph'), pays, false),
    contiene: ['badge-abono', 'ABONOS', 'Capital + Intereses', 'Valor de liquidación'],
    // Sin la opcion (3.1.0) el pie sigue siendo el de siempre: ni el interes del mes ni una
    // fecha de vigencia. Si alguno aparece, la opcion se filtro al camino por defecto.
    noContiene: ['interés del mes en curso', 'Válido hasta', 'Valor calculado al'] },

  { nombre: 'crono-capint-usd-mora', gen: 'generateCronogramaPDF', tema: 'dark', celdas: 7,
    entrada: () => ({ loanId: '1782151590658w66y', tema: 'dark', dark: true }),
    ejecutar: () => S.generateCronogramaPDF(L('1782151590658w66y'), pays, true),
    contiene: ['badge-mora', 'USD $', '#0d1117'] },

  { nombre: 'crono-intereses-cop-mora', gen: 'generateCronogramaPDF', tema: 'light', celdas: 7,
    entrada: () => ({ loanId: '1773655076017', tema: 'light', dark: false }),
    ejecutar: () => S.generateCronogramaPDF(L('1773655076017'), pays, false),
    contiene: ['INTERESES PAGADOS', 'plazo indefinido'] },

  { nombre: 'crono-prestamo-cop', gen: 'generateCronogramaPDF', tema: 'light', celdas: 7,
    entrada: () => ({ loanId: '1782442889816wjhf', tema: 'light', dark: false }),
    ejecutar: () => S.generateCronogramaPDF(L('1782442889816wjhf'), pays, false),
    contiene: ['>Préstamo sin interés</span>'] },

  { nombre: 'crono-pagounico-usd', gen: 'generateCronogramaPDF', tema: 'dark', celdas: 7,
    entrada: () => ({ loanId: '1784667444678qsmr', tema: 'dark', dark: true }),
    ejecutar: () => S.generateCronogramaPDF(L('1784667444678qsmr'), pays, true),
    contiene: ['ganancia pactada', 'Pago único'] },

  { nombre: 'crono-capint-cop-parcial', gen: 'generateCronogramaPDF', tema: 'light', celdas: 7,
    entrada: () => ({ loanId: LOAN_PARCIAL, parcial: true, tema: 'light', dark: false }),
    ejecutar: () => S.generateCronogramaPDF(L(LOAN_PARCIAL), paysParcial, false),
    contiene: ['badge-parcial', 'Abonado'] },

  // ── 3.1.0 — el valor de liquidacion con el interes del mes en curso ──────────────────
  // La misma decision que la casilla de Liquidar deuda, tomada en CronogramaPdfModal. Las
  // cifras van literales: capital 2.885.494 + interes del mes 215.177 = 3.100.671, valido
  // hasta la proxima cuota (14-ago, sale de las filas guardadas). Es el aserto que se pone
  // rojo si la opcion deja de viajar hasta `computeLiquidacion`.
  { nombre: 'crono-capint-cop-con-mes', gen: 'generateCronogramaPDF', tema: 'light', celdas: 7,
    entrada: () => ({ loanId: '1776205975507jkph', tema: 'light', dark: false, incluyeProxMes: true }),
    ejecutar: () => S.generateCronogramaPDF(L('1776205975507jkph'), pays, false, { incluyeProxMes: true }),
    contiene: ['Valor de liquidación', 'interés del mes en curso', '215.177', '3.100.671',
               'Válido hasta el 14 de ago de 2026'],
    noContiene: ['Valor calculado al'] },

  // El mismo pie en dolares y en oscuro, sobre un credito CON mora: la linea del interes se
  // suma DETRAS de la mora, y la vigencia es la de su propia proxima cuota (19-ago).
  { nombre: 'crono-capint-usd-con-mes', gen: 'generateCronogramaPDF', tema: 'dark', celdas: 7,
    entrada: () => ({ loanId: '1782151590658w66y', tema: 'dark', dark: true, incluyeProxMes: true }),
    ejecutar: () => S.generateCronogramaPDF(L('1782151590658w66y'), pays, true, { incluyeProxMes: true }),
    contiene: ['+ mora ', 'interés del mes en curso', 'USD $', 'Válido hasta el 19 de ago de 2026', '#0d1117'] },

  // ── generateReportePrestamosPDF — cartera completa, ambos temas ───────────────────────
  { nombre: 'reporte-activos-claro', gen: 'generateReportePrestamosPDF', tema: 'light', celdas: 8,
    entrada: () => ({ todos: true, tema: 'light', dark: false }),
    ejecutar: () => S.generateReportePrestamosPDF(loans, pays, false),
    contiene: ['Capital total en la calle', 'Referencia de estados', 'mora-sub'] },

  // Este caso es el unico que ejercita `saldoMora`/`saldoMoraUSD`: los parciales inyectados
  // sobre cuotas EN MORA hacen que las sub-filas rojas anoten "abonado X de Y" y que tanto el
  // total vencido como su equivalente en dolares descuenten lo ya recibido.
  { nombre: 'reporte-activos-oscuro-parcial', gen: 'generateReportePrestamosPDF', tema: 'dark', celdas: 8,
    entrada: () => ({ todos: true, parcial: true, tema: 'dark', dark: true }),
    ejecutar: () => S.generateReportePrestamosPDF(loans, paysParcial, true),
    contiene: ['Capital total en la calle', '#0d1117', 'abonado ', ' + USD $', 'pesos y dólares por separado'],
    noContiene: ['Incluye'] },

  // ── generateRecibo — pago completo, parcial y USD ─────────────────────────────────────
  // Se cobra una cuota PENDIENTE, no una ya Pagada: el recibo se emite ANTES de persistir
  // (por eso `allPays` es el estado previo y la imputacion parte de lo que la cuota debia).
  // Sobre una cuota ya saldada, `pendienteDeCuota` da 0 y las filas de interes y capital
  // se suprimen — util como caso limite, pero no representa el flujo real.
  { nombre: 'recibo-pago-completo-cop', gen: 'generateRecibo', tema: 'light', celdas: null,
    entrada: () => ({ loanId: '1776205975507jkph', cuotaN: 4, cop: 393610, usd: 0, tema: 'light' }),
    ejecutar: () => S.generateRecibo(cuota('1776205975507jkph', 4), L('1776205975507jkph'),
                                     393610, 0, pays, { fechaRecaudo: '2026-08-14' }),
    contiene: ['Recibo de Pago', 'Abono a capital', 'Intereses', 'pago puntual'] },

  { nombre: 'recibo-parcial-cop', gen: 'generateRecibo', tema: 'light', celdas: null,
    entrada: () => ({ loanId: LOAN_PARCIAL, cuotaN: 3, cop: 100000, previo: 300000, parcial: true, tema: 'light' }),
    ejecutar: () => S.generateRecibo(cuota(LOAN_PARCIAL, 3, paysParcial), L(LOAN_PARCIAL),
                                     100000, 0, paysParcial,
                                     { fechaRecaudo: '2026-07-31', yaAbonadoPrev: 300000 }),
    contiene: ['Recibo de Abono Parcial', 'Restante por pagar', 'Abonado previamente'] },

  // Cuota USD En Mora cobrada con MENOS pesos de los proyectados (TRM del dia por debajo de
  // la pactada): los dolares cubren la cuota, asi que NO es un pago parcial (doctrina del
  // Bug #23). Es el escenario bimonetario que mas facil se rompe.
  { nombre: 'recibo-usd-oscuro', gen: 'generateRecibo', tema: 'dark', celdas: null,
    entrada: () => ({ loanId: '1782151590658w66y', cuotaN: 2, cop: 1272258, usd: 400, tema: 'dark' }),
    ejecutar: () => S.generateRecibo(cuota('1782151590658w66y', 2), L('1782151590658w66y'),
                                     1272258, 400, pays, { fechaRecaudo: '2026-07-31' }),
    contiene: ['USD $400.00', 'Pago completo', 'Intereses', 'Abono a capital', '--r-bg:#000000'] },

  // ── generateFacturaCobro — mora / hoy / proximo, USD, transitoria y parcial ───────────
  { nombre: 'factura-mora-cop', gen: 'generateFacturaCobro', tema: 'light', celdas: null,
    entrada: () => ({ loanId: '1773655076017', cuotaN: 4, tema: 'light' }),
    ejecutar: () => S.generateFacturaCobro(cuota('1773655076017', 4), L('1773655076017'),
                                           pays, config.datos_pago, {}),
    contiene: ['Aviso de mora', 'Cómo pagar', 'FC-'] },

  { nombre: 'factura-usd-mora', gen: 'generateFacturaCobro', tema: 'dark', celdas: null,
    entrada: () => ({ loanId: '1782151590658w66y', cuotaN: 2, tema: 'dark' }),
    ejecutar: () => S.generateFacturaCobro(cuota('1782151590658w66y', 2), L('1782151590658w66y'),
                                           pays, config.datos_pago, {}),
    contiene: ['Aviso de mora', 'USD $', '--r-bg:#000000'] },

  { nombre: 'factura-hoy-pagounico', gen: 'generateFacturaCobro', tema: 'light', celdas: null,
    entrada: () => ({ loanId: '1783874778375ziu4', cuotaN: 1, tema: 'light' }),
    ejecutar: () => S.generateFacturaCobro(cuota('1783874778375ziu4', 1), L('1783874778375ziu4'),
                                           pays, config.datos_pago, {}),
    contiene: ['Recordatorio', 'HOY'] },

  { nombre: 'factura-transitoria-proxima', gen: 'generateFacturaCobro', tema: 'light', celdas: null,
    entrada: () => ({ loanId: '1782872189716p6cz', cuotaN: 1, tema: 'light' }),
    ejecutar: () => S.generateFacturaCobro(cuota('1782872189716p6cz', 1), L('1782872189716p6cz'),
                                           pays, config.datos_pago, {}),
    contiene: ['Aviso de próximo vencimiento', 'Cuota Transitoria', 'Interés prorrateado'] },

  { nombre: 'factura-parcial-cop', gen: 'generateFacturaCobro', tema: 'light', celdas: null,
    entrada: () => ({ loanId: LOAN_PARCIAL, cuotaN: 3, parcial: true, tema: 'light' }),
    ejecutar: () => S.generateFacturaCobro(cuota(LOAN_PARCIAL, 3, paysParcial), L(LOAN_PARCIAL),
                                           paysParcial, config.datos_pago, {}),
    contiene: ['Desglose de lo que falta', 'Ya abonaste', 'Total pendiente'] },

  // ── generateReciboAbono — variantes completa / corta / paz y salvo ────────────────────
  { nombre: 'abono-capint-cop-mantener', gen: 'generateReciboAbono', tema: 'light', celdas: 6,
    entrada: () => ({ loanId: '1776205975507jkph', monto: 560000, mode: 'mantener', tema: 'light' }),
    ejecutar: () => S.generateReciboAbono(L('1776205975507jkph'), pays, {
      monto: 560000, fecha: '2026-07-18', recalcMode: 'mantener',
      pre: snapshotPrevio(L('1776205975507jkph'), pays, 560000) }),
    contiene: ['Impacto del abono', 'Cronograma actualizado', 'Recálculo aplicado', 'AB-'] },

  { nombre: 'abono-capint-usd-modificarplazo', gen: 'generateReciboAbono', tema: 'dark', celdas: 6,
    entrada: () => ({ loanId: '1782151590658w66y', monto: 1000000, usd: 271.66, mode: 'modificarPlazo', tema: 'dark' }),
    ejecutar: () => S.generateReciboAbono(L('1782151590658w66y'), pays, {
      monto: 1000000, montoUSD: 271.66, fecha: '2026-07-20', recalcMode: 'modificarPlazo',
      pre: snapshotPrevio(L('1782151590658w66y'), pays, 1000000) }),
    contiene: ['Plazo restante', 'USD $', '--r-bg:#000000'] },

  { nombre: 'abono-corta-intereses-cop', gen: 'generateReciboAbono', tema: 'light', celdas: null,
    entrada: () => ({ loanId: '1773656070840', monto: 100000, mode: 'mantener', tema: 'light' }),
    ejecutar: () => S.generateReciboAbono(L('1773656070840'), pays, {
      monto: 100000, fecha: '2026-07-20', recalcMode: 'mantener',
      pre: snapshotPrevio(L('1773656070840'), pays, 100000) }),
    contiene: ['Resumen', 'Nuevo saldo pendiente'] },

  // ── generateReciboCobro — el RECIBO DE PAGO de un cobro en cascada ─────────────────────
  // 3.5.0: rediseno aprobado por el PO sobre un prototipo con un cobro real. Una cifra
  // protagonista (lo que entro), una FRASE por movimiento (las cuotas saldadas seguidas en una
  // sola), "Lo que sigue" (ponerse al dia y la proxima cuota), la barra del credito con dos
  // saldos con nombre propio y una tabla de 4 columnas con las cuotas lejanas resumidas.
  // Los golden de estos casos se RE-ESTABLECIERON a proposito con ese rediseno.
  // Los pasos se construyen con `planCascada` REAL sobre los datos del fixture: escribirlos a
  // mano fijaria una forma que podria dejar de ser la que el orquestador produce.
  // Que lo declarado cuadre al peso con el motor lo fijan las secciones G, H y J de
  // `cascada-cobro`, contra el server real.
  { nombre: 'cobro-cascada-usd-oscuro', gen: 'generateReciboCobro', tema: 'dark', celdas: 4,
    entrada: () => ({ loanId: '1782151590658w66y', cascada: true, tema: 'dark', dark: true }),
    ejecutar: () => S.generateReciboCobro(L('1782151590658w66y'), pays,
      cobroDe(L('1782151590658w66y'), pays)),
    // Solo dolares (3.7.0: sin la caja del dia en pesos ni la TRM debajo); mora + abono = dos frases
    // y la nota del orden de imputacion. El recibo viejo repetia la cifra en "Total aplicado": ya no existe.
    // Rediseño v4: con la app en tema oscuro, el oscuro de la app (el #0d1117 viejo ya no aparece).
    contiene: ['Recibo de pago', 'Recibimos tu pago', 'Cómo se aplicó tu pago', 'Saldamos tu', 'Abonamos',
               'class="r-a"', 'USD $', 'RC-', '--r-bg:#000000', 'Así va tu crédito',
               'Te falta por pagar', 'De eso, capital', 'Tus cuotas', 'Total por pagar', 'Cómo se imputa el pago'],
    noContiene: ['Total aplicado', 'TOTAL RECIBIDO', 'Intereses vencidos', 'Equivalen a', 'TRM', '#0d1117'] },

  // ── generatePropuestaAbono — el papel que se manda ANTES de cobrar ────────────────────
  // Lo que este caso fija: que el documento NO se presente como comprobante. Un papel con
  // el membrete de la app y cifras exactas que dijera "recibido" seria un registro falso
  // de dinero que nunca entro.
  { nombre: 'propuesta-usd-oscuro', gen: 'generatePropuestaAbono', tema: 'dark', celdas: 6,
    entrada: () => ({ loanId: '1782151590658w66y', propuesta: true, tema: 'dark', dark: true }),
    ejecutar: () => S.generatePropuestaAbono(L('1782151590658w66y'), pays,
      propuestaDe(L('1782151590658w66y'), pays)),
    contiene: ['Propuesta de Abono', 'Si abonas', 'Así se aplicaría tu pago',
               'Así quedaría tu crédito', 'Total por pagar', 'Cronograma que quedaría',
               'no un comprobante', 'PA-', '--r-bg:#000000'],
    noContiene: ['TOTAL RECIBIDO', 'Total recibido', 'certifica el dinero', 'Recibido el'] },

  { nombre: 'propuesta-cop-claro', gen: 'generatePropuestaAbono', tema: 'light', celdas: 6,
    entrada: () => ({ loanId: '1773655076017', propuesta: true, tema: 'light', dark: false }),
    ejecutar: () => S.generatePropuestaAbono(L('1773655076017'), pays,
      propuestaDe(L('1773655076017'), pays)),
    // En `Intereses` la Propuesta ya no titula un total: sus cuotas son de puro interes y
    // el capital vence fuera del cronograma. Este caso llego a emitir "Quedaria un solo
    // pago de 2.310.000" sobre un capital de 3.000.000, el mismo defecto que el recibo
    // cierra con su gate. Es inalcanzable desde la UI (el preview solo existe en C+I) pero
    // este arnes SI lo alcanza, asi que el gate vive en el generador y se fija aqui.
    contiene: ['Propuesta de Abono', 'Si abonas', 'A pagar el', 'no un comprobante'],
    noContiene: ['TOTAL RECIBIDO', 'certifica el dinero', 'Total por pagar',
                 'Quedaria un solo pago'] },

  // La fila que YA TRAE DINERO ADENTRO lo dice en una sub-linea. Sin ella, el encabezado
  // anunciaba "a pagar 144.59" y la primera fila mostraba "500.00" para la MISMA fecha, sin
  // nada que las uniera: el lector concluia que el papel se contradice. `VALOR CUOTA` sigue
  // siendo la cuota entera porque es lo que sostiene la identidad con INTERES y ABONO A
  // CAPITAL; el neto va aparte. Y el titular ya no repite la resta: la explica la tabla.
  { nombre: 'propuesta-con-interes-adelantado', gen: 'generatePropuestaAbono', tema: 'light', celdas: 6,
    entrada: () => ({ loanId: '1782151590658w66y', propuesta: true, interesMes: true, tema: 'light', dark: false }),
    ejecutar: () => S.generatePropuestaAbono(L('1782151590658w66y'), pays,
      propuestaConInteresMes(L('1782151590658w66y'), pays)),
    contiene: ['pa-ab', 'esta cuota quedaría con', 'a pagar', 'Cronograma que quedaría',
               'POR ADELANTADO', 'no un comprobante'],
    // El titular no vuelve a explicar la resta que la sub-linea ya explico.
    // 'ya abonado' es la frase exacta que llevaba el titular; 'menos' a secas seria un
    // aserto fragil, esa palabra puede aparecer en cualquier copy futuro sin ser el defecto.
    noContiene: ['ya abonado'] },

  // El HERO de la Propuesta: con UNA sola cuota proyectada el total y el proximo pago son
  // el mismo numero y las tarjetas colapsan en una. Su titular NO repite la resta —la
  // explica la sub-linea de la fila, que aqui tambien esta— y solo lleva la fecha.
  { nombre: 'propuesta-hero-un-solo-pago', gen: 'generatePropuestaAbono', tema: 'light', celdas: 6,
    entrada: () => ({ loanId: '1782151590658w66y', propuesta: true, hero: true, tema: 'light', dark: false }),
    ejecutar: () => S.generatePropuestaAbono(L('1782151590658w66y'), pays,
      propuestaConInteresMes(L('1782151590658w66y'), pays, 'modificarPlazo', 1)),
    contiene: ['pa-hero', 'Quedaría un solo pago', 'esta cuota quedaría con', 'a pagar'],
    // Lo que el titular dejo de decir, porque la tabla ya lo dice.
    noContiene: ['ya abonado', 'Total por pagar', 'Cuotas restantes'] },

  // El override `incluirInteresMes`: el paso se dice en otro tiempo verbal ("Adelantamos el
  // interes de tu cuota del..., que aun no vence") y su importe lleva su propia clase. Una
  // prueba real del PO destapo que el recibo viejo llamaba "vencida" a una cuota del 19 en un
  // cobro del 3.
  { nombre: 'cobro-con-interes-del-mes', gen: 'generateReciboCobro', tema: 'dark', celdas: 4,
    entrada: () => ({ loanId: '1782151590658w66y', cascada: 'interesMes', tema: 'dark', dark: true }),
    ejecutar: () => S.generateReciboCobro(L('1782151590658w66y'), pays,
      cobroConInteresMes(L('1782151590658w66y'), pays)),
    contiene: ['Adelantamos el interés de', 'que aún no vence', 'class="r-m"', 'Tus cuotas', 'Total por pagar'],
    noContiene: ['queda debiendo', 'Total aplicado'] },

  // Modalidad `Intereses`: varias cuotas vencidas saldadas van en UNA frase, y NO hay "Te falta
  // por pagar": sus cuotas son de puro interes y el capital vence fuera de ellas, asi que la suma
  // anunciaria MENOS deuda de la que hay (medido sobre este credito: 2.700.000 bajo un capital
  // de 3.000.000). El total de la tabla se rotula como lo que es.
  { nombre: 'cobro-cascada-cop-intereses', gen: 'generateReciboCobro', tema: 'light', celdas: 4,
    entrada: () => ({ loanId: '1773655076017', cascada: true, tema: 'light', dark: false }),
    ejecutar: () => S.generateReciboCobro(L('1773655076017'), pays,
      cobroDe(L('1773655076017'), pays)),
    contiene: ['Saldamos tus <b>cuotas del', 'Cómo se imputa el pago', 'Saldo de capital', 'plazo indefinido',
               'Total de estas cuotas'],
    noContiene: ['Te falta por pagar', 'Total por pagar', 'De eso, capital'] },

  // Un cobro de UN solo paso: sin mora, la cascada degenera en un abono. Sin numeracion de
  // pasos ni nota de imputacion (no hay nada que repartir), y sin "Para ponerte al dia".
  { nombre: 'cobro-un-solo-paso', gen: 'generateReciboCobro', tema: 'light', celdas: 4,
    entrada: () => ({ loanId: '17795544041379obc', cascada: true, unPaso: true, tema: 'light', dark: false }),
    ejecutar: () => S.generateReciboCobro(L('17795544041379obc'), pays,
      cobroDe(L('17795544041379obc'), pays)),
    contiene: ['Abonamos', 'Tu próxima cuota', 'Te falta por pagar', 'De eso, capital', 'Total por pagar', 'Por vencer'],
    noContiene: ['Cómo se imputa el pago', 'class="r-n"', 'Para ponerte al día'] },

  // Una sola cuota viva con un parcial que ya cubrio su interes: lo que falta por pagar y el
  // capital son EL MISMO numero (es una identidad: cuota - abonado = capital + interes -
  // abonado), y ninguna cifra se repite: queda un solo saldo. La cuota a medias dice lo
  // abonado en su fila. El fixture no tiene un credito en ese estado; se construye en memoria.
  { nombre: 'cobro-hero-un-solo-pago', gen: 'generateReciboCobro', tema: 'light', celdas: 4,
    entrada: () => ({ loanId: LOAN_HERO, hero: true, tema: 'light', dark: false }),
    ejecutar: () => S.generateReciboCobro(L(LOAN_HERO), paysHero, cobroDe(L(LOAN_HERO), paysHero)),
    contiene: ['Tu próxima cuota', 'ya abonaste', 'Te falta por pagar', 'class="r-cap"'],
    noContiene: ['De eso, capital', 'Para ponerte al día'] },

  // Variante PAZ Y SALVO. Es la unica que se alimenta de un paso sintetico: pdf-render no
  // escribe en la BD. Sin "Lo que sigue", sin credito ni tabla: no queda deuda que anunciar.
  { nombre: 'cobro-paz-y-salvo', gen: 'generateReciboCobro', tema: 'light', celdas: null,
    entrada: () => ({ loanId: '1773652420812', cascada: true, sintetico: true, tema: 'light', dark: false }),
    ejecutar: () => S.generateReciboCobro(L('1773652420812'), pays, {
      fecha: '2026-07-20', pre: { saldoCaja: 200000, cuota: 0 },
      pasos: [{ tipo: 'abono', obligacionCOP: 200000, obligacionUSD: 0,
                interes: 0, capital: 200000, cajaCOP: 200000 }] }),
    contiene: ['PAZ Y SALVO', 'Paz y salvo', 'cancelada la totalidad', '¡Felicidades'],
    noContiene: ['Te falta por pagar', 'Tus cuotas', 'Lo que sigue'] },

  // ── generateReciboGeneral — el aviso de cobro con toda la deuda de un deudor (3.5.0) ──────
  // El prototipo aprobado por el PO usaba el credito ...jkph del fixture: al 31-jul esta al
  // dia, y al 2-nov (sin pagos nuevos) tiene 3 cuotas vencidas por $1.180.830. `hasta` es un
  // parametro del generador, asi que el corte no depende del reloj congelado.
  { nombre: 'general-un-credito-mora', gen: 'generateReciboGeneral', tema: 'light', celdas: 4,
    entrada: () => ({ loanIds: ['1776205975507jkph'], hasta: '2026-11-02', tema: 'light' }),
    ejecutar: () => S.generateReciboGeneral([L('1776205975507jkph')], pays, config.datos_pago, { hasta: '2026-11-02' }),
    contiene: ['Recibo de cobro general', 'Para ponerte al día', '3 cuotas vencidas', 'Lo que está vencido',
               'de eso, intereses', 'Tus opciones de pago', 'LO MÍNIMO', 'Al día + la próxima cuota', 'Liquidar el crédito',
               'válido hasta el', 'Así va tu crédito', 'abono a capital', 'Cómo pagar', 'no certifica ningún pago', 'CG-'],
    noContiene: ['Crédito 1', 'Recibimos tu pago', 'Estás al día'] },

  { nombre: 'general-al-dia', gen: 'generateReciboGeneral', tema: 'light', celdas: null,
    entrada: () => ({ loanIds: ['1776205975507jkph'], hasta: '2026-07-31', tema: 'light' }),
    ejecutar: () => S.generateReciboGeneral([L('1776205975507jkph')], pays, config.datos_pago, { hasta: '2026-07-31' }),
    contiene: ['Estás al día', 'Tu próxima cuota', 'Puedes adelantar cualquier valor', 'Gracias por estar al día'],
    noContiene: ['Lo que está vencido', 'LO MÍNIMO', 'Para ponerte al día'] },

  // VARIOS CREDITOS (decision del PO): el total consolidado arriba y el desglose por credito
  // debajo. La tabla de lo vencido gana la columna del credito (5 celdas).
  { nombre: 'general-varios-usd-oscuro', gen: 'generateReciboGeneral', tema: 'dark', celdas: 5,
    entrada: () => ({ loanIds: ['1773657323435hkkb', '1782151590658w66y'], hasta: '2026-11-02', tema: 'dark' }),
    ejecutar: () => S.generateReciboGeneral([L('1773657323435hkkb'), L('1782151590658w66y')], pays, config.datos_pago, { hasta: '2026-11-02' }),
    // Rediseño v4: con la app en tema oscuro, el oscuro de la app (el #0d1117 viejo ya no aparece).
    contiene: ['Crédito 1', 'Crédito 2', 'en 2 créditos', 'Liquidar tus créditos', 'liquidarlo hoy', 'USD $', '--r-bg:#000000', '-2C-'],
    noContiene: ['Así va tu crédito', '#0d1117'] },

  // `Intereses` con muchas cuotas vencidas: las mas viejas se resumen en UNA fila con su total
  // (nunca se omiten), y no hay "lo que falta por pagar" (el capital vence fuera de las cuotas).
  // Corre sobre `paysParcial`, con un abono de 120.000 encima de una cuota vencida: liquidar
  // RESTA lo ya abonado (`computeLiquidacion`), y la tarjeta tiene que explicarlo sin tocar el
  // capital. Sin un parcial, omitir esa resta pasaba la suite en verde (verificado).
  { nombre: 'general-intereses-resumen', gen: 'generateReciboGeneral', tema: 'light', celdas: 4,
    entrada: () => ({ loanIds: ['1773655076017'], hasta: '2026-11-02', tema: 'light', parcial: true }),
    ejecutar: () => S.generateReciboGeneral([L('1773655076017')], paysParcial, '', { hasta: '2026-11-02' }),
    contiene: ['8 cuotas vencidas', 'hasta ', ' cuotas</span>', 'Saldo de capital', 'plazo indefinido',
               'capital ' + S.fmt(S.computeLiquidacion(L('1773655076017'), paysParcial, { hasta: '2026-11-02' }).capitalPendiente) + ' + intereses vencidos',
               ' − lo ya abonado ' + S.fmt(120000)],
    noContiene: ['Te falta por pagar', 'Cómo pagar'] },

  // Un deudor con un credito en pesos y otro en dolares: los totales no se suman entre si, se
  // imprimen juntos. Y el credito abierto de interes diario no entra, pero se ANUNCIA (doctrina
  // "no silent caps"). El fixture no tiene ese deudor: se arma con creditos de otros.
  { nombre: 'general-mixto-con-diario', gen: 'generateReciboGeneral', tema: 'light', celdas: 5,
    entrada: () => ({ loanIds: ['1776205975507jkph', '1782151590658w66y', 'fixture-diario-01'], hasta: '2026-11-02', tema: 'light' }),
    ejecutar: () => S.generateReciboGeneral([L('1776205975507jkph'), L('1782151590658w66y'), L('fixture-diario-01')], pays, config.datos_pago, { hasta: '2026-11-02' }),
    contiene: ['r-monto mixto', ' + USD $', 'Crédito 2', 'de interés diario no está en este documento'],
    noContiene: ['Crédito 3'] },

  { nombre: 'abono-paz-y-salvo', gen: 'generateReciboAbono', tema: 'light', celdas: null,
    entrada: () => ({ loanId: '1773652420812', monto: 200000, mode: 'mantener', tema: 'light' }),
    ejecutar: () => S.generateReciboAbono(L('1773652420812'), pays, {
      monto: 200000, fecha: '2026-07-20', recalcMode: 'mantener',
      pre: snapshotPrevio(L('1773652420812'), pays, 200000) }),
    contiene: ['PAZ Y SALVO', 'Paz y Salvo'] },

  { nombre: 'abono-capint-parcial-fijarcuota', gen: 'generateReciboAbono', tema: 'light', celdas: 6,
    entrada: () => ({ loanId: LOAN_PARCIAL, monto: 400000, mode: 'fijarCuota', parcial: true, tema: 'light' }),
    ejecutar: () => S.generateReciboAbono(L(LOAN_PARCIAL), paysParcial, {
      monto: 400000, fecha: '2026-07-30', recalcMode: 'fijarCuota',
      pre: snapshotPrevio(L(LOAN_PARCIAL), paysParcial, 400000) }),
    contiene: ['Nueva cuota fija', 'ya abonado', 'TOTAL A PAGAR'] },

  // -- El Paz y Salvo de una LIQUIDACION declara la CAJA, no el capital --------------------
  // El defecto salio de produccion: un cierre por $1.473.036 se imprimio como "ABONO RECIBIDO
  // A CAPITAL $1.358.096", callando los $114.940 de mora que el cliente si pago. El capital
  // que envia `LiquidarModal` no es la caja NI ninguna fila persistida — el backend lo parte
  // entre la fila `-ab-` y las cuotas vencidas para no contarlo dos veces (Bug #35)—, asi que
  // titular con el era describir un movimiento que no existe.
  { nombre: 'abono-liquidacion-con-mora', gen: 'generateReciboAbono', tema: 'light', celdas: null,
    entrada: () => ({ loanId: '1773656070840', liquidar: true, intExtra: 40000, tema: 'light' }),
    ejecutar: () => S.generateReciboAbono(finalizado(L('1773656070840')), pays,
      optsLiquidacion(L('1773656070840'), pays, 40000)),
    // Capital 400.000 + mora 40.000 + mes en curso 40.000 = 480.000 de caja. La cifra va
    // literal: es el aserto que se pone rojo si el hero vuelve a declarar solo el capital.
    contiene: ['Total recibido', '480.000', 'Liquidación pagada por', 'Cómo se aplicó tu pago',
               'ab-dsg', 'Aplicado a capital', 'Intereses atrasados cubiertos',
               'Interés del mes en curso', 'PAZ Y SALVO'],
    // Lo que el titular dejo de decir. 'Saldo anterior' y 'Abono aplicado' son las dos filas
    // del Resumen viejo, que imprimian por tercera vez la misma cifra de capital y volvian a
    // insinuar que el capital fue todo lo que entro.
    noContiene: ['Abono recibido a capital', 'Saldo anterior', 'Abono aplicado'] },

  // El mismo documento en USD y en oscuro, parado SOBRE el borde de redondeo. En dolares cada
  // rubro se redondea por su cuenta y `round(a/t)+round(b/t)` no es `round((a+b)/t)`: sin
  // reconciliar, el desglose imprime 1.326,89 + 105,24 + 105,23 = 1.537,36 bajo un titular de
  // 1.537,37. Un centavo, pero es un desglose que no cuadra con su propio total — exactamente
  // el defecto que este documento viene a corregir. El capital absorbe el residuo (1.326,90),
  // igual que en las columnas del cronograma.
  //
  // El `intExtra` va cuatro pesos por debajo del que mandaria el checkbox (387.374 = 7,931%
  // del capital): con el valor exacto las cifras cuadran por casualidad y el caso no probaria
  // nada. Es el mismo recurso de `cobro-hero-un-solo-pago`, que arma en memoria un estado que
  // el fixture no tiene.
  { nombre: 'abono-liquidacion-usd-oscuro', gen: 'generateReciboAbono', tema: 'dark', celdas: null,
    entrada: () => ({ loanId: '1782151590658w66y', liquidar: true, intExtra: 387370, tema: 'dark' }),
    ejecutar: () => S.generateReciboAbono(finalizado(L('1782151590658w66y')), pays,
      optsLiquidacion(L('1782151590658w66y'), pays, 387370)),
    contiene: ['Total recibido', 'USD $1,537.37', 'USD $1,326.90', 'USD $105.24', 'USD $105.23',
               'Cómo se aplicó tu pago', 'Intereses atrasados cubiertos',
               'Interés del mes en curso', '--r-bg:#000000'],
    // 1.326,89 es lo que imprimiria el capital sin reconciliar: es el aserto que se pone rojo
    // si alguien vuelve a formatear cada rubro por separado.
    noContiene: ['Abono recibido a capital', 'USD $1,326.89'] },

  // ANTI-TRIVIAL de los dos anteriores: sin intereses el total ES el capital, asi que el
  // desglose NO se dibuja y el titular vuelve a ser el de un abono. Es lo que impide
  // "arreglar" los de arriba imprimiendo el bloque siempre: quitar el gate pone rojo este.
  { nombre: 'abono-liquidacion-sin-intereses', gen: 'generateReciboAbono', tema: 'light', celdas: null,
    entrada: () => ({ loanId: '1782872189716p6cz', liquidar: true, intExtra: 0, tema: 'light' }),
    ejecutar: () => S.generateReciboAbono(finalizado(L('1782872189716p6cz')), pays,
      optsLiquidacion(L('1782872189716p6cz'), pays, 0)),
    contiene: ['PAZ Y SALVO', 'Abono recibido a capital', 'Saldo anterior'],
    noContiene: ['Total recibido', 'Cómo se aplicó tu pago', 'ab-dsg'] },

  // ── generateEstadoLiquidacion — desglose + respaldo, con y sin el mes opcional ────────
  // `hasta` se pasa SIEMPRE fijo: el valor de liquidacion depende del dia, asi que sin
  // anclarlo el golden caducaria cada 24 h (por eso el generador lo recibe por parametro).
  { nombre: 'liq-capint-cop-con-mes', gen: 'generateEstadoLiquidacion', tema: 'light', celdas: 8,
    entrada: () => ({ loanId: '1776205975507jkph', incluye: true, tema: 'light' }),
    ejecutar: () => S.generateEstadoLiquidacion(L('1776205975507jkph'), pays, config.datos_pago,
      { incluyeProxMes: true, hasta: '2026-07-31' }),
    // Cobrando el mes en curso, el deudor queda cubierto HASTA el proximo vencimiento:
    // decir "solo por hoy" lo presionaria con un vencimiento que no existe.
    contiene: ['Estado de Liquidación', 'Total a liquidar hoy', 'Interés del mes en curso',
               'válido hasta', 'Incluye el interés de este periodo', 'LQ-'] },

  // Control del mismo prestamo SIN el mes opcional: el bloque no aparece y el
  // disclaimer cambia de razon (vence la proxima cuota) sin cambiar de fecha.
  { nombre: 'liq-capint-cop-sin-mes', gen: 'generateEstadoLiquidacion', tema: 'light', celdas: 8,
    entrada: () => ({ loanId: '1776205975507jkph', incluye: false, tema: 'light' }),
    ejecutar: () => S.generateEstadoLiquidacion(L('1776205975507jkph'), pays, config.datos_pago,
      { incluyeProxMes: false, hasta: '2026-07-31' }),
    contiene: ['Total a liquidar hoy', 'Respaldo', 'válido hasta', 'vence la próxima cuota'] },

  { nombre: 'liq-intereses-cop-mora', gen: 'generateEstadoLiquidacion', tema: 'light', celdas: 8,
    entrada: () => ({ loanId: '1773655076017', incluye: true, tema: 'light' }),
    ejecutar: () => S.generateEstadoLiquidacion(L('1773655076017'), pays, config.datos_pago,
      { incluyeProxMes: true, hasta: '2026-07-31' }),
    contiene: ['Intereses atrasados', 'Total a liquidar hoy'] },

  { nombre: 'liq-capint-usd-oscuro', gen: 'generateEstadoLiquidacion', tema: 'dark', celdas: 8,
    entrada: () => ({ loanId: '1782151590658w66y', incluye: true, tema: 'dark' }),
    ejecutar: () => S.generateEstadoLiquidacion(L('1782151590658w66y'), pays, config.datos_pago,
      { incluyeProxMes: true, hasta: '2026-07-31' }),
    contiene: ['USD $', '#0d1117', 'Total a liquidar hoy'] },

  // Rama propia del credito abierto: sin bloque de mora, con el devengo explicado en dias.
  { nombre: 'liq-diario-cop', gen: 'generateEstadoLiquidacion', tema: 'light', celdas: 5,
    entrada: () => ({ loanId: 'fixture-diario-01', incluye: false, tema: 'light' }),
    ejecutar: () => S.generateEstadoLiquidacion(L('fixture-diario-01'), pays, config.datos_pago,
      { incluyeProxMes: false, hasta: '2026-07-31' }),
    // El credito abierto SI caduca cada dia: aqui el disclaimer debe seguir siendo el
    // estricto. Es el control de que la rama nueva no se lo comio.
    contiene: ['Interés acumulado', 'por día', 'Corte', 'válido únicamente para el'] },

  // El parcial en vuelo TIENE que restarse del total y anunciarse en el respaldo.
  { nombre: 'liq-capint-parcial', gen: 'generateEstadoLiquidacion', tema: 'light', celdas: 8,
    entrada: () => ({ loanId: LOAN_PARCIAL, incluye: false, parcial: true, tema: 'light' }),
    ejecutar: () => S.generateEstadoLiquidacion(L(LOAN_PARCIAL), paysParcial, config.datos_pago,
      { incluyeProxMes: false, hasta: '2026-07-31' }),
    contiene: ['Abonos parciales ya recibidos', 'ya están descontados'] },
];

// ── Extraccion de la huella ──────────────────────────────────────────────────────────────

const TOKENS_PROHIBIDOS = ['undefined', 'NaN', '[object Object]', 'Infinity'];

// Importes tal como los formatean fmt/fmtUSD: "$ 3.445.494" (espacio duro U+00A0 de Intl)
// y "USD $1,326.89".
const RE_MONTO = /(?:USD[\s ]*)?\$[\s ]*\d[\d.,]*/g;

// Clases cuyo contenido es una ETIQUETA del documento (literal del codigo, nunca un dato del
// cliente). Deliberadamente NO se incluyen `.value`, `.rc-val`, `.ab-val`, `.rc-deudor-name`
// ni `.ab-name`: ahi viven los importes y los nombres de las personas.
const CLASES_ETIQUETA = ['section-title', 'label', 'rc-stitle', 'rc-lab', 'rc-doc-type',
                         'rc-hero-label', 'rc-total-label', 'rc-tdate-lab', 'ab-st', 'ab-lab',
                         'ab-cl', 'ab-tl', 'ab-type', 'ab-liq-q', 'ab-paz-t',
                         // Los recibos de 3.5.0 (`recibo-estilo.js`): titulos de seccion y de tarjeta.
                         'r-sec-t', 'r-tar-l'];

const MESES = 'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|ene|feb|mar|abr|may|jun|jul|ago|sept|sep|oct|nov|dic';

function sinTags(s) {
  return String(s).replace(/<[^>]*>/g, ' ').replace(/&[a-zA-Z]+;/g, ' ').replace(/\s+/g, ' ').trim();
}

// Normaliza una etiqueta: fuera digitos y nombres de mes. Cumple dos funciones — deja la
// huella inmune al paso del tiempo, y garantiza que no se filtre ningun dato a `tests/golden/`.
function normEtiqueta(s) {
  return sinTags(s)
    .replace(/\d+/g, '#')
    .replace(new RegExp('\\b(' + MESES + ')\\b', 'gi'), 'M')
    .replace(/\s+/g, ' ').trim();
}

function todos(re, txt) {
  const out = []; let m;
  while ((m = re.exec(txt)) !== null) out.push(sinTags(m[1]));
  return out;
}

function etiquetasDe(html) {
  const halladas = [];
  for (const clase of CLASES_ETIQUETA) {
    // El contenido de estas clases es texto plano (a lo sumo con una entidad), asi que un
    // cierre no-goloso basta; el limite de 400 caracteres evita que un fallo de cierre se
    // trague medio documento.
    const re = new RegExp('<[a-z0-9]+[^>]*class="' + clase + '"[^>]*>([\\s\\S]{0,400}?)</[a-z0-9]+>', 'g');
    let m;
    while ((m = re.exec(html)) !== null) halladas.push([m.index, normEtiqueta(m[1])]);
  }
  // Orden documental: asi la huella tambien detecta que una seccion se haya movido de sitio.
  return halladas.sort((a, b) => a[0] - b[0]).map(x => x[1]);
}

function celdasDeFila(tr) {
  let n = 0, m;
  const re = /<(?:th|td)\b([^>]*)>/g;
  while ((m = re.exec(tr)) !== null) {
    const cs = /colspan="(\d+)"/.exec(m[1]);
    n += cs ? +cs[1] : 1;
  }
  return n;
}

function sha1(s) { return crypto.createHash('sha1').update(String(s), 'utf8').digest('hex'); }

// Valores distintos del atributo `class` presentes en el documento. Son literales del codigo
// (`badge badge-mora`, `rc-hero-label`, `tran-sub`...), asi que renombrar, agregar o dejar de
// emitir una clase se ve aca aunque el texto y los importes no se muevan. Va en `valores` y no
// en `estructura` porque QUE clases aparecen depende en parte de los datos (que prestamos estan
// en mora, si hay un abono intercalado...).
function clasesDe(html) {
  const s = new Set(); let m;
  const re = /class="([^"]*)"/g;
  while ((m = re.exec(html)) !== null) s.add(m[1]);
  return [...s].sort();
}

function huellaDe(html, fname) {
  const sinCss  = html.replace(/<style[\s\S]*?<\/style>/gi, '');
  const trs     = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
  const celdas  = trs.map(celdasDeFila);
  const montos  = sinCss.match(RE_MONTO) || [];
  return {
    estructura: {
      docTitle:  sinTags((/<title>([\s\S]*?)<\/title>/i.exec(html) || [, ''])[1]),
      h1:        todos(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, sinCss),
      cabeceras: todos(/<th[^>]*>([\s\S]*?)<\/th>/gi, sinCss),
      etiquetas: etiquetasDe(sinCss),
    },
    valores: {
      bytes:       html.length,
      nFilas:      trs.length,
      nCeldas:     celdas.reduce((a, b) => a + b, 0),
      celdasPorTr: celdas,
      nMontos:     montos.length,
      // Digesto, NO los importes: el repo es publico (ver nota 2 de la cabecera).
      hashMontos:  sha1(montos.join('|')),
      hashFname:   sha1(String(fname)),
      // Regla C: digesto del TEXTO COMPLETO (sin tags, digitos -> '#', meses -> 'M').
      // `etiquetasDe` es un allowlist de clases; todo lo que queda fuera —el texto de los
      // badges, los mensajes del hero, las notas al pie— solo estaba cubierto por `bytes`, que
      // no ve un cambio de palabra del mismo largo. Esto lo ve. Sigue siendo un sha1: no se
      // filtra ni un importe ni un nombre a `tests/golden/`.
      hashTexto:   sha1(normEtiqueta(sinCss)),
      clases:      clasesDe(sinCss),
    },
    // Solo para el diagnostico en pantalla; no se guarda en el golden.
    _montos: montos,
  };
}

// ── Protocolo del golden master ──────────────────────────────────────────────────────────

function rutaGolden(caso) { return path.join(GOLDEN, 'pdf-' + caso + '.json'); }

function leerGolden(caso) {
  const f = rutaGolden(caso);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch (e) { return { _corrupto: String(e.message) }; }
}

function escribirGolden(caso, obj) {
  if (!fs.existsSync(GOLDEN)) fs.mkdirSync(GOLDEN, { recursive: true });
  fs.writeFileSync(rutaGolden(caso), JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

// ── Corrida ──────────────────────────────────────────────────────────────────────────────

// Los recibos de 3.5.0 envuelven el documento en una tabla cuyo thead/tfoot repite el margen en
// cada hoja impresa (`RB_MARCO_*` en recibo-estilo.js). Es MAQUETACION, no contenido: se quita
// antes de medir, o su fila de una celda contaria como una fila mas de cada documento.
function sinMarco(html) {
  const abre = S.RB_MARCO_ABRE, cierra = S.RB_MARCO_CIERRA;
  if (!abre || html.indexOf(abre) === -1) return html;
  const sin = html.replace(abre, ''), k = sin.lastIndexOf(cierra);
  return sin.slice(0, k) + sin.slice(k + cierra.length);
}

// Ejecuta un caso y devuelve { html, fname } o lanza si no emitio exactamente un PDF.
function generar(caso) {
  ponerTema(caso.tema);
  CAP.pdfs.length = 0;
  caso.ejecutar();
  if (CAP.pdfs.length !== 1) {
    throw new Error(`emitio ${CAP.pdfs.length} documento(s) por electronAPI.printPDF, se esperaba 1`);
  }
  return { html: sinMarco(CAP.pdfs[0].html), fname: CAP.pdfs[0].fname, crudo: CAP.pdfs[0].html };
}

// VOLCADO (rediseño v4 de los documentos, 2026-11-13): con `PDF_VOLCAR=<carpeta>`, cada caso
// deja el HTML TAL CUAL lo recibe la capa nativa (con el marco) y un `casos.json` con su
// generador, tema y nombre de archivo. Lo usa el arnes que compara el antes y el despues de un
// cambio de diseño: los mismos casos, los mismos datos, otro codigo. La carpeta va fuera del
// repo (los documentos llevan nombres del fixture y el repo es publico).
const VOLCAR = process.env.PDF_VOLCAR || '';
const volcados = [];
if (VOLCAR) fs.mkdirSync(VOLCAR, { recursive: true });

// Regla D (rediseño v4 de los documentos, 2026-11-13): `PDF_GOLDEN_DISENO=1` re-establece una
// linea base cuando cambia SOLO la presentacion. Puede mover el tamaño del HTML (`bytes`), las
// clases y el digesto del texto (`hashTexto`: el logo deja su letra "C"); todo lo demas tiene que
// quedar IDENTICO —la estructura entera (titulo, h1, cabeceras, rotulos), los importes, las filas,
// las celdas, el nombre de archivo y la entrada—, o el caso sale en rojo y NO se reescribe (regla
// A). Que el texto no cambio, salvo esa letra, lo prueba aparte la comparacion EXACTA del arnes
// de diseño (sin normalizar digitos ni meses), que el digesto no puede dar.
const DISENO_GOLDEN = process.env.PDF_GOLDEN_DISENO === '1';
const LIBRES_DE_DISENO = ['bytes', 'clases', 'hashTexto'];
function sinLibres(v) {
  const o = {};
  for (const k of Object.keys(v)) if (LIBRES_DE_DISENO.indexOf(k) === -1) o[k] = v[k];
  return o;
}

console.log('[pdf-render] frontend: ' + FE.meta.origen + ' (lineas ' + FE.meta.lineas + ', ' +
            FE.meta.nSimbolos + ' simbolos)  ·  BD: ' + loans.length + ' loans / ' + pays.length + ' payments');
console.log('[pdf-render] reloj congelado en ' + INSTANTE_FIJO.toISOString() + ' (huella estable)');

const generadoresVistos = new Set();
const bytesPorCaso = [];
let nCreados = 0, nEstrictos = 0, nRebaseline = 0, nCasosOK = 0, nSinBase = 0, nDriftRoto = 0, nDiseno = 0;

for (const caso of CASOS) {
  R.seccion(caso.nombre + '  [' + caso.gen + ' · tema ' + caso.tema + ']');

  let salida1, salida2;
  try {
    salida1 = generar(caso);
    salida2 = generar(caso);        // segunda corrida: la huella debe ser identica
  } catch (e) {
    R.check('el generador produjo un PDF', false, String(e && e.message ? e.message : e));
    continue;
  }
  generadoresVistos.add(caso.gen);
  nCasosOK++;
  if (VOLCAR) {
    fs.writeFileSync(path.join(VOLCAR, caso.nombre + '.html'), salida1.crudo);
    // Ademas, el MISMO caso en los dos temas de la app (`<caso>.light.html` / `<caso>.dark.html`):
    // los documentos siguen el tema, y un cambio de diseño se revisa en los dos.
    for (const t of ['light', 'dark']) {
      const otro = t === caso.tema ? salida1 : generar(Object.assign({}, caso, { tema: t }));
      fs.writeFileSync(path.join(VOLCAR, caso.nombre + '.' + t + '.html'), otro.crudo);
    }
    volcados.push({ caso: caso.nombre, gen: caso.gen, tema: caso.tema, fname: salida1.fname });
  }

  const html = salida1.html, fname = salida1.fname;
  bytesPorCaso.push({ caso: caso.nombre, bytes: html.length });

  // 1 — el documento existe y esta completo
  R.check('emitio exactamente 1 documento', true);
  R.check('abre con <!DOCTYPE html>', html.slice(0, 15) === '<!DOCTYPE html>', html.slice(0, 40));
  R.check('cierra con </body></html>', html.trim().endsWith('</body></html>'), JSON.stringify(html.slice(-40)));
  R.check('tamano razonable (>1500 bytes)', html.length > 1500, 'bytes=' + html.length);

  // 2 — ningun rastro de valor perdido en el camino (la regresion tipica de un refactor)
  const sucios = TOKENS_PROHIBIDOS.filter(t => html.indexOf(t) !== -1);
  R.check('sin undefined/NaN/[object Object]/Infinity', sucios.length === 0,
          sucios.length ? ('aparecen: ' + sucios.join(', ')) : undefined);

  // 3 — nombre de archivo
  R.check('fname no vacio y sin undefined',
          typeof fname === 'string' && fname.trim().length > 0 &&
          fname.indexOf('undefined') === -1 && fname.indexOf('NaN') === -1,
          JSON.stringify(fname));

  // 4 — conteo de columnas
  const trs = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
  if (caso.celdas === null) {
    R.check('documento sin tablas (0 <tr>)', trs.length === 0, 'trs=' + trs.length);
  } else {
    const mal = trs.map((t, i) => [i, celdasDeFila(t)]).filter(x => x[1] !== caso.celdas);
    R.check(`las ${trs.length} filas tienen ${caso.celdas} celdas (colspan incluido)`,
            trs.length > 0 && mal.length === 0,
            mal.length ? ('filas fuera de rango: ' + JSON.stringify(mal)) : 'no hay ninguna fila');
  }

  // 4b — las 7 columnas universales del cronograma, por nombre y en orden
  if (caso.gen === 'generateCronogramaPDF') {
    const ths = todos(/<th[^>]*>([\s\S]*?)<\/th>/gi, html);
    R.eq('7 columnas universales del cronograma', ths,
         ['#', 'Vence', 'Interés', 'Abono a capital', 'Valor cuota', 'Saldo', 'Estado']);
  }

  // 5 — el caso ejercito de verdad la rama que dice ejercitar
  const ausentes = (caso.contiene || []).filter(t => html.indexOf(t) === -1);
  R.check('contiene los marcadores de su escenario', ausentes.length === 0,
          ausentes.length ? ('faltan: ' + JSON.stringify(ausentes)) : undefined);

  // 5b — marcadores que NO deben aparecer. El golden fija la forma, pero no dice nada
  // sobre un texto que seria INCORRECTO emitir: un recibo que llame "vencida" a una
  // cuota que aun no vence tiene la misma estructura que uno correcto.
  if (caso.noContiene && caso.noContiene.length) {
    const presentes = caso.noContiene.filter(t => html.indexOf(t) !== -1);
    R.check('no dice lo que no debe decir', presentes.length === 0,
            presentes.length ? ('aparecen y no deberian: ' + JSON.stringify(presentes)) : undefined);
  }

  // 6 — determinismo: dos corridas seguidas, misma huella
  const h1 = huellaDe(salida1.html, salida1.fname);
  const h2 = huellaDe(salida2.html, salida2.fname);
  delete h1._montos; const montosVivos = h2._montos; delete h2._montos;
  R.eq('dos corridas seguidas dan la misma huella',
       { e: h1.estructura, v: h1.valores }, { e: h2.estructura, v: h2.valores });

  // 7 — golden master
  const entradaHash = sha1(JSON.stringify(caso.entrada()) + '|' +
                           JSON.stringify(loans) + '|' +
                           JSON.stringify(caso.entrada().parcial ? paysParcial : pays));
  // `version` es el formato de la HUELLA. Si cambia lo que se mide (una clave nueva en
  // `valores`), una linea base vieja no es comparable: se declara ausente en vez de fallar con
  // un diff ilegible o, peor, de compararse a medias.
  const VERSION_HUELLA = 2;
  const actual = { version: VERSION_HUELLA, caso: caso.nombre, generador: caso.gen, tema: caso.tema,
                   entradaHash, estructura: h1.estructura, valores: h1.valores };
  let prev = leerGolden(caso.nombre);
  if (prev && !prev._corrupto && prev.version !== VERSION_HUELLA) {
    prev = { _corrupto: 'formato de huella v' + prev.version + ', el arnes usa v' + VERSION_HUELLA };
  }

  if (!prev || prev._corrupto) {
    // Regla B: sin linea base no se compara NADA. Eso no puede ser un aviso verde, porque
    // convierte `rm tests/golden/*` en la via rapida para acallar la suite.
    const motivo = prev && prev._corrupto
      ? 'esta CORRUPTA (' + prev._corrupto + ')'
      : 'no existe';
    if (INIT_GOLDEN) {
      escribirGolden(caso.nombre, actual);
      nCreados++;
      console.log('  linea base ESTABLECIDA (' + motivo + ') en tests/golden/pdf-' + caso.nombre + '.json');
    } else {
      nSinBase++;
      R.check('golden · hay una linea base contra la cual comparar', false,
              'La linea base de "' + caso.nombre + '" ' + motivo + ', asi que este caso no\n' +
              'comparo ni estructura ni valores.\n' + COMO_INICIAR);
    }
  } else if (prev.entradaHash === entradaHash && DISENO_GOLDEN) {
    // Regla D: solo la presentacion puede moverse.
    nEstrictos++;
    const okE = R.eq('golden (diseño) · estructura del documento, idéntica', actual.estructura, prev.estructura);
    const okV = R.eq('golden (diseño) · importes, filas, celdas y nombre de archivo, idénticos',
                     sinLibres(actual.valores), sinLibres(prev.valores));
    const movio = LIBRES_DE_DISENO.filter(k => JSON.stringify(actual.valores[k]) !== JSON.stringify(prev.valores[k]));
    if (okE && okV && movio.length) {
      nDiseno++;
      escribirGolden(caso.nombre, actual);
      console.log('  re-establecida por DISEÑO (se movio: ' + movio.join(', ') + ')');
    } else if (!(okE && okV)) {
      nDriftRoto++;
      console.log('  la linea base NO se re-establecio: cambio algo mas que la presentacion.');
    }
  } else if (prev.entradaHash === entradaHash) {
    nEstrictos++;
    R.eq('golden · estructura del documento', actual.estructura, prev.estructura);
    const okValores = R.eq('golden · valores (filas, celdas, importes, texto, bytes)', actual.valores, prev.valores);
    if (!okValores) {
      console.log('        importes de esta corrida (' + montosVivos.length + '): ' +
                  montosVivos.slice(0, 12).join(' ') + (montosVivos.length > 12 ? ' ...' : ''));
    }
  } else {
    // Los datos de produccion se movieron (un cobro, un abono...). La estructura —que sale
    // del codigo, no de la BD— se sigue exigiendo; los valores se re-establecen.
    const ok = R.eq('golden · estructura del documento (datos cambiados)', actual.estructura, prev.estructura);
    if (ok) {
      nRebaseline++;
      escribirGolden(caso.nombre, actual);
      console.log('  AVISO  los datos de produccion cambiaron desde la ultima linea base:' +
                  ' se re-establecieron los VALORES de pdf-' + caso.nombre + '.json.');
    } else {
      // Regla A: NO se reescribe. Si se reescribiera, la huella nueva (con la regresion
      // adentro) pasaria a ser la referencia y la corrida siguiente saldria verde — el fallo
      // se reportaria UNA vez y se absorberia para siempre. Reproducido antes de esta guarda.
      nDriftRoto++;
      console.log('  la linea base NO se re-establecio: la estructura cambio y eso no lo explican');
      console.log('  los datos. Revisa el codigo. Si de verdad fue un cambio buscado, rehace la');
      console.log('  linea base a mano:');
      console.log('        ' + COMO_INICIAR.split('\n')[1].trim() +
                  '   (tras borrar tests/golden/pdf-' + caso.nombre + '.json)');
    }
  }
}

// ── V4 — los documentos ya rediseñados con el sistema de la app (2026-11-13) ──────────────
// Se migran por familias (decision del PO); esta lista crece con cada una. Lo que garantiza que
// un documento quedo en v4, en TODOS sus casos y en LOS DOS temas de la app: pide la letra Inter (la
// incrusta desktop/pdf.js, ver pdf-nativo), lleva el logo nuevo (el maletin; la "C" vieja era el
// unico texto que cambiaba), pinta el papel del TEMA (blanco en claro, el negro de la app en oscuro:
// el PO revirtio el "siempre en claro" el mismo dia) y no deja colores del tema oscuro viejo. Que el
// texto, las cifras y las filas no se movieron lo prueba el golden (regla D al rediseñar).
const GENERADORES_V4 = ['generateReciboCobro', 'generateReciboGeneral',
                        'generateRecibo', 'generateFacturaCobro', 'generateReciboAbono', 'generatePropuestaAbono'];
R.seccion('V4 · los documentos rediseñados: Inter, el logo de la app y el papel del tema');
{
  const casosV4 = CASOS.filter(c => GENERADORES_V4.indexOf(c.gen) !== -1);
  R.check('V0 cada generador v4 tiene casos (y alguno en tema oscuro)',
          GENERADORES_V4.every(g => casosV4.some(c => c.gen === g)) && casosV4.some(c => c.tema === 'dark'),
          casosV4.map(c => c.nombre + ':' + c.tema));
  for (const caso of casosV4) {
    for (const tema of ['light', 'dark']) {
      let html;
      try { html = generar(Object.assign({}, caso, { tema: tema })).html; }
      catch (e) { R.check(caso.nombre + ' (' + tema + '): genera', false, String(e && e.message)); continue; }
      const fallas = [];
      if (html.indexOf("font-family:'Inter'") === -1) fallas.push('no pide la letra Inter');
      if (!/<div class="[a-z]+-logo"><svg[^>]*>[\s\S]*?<\/svg><\/div>/.test(html)) fallas.push('sin el logo de la app');
      if (/<div class="r-logo">C<\/div>|<text[^>]*>C<\/text>/.test(html)) fallas.push('conserva la "C" vieja');
      const fondo = tema === 'dark' ? '--r-bg:#000000' : '--r-bg:#ffffff';
      if (html.indexOf(fondo) === -1) fallas.push('no pinta el papel del tema (' + fondo + ')');
      if (/#0d1117|#161b22|#e6edf3/i.test(html)) fallas.push('deja colores del tema oscuro viejo');
      if (/font-weight:\s*(?:800|900|650)/.test(html)) fallas.push('pide un peso que no se incrusta (solo 400, 500, 600 y 700)');
      R.check('V1 ' + caso.nombre + ' (tema ' + tema + ' en la app): documento v4', fallas.length === 0, fallas.join(' · '));
    }
  }
}

// ── 3.7.0 — un credito en dolares se imprime SOLO en dolares (decision del PO) ───────────
// "A los clientes que pagan en USD no les interesa ver el valor en COP": todo documento cuyos
// creditos son TODOS en dolares no puede llevar ni una cifra en pesos — ni equivalencias, ni la
// TRM, ni el monto original convertido, ni la palabra "pesos". Se mira el TEXTO VISIBLE (sin CSS
// ni etiquetas) y el nombre del archivo. Lo que delata un peso:
//   - el formato de `fmt`: "$" + espacio + digitos ("$ 17.640.000", "$ 0"). `fmt` pone un espacio
//     duro, pero `sinTags` lo normaliza a uno comun: por eso se busca CUALQUIER espacio. Un dolar
//     nunca lo lleva ("USD $1,234.56", "$1,234.56" en las tablas);
//   - un importe con miles en punto y SIN centavos ("17.640.000", "$1.234.567" de un nombre de
//     archivo), que es el formato es-CO de los pesos y de la TRM; un dolar siempre trae ".dd";
//   - las palabras COP, pesos y TRM.
//   (una tasa como "7.931%" no es un importe: el numero seguido de % se excluye).
// N1 recorre los casos golden cuyos creditos son todos en dolares; N3 el Reporte de Activos (las filas
// en dolares van solo en dolares, y una cartera solo en dolares no lee ni un peso, tampoco en los totales);
// N6 sus totales, separados por moneda (decision del PO), son la suma EXACTA de las filas impresas;
// N4 el Recibo general de deudores solo en dolares, tambien al dia (sin un "$ 0" de rbMixto); N5 los
// tres documentos del credito abierto, sobre una copia en dolares del credito diario del fixture.
// N2 es el anti-vacio: los casos USD existen, cubren 8 generadores y de verdad imprimen dolares.
const RE_PESO = [
  [/\$\s\d/, 'importe con el formato de fmt ($ + espacio)'],
  [/(^|[^\d.,])\d{1,3}(?:\.\d{3})+(?![\d.,]*\d)(?!\s*%)/, 'importe con miles en punto y sin centavos'],
  [/\bCOP\b/, 'la palabra COP'],
  [/\bpesos\b/i, 'la palabra pesos'],
  [/\bTRM\b/, 'la TRM'],
];
function pesosEn(texto) {
  const halladas = [];
  for (const [re, que] of RE_PESO) {
    const g = new RegExp(re.source, re.flags.indexOf('g') === -1 ? re.flags + 'g' : re.flags);
    let m;
    while ((m = g.exec(texto)) !== null) {
      halladas.push(que + ': «…' + texto.slice(Math.max(0, m.index - 40), m.index + m[0].length + 25) + '…»');
      if (halladas.length > 12) return halladas;
    }
  }
  return halladas;
}
function loansDelCaso(caso) {
  const e = caso.entrada();
  return (e.loanIds || (e.loanId ? [e.loanId] : [])).map(L).filter(Boolean);
}
{
  R.seccion('creditos en dolares · el documento no imprime ni una cifra en pesos (3.7.0)');
  const usdCasos = CASOS.filter(c => { const ls = loansDelCaso(c); return ls.length && ls.every(l => l.moneda === 'USD'); });
  const gensUSD = new Set();
  for (const caso of usdCasos) {
    let out;
    try { out = generar(caso); } catch (e) { R.check(caso.nombre + ' · el generador produjo un PDF', false, String(e.message || e)); continue; }
    gensUSD.add(caso.gen);
    const visible = sinTags(out.html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<title>[\s\S]*?<\/title>/gi, ''));
    const titulo = sinTags((/<title>([\s\S]*?)<\/title>/i.exec(out.html) || [, ''])[1]);
    const malas = pesosEn(visible + ' ¦ ' + titulo + ' ¦ ' + out.fname);
    R.check('N1 ' + caso.nombre + ' · solo dolares', malas.length === 0, malas.slice(0, 6).join('\n      '));
    R.check('N2 ' + caso.nombre + ' · imprime dolares', /\d,?\d*\.\d{2}\b/.test(visible) && /US\$|USD/.test(visible), 'no se encontro ningun importe en dolares');
  }
  const GENS_USD = ['generateCronogramaPDF', 'generateRecibo', 'generateFacturaCobro', 'generateReciboAbono', 'generateReciboCobro',
                    'generatePropuestaAbono', 'generateReciboGeneral', 'generateEstadoLiquidacion'];
  R.check('N2 los casos golden en dolares cubren ' + GENS_USD.length + ' generadores', GENS_USD.every(g => gensUSD.has(g)),
          'faltan: ' + GENS_USD.filter(g => !gensUSD.has(g)).join(', '));

  // Un documento emitido fuera de los casos golden: devuelve el texto visible + titulo + archivo.
  function emitir(fn) {
    CAP.pdfs.length = 0; fn();
    if (CAP.pdfs.length !== 1) throw new Error('emitio ' + CAP.pdfs.length + ' documento(s), se esperaba 1');
    const html = sinMarco(CAP.pdfs[0].html);
    return { html, fname: CAP.pdfs[0].fname,
             texto: sinTags(html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<title>[\s\S]*?<\/title>/gi, '')) + ' ¦ ' +
                    sinTags((/<title>([\s\S]*?)<\/title>/i.exec(html) || [, ''])[1]) + ' ¦ ' + CAP.pdfs[0].fname };
  }

  // N3 — Reporte de Activos: cada fila (principal, mora y transitoria) de un prestamo en dolares.
  ponerTema('light');
  const usdActivos = loans.filter(l => l.estado === 'Activo' && l.moneda === 'USD');
  for (const [etq, arr] of [['datos del fixture', pays], ['con un parcial sobre mora', paysParcial]]) {
    const rep = emitir(() => S.generateReportePrestamosPDF(usdActivos, arr, false));
    const filas = rep.html.match(/<tr class="(?:loan-row|mora-sub|tran-sub)[\s\S]*?<\/tr>/g) || [];
    const malas = filas.map(tr => pesosEn(sinTags(tr))).filter(x => x.length).map(x => x[0]);
    R.check('N3 reporte de activos (' + etq + ') · las ' + filas.length + ' filas de prestamos en dolares van solo en dolares',
            filas.length >= usdActivos.length && malas.length === 0, malas.slice(0, 4).join('\n      '));
    if (etq !== 'datos del fixture') {
      R.check('N3 reporte de activos · un parcial en mora se explica en dolares ("abonado USD $X de USD $Y")',
              /abonado USD \$[\d,]+\.\d{2} de USD \$[\d,]+\.\d{2}/.test(sinTags(rep.html)), 'sin la nota del abono en dolares');
    }
    R.check('N3 reporte de una cartera solo en dolares (' + etq + ') · ni un peso en todo el documento, totales incluidos',
            pesosEn(rep.texto).length === 0, pesosEn(rep.texto).slice(0, 3).join('\n      '));
  }
  // Una cartera en dolares SIN mora: el total vencido es cero, y `rbMixto` lo escribiria "$ 0".
  const usdAlDia = usdActivos.filter(l => !pays.some(p => p.prestamoId === l.id && p.estadoPago === 'En Mora'));
  R.check('N3 ANTI-VACIO: el fixture tiene un prestamo en dolares al dia', usdAlDia.length >= 1, usdAlDia.length);
  const repAlDia = emitir(() => S.generateReportePrestamosPDF(usdAlDia, pays, false));
  R.check('N3 reporte de una cartera en dolares al dia · el total vencido es "USD $0.00", no "$ 0"',
          /Total vencido: USD \$0\.00/.test(repAlDia.texto) && pesosEn(repAlDia.texto).length === 0,
          (/Total vencido:[^·]{0,30}/.exec(repAlDia.texto) || [''])[0]);

  // N6 — los totales del reporte MIXTO, separados por moneda: cada uno es la suma exacta de sus filas.
  const pesoDe = t => { const m = /\$\s?([\d.]+)(?![\d,]*\.\d{2})/.exec(t); return m ? +m[1].replace(/\./g, '') : 0; };
  const centDe = t => { const m = /USD \$([\d,]+\.\d{2})/.exec(t); return m ? Math.round(parseFloat(m[1].replace(/,/g, '')) * 100) : 0; };
  for (const [etq, arr] of [['datos del fixture', pays], ['con un parcial sobre mora', paysParcial]]) {
    const rep = emitir(() => S.generateReportePrestamosPDF(loans, arr, false));
    const filas = rep.html.match(/<tr class="loan-row[\s\S]*?<\/tr>/g) || [];
    const saldos = filas.map(tr => sinTags((tr.match(/<td[^>]*>[\s\S]*?<\/td>/g) || [])[6] || ''));
    const moras = (rep.html.match(/<tr class="mora-sub">[\s\S]*?<\/tr>/g) || []).map(tr => sinTags((/<strong>([^<]*)<\/strong>/.exec(tr) || [, ''])[1]));
    const suma = arr2 => ({ cop: arr2.filter(t => !/USD/.test(t)).reduce((a, t) => a + pesoDe(t), 0),
                            usd: arr2.filter(t => /USD/.test(t)).reduce((a, t) => a + centDe(t), 0) });
    const sS = suma(saldos), sV = suma(moras);
    const totV = sinTags((/Total vencido: <strong>([^<]*)<\/strong>/.exec(rep.html) || [, ''])[1]);
    const totS = sinTags((/font-size:24px;font-weight:700;color:[^"]*">([^<]*)<\/div>/.exec(rep.html) || [, ''])[1]);
    R.check('N6 reporte mixto (' + etq + ') · ANTI-VACIO: hay filas en pesos y en dolares, y mora en las dos monedas',
            sS.cop > 0 && sS.usd > 0 && sV.cop > 0 && sV.usd > 0, JSON.stringify({ sS, sV }));
    R.eq('N6 reporte mixto (' + etq + ') · capital en la calle = suma de las ' + filas.length + ' filas, cada moneda por su lado',
         { cop: pesoDe(totS), usd: centDe(totS), texto: / \+ USD \$/.test(totS) }, { cop: sS.cop, usd: sS.usd, texto: true });
    R.eq('N6 reporte mixto (' + etq + ') · total vencido = suma de las ' + moras.length + ' cuotas en mora, cada moneda por su lado',
         { cop: pesoDe(totV), usd: centDe(totV) }, { cop: sV.cop, usd: sV.usd });
    R.check('N6 reporte mixto (' + etq + ') · avisa que las dos monedas no se suman, y ya no dice "Incluye"',
            /pesos y dólares por separado: no se suman entre sí/.test(rep.texto) && !/Incluye/.test(rep.texto), totS);
  }
  // Una cartera solo en pesos queda como siempre: un solo total, sin el aviso de las dos monedas.
  const repCOP = emitir(() => S.generateReportePrestamosPDF(loans.filter(l => l.moneda !== 'USD'), pays, false));
  R.check('N6 una cartera solo en pesos: totales en pesos, sin "+ USD" ni el aviso',
          /Total vencido: \$\s[\d.]+ /.test(repCOP.texto) && !/USD/.test(repCOP.texto) && !/no se suman/.test(repCOP.texto),
          (/Total vencido:[^·]{0,30}/.exec(repCOP.texto) || [''])[0]);

  // N4 — Recibo general de cada deudor con creditos SOLO en dolares, con mora y al dia.
  const porDeudor = {};
  loans.filter(l => l.estado === 'Activo').forEach(l => { (porDeudor[l.nombre] = porDeudor[l.nombre] || []).push(l); });
  const soloUSD = Object.values(porDeudor).filter(ls => ls.every(l => l.moneda === 'USD') && ls.some(l => !S.esDiario(l)));
  for (const ls of soloUSD) {
    for (const hasta of ['2026-07-31', '2026-11-02']) {
      const g = emitir(() => S.generateReciboGeneral(ls, pays, config.datos_pago, { hasta }));
      const malas = pesosEn(g.texto);
      R.check('N4 recibo general de un deudor en dolares (' + ls.length + ' credito(s), al ' + hasta + ') · solo dolares',
              malas.length === 0, malas.slice(0, 4).join('\n      '));
    }
  }
  R.check('N4 anti-vacio: el fixture tiene deudores solo en dolares', soloUSD.length >= 2, soloUSD.length);
  // N4b — el total en CERO: rbMixto imprime los pesos cuando no hay dolares que sumar, asi que un deudor
  // en dolares que ya devolvio TODO el capital y aun debe intereses vencidos leia "capital $ 0" en la
  // tarjeta de liquidar. El fixture no tiene ese estado: se arma en memoria con el credito de Intereses
  // en mora, pasado a dolares (misma deuda en pesos) y con un abono por todo el capital.
  const iBase = L('1773655076017');
  if (!iBase) abortar('el fixture ya no tiene el credito 1773655076017 (lo usa la seccion N4b).');
  const origI = Math.round(iBase.montoOrigen);
  const iUSD = Object.assign({}, iBase, { id: 'n4b-usd-intereses', moneda: 'USD', trmAcordada: 4000, montoOrigen: iBase.montoOrigen / 4000 });
  const lpI = pays.filter(p => p.prestamoId === iBase.id).map(p => Object.assign({}, p, { prestamoId: iUSD.id }));
  lpI.push({ id: iUSD.id + '-ab-1', prestamoId: iUSD.id, nombreCliente: iUSD.nombre, cuotaN: 99, fechaPago: '2026-07-01',
             saldoInicial: origI, interesPeriodo: 0, abonoCapital: origI, cuotaTotal: origI, saldoFinal: 0, estadoPago: 'Pagado',
             fechaRecaudo: '2026-07-01', montoCOPRecibido: origI, montoUSDRecibido: origI / 4000, partialPaid: origI, recibos: '[]', observaciones: '' });
  ponerTema('light');
  const g0 = emitir(() => S.generateReciboGeneral([iUSD], lpI, config.datos_pago, { hasta: '2026-11-02' }));
  const tarjetaLiq = (/Liquidar el crédito[^·]{0,120}/.exec(g0.texto) || [''])[0];
  R.check('N4b ANTI-VACIO: la tarjeta de liquidar lleva el capital en cero', /capital USD \$0\.00/.test(tarjetaLiq), tarjetaLiq);
  R.check('N4b recibo general de un deudor en dolares con el capital en cero · solo dolares', pesosEn(g0.texto).length === 0,
          pesosEn(g0.texto).slice(0, 3).join('\n      '));

  // N5 — el credito abierto en dolares: una COPIA del diario del fixture, con la misma deuda en pesos.
  const dBase = L('fixture-diario-01');
  if (!dBase) abortar('el fixture ya no tiene fixture-diario-01 (lo usa la seccion N5).');
  const TRM_N5 = 4000;
  const dUSD = Object.assign({}, dBase, { moneda: 'USD', trmAcordada: TRM_N5, montoOrigen: dBase.montoOrigen / TRM_N5 });
  const lpD = pays.filter(p => p.prestamoId === dBase.id);
  const corteD = lpD.filter(p => S.esCorte(p)).sort((a, b) => a.cuotaN - b.cuotaN).pop();
  if (!corteD) abortar('fixture-diario-01 no tiene cortes (los usa la seccion N5).');
  ponerTema('dark');
  for (const [etq, fn] of [
    ['estado de cuenta', () => S.generateEstadoCuentaDiario(dUSD, lpD, { hasta: '2026-07-31' })],
    ['recibo de corte', () => S.generateReciboCorte(dUSD, lpD, corteD, {})],
    ['factura de interes', () => S.generateFacturaCobroDiario(dUSD, lpD, config.datos_pago, { hasta: '2026-07-31' })],
  ]) {
    const d = emitir(fn);
    const malas = pesosEn(d.texto);
    R.check('N5 credito abierto en dolares · ' + etq + ' · solo dolares', malas.length === 0, malas.slice(0, 4).join('\n      '));
    R.check('N5 credito abierto en dolares · ' + etq + ' · imprime dolares', /USD \$[\d,]+\.\d{2}/.test(d.texto), 'sin importes en dolares');
  }
}

// ── 3.1.0 — CronogramaPdfModal: compuerta, modal real, coherencia y cable ────────────────
// Los dos casos golden `crono-*-con-mes` fijan el DOCUMENTO. Esto fija lo que lo rodea:
//   M1 la compuerta: el modal solo se abre donde la pregunta tiene respuesta.
//   M2 el modal REAL: la casilla viaja hasta el PDF (sembrando su useState por posicion,
//      el mismo metodo de la seccion H de cascada-cobro).
//   M3 coherencia: para la misma decision, el cronograma y el Estado de Liquidacion
//      imprimen el mismo total y la misma fecha de vigencia.
//   M4 el cable: el perfil y el alta de prestamo abren el modal en vez del PDF directo.
{
  R.seccion('cronograma · valor de liquidacion con el interes del mes (3.1.0)');
  const ID_M = '1776205975507jkph';
  const lM = L(ID_M);
  const liqSin = S.computeLiquidacion(lM, pays, {});
  const liqCon = S.computeLiquidacion(lM, pays, { incluyeProxMes: true });
  R.check('M ANTI-TRIVIAL: el interes del mes mueve el total (y solo por el interes)',
          liqCon.intExtra > 0 && liqCon.total === liqSin.total + liqCon.intExtra,
          JSON.stringify({ sin: liqSin.total, con: liqCon.total, extra: liqCon.intExtra }));

  // M1 — compuerta. El fixture solo trae `Prestamo` finalizados, y ahi la compuerta diria que
  // no por falta de capital, no por la modalidad: se reabren sus cuotas en memoria para que el
  // "no" se deba a la regla que se quiere probar.
  R.check('M1 un C+I activo con capital SI pregunta', S.preguntaInteresMes(lM, pays) === true);
  const reabrir = (l) => pays.map(p => p.prestamoId === l.id
    ? Object.assign({}, p, { estadoPago: 'Pendiente', partialPaid: 0 }) : p);
  const prest = loans.find(l => l.modalidad === 'Prestamo');
  const paysPrest = reabrir(prest);
  R.check('M1 ANTI-TRIVIAL: el Prestamo reabierto tiene capital vivo',
          S.computeLiquidacion(prest, paysPrest, {}).capitalPendiente > 0);
  R.check('M1 un Prestamo con capital vivo NO pregunta (0% interes)', S.preguntaInteresMes(prest, paysPrest) === false);
  const puVivo = loans.find(l => l.modalidad === 'Pago Unico' && l.estado === 'Activo');
  R.check('M1 ANTI-TRIVIAL: hay un Pago Unico activo con capital',
          !!puVivo && S.computeLiquidacion(puVivo, pays, {}).capitalPendiente > 0);
  R.check('M1 un Pago Unico con capital NO pregunta (ganancia fija)', !!puVivo && S.preguntaInteresMes(puVivo, pays) === false);
  const diario = loans.find(l => l.modalidad === 'Interes Diario');
  R.check('M1 Interes Diario NO pregunta (su boton imprime el Estado de Cuenta)', !!diario && S.preguntaInteresMes(diario, pays) === false);
  R.check('M1 un C+I con tasa 0 NO pregunta', S.preguntaInteresMes(Object.assign({}, lM, { tasaMensual: 0 }), pays) === false);
  const ciCerrado = loans.find(l => l.modalidad === 'Capital + Intereses' && l.estado === 'Finalizado');
  R.check('M1 un credito saldado NO pregunta (sin capital no hay liquidacion)', !!ciCerrado && S.preguntaInteresMes(ciCerrado, pays) === false);

  // M2 — el componente REAL.
  const useStateOrig = FE.sandbox.useState;
  const sembrar = (vals) => {
    let i = 0;
    FE.sandbox.useState = (init) => {
      const v = (i < vals.length && vals[i] !== undefined) ? vals[i] : (typeof init === 'function' ? init() : init);
      i++;
      return [v, () => {}];
    };
  };
  const pintar = (n) => {
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
  const usar = (marcada) => {
    ponerTema('light');
    sembrar([marcada, false]);           // orden de useState en el modal: [incluyeProxMes, busy]
    let cierres = 0;
    const arbol = pintar({ type: S.CronogramaPdfModal, props: { loan: lM, pays: pays, onClose: () => { cierres++; } }, children: [] });
    const pantalla = textos(arbol).join(' ');
    const casilla = nodos(arbol, 'input').filter(n => n.props && n.props.type === 'checkbox')[0];
    const boton = nodos(arbol, 'button').filter(b => textos(b).join('').indexOf('Descargar PDF') !== -1)[0];
    CAP.pdfs.length = 0;
    if (boton) boton.props.onClick();
    return { pantalla, casilla, boton, docs: CAP.pdfs.slice(), cierres: () => cierres };
  };
  let conMes, sinMes;
  try { conMes = usar(true); sinMes = usar(false); }
  finally { FE.sandbox.useState = useStateOrig; }

  R.check('M2 el modal REAL se cargo y tiene su boton "Descargar PDF"', typeof S.CronogramaPdfModal === 'function' && !!conMes.boton);
  R.check('M2 la casilla compartida aparece, marcada segun su estado',
          !!conMes.casilla && conMes.casilla.props.checked === true && !!sinMes.casilla && sinMes.casilla.props.checked === false);
  R.check('M2 la casilla usa el texto de Liquidar deuda', conMes.pantalla.indexOf('Cobrar el interés del mes en curso') !== -1);
  R.check('M2 la pantalla muestra la cifra que va a imprimir (marcada)', conMes.pantalla.indexOf(S.fmt(liqCon.total)) !== -1, conMes.pantalla.slice(0, 400));
  R.check('M2 la pantalla muestra la cifra que va a imprimir (desmarcada)', sinMes.pantalla.indexOf(S.fmt(liqSin.total)) !== -1, sinMes.pantalla.slice(0, 400));
  R.check('M2 marcada: emite 1 PDF CON el interes del mes y su vigencia',
          conMes.docs.length === 1 && conMes.docs[0].html.indexOf('interés del mes en curso') !== -1 &&
          conMes.docs[0].html.indexOf('3.100.671') !== -1 && conMes.docs[0].html.indexOf('Válido hasta el 14 de ago de 2026') !== -1,
          conMes.docs.length ? '' : 'no se emitio documento');
  R.check('M2 desmarcada: emite 1 PDF SIN el interes del mes, con el total de siempre',
          sinMes.docs.length === 1 && sinMes.docs[0].html.indexOf('interés del mes en curso') === -1 &&
          sinMes.docs[0].html.indexOf('Válido hasta') === -1 && sinMes.docs[0].html.indexOf('2.885.494') !== -1);
  R.check('M2 tras descargar, el modal se cierra (el perfil vuelve)', conMes.cierres() === 1 && sinMes.cierres() === 1);

  // M3 — el cronograma y el Estado de Liquidacion, misma decision, mismas cifras.
  CAP.pdfs.length = 0;
  S.generateEstadoLiquidacion(lM, pays, '', { incluyeProxMes: true, hasta: S.nowStr() });
  const estado = CAP.pdfs[0] ? CAP.pdfs[0].html : '';
  const fechaVig = S.fmtD(S.proximoVencimiento(lM, pays, S.nowStr()));
  const cronoCon = conMes.docs[0] ? conMes.docs[0].html : '';
  R.check('M3 el Estado de Liquidacion imprime el mismo total que el cronograma',
          estado.indexOf('3.100.671') !== -1 && cronoCon.indexOf('3.100.671') !== -1);
  R.check('M3 y la misma fecha de vigencia (' + fechaVig + ')',
          estado.indexOf(fechaVig) !== -1 && cronoCon.indexOf(fechaVig) !== -1);
  CAP.pdfs.length = 0;
  S.generateEstadoLiquidacion(lM, pays, '', { incluyeProxMes: false, hasta: S.nowStr() });
  R.check('M3 ANTI-TRIVIAL: sin la opcion el Estado de Liquidacion NO imprime ese total',
          !!CAP.pdfs[0] && CAP.pdfs[0].html.indexOf('3.100.671') === -1);

  // M4 — el cable. El comportamiento del modal ya esta probado; esto fija que los DOS puntos de
  // entrada lo abren (la leccion de la seccion K de cascada-cobro: un arnes que arma sus propios
  // argumentos no ve si el cable real se corta).
  const leer = (rel) => fs.readFileSync(path.join(REPO, 'public', 'js', rel), 'utf8');
  // 3.5.0: el perfil del deudor paso de modal (DebtorModal) a panel lateral (DeudorPanel).
  const srcPanel = leer('componentes/DeudorPanel.js'), srcApp = leer('app.js'), srcLiq = leer('modales/LiquidarModal.js');
  R.check('M4 panel del deudor: "Cronograma PDF" pasa por la compuerta y abre el modal',
          /else if \(preguntaInteresMes\(l, m\.lp\)\) setCronoPdf\(l\.id\);/.test(srcPanel) &&
          /cronoPdf && h\(CronogramaPdfModal,/.test(srcPanel));
  R.check('M4 alta de prestamo: pasa por la compuerta y abre el modal',
          /if\(pNuevo\.length&&preguntaInteresMes\(lNuevo,pNuevo\)\)\{\s*setCronoPdfModal\(/.test(srcApp) &&
          /cronoPdfModal&&h\(CronogramaPdfModal,/.test(srcApp));
  R.check('M4 Liquidar deuda usa la MISMA casilla (sin copia inline del texto)',
          /h\(CheckInteresMes,/.test(srcLiq) && srcLiq.indexOf("'Cobrar el '") === -1);
}

// ── Guardas anti "verde en vacio" ────────────────────────────────────────────────────────

R.seccion('cobertura de la suite');
R.check('se ejercitaron al menos 8 casos', nCasosOK >= 8, 'casos con salida: ' + nCasosOK + ' de ' + CASOS.length);
R.check('los ' + CASOS.length + ' casos definidos produjeron documento', nCasosOK === CASOS.length,
        'con salida: ' + nCasosOK + ' / definidos: ' + CASOS.length);
// El conteo se DERIVA de la lista (leccion del Bug #48: un numero escrito a mano en el
// titulo se desincroniza y la suite acaba mintiendo sobre su propia cobertura).
R.eq('los ' + GENERADORES.length + ' generadores fueron ejercitados',
     GENERADORES.filter(g => generadoresVistos.has(g)).sort(), GENERADORES.slice().sort());

// Cobertura declarada en el encargo: las 5 modalidades, ambas monedas, mora, parcial, 2 temas.
const modsCubiertas = new Set();
const monedas = new Set();
for (const c of CASOS) {
  const e = c.entrada();
  if (!e.loanId) continue;
  const l = L(e.loanId);
  if (l) { modsCubiertas.add(l.modalidad); monedas.add(l.moneda); }
}
// 'Interes Diario' entra aqui con el Estado de Liquidacion: es el primer caso de
// pdf-render que ejercita la 5a modalidad (los 2 generadores propios del credito
// abierto, generateEstadoCuentaDiario y generateReciboCorte, siguen sin golden; desde 3.7.0 la
// seccion N los renderiza en dolares y exige que no impriman pesos).
const MODALIDADES = ['Capital + Intereses', 'Interes Diario', 'Intereses', 'Pago Unico', 'Prestamo'];
R.eq('las ' + MODALIDADES.length + ' modalidades estan cubiertas', [...modsCubiertas].sort(), MODALIDADES);
R.eq('COP y USD cubiertos', [...monedas].sort(), ['COP', 'USD']);
R.eq('temas claro y oscuro cubiertos', [...new Set(CASOS.map(c => c.tema))].sort(), ['dark', 'light']);
R.check('hay un caso con pago PARCIAL en vuelo', CASOS.some(c => c.entrada().parcial === true));
R.check('el parcial inyectado sigue Pendiente (parcial en vuelo, no cuota saldada)',
        cuotaParcial.estadoPago === 'Pendiente' && cuotaParcial.partialPaid > 0 &&
        cuotaParcial.partialPaid < cuotaParcial.cuotaTotal,
        JSON.stringify({ estado: cuotaParcial.estadoPago, partial: cuotaParcial.partialPaid, cuota: cuotaParcial.cuotaTotal }));
R.check('hay al menos un caso con cuotas En Mora',
        pays.some(p => p.estadoPago === 'En Mora' && p.id.indexOf('-ab-') === -1));
// Sin esto, la rama `saldoMora`/`saldoMoraUSD` del Reporte (Bugs #42 y #45) queda sin cubrir:
// son los unicos consumidores de `partialPaid` sobre una cuota EN MORA.
R.check('hay un parcial en vuelo sobre una cuota EN MORA (COP y USD)',
        moraParcialCOP.estadoPago === 'En Mora' && moraParcialCOP.partialPaid > 0 &&
        moraParcialCOP.partialPaid < moraParcialCOP.cuotaTotal &&
        moraParcialUSD.estadoPago === 'En Mora' && moraParcialUSD.partialPaid > 0 &&
        moraParcialUSD.partialPaid < moraParcialUSD.cuotaTotal &&
        moraParcialUSD.montoUSDRecibido > 0,
        JSON.stringify({ cop: { e: moraParcialCOP.estadoPago, p: moraParcialCOP.partialPaid },
                         usd: { e: moraParcialUSD.estadoPago, p: moraParcialUSD.partialPaid,
                                usd: moraParcialUSD.montoUSDRecibido } }));

// ── Resumen ──────────────────────────────────────────────────────────────────────────────

console.log('\n-- tamano de cada documento (bytes)');
for (const b of bytesPorCaso) console.log('   ' + String(b.bytes).padStart(6) + '  ' + b.caso);
console.log('   ' + String(bytesPorCaso.reduce((s, b) => s + b.bytes, 0)).padStart(6) + '  TOTAL (' + bytesPorCaso.length + ' documentos)');
console.log('\n-- golden master: ' + nEstrictos + ' comparados en estricto · ' +
            nRebaseline + ' re-establecidos por cambio de datos · ' + nCreados + ' creados · ' +
            nSinBase + ' SIN linea base · ' + nDriftRoto + ' con estructura rota (no re-establecidos)' +
            (DISENO_GOLDEN ? ' · ' + nDiseno + ' re-establecidos por DISEÑO (regla D)' : ''));
if (VOLCAR) {
  fs.writeFileSync(path.join(VOLCAR, 'casos.json'), JSON.stringify(volcados, null, 2));
  console.log('-- volcados ' + volcados.length + ' documentos en ' + VOLCAR);
}

if (nCasosOK < 8) {
  abortar(`Solo ${nCasosOK} casos produjeron documento (minimo exigido: 8). La suite no cubre nada.`);
}
if (R.ok + R.fallos === 0) {
  abortar('La suite no ejecuto ni un solo aserto.');
}
// Ultima red contra el verde en vacio del golden: una corrida donde NINGUN caso llego a
// compararse contra una linea base no vale como baseline, por muchos asertos genericos que
// haya sumado. En modo INIT eso es lo esperado y se dice sin disfrazarlo de exito.
if (nEstrictos + nRebaseline + nDriftRoto === 0) {
  if (INIT_GOLDEN) {
    console.log('\nMODO INIT: se establecieron ' + nCreados + ' lineas base y NO se comparo ninguna.\n' +
                'Corre la suite otra vez SIN PDF_GOLDEN_INIT para que el baseline valga.');
    process.exit(R.fallos === 0 ? 3 : 1);
  }
  abortar('Ningun caso se comparo contra una linea base: la capa de golden no afirmo nada.\n' + COMO_INICIAR);
}

process.exit(R.finalizar());
