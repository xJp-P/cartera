// public/js/componentes/DeudorPanel.js — el panel del deudor (3.5.0).
//
// Reemplaza al modal "perfil del deudor" (DebtorModal) y vive AL LADO de la lista, en Cobros y en
// Cartera: un deudor, todos sus prestamos como pestanas, y el prestamo elegido con sus acciones,
// sus cifras, su cronograma y lo recaudado, en una sola superficie que no tapa la lista. Como no
// se cierra al abrir un modal de accion, ya no hace falta el ida y vuelta `fromDeudor`: tras
// cobrar o liquidar, el panel se redibuja solo con los datos frescos.
//
// Las cifras salen de `modeloDeudor` / `modeloPrestamo` (core/operacion.js), sin formulas propias.
//
// Rediseño v4 (Cobros y Cartera, fases 2 y 3 de la integracion): el diseño del panel lo pone el CSS
// bajo `.v4p` (public/css/panel.css), que lleva la raiz de las dos pestañas; la TRM de cada compra de
// dolares se lee "TRM $ 3.550" (antes "@ $ 3.550").

import { Ico } from './iconos.js';
import { FlujoCajaPanel } from './FlujoCajaPanel.js';
import { GananciaBimonetaria, notaCOPGanancia } from './GananciaBimonetaria.js';
import { CronogramaPdfModal } from '../modales/CronogramaPdfModal.js';
import { preguntaInteresMes, esDiario, pendCuota } from '../core/dominio.js';
import { copToUsd, fmt, fmtN, fmtUSD } from '../core/format.js';
import { esAbono } from '../core/ids.js';
import { modeloDeudor, opModalidad, opIniciales, opCorta, opCortaAnio, opRel, opPlazo, opFrecuencia, opPuedeCambiarDia } from '../core/operacion.js';
import { h, useState } from '../core/react.js';
import { properCase } from '../core/ui.js';
import { generateCronogramaPDF } from '../pdf/cronograma.js';
import { generateEstadoCuentaDiario } from '../pdf/estado-cuenta.js';
import { generateFacturaCobroDiario } from '../pdf/factura-cobro.js';
import { generateReciboGeneral, puedeReciboGeneral } from '../pdf/recibo-general.js';
import { usdLinea } from './CifraUSD.js';

var DP_EST = {
  mora: ['En mora', 'red'], hoy: ['Cobra hoy', 'yellow'], semana: ['Cobra esta semana', 'yellow'], aldia: ['Al día', 'green'],
  abierto: ['Crédito abierto', 'blue'], finalizado: ['Finalizado', 'green'], cancelado: ['Cancelado', 'red'],
  condonado: ['Intereses condonados', 'yellow'], inactivo: ['Sin préstamos activos', 'text3']
};
function dpChip(estado, extra){
  var e = DP_EST[estado] || DP_EST.aldia;
  return h('span', { className: 'op-chip', style: { color: 'var(--' + e[1] + ')', background: e[1] === 'text3' ? 'var(--bg3)' : 'var(--' + e[1] + '-bg)' } }, e[0] + (extra || ''));
}
function dpUsd(m, cop){ return m.esUSD ? usdLinea(copToUsd(cop, m.trm)) : null; }
function dpMonto(m){ return m.esUSD ? 'USD ' + fmtN(m.loan.montoOrigen) : fmt(m.loan.montoOrigen); }

// ── Cronograma: las 7 columnas universales, abonos intercalados ────────────────────
function DpCronograma(p){
  var m = p.m, l = m.loan, hoy = p.hoy, foco = p.focoPay;
  var proxId = m.prox ? m.prox.id : null;
  if (!m.timeline.length) return h('div', { className: 'op-vacio' }, esDiario(l) ? 'Todavía no hay cortes registrados.' : 'Sin cuotas.');
  return h('div', { className: 'dp-crono' },
    h('div', { className: 'dp-crono-h' },
      h('span', null, '#'), h('span', null, 'Vence'), h('span', { className: 'r' }, 'Interés'), h('span', { className: 'r' }, 'Abono a capital'),
      h('span', { className: 'r' }, 'Valor cuota'), h('span', { className: 'r' }, 'Saldo'), h('span', { className: 'c' }, 'Estado')),
    m.timeline.map(function(x){
      if (esAbono(x)) return h('div', { key: x.id, className: 'dp-crono-f abono' },
        h('span', null, '—'),
        h('span', null, opCortaAnio(x.fechaPago), x.observaciones && h('div', { className: 'dp-sub' }, x.observaciones)),
        h('span', { className: 'r muted' }, x.interesPeriodo > 0 ? fmt(x.interesPeriodo) : '—'),
        h('span', { className: 'r mono' }, fmt(x.abonoCapital), dpUsd(m, x.abonoCapital)),
        h('span', { className: 'r mono' }, fmt(x.cuotaTotal), dpUsd(m, x.cuotaTotal)),
        h('span', { className: 'r mono' }, fmt(x.saldoFinal)),
        h('span', { className: 'c' }, h('span', { className: 'op-chip', style: { color: 'var(--blue)', background: 'var(--blue-bg)' } }, 'Abono')));
      var est = x.estadoPago, parcial = est !== 'Pagado' && (x.partialPaid || 0) > 0;
      var cls = 'dp-crono-f' + (est === 'En Mora' ? ' mora' : '') + (x.id === proxId ? ' prox' : '') + (x.id === foco ? ' foco' : '') + (est === 'Pagado' ? ' pagada' : '');
      var capRec = Math.max(0, x.cuotaTotal - x.interesPeriodo);
      var capUSD = m.esUSD && m.trm > 0 ? Math.max(0, (Math.round(x.cuotaTotal / m.trm * 100) - Math.round(x.interesPeriodo / m.trm * 100)) / 100) : 0;
      var chip = est === 'Pagado' ? ['Pagada', 'green'] : est === 'En Mora' ? ['Mora', 'red'] : parcial ? ['Parcial', 'blue'] : x.id === proxId ? ['Próxima', 'yellow'] : ['Pendiente', 'text3'];
      return h('div', { key: x.id, className: cls },
        h('span', { className: 'muted' }, x.cuotaN),
        h('span', null, opCortaAnio(x.fechaPago),
          est === 'En Mora' && h('div', { className: 'dp-sub', style: { color: 'var(--red)' } }, 'vencida ' + opRel(hoy, x.fechaPago)),
          x.id === proxId && h('div', { className: 'dp-sub', style: { color: 'var(--yellow)' } }, opRel(hoy, x.fechaPago)),
          est === 'Pagado' && x.fechaRecaudo && x.fechaRecaudo !== x.fechaPago && h('div', { className: 'dp-sub' }, 'cobrada ' + opCorta(x.fechaRecaudo))),
        h('span', { className: 'r mono' }, fmt(x.interesPeriodo), m.esUSD && x.interesPeriodo > 0 ? dpUsd(m, x.interesPeriodo) : null),
        h('span', { className: 'r mono' }, fmt(capRec), m.esUSD && capRec > 0 ? usdLinea(fmtUSD(capUSD)) : null),
        h('span', { className: 'r mono strong' }, fmt(x.cuotaTotal),
          parcial && h('div', { className: 'dp-sub', style: { color: 'var(--blue)' } }, 'abonó ' + fmt(x.partialPaid) + ' · falta ' + fmt(pendCuota(x))),
          dpUsd(m, x.cuotaTotal)),
        h('span', { className: 'r mono' }, fmt(x.saldoFinal), dpUsd(m, x.saldoFinal)),
        h('span', { className: 'c' },
          est !== 'Pagado' && p.onPay
            ? h('button', { className: 'op-chip btn', title: 'Registrar el pago de esta cuota', style: { color: 'var(--' + chip[1] + ')', background: chip[1] === 'text3' ? 'var(--bg3)' : 'var(--' + chip[1] + '-bg)' }, onClick: function(){ p.onPay(x); } }, chip[0])
            : h('span', { className: 'op-chip', style: { color: 'var(--' + chip[1] + ')', background: chip[1] === 'text3' ? 'var(--bg3)' : 'var(--' + chip[1] + '-bg)' } }, chip[0])));
    }));
}

// ── Tarjetas laterales ────────────────────────────────────────────────────────────
function dpFila(label, valor, sub, color, nota){
  return h('div', { className: 'dp-fila' },
    h('div', null, h('div', { className: 'dp-fila-l' }, label), nota && h('div', { className: 'dp-sub' }, nota)),
    h('div', { className: 'r' }, h('div', { className: 'mono', style: { color: color || 'var(--text)', fontWeight: 600 } }, valor), sub));
}
function DpRecaudado(p){
  var m = p.m, l = m.loan;
  if (m.recTotal <= 0) return null;
  return h('div', { className: 'dp-card' },
    h('div', { className: 'dp-card-t' }, 'Recaudado a la fecha'),
    h('div', { className: 'dp-hero-mini' },
      h('span', null, 'Total recibido'),
      h('div', { className: 'r' }, h('div', { className: 'mono' }, fmt(m.recTotal)), m.esUSD && usdLinea(fmtUSD(m.recTotalUSD)))),
    dpFila(l.estado === 'Cancelado' ? 'Capital recuperado' : 'Capital recuperado', fmt(m.recCap), dpUsd(m, m.recCap)),
    dpFila('Intereses cobrados', (m.recInt > 0 ? '+' : '') + fmt(m.recInt), m.esUSD && m.recInt > 0 ? usdLinea(fmtUSD(m.gp.usd)) : null, m.recInt > 0 ? 'var(--green)' : 'var(--text3)'),
    m.esUSD && dpFila('Efecto TRM', (m.recTRM > 0 ? '+' : m.recTRM < 0 ? '-' : '') + fmt(Math.abs(m.recTRM)), null,
      m.recTRM > 0 ? 'var(--green)' : m.recTRM < 0 ? 'var(--red)' : 'var(--text3)',
      m.recTRM === 0 ? 'sin datos de TRM al cobro' : m.recTRM > 0 ? 'la TRM subió al cobrar' : 'la TRM bajó al cobrar'),
    m.capAbonos > 0 && dpFila('Abonos a capital', fmt(m.capAbonos), dpUsd(m, m.capAbonos)),
    m.esUSD
      ? h('div', { className: 'dp-gb' }, h(GananciaBimonetaria, { compacto: true, titulo: m.esPrest ? 'Resultado total' : 'Ganancia total',
          colorTitulo: m.recGan < 0 ? 'var(--red)' : 'var(--text2)', usd: m.gp.usd, cop: m.recGan,
          notaUSD: m.esPrest ? 'Sin interés pactado' : 'Intereses pagados en dólares', notaCOP: notaCOPGanancia(m.gp, m.esPrest, m.recTRM) }))
      : !m.esPrest && dpFila('Ganancia', (m.gp.cop > 0 ? '+' : '') + fmt(m.gp.cop), null, m.gp.cop > 0 ? 'var(--green)' : 'var(--text3)'));
}
function DpProyeccion(p){
  var m = p.m, l = m.loan;
  if (l.modalidad === 'Intereses' && m.activo){
    var renta = Math.round(m.saldoMotor * (+l.tasaMensual || 0) / 100);
    return h('div', { className: 'dp-card' }, h('div', { className: 'dp-card-t' }, 'Rendimiento'),
      dpFila('Renta mensual', '+' + fmt(renta), dpUsd(m, renta), 'var(--green)', 'saldo ' + fmt(m.saldoMotor) + ' × ' + l.tasaMensual + '%'),
      dpFila('Intereses cobrados', '+' + fmt(m.recInt), null, 'var(--green)'));
  }
  if (m.gananciaEsperada == null || m.gananciaEsperada <= 0) return null;
  var pct = Math.min(100, Math.round(m.recInt / m.gananciaEsperada * 100));
  return h('div', { className: 'dp-card' }, h('div', { className: 'dp-card-t' }, 'Intereses del crédito'),
    h('div', { className: 'dp-bar-t' }, h('span', { style: { color: 'var(--green)' } }, pct + '% cobrado'), h('span', { className: 'mono' }, fmt(m.recInt) + ' de ' + fmt(m.gananciaEsperada))),
    h('div', { className: 'op-bar' }, h('div', { style: { width: pct + '%', background: 'var(--green)' } })),
    m.gananciaEsperada > m.recInt && dpFila('Por cobrar', fmt(m.gananciaEsperada - m.recInt), dpUsd(m, m.gananciaEsperada - m.recInt), 'var(--yellow)'));
}
function DpExtras(p){
  var m = p.m, l = m.loan, out = [];
  if (m.dv) out.push(h('div', { key: 'dv', className: 'dp-card' }, h('div', { className: 'dp-card-t' }, 'Interés por días'),
    dpFila('Devengado por cobrar', fmt(m.dv.interesPendiente), dpUsd(m, m.dv.interesPendiente), 'var(--blue)',
      m.dv.diasDesdeUltimoCorte + ' día' + (m.dv.diasDesdeUltimoCorte === 1 ? '' : 's') + ' × ' + fmt(Math.round(m.dv.capitalVivo * (+l.tasaMensual || 0) / 100 / 30)) + '/día'),
    dpFila('Último corte', m.dv.fechaUltimoCorte ? opCortaAnio(m.dv.fechaUltimoCorte) : 'sin cortes aún')));
  if (m.lotes){
    var u = m.lotes.reduce(function(s, c){ return s + (+c.monto || 0); }, 0), c = m.lotes.reduce(function(s, x){ return s + (+x.monto || 0) * (+x.tasa || 0); }, 0);
    out.push(h('div', { key: 'lotes', className: 'dp-card' }, h('div', { className: 'dp-card-t' }, 'Compras de dólares · TRM promedio ' + fmt(Math.round(c / (u || 1)))),
      m.lotes.map(function(x, i){ return dpFila('Compra ' + (i + 1) + ' · USD ' + fmtN(+x.monto), 'TRM ' + fmt(+x.tasa)); }),
      dpFila('Total invertido', fmt(c))));
  }
  if (l.estado === 'Cancelado' && !m.condonado){
    var cp = Math.round(l.capitalPerdido || 0), ip = Math.round(l.interesesPerdidos || 0);
    out.push(h('div', { key: 'perd', className: 'dp-card', style: { borderColor: 'var(--red-bd)' } }, h('div', { className: 'dp-card-t', style: { color: 'var(--red)' } }, 'Cierre forzoso'),
      dpFila('Capital que quedó debiendo', fmt(cp), dpUsd(m, cp), 'var(--red)'),
      dpFila('Intereses que quedó debiendo', fmt(ip), dpUsd(m, ip), 'var(--red)'),
      dpFila('Total perdido', '-' + fmt(cp + ip), null, 'var(--red)')));
  }
  return out;
}

// ── El panel ──────────────────────────────────────────────────────────────────────
export function DeudorPanel(props){
  var hoy = props.hoy, loans = props.loans, pays = props.pays;
  var M = modeloDeudor(props.deudor, loans, pays, hoy);
  var todos = M.activos.concat(M.cerrados);
  var inicial = props.focoLoan && todos.some(function(m){ return m.loan.id === props.focoLoan; }) ? props.focoLoan : (todos[0] ? todos[0].loan.id : null);
  var _s = useState(inicial); var sel = _s[0], setSel = _s[1];
  var _h = useState(!M.activos.length || M.cerrados.some(function(m){ return m.loan.id === inicial; })); var verHist = _h[0], setVerHist = _h[1];
  var _m = useState(false); var menu = _m[0], setMenu = _m[1];
  var _c = useState(null); var cronoPdf = _c[0], setCronoPdf = _c[1];
  var m = todos.filter(function(x){ return x.loan.id === sel; })[0] || todos[0] || null;
  var l = m ? m.loan : null;
  var d = M.d;
  var tel = d.telefono && d.telefono !== '0' ? d.telefono : null;
  var cc = d.cedula && d.cedula !== '0' ? d.cedula : null;

  function accion(fn, arg){ setMenu(false); if (fn) fn(arg); }
  function pdf(){
    if (esDiario(l)) generateEstadoCuentaDiario(l, m.lp, {});
    else if (preguntaInteresMes(l, m.lp)) setCronoPdf(l.id);
    else generateCronogramaPDF(l, m.lp, document.documentElement.getAttribute('data-theme') === 'dark');
  }
  function tab(x){
    var on = x.loan.id === sel;
    return h('button', { key: x.loan.id, className: 'dp-tab' + (on ? ' on' : '') + ' e-' + x.estado, onClick: function(){ setSel(x.loan.id); setMenu(false); if (props.onLoan) props.onLoan(x.loan.id); } },
      h('div', { className: 'dp-tab-1' }, h('i', { className: 'dp-dot' }), h('span', { className: 'mono' }, dpMonto(x)), x.esUSD && h('span', { className: 'dp-usdtag' }, 'USD')),
      h('div', { className: 'dp-tab-2' }, opModalidad(x.loan.modalidad, true) + ' · ' + opCorta(x.loan.fechaInicio)),
      x.activo
        ? h('div', { className: 'dp-tab-3 mono' }, 'debe ' + fmt(x.saldo))
        : h('div', { className: 'dp-tab-3' }, (x.estado === 'cancelado' ? 'cancelado ' : 'pagado ') + (x.fechaFin ? opCorta(x.fechaFin) : '')));
  }

  var acciones = null, figuras = null;
  if (m && m.activo){
    var esC = l.modalidad === 'Capital + Intereses';
    var puedeFecha = opPuedeCambiarDia(l);
    var intMora = m.enMora.reduce(function(s, p){ return s + p.interesPeriodo; }, 0);
    var puedeCondonar = l.modalidad !== 'Prestamo' && l.modalidad !== 'Pago Unico' && (esDiario(l) ? (m.dv && m.dv.interesPendiente > 0) : intMora > 0);
    acciones = h('div', { className: 'dp-acc' },
      h('button', { className: 'op-btn pri', onClick: function(){ accion(esDiario(l) ? props.onCorte : props.onCobro, l); } },
        h(Ico, { name: esDiario(l) ? 'receipt' : 'dollar', size: 15, color: '#fff', sw: 2.3 }), esDiario(l) ? 'Registrar corte' : 'Registrar cobro'),
      h('button', { className: 'op-btn', onClick: function(){ accion(props.onLiquidar, l); } }, h(Ico, { name: 'check', size: 15, color: 'var(--green)', sw: 2.4 }), 'Liquidar'),
      h('button', { className: 'op-btn', onClick: pdf }, h(Ico, { name: 'download', size: 15, color: 'var(--text2)', sw: 2.2 }), esDiario(l) ? 'Estado de cuenta' : 'Cronograma PDF'),
      esDiario(l) && h('button', { className: 'op-btn', onClick: function(){ generateFacturaCobroDiario(l, m.lp, props.datosPago, {}); } }, h(Ico, { name: 'receipt', size: 15, color: 'var(--text2)', sw: 2.2 }), 'Cobrar interés (PDF)'),
      h('div', { className: 'dp-mas' },
        h('button', { className: 'op-btn' + (menu ? ' on' : ''), onClick: function(){ setMenu(!menu); } }, 'Más', h(Ico, { name: 'chevdown', size: 14, color: 'var(--text2)', sw: 2.3 })),
        menu && h('div', { className: 'dp-menu' },
          h('div', { className: 'dp-menu-t' }, 'Ajustar el crédito'),
          esC && h('button', { onClick: function(){ accion(props.onReestructurar, l); } }, h(Ico, { name: 'calc', size: 14, color: 'var(--text2)' }), 'Reestructurar cuotas'),
          puedeFecha && h('button', { onClick: function(){ accion(props.onCambiarDia, l); } }, h(Ico, { name: 'calendar', size: 14, color: 'var(--text2)' }), 'Cambiar día de pago'),
          puedeCondonar && h('button', { onClick: function(){ accion(props.onCondonar, l); } }, h(Ico, { name: 'shield', size: 14, color: 'var(--text2)' }), 'Condonar intereses'),
          h('button', { onClick: function(){ accion(props.onEdit, l); } }, h(Ico, { name: 'edit', size: 14, color: 'var(--text2)' }), 'Editar datos'),
          h('div', { className: 'dp-menu-t' }, 'Cerrar'),
          h('button', { onClick: function(){ accion(props.onForceClose, l); } }, h(Ico, { name: 'x', size: 14, color: 'var(--yellow)' }), 'Cerrar préstamo (forzar)'),
          h('button', { className: 'peligro', onClick: function(){ accion(props.onDelete, l.id); } }, h(Ico, { name: 'trash', size: 14, color: 'var(--red)' }), 'Eliminar préstamo'))));
    var L = m.liq || { total: 0, intMora: 0, moraConsolidada: 0, partialPend: 0 };
    figuras = h('div', { className: 'dp-figs' },
      h('div', { className: 'dp-fig' }, h('div', { className: 'dp-fig-l' }, 'Saldo pendiente'), h('div', { className: 'dp-fig-v mono' }, fmt(m.saldo)), dpUsd(m, m.saldo),
        h('div', { className: 'dp-fig-s' }, m.pct + '% del capital recuperado')),
      m.dv
        ? h('div', { className: 'dp-fig' }, h('div', { className: 'dp-fig-l' }, 'Interés devengado'), h('div', { className: 'dp-fig-v mono', style: { color: 'var(--blue)' } }, fmt(m.dv.interesPendiente)), dpUsd(m, m.dv.interesPendiente),
            h('div', { className: 'dp-fig-s' }, m.dv.diasDesdeUltimoCorte + ' días desde el último corte'))
        : h('div', { className: 'dp-fig' }, h('div', { className: 'dp-fig-l' }, 'Próxima cuota'),
            m.prox ? [h('div', { key: 'v', className: 'dp-fig-v mono', style: { color: m.dProx === 0 ? 'var(--yellow)' : 'var(--text)' } }, fmt(pendCuota(m.prox))), h('span', { key: 'u' }, dpUsd(m, pendCuota(m.prox))),
              h('div', { key: 's', className: 'dp-fig-s' }, 'cuota ' + m.prox.cuotaN + ' · ' + opCorta(m.prox.fechaPago) + ' · ' + opRel(hoy, m.prox.fechaPago))]
              : h('div', { className: 'dp-fig-v', style: { color: 'var(--text3)' } }, '—')),
      h('div', { className: 'dp-fig' + (m.enMora.length ? ' mal' : '') }, h('div', { className: 'dp-fig-l' }, 'En mora'),
        m.enMora.length
          ? [h('div', { key: 'v', className: 'dp-fig-v mono', style: { color: 'var(--red)' } }, fmt(m.moraMonto)), h('span', { key: 'u' }, dpUsd(m, m.moraMonto)),
             h('div', { key: 's', className: 'dp-fig-s' }, m.enMora.length + ' cuota' + (m.enMora.length > 1 ? 's' : '') + ' · la más vieja hace ' + m.moraDias + ' días')]
          : [h('div', { key: 'v', className: 'dp-fig-v', style: { color: 'var(--green)' } }, 'Al día'), h('div', { key: 's', className: 'dp-fig-s' }, 'ninguna cuota vencida')]),
      h('div', { className: 'dp-fig' }, h('div', { className: 'dp-fig-l' }, 'Liquidar hoy'), h('div', { className: 'dp-fig-v mono', style: { color: 'var(--yellow)' } }, fmt(L.total)), dpUsd(m, L.total),
        h('div', { className: 'dp-fig-s' }, 'capital' + (L.intMora > 0 ? ' + intereses en mora' : '') + (L.moraConsolidada > 0 ? ' + mora consolidada' : '') + (m.dv ? ' + interés devengado' : '') + (L.partialPend > 0 ? ' − abonos parciales' : ''))));
  } else if (m){
    var meses = m.fechaFin ? Math.max(0, Math.round((new Date(m.fechaFin + 'T12:00:00') - new Date(l.fechaInicio + 'T12:00:00')) / (30.44 * 864e5))) : null;
    acciones = h('div', { className: 'dp-acc' },
      !esDiario(l) && h('button', { className: 'op-btn', onClick: function(){ generateCronogramaPDF(l, m.lp, document.documentElement.getAttribute('data-theme') === 'dark'); } }, h(Ico, { name: 'download', size: 15, color: 'var(--text2)', sw: 2.2 }), 'Cronograma PDF'),
      h('button', { className: 'op-btn', onClick: function(){ accion(props.onEdit, l); } }, h(Ico, { name: 'edit', size: 15, color: 'var(--text2)', sw: 2.2 }), 'Editar'),
      h('button', { className: 'op-btn peligro', onClick: function(){ accion(props.onDelete, l.id); } }, h(Ico, { name: 'trash', size: 15, color: 'var(--red)', sw: 2.2 }), 'Eliminar'));
    var cancel = l.estado === 'Cancelado', perd = Math.round((l.capitalPerdido || 0) + (l.interesesPerdidos || 0));
    figuras = h('div', { className: 'dp-figs' },
      h('div', { className: 'dp-fig' }, h('div', { className: 'dp-fig-l' }, 'Capital prestado'), h('div', { className: 'dp-fig-v mono' }, dpMonto(m)), m.esUSD && h('div', { className: 'dp-fig-s' }, fmt(m.orig) + ' · TRM ' + fmtN(m.trm))),
      h('div', { className: 'dp-fig' }, h('div', { className: 'dp-fig-l' }, 'Total recibido'), h('div', { className: 'dp-fig-v mono' }, fmt(m.recTotal)), m.esUSD && usdLinea(fmtUSD(m.recTotalUSD))),
      m.condonado
        ? h('div', { className: 'dp-fig' }, h('div', { className: 'dp-fig-l' }, 'Intereses condonados'), h('div', { className: 'dp-fig-v mono', style: { color: 'var(--yellow)' } }, fmt(Math.round(l.interesesPerdidos || 0))),
            h('div', { className: 'dp-fig-s' }, 'capital recuperado al 100%'))
      : cancel
        ? h('div', { className: 'dp-fig mal' }, h('div', { className: 'dp-fig-l' }, 'Pérdida'), h('div', { className: 'dp-fig-v mono', style: { color: 'var(--red)' } }, '-' + fmt(perd)))
        : h('div', { className: 'dp-fig' }, h('div', { className: 'dp-fig-l' }, m.esPrest && m.esUSD ? 'Efecto TRM' : 'Ganancia'),
            h('div', { className: 'dp-fig-v mono', style: { color: m.recGan < 0 ? 'var(--red)' : 'var(--green)' } }, (m.recGan > 0 ? '+' : '') + fmt(m.recGan)),
            m.esUSD && !m.esPrest && usdLinea('+' + fmtUSD(m.gp.usd))),
      h('div', { className: 'dp-fig' }, h('div', { className: 'dp-fig-l' }, cancel ? 'Cerrado el' : 'Pagado el'), h('div', { className: 'dp-fig-v' }, m.fechaFin ? opCortaAnio(m.fechaFin) : '—'),
        meses != null && h('div', { className: 'dp-fig-s' }, 'duró ' + (meses < 1 ? 'menos de un mes' : meses + (meses === 1 ? ' mes' : ' meses')))));
  }

  var deudaUSD = M.saldoUSD > 0 ? usdLinea('incluye ' + fmtUSD(M.saldoUSD)) : null;
  return h('aside', { className: 'dp' + (props.superpuesto ? ' superpuesto' : '') },
    h('div', { className: 'dp-head' },
      props.superpuesto && h('button', { className: 'dp-x', onClick: props.onClose, title: 'Volver' }, h(Ico, { name: 'chevleft', size: 18, color: 'var(--text2)', sw: 2.4 })),
      h('div', { className: 'op-avatar grande e-' + M.estado }, opIniciales(d.nombre)),
      h('div', { style: { minWidth: 0, flex: 1 } },
        h('div', { className: 'dp-nombre' }, properCase(d.nombre), ' ', dpChip(M.estado, M.estado === 'mora' ? ' · ' + M.moraDias + ' días' : '')),
        h('div', { className: 'dp-meta' },
          tel && h('button', { className: 'dp-tel', title: 'Copiar teléfono', onClick: function(){ try { navigator.clipboard.writeText(tel); } catch (_){} if (props.showToast) props.showToast('Teléfono copiado'); } },
            h(Ico, { name: 'phone', size: 12, color: 'var(--blue)', sw: 2.2 }), tel),
          cc && h('span', null, 'CC ' + cc),
          h('span', null, M.mods.length + ' préstamo' + (M.mods.length === 1 ? '' : 's') + ' · ' + M.activos.length + ' activo' + (M.activos.length === 1 ? '' : 's')),
          M.ultimo && h('span', null, 'último pago ' + opCorta(M.ultimo.fecha) + ' · ' + fmt(M.ultimo.cop)))),
      h('div', { className: 'dp-head-acc' },
        // Del deudor, no de un prestamo: por eso va en la cabecera y no entre las acciones del credito.
        puedeReciboGeneral(M.activos.map(function(x){ return x.loan; })) && h('button', { className: 'op-btn sm', title: 'Recibo de cobro general (PDF): toda su deuda vencida, sus opciones de pago y el estado de cada crédito',
          onClick: function(){ generateReciboGeneral(M.activos.map(function(x){ return x.loan; }), pays, props.datosPago, { hasta: hoy }); } },
          h(Ico, { name: 'clipboard', size: 14, color: 'var(--text2)', sw: 2.3 }), 'Recibo general'),
        h('button', { className: 'op-btn sm', onClick: function(){ props.onNewLoan(d); }, title: 'Nuevo préstamo a ' + properCase(d.nombre) }, h(Ico, { name: 'plus', size: 14, color: 'var(--text2)', sw: 2.4 }), 'Préstamo'),
        !props.superpuesto && props.onClose && h('button', { className: 'dp-x', onClick: props.onClose, title: 'Cerrar panel' }, h(Ico, { name: 'x', size: 15, color: 'var(--text2)', sw: 2.4 })))),
    h('div', { className: 'dp-kpis' },
      h('div', { className: 'dp-kpi' }, h('div', { className: 'dp-fig-l' }, 'Te debe'), h('div', { className: 'dp-kpi-v mono' }, fmt(M.saldo)), deudaUSD),
      h('div', { className: 'dp-kpi' + (M.mora ? ' mal' : '') }, h('div', { className: 'dp-fig-l' }, 'Vencido'), h('div', { className: 'dp-kpi-v mono', style: { color: M.mora ? 'var(--red)' : 'var(--text3)' } }, M.mora ? fmt(M.mora) : '$ 0'),
        M.moraN > 0 && h('div', { className: 'dp-fig-s' }, M.moraN + ' cuota' + (M.moraN > 1 ? 's' : ''))),
      h('div', { className: 'dp-kpi' }, h('div', { className: 'dp-fig-l' }, 'Te ha pagado'), h('div', { className: 'dp-kpi-v mono' }, fmt(M.cobrado)), h('div', { className: 'dp-fig-s' }, 'en toda la relación')),
      h('div', { className: 'dp-kpi' }, h('div', { className: 'dp-fig-l' }, 'Ganancia'), h('div', { className: 'dp-kpi-v mono', style: { color: 'var(--green)' } }, (M.ganancia > 0 ? '+' : '') + fmt(M.ganancia)),
        M.gananciaUSD > 0 && usdLinea('+' + fmtUSD(M.gananciaUSD) + ' en dólares'))),
    todos.length > 0 && h('div', { className: 'dp-tabs' },
      M.activos.map(tab),
      M.cerrados.length > 0 && h('button', { className: 'dp-tab hist' + (verHist ? ' abierto' : ''), onClick: function(){ setVerHist(!verHist); } },
        h('div', { className: 'dp-tab-1' }, h(Ico, { name: verHist ? 'chevleft' : 'clock', size: 13, color: 'var(--text3)', sw: 2.3 }), verHist ? 'Ocultar' : 'Historial'),
        h('div', { className: 'dp-tab-2' }, M.cerrados.length + ' cerrado' + (M.cerrados.length > 1 ? 's' : ''))),
      verHist && M.cerrados.map(tab)),
    !m && h('div', { className: 'op-vacio' }, 'Este deudor no tiene préstamos.'),
    m && h('section', { className: 'dp-loan' },
      h('div', { className: 'dp-loan-h' },
        h('div', { style: { minWidth: 0 } },
          h('div', { className: 'dp-loan-t' }, dpMonto(m), m.esUSD && h('span', { className: 'dp-loan-cop mono' }, ' · ' + fmt(m.orig)), ' ', dpChip(m.estado)),
          h('div', { className: 'dp-loan-s' }, [opModalidad(l.modalidad), opFrecuencia(l), (+l.tasaMensual > 0 ? String(l.tasaMensual).replace('.', ',') + '% mensual' : 'sin interés'), opPlazo(l), 'desde ' + opCortaAnio(l.fechaInicio)].join(' · '),
            m.esUSD && ' · TRM ' + fmtN(m.trm))),
        m.activo && !esDiario(l) && l.modalidad !== 'Intereses' && h('div', { className: 'dp-prog', title: m.pagadas + ' de ' + m.total + ' cuotas pagadas' },
          h('div', { className: 'dp-prog-t' }, m.pagadas + '/' + m.total + ' cuotas'),
          h('div', { className: 'op-bar' }, h('div', { style: { width: (m.total ? m.pagadas / m.total * 100 : 0) + '%', background: m.enMora.length ? 'var(--red)' : 'var(--green)' } })))),
      acciones,
      figuras,
      h('div', { className: 'dp-cuerpo' },
        h('div', { className: 'dp-cuerpo-main' },
          h('div', { className: 'dp-sec-t' }, esDiario(l) ? 'Cortes registrados' : 'Cronograma', l.modalidad === 'Intereses' && h('span', { className: 'dp-sec-n' }, 'pagadas, vencidas y la próxima · las siguientes se generan solas')),
          h(DpCronograma, { m: m, hoy: hoy, focoPay: props.focoPay, onPay: m.activo ? props.onPay : null }),
          h(FlujoCajaPanel, { loan: l, pays: pays })),
        h('div', { className: 'dp-cuerpo-lado' },
          h(DpRecaudado, { m: m }), h(DpProyeccion, { m: m }), DpExtras({ m: m })))),
    cronoPdf && h(CronogramaPdfModal, { loan: l, pays: m.lp, onClose: function(){ setCronoPdf(null); } }));
}
