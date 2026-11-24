// public/js/componentes/FlujoCajaPanel.js — panel de Flujo de Caja Real.
//
// Va en componentes/ y no en modales/ porque NO es un modal: no superpone ni bloquea, es un panel
// expandible dentro del panel del deudor (DeudorPanel). Reconstruye lo que REALMENTE entro y cuando, a
// partir de `flujoCajaDe` (v2.2.0): el historial real de movimientos de un prestamo, no el cronograma
// teorico. Estado propio: cada tarjeta abre y cierra el suyo sin que el padre tenga que enhebrarlo.
//
// Rediseño v4 (integracion de Cartera, fase 3): los estilos van por clase (`fcv-`, en
// public/css/panel.css bajo `.v4p`) y no en linea; las cifras en tinta neutra y el color reservado al
// estado (atraso, efecto TRM negativo, saldo en cero).
//
// Post-4.1.4 ("dolares por pago", aprobado por el PO sobre una maqueta):
//   - Es el tercer hijo de la rejilla del panel (`dp-cuerpo-ancho`): con el panel en dos columnas va
//     de borde a borde; en una sola, justo bajo el cronograma, como antes.
//   - En un prestamo en dolares: "Dolares entregados" y "TRM del ingreso" (pesos / dolares) por pago, y
//     sale la linea "US$" que iba bajo los pesos: era pesos / TRM pactada, no los dolares del cliente.
//     Los pagos sin dolares registrados dicen "—": no se inventan. El pie suma los dolares registrados,
//     la misma cifra de "Total recibido" (`dolaresRecibidos`).
//   - Con el panel angosto la TRM va como segunda linea bajo los dolares (`fcv-sub-trm`).

import { Ico } from '../componentes/iconos.js';
import { flujoCajaDe } from '../core/dominio.js';
import { fmtD, fmtN } from '../core/format.js';
import { h, useState } from '../core/react.js';

// Dolares en la tabla (columna de una sola moneda: sin "USD $") y la TRM con sus dos decimales.
var fcvUSD = function(n){ return new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n || 0); };
var fcvTRM = function(n){ return new Intl.NumberFormat('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n || 0); };

export function FlujoCajaPanel(props){
  var loan = props.loan, pays = props.pays || [];
  var op = useState(false); var abierto = op[0]; var setAbierto = op[1];
  var fj = flujoCajaDe(loan, pays);
  if (!fj.eventos.length) return null;
  var esUSD = loan.moneda === 'USD';
  var trm = loan.trmAcordada || 0;
  // Efecto TRM: solo en prestamos USD; el filtro de $5 descarta el residuo de redondeo legacy (Bug #43).
  var hayAjuste = fj.eventos.some(function(e){ return Math.abs(e.ajuste) > 5; });
  var D = fj.dolares;
  var trmProm = D.usd > 0 ? D.copConUSD / D.usd : null;
  var variosPorPago = esUSD && fj.eventos.some(function(e){ return e.nEv > 1 && e.usd != null && e.nPagos === 1; });
  var variosPromedio = esUSD && fj.eventos.some(function(e){ return e.nPagos > 1; });

  function celdaUSD(e){
    if (e.usd == null) return h('td', { className: 'r muted' }, '—',
      h('div', { className: 'fcv-nota' }, e.enOtroPago ? 'en el último pago' : 'sin registrar'));
    return h('td', { className: 'r fuerte' }, fcvUSD(e.usd),
      e.nPagos > 1 && h('div', { className: 'fcv-nota muted' }, 'de los ' + e.nPagos + ' pagos'),
      h('div', { className: 'fcv-sub-trm' }, 'TRM ' + fcvTRM(e.trmDia) + (e.nPagos > 1 ? ' · promedio' : '')));
  }
  function celdaTRM(e){
    return h('td', { className: 'r fcv-col-trm' }, e.trmDia == null ? h('span', { className: 'muted' }, '—') : fcvTRM(e.trmDia),
      e.nPagos > 1 && h('div', { className: 'fcv-nota muted' }, 'promedio'));
  }

  return h('div', { className: 'fcv dp-cuerpo-ancho' + (abierto ? ' abierto' : '') },
    h('button', { className: 'fcv-btn', onClick: function(){ setAbierto(!abierto); } },
      h(Ico, { name: 'chevright', size: 13, sw: 2.4 }),
      abierto ? 'Ocultar flujo de caja' : 'Ver flujo de caja',
      h('span', { className: 'fcv-n' }, fj.eventos.length)),

    abierto && h('div', { className: 'fcv-cuerpo' },
      h('div', { className: 'fcv-t' }, 'Flujo de caja real · ' + fj.eventos.length + ' movimiento' + (fj.eventos.length !== 1 ? 's' : ''),
        esUSD && trm > 0 && h('span', { className: 'fcv-t-trm' }, 'TRM pactada $ ' + fmtN(trm))),
      h('div', { className: 'fcv-tabla' },
        h('table', null,
          h('thead', null,
            esUSD && h('tr', { className: 'fcv-grupos' },
              h('th', { colSpan: 3 }),
              h('th', { colSpan: hayAjuste ? 3 : 2, className: 'g' }, 'Cómo se aplicó'),
              h('th', { colSpan: 3, className: 'g fcv-g-ancho' }, 'Lo que entró'),
              h('th', { colSpan: 2, className: 'g fcv-g-angosto' }, 'Lo que entró'),
              h('th', null)),
            h('tr', null,
              h('th', null, '#'), h('th', null, 'Recaudado'), h('th', null, 'Concepto'),
              h('th', { className: 'r' }, 'Interés'), h('th', { className: 'r' }, 'Capital'),
              hayAjuste ? h('th', { className: 'r' }, 'Efecto TRM') : null,
              h('th', { className: 'r' }, esUSD ? 'Pesos recibidos' : 'Ingreso'),
              esUSD ? h('th', { className: 'r' }, 'Dólares entregados') : null,
              esUSD ? h('th', { className: 'r fcv-col-trm' }, 'TRM del ingreso') : null,
              h('th', { className: 'r' }, 'Saldo'))),
          h('tbody', null,
            fj.eventos.map(function(e){
              var concepto = e.esAbono
                ? (/liquidacion/i.test(e.obs) ? 'Liquidación' : 'Abono a capital')
                : (e.parcialEnCurso ? 'Pago parcial cuota #' + e.cuotaN : 'Cuota #' + e.cuotaN);
              var nota = null;
              if (e.parcialEnCurso) nota = h('div', { className: 'fcv-nota warn' }, 'no salda la cuota');
              else if (e.atraso !== null && e.atraso > 0) nota = h('div', { className: 'fcv-nota ' + (e.atraso > 7 ? 'crit' : 'warn') }, 'vencía ' + fmtD(e.vence).replace(/ de \d+$/, '') + ' · +' + e.atraso + ' día' + (e.atraso !== 1 ? 's' : ''));
              else if (e.atraso !== null && e.atraso <= 0) nota = h('div', { className: 'fcv-nota good' }, e.atraso < 0 ? 'anticipado' : 'puntual');
              return h('tr', { key: e.n },
                h('td', { className: 'muted' }, String(e.n)),
                h('td', { className: 'sec' }, fmtD(e.fecha).replace(/ de /g, ' ')),
                h('td', { className: 'txt' }, h('div', null, concepto), nota),
                h('td', { className: 'r' }, fmtN(e.interes)),
                h('td', { className: 'r' }, fmtN(e.capital)),
                hayAjuste ? h('td', { className: 'r ' + (e.ajuste < 0 ? 'crit' : e.ajuste > 0 ? 'good' : 'muted') }, e.ajuste === 0 ? '—' : fmtN(e.ajuste)) : null,
                h('td', { className: 'r fuerte' }, fmtN(e.cop), e.inferido ? h('span', { className: 'muted' }, '*') : null),
                esUSD ? celdaUSD(e) : null,
                esUSD ? celdaTRM(e) : null,
                h('td', { className: 'r ' + (e.saldo === 0 ? 'good' : 'muted') }, fmtN(e.saldo)));
            }),
            h('tr', { className: 'fcv-tot' },
              h('td', { className: 'txt', colSpan: 3 }, 'Totales'),
              h('td', { className: 'r' }, fmtN(fj.totales.interes)),
              h('td', { className: 'r' }, fmtN(fj.totales.capital)),
              hayAjuste ? h('td', { className: 'r ' + (fj.totales.ajuste < 0 ? 'crit' : 'good') }, fmtN(fj.totales.ajuste)) : null,
              h('td', { className: 'r fuerte' }, fmtN(fj.totales.ingreso)),
              esUSD ? h('td', { className: 'r fuerte fcv-tot-usd' }, D.usd > 0 ? fcvUSD(D.usd) : '—',
                D.sinUSD > 0 && h('div', { className: 'fcv-nota muted' }, 'no incluye ' + D.sinUSD + ' pago' + (D.sinUSD !== 1 ? 's' : '')),
                trmProm && h('div', { className: 'fcv-sub-trm' }, 'TRM promedio ' + fcvTRM(trmProm))) : null,
              esUSD ? h('td', { className: 'r fcv-col-trm' }, trmProm ? fcvTRM(trmProm) : '—', trmProm && h('div', { className: 'fcv-nota muted' }, 'promedio')) : null,
              h('td', null))))),
      (fj.inferidos > 0 || hayAjuste || esUSD) && h('div', { className: 'fcv-pie' },
        fj.inferidos > 0 ? h('div', { key: 'inf' },
          h('b', null, '*'), ' Monto reconstruido del valor de la cuota: son cobros anteriores a que la app registrara el efectivo exacto. La fecha sí es la real de recaudo.') : null,
        esUSD ? h('div', { key: 'usd' },
          h('b', null, 'Dólares entregados: '), 'lo que el cliente entregó en cada pago. ',
          D.sinUSD > 0 ? '«—» son pagos registrados antes de que la app pidiera los dólares: se sabe cuántos pesos entraron, no cuántos dólares. ' : null,
          h('b', null, 'TRM del ingreso'), ' = pesos recibidos ÷ dólares entregados (no se guarda: sale de esas dos cifras).') : null,
        hayAjuste ? h('div', { key: 'trm' },
          h('b', null, 'Efecto TRM: '), esUSD
            ? 'lo que la TRM del día le quitó (o le sumó) en pesos a cada pago frente a la TRM pactada ($ ' + fmtN(trm) + '). El cliente entregó los dólares completos: no es un saldo por cobrar. Interés + Capital + Efecto TRM = Pesos recibidos.'
            : 'diferencia entre los pesos que entraron y el valor de la cuota. Interés + Capital + Efecto TRM = Ingreso.') : null,
        variosPorPago ? h('div', { key: 'pp' },
          h('b', null, 'Cuota pagada en varias partes: '), 'cada pago con sus dólares y su TRM, y el efecto TRM en el pago en que ocurrió.') : null,
        variosPromedio ? h('div', { key: 'prom' },
          h('b', null, 'Pagos anteriores en varias partes: '), 'la app guardaba solo el total de dólares de la cuota; van en el último pago, con la TRM promedio, y el efecto TRM de toda la cuota cae ahí.') : null)));
}
