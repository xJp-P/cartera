// public/js/core/operacion.js — el modelo de la operacion diaria (3.5.0): Cobros, Cartera y el
// panel del deudor.
//
// Ninguna formula nueva de dinero: todo sale de los helpers del dominio (imputarCobros,
// computeLiquidacion, gananciaDePrestamo, pendCuota, estadoDiario, progresoCapital), con las mismas
// expresiones que usaba el perfil del deudor que este panel reemplaza, para que las cifras no se
// muevan al cambiar de pantalla. Lo fija `tests/operacion.js`.
//
// Nombres top-level con prefijo `op`/`OP_`: el arnes de pruebas aplana todos los modulos en un
// mismo ambito.

import { imputarCobros, pendCuota, computeLiquidacion, gananciaDePrestamo, esDiario, estadoDiario, progresoCapital, diasEntre, cobrosDe } from './dominio.js';
import { esAbono, esCuotaRegular } from './ids.js';
import { addDays } from './ui.js';

export var OP_MESES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
export var OP_DIAS = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
var OP_MES3 = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];

export function opFecha(iso){ return new Date(iso + 'T12:00:00'); }
export function opCorta(iso){ if (!iso) return '—'; var d = opFecha(iso); return d.getDate() + ' ' + OP_MES3[d.getMonth()]; }
export function opCortaAnio(iso){ if (!iso) return '—'; var d = opFecha(iso); return d.getDate() + ' ' + OP_MES3[d.getMonth()] + ' ' + d.getFullYear(); }
export function opRel(hoy, iso){
  var d = diasEntre(hoy, iso);
  if (d === 0) return 'hoy'; if (d === 1) return 'mañana'; if (d === -1) return 'ayer';
  return d > 0 ? 'en ' + d + ' días' : 'hace ' + (-d) + ' días';
}
// La modalidad se guarda sin tildes (valor interno); aqui solo se rotula.
var OP_MOD = { 'Capital + Intereses': ['Capital + Intereses', 'Cap. + Int.'], 'Intereses': ['Solo intereses', 'Intereses'],
  'Prestamo': ['Préstamo sin interés', 'Préstamo'], 'Pago Unico': ['Pago único', 'Pago único'], 'Interes Diario': ['Interés diario', 'Diario'] };
export function opModalidad(m, corto){ var r = OP_MOD[m]; return r ? r[corto ? 1 : 0] : m; }
export function opIniciales(nombre){
  var p = String(nombre || '').replace(/\(.*?\)/g, ' ').trim().split(/\s+/).filter(Boolean);
  return ((p[0] || '?').charAt(0) + (p[1] ? p[1].charAt(0) : '')).toUpperCase();
}
function opOrigCOP(l){ return l.moneda === 'USD' ? Math.round(l.montoOrigen * l.trmAcordada) : Math.round(l.montoOrigen); }
export function opPlazo(l){
  if (esDiario(l)) return 'crédito abierto';
  if (l.modalidad === 'Intereses') return 'plazo indefinido';
  if (l.modalidad === 'Prestamo' || l.modalidad === 'Pago Unico') return 'una cuota';
  var f = l.frecuencia || 'Mensual', n = l.plazoMeses;
  return n + (f === 'Semanal' ? ' semanas' : f === 'Quincenal' ? ' quincenas' : (n === 1 ? ' mes' : ' meses'));
}
export function opFrecuencia(l){
  if (esDiario(l)) return 'interés por días';
  if (l.modalidad === 'Prestamo' || l.modalidad === 'Pago Unico') return 'pago único';
  return (l.frecuencia || 'Mensual').toLowerCase();
}
// "Cambiar dia de pago" existe solo donde el backend lo acepta: whitelist de modalidades con
// cuotas periodicas y frecuencia Mensual (ver `/cambiar-dia-pago`). Ofrecer el boton en un semanal
// era mostrar una accion que siempre rebota.
export function opPuedeCambiarDia(l){
  return l.estado === 'Activo' && (l.modalidad === 'Intereses' || l.modalidad === 'Capital + Intereses') && (l.frecuencia || 'Mensual') === 'Mensual';
}

// Todo lo que el panel necesita de UN prestamo, en una pasada.
function modeloPrestamo(l, lp, hoy){
  var esUSD = l.moneda === 'USD', trm = l.trmAcordada || 0;
  var regulares = lp.filter(function(p){ return !esAbono(p); });
  var abonos = lp.filter(esAbono);
  var porFecha = function(a, b){ return a.fechaPago.localeCompare(b.fechaPago) || a.cuotaN - b.cuotaN; };
  var pagadas = regulares.filter(function(p){ return p.estadoPago === 'Pagado'; }).length;
  var enMora = regulares.filter(function(p){ return p.estadoPago === 'En Mora'; }).sort(porFecha);
  var pendientes = regulares.filter(function(p){ return p.estadoPago === 'Pendiente'; }).sort(porFecha);
  var orig = opOrigCOP(l);
  // Saldo del MOTOR: gobierna decisiones (la base de "Cambiar dia de pago"). El que se MUESTRA es
  // el saldo con caja aplicada (`saldo`), el mismo de `saldoConCaja`.
  var todoCapPag = lp.filter(function(p){ return p.estadoPago === 'Pagado'; }).reduce(function(s, p){ return s + p.abonoCapital; }, 0);
  var saldoMotor = Math.max(0, orig - todoCapPag);
  var imp = lp.reduce(function(a, p){ var t = imputarCobros(p).totales;
    a.cobrado += t.cobrado; a.interes += t.interes; a.capital += t.capital; a.ajuste += t.ajuste; return a; },
    { cobrado: 0, interes: 0, capital: 0, ajuste: 0 });
  var saldo = Math.max(0, orig - Math.round(imp.capital));
  var activo = l.estado === 'Activo';
  var liq = activo ? computeLiquidacion(l, lp, {}) : null;
  var gp = gananciaDePrestamo(l, lp);
  var esPrest = l.modalidad === 'Prestamo';
  var recCap = Math.round(imp.capital), recInt = Math.round(imp.interes), recTRM = Math.round(imp.ajuste), recTotal = Math.round(imp.cobrado);
  var regPag = regulares.filter(function(p){ return p.estadoPago === 'Pagado'; });
  var aboPag = abonos.filter(function(p){ return p.estadoPago === 'Pagado'; });
  var efectoUSD = esUSD && trm > 0
    ? regPag.filter(function(p){ return p.montoUSDRecibido > 0; }).reduce(function(s, p){ return s + (p.montoUSDRecibido - p.cuotaTotal / trm); }, 0)
      + aboPag.filter(function(p){ return p.montoUSDRecibido > 0; }).reduce(function(s, p){ return s + (p.montoUSDRecibido - p.abonoCapital / trm); }, 0)
    : 0;
  var recTotalUSD = esUSD && trm > 0 ? recCap / trm + recInt / trm + efectoUSD : 0;
  var capAbonos = aboPag.reduce(function(s, p){ return s + p.abonoCapital; }, 0);
  var moraMonto = enMora.reduce(function(s, p){ return s + pendCuota(p); }, 0);
  var dv = esDiario(l) && activo ? estadoDiario(l, lp, hoy) : null;
  var pct = esDiario(l) ? progresoCapital(l, lp) : (orig > 0 ? Math.round((1 - saldo / orig) * 100) : 0);
  var gananciaEsperada = l.modalidad === 'Pago Unico' ? (+l.gananciaFija || 0)
    : (l.modalidad === 'Intereses' || esDiario(l) || esPrest) ? null
    : regulares.reduce(function(s, p){ return s + p.interesPeriodo; }, 0);
  var lotes = null;
  if (esUSD && l.comprasUSD){ try { var pa = typeof l.comprasUSD === 'string' ? JSON.parse(l.comprasUSD) : l.comprasUSD; if (Array.isArray(pa) && pa.length) lotes = pa; } catch (_){} }
  var ult = lp.filter(function(p){ return p.estadoPago === 'Pagado'; }).sort(function(a, b){ return (b.fechaRecaudo || b.fechaPago).localeCompare(a.fechaRecaudo || a.fechaPago); })[0];
  var fechaFin = ult ? (ult.fechaRecaudo || ult.fechaPago) : null;
  // Linea de tiempo del cronograma: cuotas + abonos intercalados. En Intereses las pendientes son
  // infinitas (se generan solas): se muestra solo la PROXIMA, que es la que se esta cobrando.
  var cronoCuotas = regulares.filter(function(p){ return l.modalidad !== 'Intereses' || p.estadoPago !== 'Pendiente' || (pendientes[0] && p.id === pendientes[0].id); });
  var timeline = cronoCuotas.concat(abonos).sort(porFecha);
  var dProx = pendientes[0] ? diasEntre(hoy, pendientes[0].fechaPago) : null;
  // Un cierre forzoso que solo dejo intereses sin cobrar (capital recuperado al 100%) es una
  // condonacion hecha por la via vieja: Rendimiento ya lo rotula asi desde v2.9.0, no "perdida".
  var condonado = l.estado === 'Cancelado' && Math.round(l.capitalPerdido || 0) === 0 && Math.round(l.interesesPerdidos || 0) > 0;
  var estado = condonado ? 'condonado' : l.estado === 'Cancelado' ? 'cancelado' : l.estado !== 'Activo' ? 'finalizado'
    : enMora.length ? 'mora' : dProx === 0 ? 'hoy' : (dProx != null && dProx <= 7) ? 'semana' : esDiario(l) ? 'abierto' : 'aldia';
  return { loan: l, lp: lp, esUSD: esUSD, trm: trm, regulares: regulares, abonos: abonos, pagadas: pagadas, total: regulares.length,
    enMora: enMora, pendientes: pendientes, prox: pendientes[0] || null, dProx: dProx, orig: orig, saldoMotor: saldoMotor, saldo: saldo,
    liq: liq, gp: gp, esPrest: esPrest, recCap: recCap, recInt: recInt, recTRM: recTRM, recTotal: recTotal,
    recGan: esPrest ? recInt + recTRM : gp.cop, recTotalUSD: recTotalUSD, capAbonos: capAbonos, moraMonto: moraMonto,
    moraDias: enMora.length ? diasEntre(enMora[0].fechaPago, hoy) : 0, dv: dv, pct: Math.max(0, Math.min(100, pct)),
    gananciaEsperada: gananciaEsperada, lotes: lotes, fechaFin: fechaFin, timeline: timeline, estado: estado, activo: activo, condonado: condonado };
}

var OP_PESO = { mora: 0, hoy: 1, semana: 2, aldia: 3, abierto: 4, finalizado: 5, cancelado: 5, condonado: 5 };
export function opPesoEstado(e){ return OP_PESO[e] == null ? 9 : OP_PESO[e]; }

// Un deudor = todos sus prestamos (agrupados por nombre, como en la app).
export function modeloDeudor(d, loans, pays, hoy){
  var paysPor = {};
  pays.forEach(function(p){ (paysPor[p.prestamoId] = paysPor[p.prestamoId] || []).push(p); });
  var mods = loans.filter(function(l){ return l.nombre === d.nombre; }).map(function(l){ return modeloPrestamo(l, paysPor[l.id] || [], hoy); });
  var activos = mods.filter(function(m){ return m.activo; })
    .sort(function(a, b){ return opPesoEstado(a.estado) - opPesoEstado(b.estado) || b.loan.fechaInicio.localeCompare(a.loan.fechaInicio); });
  var cerrados = mods.filter(function(m){ return !m.activo; })
    .sort(function(a, b){ return (b.fechaFin || b.loan.fechaInicio).localeCompare(a.fechaFin || a.loan.fechaInicio); });
  var saldo = activos.reduce(function(s, m){ return s + m.saldo; }, 0);
  var saldoUSD = activos.filter(function(m){ return m.esUSD && m.trm > 0; }).reduce(function(s, m){ return s + Math.round(m.saldo / m.trm * 100) / 100; }, 0);
  var mora = activos.reduce(function(s, m){ return s + m.moraMonto; }, 0);
  var moraN = activos.reduce(function(s, m){ return s + m.enMora.length; }, 0);
  var moraDias = activos.reduce(function(s, m){ return Math.max(s, m.moraDias); }, 0);
  var prox = null;
  activos.forEach(function(m){ if (m.prox && (!prox || m.prox.fechaPago < prox.p.fechaPago)) prox = { p: m.prox, m: m }; });
  var ultimo = null;
  mods.forEach(function(m){ m.lp.forEach(function(p){ cobrosDe(p).forEach(function(e){ if (!ultimo || e.fecha > ultimo.fecha) ultimo = { fecha: e.fecha, cop: e.cop, m: m }; }); }); });
  var estado = activos.length ? activos[0].estado : 'inactivo';
  if (estado === 'finalizado' || estado === 'cancelado' || estado === 'condonado') estado = 'inactivo';
  return { d: d, nombre: d.nombre, mods: mods, activos: activos, cerrados: cerrados, saldo: saldo, saldoUSD: saldoUSD,
    mora: mora, moraN: moraN, moraDias: moraDias, prox: prox, ultimo: ultimo, estado: estado,
    cobrado: mods.reduce(function(s, m){ return s + m.recTotal; }, 0),
    ganancia: mods.reduce(function(s, m){ return s + (m.esPrest ? 0 : m.gp.cop); }, 0),
    gananciaUSD: mods.filter(function(m){ return m.esUSD && !m.esPrest; }).reduce(function(s, m){ return s + (m.gp.usd || 0); }, 0),
    prestado: activos.reduce(function(s, m){ return s + m.orig; }, 0) };
}

// Bandeja de cobro: cada cuota del cronograma que falta cobrar, en su tramo de urgencia. Solo
// cuotas del cronograma (`esCuotaRegular`): un abono o un corte no se "cobran", ya entraron.
export function bandejaCobro(loans, pays, hoy){
  var loanMap = {};
  loans.forEach(function(l){ loanMap[l.id] = l; });
  var en7 = addDays(hoy, 7), en30 = addDays(hoy, 30);
  var filas = [];
  pays.forEach(function(p){
    var l = loanMap[p.prestamoId];
    if (!l || l.estado !== 'Activo' || !esCuotaRegular(p) || p.estadoPago === 'Pagado') return;
    var f = p.fechaPago;
    var tramo = (p.estadoPago === 'En Mora' || f < hoy) ? 'vencido' : f === hoy ? 'hoy' : f <= en7 ? 'semana' : f <= en30 ? 'mes' : 'despues';
    filas.push({ p: p, l: l, tramo: tramo, pend: pendCuota(p), dias: diasEntre(hoy, f) });
  });
  filas.sort(function(a, b){ return a.p.fechaPago.localeCompare(b.p.fechaPago) || b.pend - a.pend; });
  return filas;
}
