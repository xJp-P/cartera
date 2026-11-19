// backend/core/unificacion.js — UNIFICAR los prestamos de un deudor: el calculo, del lado del server.
//
// Es el ESPEJO de `public/js/core/unificacion.js` (el modal y los documentos usan aquel). El server
// no confia en las cifras que le llegan: recalcula todo desde la BD con las mismas reglas, y si no
// coinciden con lo que el usuario vio, rechaza (las cifras cambiaron). La suite `unificacion` fija
// la paridad entre los dos.
//
// UNIFICAR = LIQUIDAR cada prestamo, pero en vez de entrar dinero entra un prestamo NUEVO. Lo que
// traslada cada uno es su "Liquidar" (computeLiquidacion) A LA FECHA de la unificacion, partido en:
//   - capital: el capital pendiente (prestado - capital de las filas Pagadas);
//   - intereses vencidos: cuotas que vencian ese dia o antes y no estan Pagadas, mas la mora
//     consolidada de una transitoria por vencer, mas el devengo de un credito abierto;
//   - opcionales: el interes YA CORRIDO del periodo en curso (por credito) y, en un Pago Unico
//     que aun no vence, su ganancia pactada;
//   y lo ya abonado a cuotas sin saldar se descuenta primero de esos intereses (art. 1653) y el
//   resto del capital.
// Una cuota que vencio DESPUES de la fecha (aunque hoy este En Mora por la auto-mora) era por
// vencer: su interes es interes corrido, no vencido.
//
// Puro: recibe las filas ya leidas y no toca la BD.

const { ClientError } = require('./errors');
const {
  MODALIDAD_DIARIA, diasEntre, interesPeriodoParcial, devengoDiario, tasaPeriodo,
} = require('./engine');

const esAbonoU = p => String(p.id).indexOf('-ab-') !== -1;
const esCorteU = p => String(p.id).indexOf('-ct-') !== -1;
const regularU = p => !esAbonoU(p) && !esCorteU(p);
const porFecha = (a, b) => (a.fechaPago < b.fechaPago ? -1 : a.fechaPago > b.fechaPago ? 1 : a.cuotaN - b.cuotaN);
const recibosU = p => { try { const r = JSON.parse(p.recibos || '[]'); return Array.isArray(r) ? r : []; } catch (_) { return []; } };
const RE_ISO = /^\d{4}-\d{2}-\d{2}$/;

const UN_MODALIDADES_NUEVO = ['Capital + Intereses', 'Intereses', MODALIDAD_DIARIA];
const UN_DESTINOS = ['repartir', 'primera', 'capital', 'condonar'];

// El dia de la unificacion no puede ser anterior a ningun movimiento de los prestamos que se unen
// (su inicio, un cobro, un abono o un corte: lo registrado despues no tendria donde vivir) ni
// futuro.
function limitesFecha(loans, paysDe, hoy) {
  let min = '', motivo = '';
  loans.forEach(l => {
    const cand = [[l.fechaInicio, 'empezó uno de los préstamos']];
    (paysDe(l.id) || []).forEach(p => {
      if (p.estadoPago === 'Pagado' && p.fechaRecaudo) cand.push([String(p.fechaRecaudo).slice(0, 10), 'se registró un pago']);
      if (!regularU(p) && p.fechaPago) cand.push([p.fechaPago, esCorteU(p) ? 'se registró un corte' : 'se registró un abono']);
      recibosU(p).forEach(r => { if (r && r.fecha) cand.push([String(r.fecha).slice(0, 10), 'se registró un pago']); });
    });
    cand.forEach(c => { if (c[0] && c[0] > min) { min = c[0]; motivo = c[1]; } });
  });
  return { min, max: hoy, motivo };
}

function trasladoDe(loan, pays, fecha, opc) {
  opc = opc || {};
  const diario = loan.modalidad === MODALIDAD_DIARIA;
  const origCOP = loan.moneda === 'USD' ? Math.round(loan.montoOrigen * loan.trmAcordada) : Math.round(loan.montoOrigen);
  const capPagadas = pays.filter(p => p.estadoPago === 'Pagado').reduce((s, p) => s + p.abonoCapital, 0);
  const capitalPendiente = Math.max(0, origCOP - capPagadas);
  const regs = pays.filter(regularU);
  const abiertas = regs.filter(p => p.estadoPago !== 'Pagado');
  // Vencida = vencia ese dia o antes (la auto-mora de la fecha de la unificacion).
  const vencidaAl = p => p.fechaPago <= fecha;
  const intMora = abiertas.filter(vencidaAl).reduce((s, p) => s + p.interesPeriodo, 0);
  const partialPend = abiertas.reduce((s, p) => s + (p.partialPaid || 0), 0);
  const aplicaInteres = loan.modalidad !== 'Prestamo' && loan.modalidad !== 'Pago Unico' && (+loan.tasaMensual || 0) > 0;
  const fII = loan.fechaInicioIntereses ? String(loan.fechaInicioIntereses) : '';
  const enGracia = aplicaInteres && !diario && !!fII && fII > String(loan.fechaInicio || '') && fecha < fII;
  // Mora consolidada de una transitoria POR VENCER (si ya vencio, su interes ya la trae).
  const nTrans = +loan.periodoIrregularN || 0;
  const filaTrans = nTrans ? regs.find(p => p.cuotaN === nTrans) : null;
  const esTrans = !!filaTrans && !!loan.periodoIrregularDesde && (loan.modalidad === 'Intereses' || loan.modalidad === 'Capital + Intereses');
  const moraConsolidada = (esTrans && filaTrans.estadoPago !== 'Pagado' && !vencidaAl(filaTrans))
    ? Math.max(0, Math.round(+loan.periodoIrregularMora || 0)) : 0;
  const cortes = pays.filter(esCorteU).sort(porFecha);
  const devengo = diario ? devengoDiario(loan, cortes, fecha).interesPendiente : 0;
  const intVencido = intMora + moraConsolidada + devengo;

  // Interes ya corrido del periodo en curso: desde la ultima cuota facturada hasta la fecha.
  const corrido = { aplica: false, desde: null, dias: 0, monto: 0 };
  if (aplicaInteres && !diario) {
    const ords = regs.slice().sort(porFecha);
    const facturadas = ords.filter(p => p.fechaPago <= fecha);
    const desde = facturadas.length ? facturadas[facturadas.length - 1].fechaPago : (fII || loan.fechaInicio);
    // Sin una cuota por vencer (el plazo ya termino) no hay periodo en curso: el motor no sigue
    // cobrando interes despues de la ultima cuota.
    const sinCuotas = !ords.some(p => p.fechaPago > fecha && p.estadoPago !== 'Pagado') && loan.modalidad !== 'Intereses';
    const dias = (enGracia || sinCuotas) ? 0 : Math.max(0, diasEntre(desde, fecha));
    corrido.aplica = !enGracia && !sinCuotas;
    corrido.desde = desde;
    corrido.dias = dias;
    // Sobre el capital de la cuota en curso (su saldo inicial), como el modal.
    const prox = ords.filter(p => p.fechaPago > fecha && p.estadoPago !== 'Pagado')[0];
    corrido.monto = (enGracia || sinCuotas) ? 0 : interesPeriodoParcial(prox ? Math.round(+prox.saldoInicial || 0) : capitalPendiente,
      +loan.tasaMensual || 0, loan.frecuencia || 'Mensual', dias);
  }
  // Pago Unico que aun no vence: su ganancia pactada.
  let gananciaPU = 0;
  if (loan.modalidad === 'Pago Unico') {
    const unica = abiertas[0];
    if (unica && !vencidaAl(unica)) gananciaPU = Math.max(0, Math.round(+loan.gananciaFija || 0));
  }
  const conPU = gananciaPU > 0 && opc.ganancia !== false;
  const conCorrido = !!opc.corrido && corrido.monto > 0;
  const causados = intVencido + (conCorrido ? corrido.monto : 0) + (conPU ? gananciaPU : 0);
  const aInteres = Math.min(causados, partialPend);
  const aCapital = partialPend - aInteres;
  return {
    loan, capitalPendiente, intVencido, abonado: partialPend, corrido, conCorrido, gananciaPU, conPU,
    aInteres, aCapital, capital: capitalPendiente - aCapital, interes: causados - aInteres,
  };
}

// Valida el pedido y arma el plan: lo que traslada cada prestamo y el prestamo nuevo (sin id ni
// cronograma: eso lo hace la ruta con el motor). Lanza ClientError (4xx, BD intacta).
//   body: { loanIds, fecha, corridos {id: bool}, ganancias {id: bool}, destino, cuotasReparto,
//           nuevo: { modalidad, tasaMensual, plazo, frecuencia, primerPago, primerPeriodo },
//           esperado: { capital, interes } }
function planUnificacion(loans, paysDe, hoy, body) {
  body = body || {};
  if (loans.length < 2) throw new ClientError('Para unificar hacen falta al menos dos préstamos.');
  const nombre = s => String(s || '').trim().toLowerCase();
  if (loans.some(l => nombre(l.nombre) !== nombre(loans[0].nombre))) throw new ClientError('Solo se pueden unificar préstamos del mismo deudor.');
  if (loans.some(l => l.estado !== 'Activo')) throw new ClientError('Solo se pueden unificar préstamos activos.');
  if (loans.some(l => (l.moneda || 'COP') !== (loans[0].moneda || 'COP'))) throw new ClientError('Una unificación es en una sola moneda: no se pueden unir pesos y dólares.');
  const fecha = body.fecha === undefined || body.fecha === null || body.fecha === '' ? hoy : String(body.fecha);
  if (!RE_ISO.test(fecha)) throw new ClientError('Fecha de la unificación inválida: "' + fecha + '".');
  const lim = limitesFecha(loans, paysDe, hoy);
  if (fecha > lim.max) throw new ClientError('La unificación no puede ser en una fecha futura.');
  if (lim.min && fecha < lim.min) throw new ClientError('La unificación no puede ser antes del ' + lim.min + ': ese día ' + lim.motivo + '.');

  const corr = body.corridos || {}, gan = body.ganancias || {};
  const traslados = loans.map(l => trasladoDe(l, paysDe(l.id), fecha, { corrido: !!corr[l.id], ganancia: gan[l.id] }));
  const capital = traslados.reduce((s, t) => s + t.capital, 0);
  const interes = traslados.reduce((s, t) => s + t.interes, 0);
  if (body.esperado && (Math.round(+body.esperado.capital) !== capital || Math.round(+body.esperado.interes) !== interes)) {
    throw new ClientError('Las cifras cambiaron desde que abriste la unificación (capital $' + capital.toLocaleString('es-CO') +
      ', intereses $' + interes.toLocaleString('es-CO') + '). Ciérrala y vuelve a abrirla.', 409);
  }

  const n = body.nuevo || {};
  const modalidad = n.modalidad || 'Capital + Intereses';
  if (UN_MODALIDADES_NUEVO.indexOf(modalidad) === -1) throw new ClientError('El préstamo nuevo puede ser de capital + intereses, solo intereses o interés diario.');
  const diario = modalidad === MODALIDAD_DIARIA;
  const frecuencia = diario ? 'Mensual' : (n.frecuencia || 'Mensual');
  if (['Mensual', 'Quincenal', 'Semanal'].indexOf(frecuencia) === -1) throw new ClientError('Frecuencia inválida: "' + frecuencia + '".');
  const conTasa = traslados.filter(t => (+t.loan.tasaMensual || 0) > 0);
  const baseT = conTasa.reduce((s, t) => s + t.capital, 0);
  const tasaPonderada = baseT > 0 ? conTasa.reduce((s, t) => s + t.capital * (+t.loan.tasaMensual), 0) / baseT : 0;
  const tasa = n.tasaMensual === undefined || n.tasaMensual === null || n.tasaMensual === '' ? Math.round(tasaPonderada * 100) / 100 : +n.tasaMensual;
  if (!isFinite(tasa) || tasa < 0 || tasa > 100) throw new ClientError('Tasa mensual inválida.');
  const plazo = Math.round(+n.plazo || 0);
  if (modalidad === 'Capital + Intereses' && (plazo < 1 || plazo > 360)) throw new ClientError('El número de cuotas debe estar entre 1 y 360.');
  let destino = body.destino || 'repartir';
  if (UN_DESTINOS.indexOf(destino) === -1) throw new ClientError('Destino de los intereses inválido: "' + destino + '".');
  // Un credito abierto no tiene cuotas: los intereses se suman al capital o se condonan.
  if (diario && (destino === 'repartir' || destino === 'primera')) destino = 'capital';
  if (interes <= 0) destino = 'repartir';
  const cuotasReparto = Math.max(1, Math.round(+body.cuotasReparto || 6));
  const carga = (destino === 'repartir' || destino === 'primera') ? interes : 0;
  const K = carga > 0 ? (destino === 'primera' ? 1 : (modalidad === 'Intereses' ? cuotasReparto : plazo)) : 0;
  const monto = capital + (destino === 'capital' ? interes : 0);
  if (!(monto > 0)) throw new ClientError('No queda nada que unificar: los préstamos no deben capital.');
  return {
    fecha, traslados, capital, interes, destino, carga, K, monto, tasa, plazo, modalidad, frecuencia, diario,
    capitalizado: destino === 'capital' ? interes : 0, condonado: destino === 'condonar' ? interes : 0,
    tasaPonderada, r: tasaPeriodo(tasa / 100, frecuencia),
  };
}

module.exports = { UN_MODALIDADES_NUEVO, UN_DESTINOS, limitesFecha, trasladoDe, planUnificacion };
