// backend/core/engine.js — MOTOR FINANCIERO.
//
// Extraido de `server.js` en la Etapa 2 (A1) del refactor de modularizacion.
// El codigo de las 6 funciones se movio VERBATIM: no se corrigio, ni se renombro,
// ni se "mejoro" nada. Cualquier cambio de comportamiento aqui seria un bug.
//
// CONTRATO DE PUREZA: este modulo no toca la base de datos, ni Express, ni ningun
// estado del closure `createApp`. Solo depende de sus argumentos, `Math`, `Date` y
// —desde el blindaje de Interes Diario— la clase `ClientError`, que es un tipo puro
// sin estado ni dependencias. Se importa para que un rechazo del motor llegue al
// cliente como 4xx con la BD intacta, en vez de como un 500.
// Se verifico mecanicamente antes de extraerlo: 0 referencias a `db`, `app`,
// `insPayment`, `mutacionAtomica` y demas simbolos del closure. Por eso es la
// pieza de menor riesgo del backend y por eso va primera.
//
// Si algun dia una funcion de aca necesita la BD, NO se le pasa `db`: se parte la
// funcion y la parte impura se queda en su router. Perder la pureza de este modulo
// es perder la unica parte del backend que se puede probar sin levantar nada.

const { ClientError } = require('./errors');

// Nombre canonico de la modalidad de credito abierto (interes diario). Vive aqui
// —y no en un literal disperso— porque el motor es el unico punto por el que pasan
// las cinco rutas que generan cronograma, y una modalidad mal escrita en un `===`
// no falla: simplemente no entra en la rama y el credito acaba amortizado a la
// francesa. Sin tilde, igual que 'Pago Unico', porque asi viajan ya los valores
// persistidos en la columna `loans.modalidad`.
const MODALIDAD_DIARIA = 'Interes Diario';

// Whitelist de las modalidades que este motor sabe amortizar. Existe porque la cascada
// de `buildSchedule` NO tiene rama por defecto: lo que no cae en 'Prestamo' ni en
// 'Pago Unico' termina en el bucle de amortizacion francesa. Un typo en la columna
// `modalidad`, o una modalidad futura que olvide registrarse aqui, no produciria un
// error sino DOCE CUOTAS PMT en silencio sobre un prestamo que nunca las pacto.
// Cuando lo que se fabrica es deuda, fallar ruidoso es la unica opcion segura.
const MODALIDADES_CONOCIDAS = ['Intereses', 'Capital + Intereses', 'Prestamo', 'Pago Unico'];

// ── Motor financiero ──────────────────────────────────────────────────────
function pmt(r, n, pv) {
  if (r === 0) return pv / n;
  return pv * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1);
}

function getPayDate(startISO, cuotaN, diaPago, frecuencia) {
  const d = new Date(startISO + 'T12:00:00');
  if (frecuencia === 'Semanal') {
    d.setDate(d.getDate() + cuotaN * 7);
    return d.toISOString().split('T')[0];
  }
  if (frecuencia === 'Quincenal') {
    d.setDate(d.getDate() + cuotaN * 14);
    return d.toISOString().split('T')[0];
  }
  // Mensual (default)
  d.setDate(1);
  d.setMonth(d.getMonth() + cuotaN);
  d.setDate(Math.min(diaPago, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  return d.toISOString().split('T')[0];
}

// Convertir tasa mensual a tasa del período según frecuencia
function tasaPeriodo(tasaMensual, frecuencia) {
  if (frecuencia === 'Semanal') return tasaMensual / 4.33;
  if (frecuencia === 'Quincenal') return tasaMensual / 2;
  return tasaMensual; // Mensual
}

/**
 * buildSchedule — genera cronograma de cuotas
 * @param {object} loan        - datos del prestamo
 * @param {number} startN      - numero de cuota inicial (default 1)
 * @param {number} startSaldo  - saldo sobre el cual calcular (default loan.montoCOP)
 * @param {number} numCuotas   - cuantas cuotas generar (default: plazoMeses completo)
 *
 * startN tambien determina el offset de fecha: cuotaN=5 => mes 5 desde fechaInicio
 */
// Para Intereses: calcular cuántas cuotas generar hasta N períodos adelante de hoy
function cuotasHastaHoy(fechaInicio, startN, periodosAdelante, frecuencia) {
  const hoy = new Date();
  const inicio = new Date(fechaInicio + 'T12:00:00');
  const diffMs = hoy - inicio;
  const diasDiff = diffMs / (24 * 60 * 60 * 1000);
  var periodosDesdeInicio;
  if (frecuencia === 'Semanal') periodosDesdeInicio = Math.ceil(diasDiff / 7);
  else if (frecuencia === 'Quincenal') periodosDesdeInicio = Math.ceil(diasDiff / 14);
  else periodosDesdeInicio = Math.ceil(diasDiff / 30.44);
  periodosDesdeInicio += periodosAdelante;
  return Math.max(3, periodosDesdeInicio - startN + 1);
}

function buildSchedule(loan, startN, startSaldo, numCuotas) {
  // ── INTERES DIARIO: credito abierto, SIN cronograma ────────────────────────
  // Un credito de capital vivo no tiene cuotas: el interes se devenga por dias y
  // solo se materializa una fila cuando ocurre un evento economico real (el corte).
  // Este `return []` va como PRIMERA linea a proposito: `buildSchedule` es el
  // sumidero comun de POST /loans, PUT /loans, /abono, /reestructurar y
  // /recalculate, asi que una sola linea deja inertes las cinco rutas.
  //
  // Sin el, la cascada de abajo NO es inerte ante una modalidad que no reconoce:
  // cae en el bucle de amortizacion francesa con `plazoMeses || 12` — y como el
  // centinela de esta modalidad es `plazoMeses = 0`, que es falsy, le fabricaria
  // DOCE cuotas PMT en silencio, con capital repartido. Esas filas entrarian en la
  // formula canonica de saldo, en `saldoReal` (techo del abono) y en la
  // auto-finalizacion. El motor no rechaza lo que no entiende: lo inventa.
  if (loan && loan.modalidad === MODALIDAD_DIARIA) return [];

  // RECHAZO ESTRICTO de lo desconocido (ver MODALIDADES_CONOCIDAS). Va DESPUES del
  // credito abierto —que es conocido pero deliberadamente sin cronograma— y ANTES de
  // cualquier calculo, para que la BD nunca vea una fila derivada de una modalidad que
  // el motor no entiende. Es `ClientError`, no `Error`: asi las rutas envueltas en
  // `mutacionAtomica` responden 4xx con la BD intacta en vez de un 500.
  if (!loan || MODALIDADES_CONOCIDAS.indexOf(loan.modalidad) === -1) {
    throw new ClientError('Modalidad no reconocida por el motor: "' + (loan && loan.modalidad) +
      '". Las validas son: ' + MODALIDADES_CONOCIDAS.join(', ') + ' y ' + MODALIDAD_DIARIA + '.');
  }

  startN = startN || 1;
  const { id, nombre, tasaMensual, modalidad, fechaInicio, diaPago } = loan;
  const freq = loan.frecuencia || 'Mensual';
  // Base para las FECHAS del cronograma (aplazamiento por cambio de dia de pago). NULL -> fechaInicio.
  const baseCron = loan.fechaBaseCronograma || fechaInicio;
  const montoCOP = startSaldo !== undefined ? startSaldo : loan.montoCOP;
  const indefinido = modalidad === 'Intereses';
  const totalCuotas = numCuotas !== undefined ? numCuotas : (indefinido ? cuotasHastaHoy(fechaInicio, startN, 3, freq) : (loan.plazoMeses || 12));
  const r = tasaPeriodo(tasaMensual / 100, freq);
  let saldo = montoCOP;
  const cuotaFija = pmt(r, totalCuotas, montoCOP);
  const rows = [];

  // Prestamo sin intereses: 1 cuota por el capital total (interesPeriodo=0, abonoCapital=capital).
  // v1.18.2 (Bug #30): abonoCapital persiste el CAPITAL (= cuotaTotal, ya que interes=0), NO 0.
  // El 0 historico era defensa contra la heuristica fragil 'interesPeriodo===0 && abonoCapital>0'
  // que confundia esta cuota con un abono; esa heuristica se erradico en v1.14.0 (Bug #28) y hoy
  // los abonos se identifican SOLO por id.indexOf('-ab-'). Con el 0, la formula canonica de saldo
  // (origCOP - Σ abonoCapital de Pagadas) no contaba el capital cobrado -> saldo fantasma en
  // prestamos ya saldados. Ahora es byte-identico a lo que 'Pago Unico' persiste con ganancia 0.
  if (modalidad === 'Prestamo') {
    var fechaCuota = loan.fechaDevolucion || getPayDate(baseCron, 1, diaPago, freq);
    rows.push({
      id: `${id}-1`, prestamoId: id, nombreCliente: nombre, cuotaN: 1,
      fechaPago: fechaCuota,
      saldoInicial: Math.round(montoCOP), interesPeriodo: 0,
      abonoCapital: Math.round(montoCOP), cuotaTotal: Math.round(montoCOP),
      saldoFinal: 0, estadoPago: 'Pendiente', fechaRecaudo: null, observaciones: '',
      montoCOPRecibido: 0, montoUSDRecibido: 0, partialPaid: 0, extraConsolidado: 0
    });
    return rows;
  }

  // v1.10.0 — Pago Unico: 1 cuota con capital + ganancia fija pactada
  // interesPeriodo carga la ganancia → entra al KPI Ganancias del Dashboard
  // abonoCapital carga el capital → entra al calculo de Saldo Pendiente
  // cuotaTotal = capital + ganancia → entra al Recaudo del mes
  if (modalidad === 'Pago Unico') {
    var fechaCuotaPU = loan.fechaDevolucion || getPayDate(baseCron, 1, diaPago, freq);
    var capitalPU = Math.round(montoCOP);
    var gananciaPU = Math.round(+loan.gananciaFija || 0);
    rows.push({
      id: `${id}-1`, prestamoId: id, nombreCliente: nombre, cuotaN: 1,
      fechaPago: fechaCuotaPU,
      saldoInicial: capitalPU,
      interesPeriodo: gananciaPU,
      abonoCapital: capitalPU,
      cuotaTotal: capitalPU + gananciaPU,
      saldoFinal: 0, estadoPago: 'Pendiente', fechaRecaudo: null, observaciones: '',
      montoCOPRecibido: 0, montoUSDRecibido: 0, partialPaid: 0, extraConsolidado: 0
    });
    return rows;
  }

  // ── v2.2.0 — ARITMETICA EN PESOS ENTEROS ─────────────────────────────────
  // Antes el bucle calculaba a 2 decimales y arrastraba ESE saldo, pero persistia
  // Math.round(...) a pesos: lo guardado y lo computado hacia adelante divergian. Dos efectos:
  //  (a) la ultima cuota (residual = interes + saldo) caia 1 peso por debajo de las demas y el
  //      cliente veia "$105.999" donde el contrato decia "$106.000" -> parecia un error del recibo;
  //  (b) peor y silencioso: Σ abonoCapital daba 400.001 sobre un prestamo de 400.000, asi que la
  //      formula canonica de saldo (origCOP − Σ capital de Pagadas) se iba a negativo y solo la
  //      salvaba el Math.max(0, ...). Ese descuadre es la misma clase de fallo de los Bugs #35/#19.
  // Ahora el saldo camina en enteros: lo persistido ES lo computado. Por construccion,
  // interes + capital == cuota en cada fila y Σ capital == capital prestado, exacto.
  const cuotaNominal = Math.round(cuotaFija);
  saldo = Math.round(saldo);
  // Tolerancia del ajuste de la ultima cuota. El residuo de redondeo NO crece linealmente con el
  // plazo: el medio peso que se pierde al redondear el PMT se capitaliza periodo a periodo, asi
  // que a 48 cuotas puede llegar a varios cientos de pesos. Medido sobre 2.700 combinaciones, el
  // criterio que separa limpiamente los dos mundos es la diferencia como FRACCION de la cuota:
  //   - ruido de redondeo -> siempre una fraccion minima del valor de la cuota
  //   - globo legitimo    -> multiplos de la cuota (pasa cuando tasa y plazo son tan altos que el
  //                          PMT converge al interes puro y el prestamo no amortiza nada)
  // Solo se absorbe el primero. El segundo se respeta: ahi la ultima cuota SI es distinta de
  // verdad y ocultarlo seria mentir sobre la deuda.
  const tolResidual = Math.max(totalCuotas * 2 + 2, Math.ceil(cuotaNominal * 0.02));

  for (let i = 0; i < totalCuotas; i++) {
    const cuotaN = startN + i;
    let interes = Math.round(saldo * r);
    const isLast  = indefinido ? false : (i === totalCuotas - 1);
    let capital, cuota;

    if (indefinido || modalidad === 'Intereses') {
      // Solo intereses: el capital viaja completo a la ultima cuota (globo). Sin cambios.
      capital = isLast ? saldo : 0;
      cuota   = isLast ? interes + saldo : interes;
    } else if (isLast) {
      // Ultima cuota: el capital es el residual EXACTO -> Σ capital == prestado, siempre.
      capital = saldo;
      const cuotaNatural = interes + capital;
      // El interes nunca puede quedar negativo al absorber (pasaria si el capital residual
      // superara la cuota nominal); en ese caso la diferencia no es ruido y se respeta.
      if (Math.abs(cuotaNatural - cuotaNominal) <= tolResidual && cuotaNominal - capital >= 0) {
        // Diferencia = ruido de redondeo: la cuota final vale lo MISMO que las demas (es lo
        // pactado) y el interes absorbe el ajuste, que es donde contablemente corresponde.
        cuota = cuotaNominal;
        interes = cuota - capital;
      } else {
        cuota = cuotaNatural; // diferencia real (globo): se respeta
      }
    } else {
      // Cuotas regulares: valor nominal exacto; el capital es el complemento del interes.
      capital = Math.min(saldo, cuotaNominal - interes);
      cuota   = cuotaNominal;
    }

    const saldoFinal = Math.max(0, saldo - capital);
    rows.push({
      id: `${id}-${cuotaN}`, prestamoId: id, nombreCliente: nombre, cuotaN: cuotaN,
      fechaPago: getPayDate(baseCron, cuotaN, diaPago, freq),
      saldoInicial: saldo, interesPeriodo: interes,
      abonoCapital: capital, cuotaTotal: cuota,
      saldoFinal: saldoFinal,
      estadoPago: 'Pendiente', fechaRecaudo: null, observaciones: '',
      montoCOPRecibido: 0, montoUSDRecibido: 0, partialPaid: 0, extraConsolidado: 0
    });
    saldo = saldoFinal;
  }
  // La cuota de periodo irregular (si el prestamo tiene una) se deriva AQUI, sobre el capital
  // vivo de esta generacion. Va despues del ajuste de la ultima cuota: si la transitoria fuera
  // tambien la ultima, ese ajuste no puede deshacer el prorrateo.
  return aplicarPeriodoIrregular(loan, rows);
}

/**
 * buildScheduleFixedPMT — genera cronograma con cuota fija y cuota residual final.
 * Usado por opcion 3 del recalculo (Fijar valor de cuota).
 * Genera N-1 cuotas iguales de cuotaFija + 1 ultima cuota que ajusta el saldo a 0.
 *
 * @param {object} loan        - datos del prestamo (necesita id, nombre, fechaInicio, diaPago, frecuencia, modalidad, tasaMensual)
 * @param {number} startN      - numero de cuota inicial
 * @param {number} saldoInicial - saldo de capital sobre el cual aplicar
 * @param {number} cuotaFija   - cuota deseada por periodo (debe ser > saldoInicial * r)
 * @returns {Array<object>} - filas de cuotas (la ultima es la residual)
 * @throws Error si cuotaFija <= saldoInicial * r (cuota insuficiente para cubrir intereses)
 */
function buildScheduleFixedPMT(loan, startN, saldoInicial, cuotaFija) {
  const { id, nombre, tasaMensual, fechaInicio, diaPago } = loan;
  const freq = loan.frecuencia || 'Mensual';
  const baseCron = loan.fechaBaseCronograma || fechaInicio; // fechas via base de cronograma (aplazamiento)
  const r = tasaPeriodo(tasaMensual / 100, freq);
  const interesInicial = saldoInicial * r;
  // Validacion: cuota debe cubrir al menos el interes del primer periodo
  if (cuotaFija <= interesInicial) {
    throw new Error('Cuota insuficiente: $' + Math.round(cuotaFija).toLocaleString('es-CO') +
      ' no cubre el interes del primer periodo ($' + Math.round(interesInicial).toLocaleString('es-CO') + ').');
  }
  const rows = [];
  // v2.2.0 — pesos enteros, misma doctrina que buildSchedule: lo persistido ES lo computado
  // hacia adelante, asi que interes + capital == cuota y Σ capital == saldo inicial, exacto.
  // AQUI SI se conserva el residual visible de la ultima cuota: en "fijar cuota" el usuario
  // pacta un valor y el sobrante final es una consecuencia BUSCADA del modelo (N-1 iguales +
  // 1 residual), no ruido de redondeo como en el PMT.
  const cuotaEnt = Math.round(cuotaFija);
  let saldo = Math.round(saldoInicial);
  let cuotaN = startN;
  const MAX_ITER = 1000; // safety net
  let i = 0;
  while (saldo > 0 && i < MAX_ITER) {
    const interes = Math.round(saldo * r);
    // Si esta cuota completa o exceria el saldo, es la ultima (residual)
    const saldoMasInteres = saldo + interes;
    let capital, cuotaTotal, saldoFinal;
    if (saldoMasInteres <= cuotaEnt) {
      // Ultima cuota: residual exacto
      capital = saldo;
      cuotaTotal = saldoMasInteres;
      saldoFinal = 0;
    } else {
      capital = Math.min(saldo, cuotaEnt - interes);
      cuotaTotal = cuotaEnt;
      saldoFinal = Math.max(0, saldo - capital);
    }
    rows.push({
      id: `${id}-${cuotaN}`,
      prestamoId: id,
      nombreCliente: nombre,
      cuotaN: cuotaN,
      fechaPago: getPayDate(baseCron, cuotaN, diaPago, freq),
      saldoInicial: Math.round(saldo),
      interesPeriodo: Math.round(interes),
      abonoCapital: Math.round(capital),
      cuotaTotal: Math.round(cuotaTotal),
      saldoFinal: Math.round(saldoFinal),
      estadoPago: 'Pendiente',
      fechaRecaudo: null,
      observaciones: '',
      montoCOPRecibido: 0,
      montoUSDRecibido: 0,
      partialPaid: 0,
      extraConsolidado: 0
    });
    saldo = saldoFinal;
    cuotaN++;
    i++;
  }
  if (i >= MAX_ITER) throw new Error('Cuota demasiado baja: requiere mas de ' + MAX_ITER + ' cuotas para saldar.');
  // Tambien aqui: un abono o una reestructura con "fijar cuota" regenera la transitoria por
  // este generador, no por `buildSchedule`.
  return aplicarPeriodoIrregular(loan, rows);
}

// ══════════════════════════════════════════════════════════════════════════════
// INTERES DIARIO — el motor del credito abierto (capital vivo)
// ══════════════════════════════════════════════════════════════════════════════
//
// No hay cronograma. El interes se devenga por DIAS sobre el capital vivo, y solo
// se materializa una fila cuando ocurre un evento economico real: el CORTE
// (id `${loanId}-ct-${n}`), donde el cliente paga intereses y/o abona a capital.
//
// Todo lo de aqui es PURO: recibe el prestamo y sus cortes YA LEIDOS, y no toca la
// BD. Es lo que permite probar la matematica sin levantar nada.
//
// ── CONVENCION DE DIAS (decision de negocio: "reutilicemos la logica que ya existe")
// La formula es la MISMA que el prorrateo de `/cambiar-dia-pago`:
//       interes = saldo * (tasaMensual/100) * dias / 30
// es decir DIAS REALES de calendario divididos entre 30. Ojo con el nombre: esto
// NO es la convencion bursatil "30/360" (que cuenta todos los meses como de 30
// dias); es Actual/360 — cada dia real vale 1/30 de la tasa mensual. La diferencia
// es observable: un mes de 31 dias cobra 31/30 de la tasa mensual, y un ano cobra
// 365/360 = 1,39% mas que doce mensualidades. Es el comportamiento estandar en
// credito y es el que la app YA aplica desde v1.14.0; duplicar una convencion
// distinta aqui seria tener dos matematicas para lo mismo.
//
// ── TRAMOS SEMIABIERTOS [desde, hasta) (decision de negocio) ────────────────────
// Cada tramo incluye su dia inicial y EXCLUYE el final. Consecuencias, las dos
// buscadas:
//   (a) dos cortes el mismo dia producen un tramo de 0 dias -> 0 interes, en vez
//       de un "dia fantasma" cobrado dos veces;
//   (b) los tramos PARTICIONAN la linea de tiempo exactamente: sin solapes y sin
//       huecos, asi que ningun dia se cobra dos veces ni se pierde.
// EFECTO A TENER PRESENTE: el dia del corte pertenece al tramo SIGUIENTE, luego un
// abono reduce la base ESE MISMO DIA. El requisito original hablaba de "a partir
// del dia siguiente", que es un dia mas de interes a la base vieja. Las dos reglas
// son coherentes consigo mismas; se implemento la semiabierta por (a) y (b).
// Para cambiarla NO hay que tocar el bucle: basta poner DIA_DEL_CORTE_A_BASE_VIEJA
// en true, y el tramo que cierra en un corte contara ese dia.
const DIA_DEL_CORTE_A_BASE_VIEJA = false;

// Dias reales entre dos fechas ISO. Anclado a las 12:00 como TODO el resto del
// proyecto: a medianoche, un desfase de horas por zona horaria cambia el dia y por
// tanto el interes. A mediodia hacen falta 12 horas de error para equivocarse de dia.
function diasEntre(desdeISO, hastaISO) {
  const a = new Date(String(desdeISO) + 'T12:00:00');
  const b = new Date(String(hastaISO) + 'T12:00:00');
  if (isNaN(a) || isNaN(b)) return 0;
  return Math.round((b - a) / 86400000);
}

// Interes de UN tramo, en pesos enteros.
// Se redondea POR TRAMO, no por dia: el tramo es lo que se persiste (el
// `interesPeriodo` de un corte), asi que redondear ahi hace que lo guardado sea
// exactamente lo computado — misma doctrina de pesos enteros de v2.2.0 (Bug #43).
// Redondear cada dia acumularia un error que no vive en ninguna columna.
function interesDeTramo(saldo, tasaMensual, dias) {
  if (!(dias > 0) || !(saldo > 0)) return 0;
  return Math.round(saldo * ((+tasaMensual || 0) / 100) * dias / 30);
}

/**
 * devengoDiario — reconstruye el devengo completo de un credito abierto.
 *
 * @param {object} loan          fila de `loans` (modalidad Interes Diario)
 * @param {Array}  cortes        filas '-ct-' de ese prestamo (en cualquier orden)
 * @param {string} hastaISO      fecha de corte del calculo, 'YYYY-MM-DD'
 * @returns {object} desglose completo (ver abajo)
 *
 * LA BASE ES EL SALDO DEL MOTOR (decision de negocio): capital prestado menos el
 * capital REALMENTE abonado en los cortes. No se usa `saldoConCaja` ni ninguna
 * cifra de presentacion: el devengo es una DECISION (cuanto se debe), y en este
 * proyecto las decisiones las gobierna el saldo del motor. Ver la doctrina de los
 * dos saldos en CLAUDE.md.
 *
 * SIN CAPITALIZACION (decision de negocio): el interes no pagado NO se suma a la
 * base. Un credito con intereses atrasados sigue devengando sobre el capital, no
 * sobre capital+intereses. Ademas de ser lo pactado, evita el anatocismo.
 *
 * RETROACTIVIDAD: no es un caso especial. Si `fechaInicio` esta en el pasado y no
 * hay cortes, sale UN tramo [fechaInicio, hasta) con todos los dias transcurridos.
 * La creacion retroactiva funciona porque el modelo es "tramos entre eventos", no
 * "un contador que empieza hoy".
 */
function devengoDiario(loan, cortes, hastaISO) {
  const tasaMensual = +loan.tasaMensual || 0;
  const origCOP = loan.moneda === 'USD'
    ? Math.round(loan.montoOrigen * loan.trmAcordada)
    : Math.round(loan.montoOrigen);

  // Orden cronologico; desempate por cuotaN para que dos cortes del mismo dia
  // tengan un orden estable y reproducible (si no, el reparto de tramos de 0 dias
  // dependeria del orden en que SQLite devolviera las filas).
  const ord = (cortes || []).slice().sort((a, b) => {
    const c = String(a.fechaPago).localeCompare(String(b.fechaPago));
    return c !== 0 ? c : (a.cuotaN - b.cuotaN);
  });

  const tramos = [];
  let saldo = origCOP;
  let cursor = loan.fechaInicio;
  let interesDevengado = 0;
  let interesCobrado = 0;
  let capitalAbonado = 0;

  const empujar = (desde, hasta, base) => {
    let dias = diasEntre(desde, hasta);
    if (dias < 0) dias = 0;                    // corte anterior al cursor: tramo nulo, nunca negativo
    const interes = interesDeTramo(base, tasaMensual, dias);
    tramos.push({ desde: desde, hasta: hasta, dias: dias, base: base, interes: interes });
    interesDevengado += interes;
  };

  ord.forEach((c) => {
    const fin = DIA_DEL_CORTE_A_BASE_VIEJA ? sumarDias(c.fechaPago, 1) : c.fechaPago;
    empujar(cursor, fin, saldo);
    // El corte consuma el evento: baja el capital y registra lo cobrado.
    const abono = Math.round(+c.abonoCapital || 0);
    capitalAbonado += abono;
    saldo = Math.max(0, saldo - abono);        // el capital vivo nunca es negativo
    interesCobrado += Math.round(+c.interesPeriodo || 0);
    cursor = fin;
  });

  // Tramo abierto: desde el ultimo evento hasta la fecha consultada.
  empujar(cursor, hastaISO, saldo);

  const ultimo = ord.length ? ord[ord.length - 1] : null;
  return {
    origCOP: origCOP,
    capitalVivo: saldo,
    capitalAbonado: capitalAbonado,
    tramos: tramos,
    interesDevengado: interesDevengado,
    interesCobrado: interesCobrado,
    // Lo que el cliente debe HOY de intereses. Clamp a 0: si pago de mas en un
    // corte (redondeo, o un pago voluntario por encima), no se le queda debiendo
    // al reves — ese excedente es un asunto del corte, no del devengo.
    interesPendiente: Math.max(0, interesDevengado - interesCobrado),
    fechaUltimoCorte: ultimo ? ultimo.fechaPago : null,
    diasDesdeUltimoCorte: diasEntre(ultimo ? ultimo.fechaPago : loan.fechaInicio, hastaISO),
    diasTotales: diasEntre(loan.fechaInicio, hastaISO),
    // Lo que se persiste en las columnas cache de `loans`. Aqui se derivan para que
    // exista UNA sola formula: la ruta que escribe (POST /corte) usa esto, no su
    // propia cuenta.
    //
    // `fechaUltimoCorte` cae a `fechaInicio` cuando aun no hay cortes, y NO a NULL.
    // El proyecto tiene el precedente contrario (`fechaBaseCronograma` es NULL y el
    // lector hace el fallback), pero aqui el modo de fallo es peor: un lector que
    // olvide el fallback pasaria `null` a `diasEntre`, que devuelve 0 sin quejarse
    // — es decir, INTERES CERO EN SILENCIO. Guardando siempre una fecha valida, ese
    // camino no existe. La columna significa "desde cuando corre el tramo abierto".
    cache: {
      fechaUltimoCorte: ultimo ? ultimo.fechaPago : loan.fechaInicio,
      interesAcumuladoPend: Math.max(0, interesDevengado - interesCobrado
        - tramos[tramos.length - 1].interes),
    },
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// PERIODO IRREGULAR — la cuota transitoria, derivada en el motor (3.2.0, Fase 1)
// ══════════════════════════════════════════════════════════════════════════════
//
// Una cuota cuyo periodo no es un mes calendario: hoy, la primera cuota despues de
// "Cambiar fecha". Su interes se cobra por los DIAS REALES del periodo con la misma
// formula del devengo diario (`interesDeTramo`: saldo * tasa/100 * dias / 30), mas la
// mora que ese cambio consolido. En Capital + Intereses el capital de la cuota NO se
// toca: solo cambia su interes (doctrina de v1.14.0), asi que la amortizacion sigue
// intacta y `interes + capital == cuota` se sostiene por construccion.
//
// EL PRESTAMO GUARDA LA DECISION, NO EL MONTO:
//   periodoIrregularN      cuotaN de la cuota transitoria
//   periodoIrregularDesde  fecha desde la que corre su periodo
//   periodoIrregularMora   mora consolidada, en pesos. Es deuda YA CAUSADA: no depende
//                          del capital y no se recalcula nunca.
// El motor deriva el interes cada vez que genera esa fila, sobre el capital vivo de
// ESA generacion.
//
// Por que: hasta 3.1.0 se guardaba el MONTO del ajuste (`proximaCuotaExtra`), calculado
// una sola vez con el saldo del dia del cambio. Un abono posterior regeneraba la cuota
// sin el ajuste y el siguiente arranque de la app le sumaba el monto viejo. Medido con
// el server real: 583.333 (35 dias sobre 10M) -> abono de 8M -> 100.000 -> al reabrir
// la app 183.333, cuando lo correcto era 116.667. Guardado como monto NEGATIVO (un
// periodo corto) el mismo camino llega a un interes negativo.
//
// Vive dentro de `buildSchedule` y `buildScheduleFixedPMT`, que son el sumidero comun
// de las cinco rutas que regeneran cuotas: ninguna tiene que acordarse de aplicarlo.
//
// NO se limpia al pagar la cuota. Una vez Pagada o En Mora, la fila no se regenera y
// estas columnas quedan inertes; si el pago se revierte a Pendiente, la transitoria
// renace bien. (La columna vieja SI se limpiaba al pagar, y revertir la perdia.)

// Cuanto vale la transitoria sobre UNA fila ya generada. Pura: la usan el motor, la
// ruta de cambio de dia (para su respuesta) y la migracion de los datos viejos.
function transitoriaDe(loan, row) {
  const dias = Math.max(1, diasEntre(loan.periodoIrregularDesde, row.fechaPago));
  const prorrateado = interesDeTramo(row.saldoInicial, loan.tasaMensual, dias);
  const mora = Math.max(0, Math.round(+loan.periodoIrregularMora || 0));
  const interes = prorrateado + mora;
  // `ajuste` = lo que la transitoria cambia sobre la cuota de mes completo. Con signo:
  // negativo en un periodo corto, positivo en uno largo o con mora consolidada.
  return { dias, prorrateado, mora, interes, ajuste: interes - row.interesPeriodo };
}

// Aplica la transitoria a la fila que le toca, si esta generacion la incluye. Muta y
// devuelve el mismo arreglo.
function aplicarPeriodoIrregular(loan, rows) {
  const n = +(loan && loan.periodoIrregularN) || 0;
  if (!n || !loan.periodoIrregularDesde) return rows;
  // Solo las modalidades de cuota periodica con interes. En Prestamo y Pago Unico no hay
  // periodo que prorratear, y el credito abierto ya cobra por dias.
  if (loan.modalidad !== 'Intereses' && loan.modalidad !== 'Capital + Intereses') return rows;
  const row = rows.find(p => p.cuotaN === n);
  if (!row) return rows;
  const t = transitoriaDe(loan, row);
  row.interesPeriodo = t.interes;
  row.cuotaTotal = row.cuotaTotal + t.ajuste;
  // `extraConsolidado` es la marca que ya leen el Recibo de Pago, la Factura de Cobro y el
  // Reporte de Activos para rotular la cuota como transitoria. Mismo valor que antes.
  row.extraConsolidado = t.ajuste;
  row.observaciones = 'Cuota transitoria: interes de ' + t.dias + ' dias prorrateado'
    + (t.mora > 0 ? ' + mora consolidada $' + t.mora.toLocaleString('es-CO') : '');
  return rows;
}

// ══════════════════════════════════════════════════════════════════════════════
// PRIMER PAGO elegido al crear (3.2.0, Fase 2)
// ══════════════════════════════════════════════════════════════════════════════
//
// El formulario deja elegir la FECHA del primer pago. Aqui se traduce a columnas que el
// motor YA entiende, asi que ningun generador cambia:
//   diaPago               dia del mes del primer pago: las cuotas siguientes caen ese dia
//   fechaBaseCronograma   el mes ANTERIOR al primer pago, de modo que
//                         getPayDate(base, 1, diaPago) === primerPago
//   periodoIrregular*     si el periodo no es un mes calendario y se eligio 'proporcional',
//                         la cuota 1 es la transitoria de la Fase 1: N=1, desde=fechaInicio.
//                         Con 'completo' la cuota 1 cobra un mes, como hasta ahora.
//
// "Irregular" se decide por CALENDARIO, no por dias: el primer pago regular es el mismo dia
// del mes siguiente (acotado a fin de mes). Si se midiera "dias != 30", la pregunta saltaria
// en todo prestamo que arranca en enero, febrero o julio, que hoy se cobran como mes completo.
//
// SIN LIMITE SUPERIOR (regla del PO): un "tiempo muerto" de 3 meses cobra, en proporcional,
// los ~92 dias en la cuota 1, con la misma formula de dias reales / 30.
//
// Si la fecha elegida ES la regular, el resultado es identico a no haber elegido nada
// (diaPago = dia de inicio, sin base, sin transitoria): el prestamo queda byte a byte igual.
const RE_FECHA_ISO = /^\d{4}-\d{2}-\d{2}$/;
function fechaIsoValida(s) {
  if (!RE_FECHA_ISO.test(String(s))) return false;
  const d = new Date(s + 'T12:00:00');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
function primerPagoRegular(fechaInicio) {
  return getPayDate(fechaInicio, 1, +String(fechaInicio).slice(8, 10), 'Mensual');
}
function resolverPrimerPago(loan, primerPago, primerPeriodo) {
  const modo = (primerPeriodo === undefined || primerPeriodo === null || primerPeriodo === '') ? 'proporcional' : primerPeriodo;
  if (modo !== 'proporcional' && modo !== 'completo') {
    throw new ClientError('Primer periodo invalido: "' + primerPeriodo + '". Debe ser "proporcional" o "completo".');
  }
  if (loan.modalidad !== 'Intereses' && loan.modalidad !== 'Capital + Intereses') {
    throw new ClientError('La fecha del primer pago solo aplica a creditos de Intereses o Capital + Intereses (modalidad: ' + loan.modalidad + ').');
  }
  if ((loan.frecuencia || 'Mensual') !== 'Mensual') {
    throw new ClientError('La fecha del primer pago solo aplica a la frecuencia Mensual.');
  }
  if (!fechaIsoValida(loan.fechaInicio)) throw new ClientError('Fecha de inicio invalida: "' + loan.fechaInicio + '".');
  if (!fechaIsoValida(primerPago)) throw new ClientError('Fecha del primer pago invalida: "' + primerPago + '".');
  if (primerPago <= loan.fechaInicio) throw new ClientError('El primer pago debe ser posterior a la fecha de inicio.');
  const sinTransitoria = { periodoIrregularN: null, periodoIrregularDesde: null, periodoIrregularMora: 0 };
  if (primerPago === primerPagoRegular(loan.fechaInicio)) {
    return Object.assign({ irregular: false, diaPago: +loan.fechaInicio.slice(8, 10), fechaBaseCronograma: null }, sinTransitoria);
  }
  const b = new Date(primerPago + 'T12:00:00');
  b.setDate(1);                       // evita el desborde de mes antes de restar
  b.setMonth(b.getMonth() - 1);
  const base = b.toISOString().split('T')[0];
  const dia = +primerPago.slice(8, 10);
  // Defensivo: la base tiene que reproducir la fecha elegida con el MISMO calculo del motor.
  if (getPayDate(base, 1, dia, 'Mensual') !== primerPago) {
    throw new ClientError('No se pudo fijar el primer pago en ' + primerPago + '.');
  }
  const proporcional = modo === 'proporcional' && (+loan.tasaMensual || 0) > 0;
  return Object.assign({ irregular: true, diaPago: dia, fechaBaseCronograma: base },
    proporcional ? { periodoIrregularN: 1, periodoIrregularDesde: loan.fechaInicio, periodoIrregularMora: 0 } : sinTransitoria);
}

// Suma dias a una fecha ISO y devuelve ISO. Solo la usa la variante
// DIA_DEL_CORTE_A_BASE_VIEJA, pero vive aqui para no repetir el anclaje a mediodia.
function sumarDias(iso, n) {
  const d = new Date(String(iso) + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

module.exports = {
  MODALIDAD_DIARIA,
  MODALIDADES_CONOCIDAS,
  diasEntre,
  sumarDias,
  interesDeTramo,
  devengoDiario,
  pmt,
  getPayDate,
  tasaPeriodo,
  cuotasHastaHoy,
  buildSchedule,
  buildScheduleFixedPMT,
  transitoriaDe,
  aplicarPeriodoIrregular,
  primerPagoRegular,
  resolverPrimerPago,
};
