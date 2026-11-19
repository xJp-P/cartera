// public/js/core/unificacion.js — UNIFICAR los prestamos de un deudor (post-4.0.0).
//
// Lo consumen el modal (`UnificarModal`) y los dos documentos (propuesta y constancia). El server
// tiene su ESPEJO (`backend/core/unificacion.js`): recalcula todo y rechaza si no coincide con lo
// que el usuario vio. La suite `unificacion` fija la paridad entre los dos y con el motor.
//
// La idea que lo sostiene: UNIFICAR = LIQUIDAR cada prestamo, pero en vez de entrar dinero entra
// un PRESTAMO NUEVO. Lo que cada uno traslada sale de `computeLiquidacion` (la misma cifra de
// "Liquidar hoy": hereda la semantica ya aprobada de cada modalidad), partido en dos:
//   - capital: el capital pendiente;
//   - intereses vencidos: cuotas vencidas + mora consolidada + devengo del credito abierto;
//   y lo ya abonado a cuotas sin saldar se descuenta en el orden del art. 1653: primero los
//   intereses (vencidos y, si se cobra, el ya corrido), luego el capital.
// Ademas, dos piezas opcionales: el interes YA CORRIDO del periodo en curso (una casilla POR
// CREDITO, desmarcadas por defecto) y, en un Pago Unico que aun no vence, su ganancia pactada
// (marcada por defecto).
//
// LA FECHA DE LA UNIFICACION (`opc.fecha`, por defecto hoy). Una unificacion se puede acordar un
// dia y registrarse despues: todo se calcula AL DIA de la unificacion, no al de hoy.
//   - Una cuota es VENCIDA si vencia ese dia o antes (`fechaPago <= fecha`); las que vencieron
//     despues (aunque hoy figuren En Mora por la auto-mora) eran por vencer: su periodo es el que
//     estaba EN CURSO, y su interes es interes corrido, no vencido.
//   - El interes ya corrido cuenta los dias desde la ultima cuota facturada hasta la fecha.
//   - El prestamo nuevo empieza ese dia: primer pago, cronograma y dias de gracia salen de ahi.
//   - La fecha no puede ser anterior a ningun movimiento de los prestamos que se unen (un pago
//     registrado despues de unificar no tendria donde vivir) ni al inicio de ninguno, y no puede
//     ser futura (`limitesFecha`).
//
// El interes ya corrido NO es el de Liquidar (un periodo entero): el prestamo nuevo cobra interes
// desde la fecha de la unificacion, asi que cobrar el periodo completo cobraria dos veces los dias
// que faltaban. Son solo los dias ya corridos, sobre el capital de la cuota en curso (su saldo
// inicial: el capital de una cuota vencida ya no corre), con la formula de dias del motor.
//
// Que hacer con los intereses que se trasladan (decision del PO, cuatro opciones):
//   'repartir'  en partes iguales entre las cuotas del nuevo (en Intereses, entre las N primeras);
//   'primera'   todos a la primera cuota;
//   'capital'   se suman al capital del nuevo y generan interes (capitalizacion);
//   'condonar'  se perdonan.
// En 'repartir' y 'primera' son una CARGA fija sin intereses encima (el motor la deriva en las
// cuotas: `cargaTrasladada` + `cargaCuotas`). Un credito abierto (Interes Diario) no tiene
// cuotas donde cargarlos, y su interes se DERIVA de los cortes (no hay donde dejarlo pendiente
// sin que el devengo lo ignore): ahi solo se suman al capital o se condonan.
//
// Puro: no toca la BD ni el reloj (`hoy` y la fecha son PARAMETROS). El cronograma del nuevo sale
// del espejo del motor (`filasPreview`, la transitoria y las fechas de calculo.js); la prueba de
// paridad contra `buildSchedule` es la que lo fija.

import {
  computeLiquidacion, diasEntre, esDiario, interesPeriodoParcial, tasaDelPeriodo, MODALIDAD_DIARIA,
} from './dominio.js';
import {
  pmt, filasPreview, aplicarTransitoriaPreview, fechaPagoFrecuencia, primerPagoRegular, inicioPeriodoRegular,
  infoPrimerPeriodo,
} from './calculo.js';

var esAbonoU = function(p){ return String(p.id).indexOf('-ab-') !== -1; };
var esCorteU = function(p){ return String(p.id).indexOf('-ct-') !== -1; };
var regularU = function(p){ return !esAbonoU(p) && !esCorteU(p); };
var deU = function(loan, pays){ return (pays || []).filter(function(p){ return String(p.prestamoId) === String(loan.id); }); };
var porFecha = function(a, b){ return a.fechaPago < b.fechaPago ? -1 : a.fechaPago > b.fechaPago ? 1 : a.cuotaN - b.cuotaN; };
var recibosU = function(p){ try { var r = JSON.parse(p.recibos || '[]'); return Array.isArray(r) ? r : []; } catch (e) { return []; } };

var UN_MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
function unFechaLarga(iso){ var d = new Date(String(iso).slice(0, 10) + 'T12:00:00'); return d.getDate() + ' de ' + UN_MESES[d.getMonth()] + ' de ' + d.getFullYear(); }

export var UN_DESTINOS = ['repartir', 'primera', 'capital', 'condonar'];
export var UN_PERIODOS_ANIO = { Mensual: 12, Quincenal: 24, Semanal: 52 };

// ── LA FECHA: DESDE CUANDO Y HASTA CUANDO ────────────────────────────────────
// El ultimo movimiento de cada prestamo (su inicio, cada cobro, cada abono o corte) acota la fecha
// por abajo; hoy la acota por arriba.
export function limitesFecha(loans, pays, hoy){
  var min = '', motivo = '';
  loans.forEach(function(l){
    var cand = [[l.fechaInicio, 'empezó uno de los préstamos']];
    deU(l, pays).forEach(function(p){
      if (p.estadoPago === 'Pagado' && p.fechaRecaudo) cand.push([String(p.fechaRecaudo).slice(0, 10), 'se registró un pago']);
      if (!regularU(p) && p.fechaPago) cand.push([p.fechaPago, esCorteU(p) ? 'se registró un corte' : 'se registró un abono']);
      recibosU(p).forEach(function(r){ if (r && r.fecha) cand.push([String(r.fecha).slice(0, 10), 'se registró un pago']); });
    });
    cand.forEach(function(c){ if (c[0] && c[0] > min) { min = c[0]; motivo = c[1]; } });
  });
  return { min: min, max: hoy, motivo: motivo };
}

// Las cuotas tal como estaban EL DIA de la unificacion: vencida = vencia ese dia o antes.
function alDia(ps, fecha){
  return ps.map(function(p){
    if (!regularU(p) || p.estadoPago === 'Pagado') return p;
    var venc = p.fechaPago <= fecha;
    if (venc && p.estadoPago !== 'En Mora') return Object.assign({}, p, { estadoPago: 'En Mora' });
    if (!venc && p.estadoPago === 'En Mora') return Object.assign({}, p, { estadoPago: 'Pendiente' });
    return p;
  });
}

// ── LO QUE TRASLADA UN PRESTAMO ──────────────────────────────────────────────
// opc: { fecha, corrido (cobrar su interes ya corrido), ganancia (Pago Unico: trasladar la pactada) }
export function trasladoDe(loan, pays, fecha, opc){
  opc = opc || {};
  var ps = alDia(deU(loan, pays), fecha);
  var liq = computeLiquidacion(loan, ps, { hasta: fecha });
  var intVencido = liq.intMora + liq.moraConsolidada + liq.interesDevengado;
  // Interes ya corrido del periodo en curso: desde la ultima cuota ya facturada (o el arranque de
  // los intereses) hasta la fecha, sobre el capital de Liquidar. Con lo necesario para decidir:
  // cuantos dias corrieron, de cuantos tiene el periodo, cuando vence y cuantos faltan.
  var corrido = { aplica: false, desde: null, dias: 0, diasPeriodo: 0, proximo: null, faltan: 0, monto: 0,
    interesCuota: 0, enGracia: !!liq.enGracia, graciaHasta: liq.graciaHasta };
  if (liq.aplicaInteres && !esDiario(loan)) {
    var regs = ps.filter(regularU).sort(porFecha);
    var facturadas = regs.filter(function(p){ return p.fechaPago <= fecha; });
    var prox = regs.filter(function(p){ return p.fechaPago > fecha && p.estadoPago !== 'Pagado'; })[0] || null;
    var desde = facturadas.length ? facturadas[facturadas.length - 1].fechaPago : (loan.fechaInicioIntereses || loan.fechaInicio);
    // Sin una cuota por vencer (el plazo ya termino) no hay periodo en curso: el motor no sigue
    // cobrando interes despues de la ultima cuota (las vencidas quedan congeladas).
    var sinCuotas = !prox && loan.modalidad !== 'Intereses';
    var dias = (liq.enGracia || sinCuotas) ? 0 : Math.max(0, diasEntre(desde, fecha));
    corrido = { aplica: !liq.enGracia && !sinCuotas, sinCuotas: sinCuotas, desde: desde, dias: dias,
      diasPeriodo: prox ? Math.max(0, diasEntre(desde, prox.fechaPago)) : 0,
      proximo: prox ? prox.fechaPago : null, faltan: prox ? Math.max(0, diasEntre(fecha, prox.fechaPago)) : 0,
      interesCuota: prox ? Math.round(prox.interesPeriodo) : 0,
      // La base es el capital sobre el que corre ESA cuota (su saldo inicial): el de una cuota
      // vencida queda congelado en el motor y no sigue generando interes. Asi lo corrido nunca
      // supera lo que la propia cuota cobra por su periodo.
      monto: (liq.enGracia || sinCuotas) ? 0 : interesPeriodoParcial(prox ? Math.round(+prox.saldoInicial || 0) : liq.capitalPendiente,
        +loan.tasaMensual || 0, loan.frecuencia || 'Mensual', dias),
      enGracia: !!liq.enGracia, graciaHasta: liq.graciaHasta };
  }
  // Pago Unico que aun no vence: su ganancia pactada no esta en Liquidar (alli no aplica interes).
  var gananciaPU = 0;
  if (loan.modalidad === 'Pago Unico') {
    var unica = ps.filter(function(p){ return regularU(p) && p.estadoPago !== 'Pagado'; })[0];
    if (unica && unica.estadoPago === 'Pendiente') gananciaPU = Math.max(0, Math.round(+loan.gananciaFija || 0));
  }
  var conPU = gananciaPU > 0 && opc.ganancia !== false;
  var conCorrido = !!opc.corrido && corrido.monto > 0;
  // Los intereses causados que se trasladan, y lo ya abonado: primero a ellos, luego al capital.
  var causados = intVencido + (conCorrido ? corrido.monto : 0) + (conPU ? gananciaPU : 0);
  var aInteres = Math.min(causados, liq.partialPend);
  var aCapital = liq.partialPend - aInteres;
  var capital = liq.capitalPendiente - aCapital;
  var interes = causados - aInteres;
  // Lo que falta por cobrar si el prestamo sigue como va (las cuotas sin saldar menos lo abonado).
  var abiertas = ps.filter(function(p){ return regularU(p) && p.estadoPago !== 'Pagado'; }).sort(porFecha);
  var vencidas = abiertas.filter(function(p){ return p.estadoPago === 'En Mora'; });
  var vencido = vencidas.reduce(function(s, p){ return s + p.cuotaTotal - (p.partialPaid || 0); }, 0);
  var porVencer = abiertas.filter(function(p){ return p.estadoPago !== 'En Mora'; });
  // El capital de REFERENCIA para comparar ganancias: lo abonado cubre primero TODO el interes
  // causado (vencido, corrido y pactado), cobrese o no. Asi "si siguen como van" no se mueve al
  // marcar una casilla, y lo que no se cobra se ve como ganancia que se deja de hacer.
  var capitalRef = liq.capitalPendiente - Math.max(0, liq.partialPend - (intVencido + corrido.monto + gananciaPU));
  return {
    loan: loan, liq: liq, capitalRef: capitalRef,
    capital: capital, intVencido: intVencido, abonado: liq.partialPend, aInteres: aInteres, aCapital: aCapital,
    // Compatibilidad con el modal y el documento: los intereses vencidos que quedan tras el abono.
    intNeto: Math.max(0, intVencido - aInteres),
    corrido: corrido, conCorrido: conCorrido, gananciaPU: gananciaPU, conPU: conPU,
    interes: interes, total: capital + interes,
    vencido: vencido, cuotasVencidas: vencidas.length,
    pagadas: ps.filter(function(p){ return regularU(p) && p.estadoPago === 'Pagado'; }).length,
    abiertas: abiertas, porVencer: porVencer,
    ultima: abiertas.length ? abiertas[abiertas.length - 1].fechaPago : null
  };
}

// ── SI SIGUEN COMO VAN ───────────────────────────────────────────────────────
// Para comparar: lo que falta por cobrar de cada prestamo y su cuota normal por mes. Un credito
// de Intereses o abierto no tiene fin: se proyecta hasta `horizonte` (la ultima cuota del nuevo),
// devolviendo el capital ese dia; asi se comparan los dos caminos sobre el mismo tiempo.
export function situacionActual(traslados, fecha, horizonte){
  var total = 0, porMes = 0, ultima = null, proyectado = false;
  traslados.forEach(function(t){
    var l = t.loan, freq = l.frecuencia || 'Mensual';
    var falta;
    if (l.modalidad === 'Intereses' || esDiario(l)) {
      proyectado = true;
      // Intereses: lo vencido + el capital + el interes desde la ultima cuota facturada hasta el
      // horizonte. Abierto: el capital + el devengo a la fecha + el interes de la fecha al horizonte.
      var desdeH = esDiario(l) ? fecha : (t.corrido.desde || fecha);
      var diasH = horizonte ? Math.max(0, diasEntre(desdeH, horizonte)) : 0;
      falta = t.capital + t.aCapital + (esDiario(l) ? t.intVencido : t.vencido) - (esDiario(l) ? t.abonado : 0) +
        interesPeriodoParcial(t.capital + t.aCapital, +l.tasaMensual || 0, esDiario(l) ? 'Mensual' : freq, diasH);
      porMes += Math.round((t.capital + t.aCapital) * (+l.tasaMensual || 0) / 100);
      if (horizonte && (!ultima || horizonte > ultima)) ultima = horizonte;
    } else {
      falta = t.abiertas.reduce(function(s, p){ return s + p.cuotaTotal - (p.partialPaid || 0); }, 0);
      // La cuota normal: la segunda por vencer si hay (la primera puede ser transitoria), si no la unica.
      var nor = t.porVencer.length > 1 ? t.porVencer[1] : t.porVencer[0];
      if (nor) porMes += Math.round(nor.cuotaTotal * (UN_PERIODOS_ANIO[freq] || 12) / 12);
      if (t.ultima && (!ultima || t.ultima > ultima)) ultima = t.ultima;
    }
    total += falta;
  });
  var vencido = traslados.reduce(function(s, t){ return s + t.vencido; }, 0);
  return { total: total, porMes: porMes, vencido: vencido, ultima: ultima, proyectado: proyectado };
}

// ── LA BASE DE FECHAS DEL NUEVO (espejo de `resolverPrimerPago`) ─────────────
function baseYDia(inicio, primerPago, freq){
  if (!primerPago || primerPago === primerPagoRegular(inicio, freq)) return { base: inicio, dia: +inicio.slice(8, 10) };
  if (freq === 'Mensual') {
    var b = new Date(primerPago + 'T12:00:00');
    b.setDate(1); b.setMonth(b.getMonth() - 1);
    return { base: b.toISOString().split('T')[0], dia: +primerPago.slice(8, 10) };
  }
  return { base: inicioPeriodoRegular(primerPago, freq), dia: +primerPago.slice(8, 10) };
}

// ── EL PLAN COMPLETO ─────────────────────────────────────────────────────────
// opc: { fecha, corridos: {loanId: bool} (o corrido: true = todos), ganancias: {loanId: bool},
//        destino, cuotasReparto,
//        nuevo: { modalidad, tasaMensual, plazo, frecuencia, primerPago, primerPeriodo } }
export function planUnificacion(loans, pays, hoy, opc){
  opc = opc || {};
  var pedida = opc.fecha === undefined ? hoy : String(opc.fecha || '');
  var valida = /^\d{4}-\d{2}-\d{2}$/.test(pedida);
  var fecha = valida ? pedida : hoy;          // con una fecha invalida se calcula a hoy, pero no se deja confirmar
  var lim = limitesFecha(loans, pays, hoy);
  var errorFecha = !valida ? 'Elige la fecha de la unificación.'
    : fecha > lim.max ? 'La unificación no puede ser en una fecha futura.'
    : (lim.min && fecha < lim.min) ? 'No puede ser antes del ' + unFechaLarga(lim.min) + ': ese día ' + lim.motivo + '.' : null;
  var gan = opc.ganancias || {};
  var corr = opc.corridos || {};
  var traslados = loans.map(function(l){
    return trasladoDe(l, pays, fecha, { corrido: opc.corrido === true || !!corr[l.id], ganancia: gan[l.id] });
  });
  var capital = traslados.reduce(function(s, t){ return s + t.capital; }, 0);
  var interes = traslados.reduce(function(s, t){ return s + t.interes; }, 0);
  var corridoTotal = traslados.reduce(function(s, t){ return s + t.corrido.monto; }, 0);
  var corridoCobrado = traslados.reduce(function(s, t){ return s + (t.conCorrido ? t.corrido.monto : 0); }, 0);
  var monedas = loans.map(function(l){ return l.moneda || 'COP'; }).filter(function(m, i, a){ return a.indexOf(m) === i; });
  // La tasa por defecto: el promedio ponderado por el capital que traslada cada prestamo.
  var conTasa = traslados.filter(function(t){ return (+t.loan.tasaMensual || 0) > 0; });
  var base = conTasa.reduce(function(s, t){ return s + t.capital; }, 0);
  var tasaPonderada = base > 0 ? conTasa.reduce(function(s, t){ return s + t.capital * (+t.loan.tasaMensual); }, 0) / base : 0;
  var tasaMax = conTasa.reduce(function(m, t){ return Math.max(m, +t.loan.tasaMensual); }, 0);

  var n = opc.nuevo || {};
  var modalidad = n.modalidad || 'Capital + Intereses';
  var diario = modalidad === MODALIDAD_DIARIA;
  var freq = diario ? 'Mensual' : (n.frecuencia || 'Mensual');
  var tasa = n.tasaMensual === undefined || n.tasaMensual === '' ? Math.round(tasaPonderada * 100) / 100 : +n.tasaMensual;
  var destino = opc.destino || 'repartir';
  if (diario && (destino === 'repartir' || destino === 'primera')) destino = 'capital';
  if (!(interes > 0)) destino = 'repartir';
  var monto = capital + (destino === 'capital' ? interes : 0);
  var carga = (destino === 'repartir' || destino === 'primera') ? interes : 0;

  var plazo = Math.max(1, +n.plazo || 1);
  var r = tasaDelPeriodo(tasa / 100, freq);
  var primerPago = n.primerPago || primerPagoRegular(fecha, freq);
  var info = diario ? null : infoPrimerPeriodo(monto, tasa, fecha, primerPago, freq);
  var modoPP = info && info.irregular ? (n.primerPeriodo || info.modoPorDefecto) : null;
  var filas = [];
  if (!diario) {
    if (modalidad === 'Intereses') {
      var nI = Math.max(plazo, +opc.cuotasReparto || 0, 12);
      filas = filasPreview(monto, r, nI, true, Math.round(monto * r));
    } else {
      filas = filasPreview(monto, r, plazo, false, Math.round(pmt(r, plazo, monto)));
    }
    if (info && info.irregular && modoPP === 'proporcional' && tasa > 0) {
      aplicarTransitoriaPreview({ id: 'nuevo', modalidad: modalidad, frecuencia: freq, tasaMensual: tasa,
        periodoIrregularN: 1, periodoIrregularDesde: fecha, periodoIrregularMora: 0 }, filas, 1, monto,
        [{ id: 'nuevo-1', fechaPago: primerPago }]);
    }
    var bd = baseYDia(fecha, primerPago, freq);
    filas.forEach(function(f){ f.fecha = fechaPagoFrecuencia(bd.base, f.n, bd.dia, freq); f.carga = 0; f.interesPropio = f.interes; });
    if (carga > 0) {
      var k = destino === 'primera' ? 1 : (modalidad === 'Intereses' ? Math.max(1, +opc.cuotasReparto || 6) : filas.length);
      k = Math.min(k, filas.length);
      var parte = Math.floor(carga / k);
      filas.slice(0, k).forEach(function(f, i){
        f.carga = i === k - 1 ? carga - parte * (k - 1) : parte;
        f.interes += f.carga; f.cuota += f.carga;
      });
    }
  }
  // Lo que se cobra en el plazo del nuevo. En Intereses el capital vuelve al final de lo proyectado.
  var horizonte = filas.length ? filas[(modalidad === 'Intereses' ? Math.min(plazo, filas.length) : filas.length) - 1].fecha : null;
  var cobro = 0;
  if (modalidad === 'Intereses') {
    var nPl = Math.min(plazo, filas.length);
    cobro = filas.slice(0, nPl).reduce(function(s, f){ return s + f.cuota; }, 0) + monto +
      filas.slice(nPl).reduce(function(s, f){ return s + f.carga; }, 0);
  } else if (!diario) {
    cobro = filas.reduce(function(s, f){ return s + f.cuota; }, 0);
  }
  var actual = situacionActual(traslados, fecha, horizonte);
  // El capital REAL contra el que se mide la ganancia de los dos caminos (sin el capitalizado, que
  // es interes, y con lo abonado aplicado primero a los intereses causados: `capitalRef`).
  var capitalReal = traslados.reduce(function(s, t){ return s + t.capitalRef; }, 0);
  var cuotaNormal = filas.length > 1 ? filas[1].cuota : (filas[0] ? filas[0].cuota : 0);
  var vencidas = filas.filter(function(f){ return f.fecha && f.fecha < hoy; }).length;
  return {
    hoy: hoy, fecha: fecha, retroactiva: fecha < hoy, limites: lim, errorFecha: errorFecha,
    traslados: traslados, monedas: monedas, unaMoneda: monedas.length === 1,
    capital: capital, interes: interes, corridoTotal: corridoTotal, corridoCobrado: corridoCobrado, total: capital + interes,
    tasaPonderada: tasaPonderada, tasaMax: tasaMax,
    destino: destino, carga: carga, condonado: destino === 'condonar' ? interes : 0,
    nuevo: { modalidad: modalidad, frecuencia: freq, tasaMensual: tasa, plazo: plazo, monto: monto, fechaInicio: fecha,
      capitalizado: destino === 'capital' ? interes : 0,
      primerPago: diario ? null : primerPago, info: info, modoPP: modoPP, filas: filas,
      cuota: cuotaNormal, primeraCuota: filas[0] ? filas[0].cuota : 0,
      porMes: Math.round(cuotaNormal * (UN_PERIODOS_ANIO[freq] || 12) / 12),
      ultima: horizonte, totalCobro: cobro, cuotasYaVencidas: vencidas },
    actual: actual,
    gananciaHoy: actual.total - capitalReal,
    gananciaNuevo: diario ? null : cobro - capitalReal,
    diferencia: diario ? null : (cobro - capitalReal) - (actual.total - capitalReal)
  };
}
