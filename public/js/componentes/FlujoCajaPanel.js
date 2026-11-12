// public/js/componentes/FlujoCajaPanel.js — panel de Flujo de Caja Real.
//
// Va en componentes/ y no en modales/ porque NO es un modal: no superpone ni bloquea, es un panel
// expandible dentro del panel del deudor (DeudorPanel). Reconstruye lo que REALMENTE entro y cuando, a
// partir de `flujoCajaDe` (v2.2.0): el historial real de movimientos de un prestamo, no el cronograma
// teorico. Estado propio: cada tarjeta abre y cierra el suyo sin que el padre tenga que enhebrarlo.
//
// Rediseño v4 (integracion de Cartera, fase 3): los estilos van por clase (`fcv-`, en
// public/css/panel.css bajo `.v4p`) y no en linea; las cifras en tinta neutra y el color reservado al
// estado (atraso, efecto TRM negativo, saldo en cero). Mismos datos, columnas, notas y aclaraciones que
// la version anterior, que salio con esta fase.

import { Ico } from '../componentes/iconos.js';
import { flujoCajaDe } from '../core/dominio.js';
import { copToUsd, fmtD, fmtN } from '../core/format.js';
import { h, useState } from '../core/react.js';
import { usdLinea } from './CifraUSD.js';

export function FlujoCajaPanel(props){
  var loan = props.loan, pays = props.pays || [];
  var op = useState(false); var abierto = op[0]; var setAbierto = op[1];
  var fj = flujoCajaDe(loan, pays);
  if (!fj.eventos.length) return null;
  var esUSD = loan.moneda === 'USD';
  var trm = loan.trmAcordada || 1;
  // Efecto TRM: solo en prestamos USD; el filtro de $5 descarta el residuo de redondeo legacy (Bug #43).
  var hayAjuste = fj.eventos.some(function(e){ return Math.abs(e.ajuste) > 5; });
  var uSub = function(cop){ return esUSD ? usdLinea(copToUsd(cop, trm)) : null; };

  return h('div', { className: 'fcv' + (abierto ? ' abierto' : '') },
    h('button', { className: 'fcv-btn', onClick: function(){ setAbierto(!abierto); } },
      h(Ico, { name: 'chevright', size: 13, sw: 2.4 }),
      abierto ? 'Ocultar flujo de caja' : 'Ver flujo de caja',
      h('span', { className: 'fcv-n' }, fj.eventos.length)),

    abierto && h('div', { className: 'fcv-cuerpo' },
      h('div', { className: 'fcv-t' }, 'Flujo de caja real · ' + fj.eventos.length + ' movimiento' + (fj.eventos.length !== 1 ? 's' : '')),
      h('div', { className: 'fcv-tabla' },
        h('table', null,
          h('thead', null, h('tr', null,
            h('th', null, '#'), h('th', null, 'Recaudado'), h('th', null, 'Concepto'),
            h('th', { className: 'r' }, 'Interés'), h('th', { className: 'r' }, 'Capital'),
            hayAjuste ? h('th', { className: 'r' }, 'Efecto TRM') : null,
            h('th', { className: 'r' }, 'Ingreso'), h('th', { className: 'r' }, 'Saldo'))),
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
                h('td', { className: 'r fuerte' }, fmtN(e.cop), e.inferido ? h('span', { className: 'muted' }, '*') : null, esUSD ? uSub(e.cop) : null),
                h('td', { className: 'r ' + (e.saldo === 0 ? 'good' : 'muted') }, fmtN(e.saldo)));
            }),
            h('tr', { className: 'fcv-tot' },
              h('td', { className: 'txt', colSpan: 3 }, 'Totales'),
              h('td', { className: 'r' }, fmtN(fj.totales.interes)),
              h('td', { className: 'r' }, fmtN(fj.totales.capital)),
              hayAjuste ? h('td', { className: 'r ' + (fj.totales.ajuste < 0 ? 'crit' : 'good') }, fmtN(fj.totales.ajuste)) : null,
              h('td', { className: 'r fuerte' }, fmtN(fj.totales.ingreso), esUSD ? uSub(fj.totales.ingreso) : null),
              h('td', null))))),
      (fj.inferidos > 0 || hayAjuste) && h('div', { className: 'fcv-pie' },
        fj.inferidos > 0 ? h('div', { key: 'inf' },
          h('b', null, '*'), ' Monto reconstruido del valor de la cuota: son cobros anteriores a que la app registrara el efectivo exacto. La fecha sí es la real de recaudo.') : null,
        hayAjuste ? h('div', { key: 'trm' },
          h('b', null, 'Efecto TRM: '), 'diferencia entre los pesos que entraron y el valor de la cuota a la TRM pactada. El cliente entregó los dólares completos; la brecha es cambiaria, no un saldo por cobrar. Interés + Capital + Efecto TRM = Ingreso.') : null)));
}
