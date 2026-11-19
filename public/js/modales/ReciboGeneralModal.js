// public/js/modales/ReciboGeneralModal.js — antes de imprimir el Recibo de cobro general (post-4.0.0, punto 4 del PO).
//
// Hace la MISMA pregunta que Liquidar deuda y el cronograma ("¿cobrar el interes del periodo en
// curso?"), pero para varios creditos a la vez: una casilla por credito (todas desmarcadas, como
// alla) y una que las marca todas. Arriba, las tres cifras de "Tu deuda hoy" tal como se van a
// imprimir: salen de `modeloReciboGeneral`, el mismo modelo del generador, asi que el modal no
// puede anunciar una cifra distinta de la del papel.
// Solo se abre si la pregunta tiene respuesta en algun credito (si no, el recibo sale directo).

import { h, useState } from '../core/react.js';
import { Modal } from '../componentes/base.js';
import { Ico } from '../componentes/iconos.js';
import { fmt, fmtD, fmtUSD } from '../core/format.js';
import { opModalidad } from '../core/operacion.js';
import { etiquetaInteresMes } from '../componentes/CheckInteresMes.js';
import { generateReciboGeneral, modeloReciboGeneral } from '../pdf/recibo-general.js';

function rgPct(t){ return (+t).toLocaleString('es-CO', { maximumFractionDigits: 3 }) + '%'; }

// ¿Hace falta preguntar? Solo si algun credito activo puede cobrar el interes en curso.
export function rgPregunta(loans, pays, hoy){
  return modeloReciboGeneral(loans, pays, { hasta: hoy }).conMes.length > 0;
}

// La puerta del boton "Recibo general" (panel del deudor y fila agrupada de Cobros, via App): si
// la pregunta tiene respuesta abre el modal (`abrirModal`); si no, imprime directo, sin el interes
// en curso. Es la regla del cronograma PDF (`preguntaInteresMes`): no se pregunta lo que no aplica.
export function abrirReciboGeneral(loansDeudor, pays, hoy, datosPago, abrirModal){
  if (rgPregunta(loansDeudor, pays, hoy)) abrirModal();
  else generateReciboGeneral(loansDeudor, pays, datosPago, { hasta: hoy });
}

export function ReciboGeneralModal(props){
  var hoy = props.hoy, loans = props.loans, pays = props.pays;
  var s = useState({}); var marcas = s[0], setMarcas = s[1];
  var Mo = modeloReciboGeneral(loans, pays, { hasta: hoy, interesMes: marcas });
  var conMes = Mo.conMes, todas = conMes.length > 0 && conMes.every(function(m){ return !!marcas[m.l.id]; });
  function marcarTodas(v){ var o = {}; conMes.forEach(function(m){ o[m.l.id] = v; }); setMarcas(o); }
  var M = function(m, u){ return m.mon.fmtUni(u); };
  var vig = Mo.mods.map(function(m){ return m.validoHasta; }).filter(Boolean).sort()[0];
  function fila(m){
    var on = !!marcas[m.l.id], L = m.L0;
    return h('label', { key: m.l.id, className: 'rg-corr' + (on ? ' on' : '') },
      h('input', { type: 'checkbox', checked: on, onChange: function(){ var o = Object.assign({}, marcas); o[m.l.id] = !on; setMarcas(o); } }),
      h('span', { className: 'rg-corr-t' },
        h('b', null, (Mo.varios ? 'Crédito ' + (m.i + 1) + ' · ' : '') + (m.mon.esUSD ? fmtUSD(m.l.montoOrigen) : fmt(m.l.montoOrigen)) + ' · ' + rgPct(+m.l.tasaMensual) + ' · ' + opModalidad(m.l.modalidad, true)),
        h('small', null, etiquetaInteresMes(L) + (m.prox ? ' · su próxima cuota vence el ' + fmtD(m.prox.fechaPago) : ''))),
      h('span', { className: 'rg-corr-v' }, '+ ' + M(m, m.mon.uni(m.mesPosible))));
  }
  var cifra = function(rot, val, sub, cls){
    return h('div', { className: 'rg-cifra' + (cls ? ' ' + cls : '') }, h('span', null, rot), h('b', null, val), h('small', null, sub));
  };
  var hayVenc = Mo.vencT.cop || Mo.vencT.usd;
  // Lo que suma el interes en curso si se marcan TODOS: se ve antes de decidir (atenuado sin marcar),
  // como el monto de cada fila. Con un solo credito es la unica cifra de la casilla.
  var posT = { cop: 0, usd: 0 };
  conMes.forEach(function(m){ posT[m.mon.esUSD ? 'usd' : 'cop'] += m.mon.uni(m.mesPosible); });
  return h(Modal, { onClose: props.onClose, wide: true },
    h('div', null, h('div', { className: 'v4m-tit' }, 'Recibo de cobro general'),
      h('div', { className: 'rg-sub' }, props.deudor + ' · ' + (Mo.varios ? Mo.activos.length + ' créditos activos' : '1 crédito activo') + ' · cifras al ' + fmtD(hoy))),
    // Lo que se va a imprimir en "Tu deuda hoy".
    h('div', { className: 'rg-deuda' },
      cifra('Vencido', hayVenc ? Mo.monto(Mo.vencT) : '—', hayVenc ? 'para ponerse al día' : 'nada vencido', hayVenc ? 'ambar' : ''),
      cifra('Debe hoy', Mo.monto(Mo.liqT), 'si liquida todo hoy' + ((Mo.liqMesT.cop || Mo.liqMesT.usd) ? ', con el interés en curso' : ''), 'fuerte'),
      cifra('Si sigue con sus cuotas', Mo.mods.some(function(m){ return !m.esIndef; }) ? Mo.monto(Mo.faltaT) : 'Sin plazo fijo', 'todas las cuotas que le quedan')),
    // La pregunta del interes en curso, credito por credito.
    conMes.length > 0 && h('div', { className: 'v4m-casilla rg-corridos' },
      h('label', { className: 'rg-corr-cab' + (todas ? ' on' : '') },
        h('input', { type: 'checkbox', checked: todas, onChange: function(){ marcarTodas(!todas); } }),
        h('span', null, h('b', null, conMes.length > 1 ? 'Cobrar el interés del periodo en curso al liquidar' : 'Cobrar el ' + etiquetaInteresMes(conMes[0].L0).toLowerCase() + ' al liquidar'),
          h('small', null, 'Es la misma casilla de Liquidar deuda: el crédito se liquidaría antes de su próximo vencimiento y ese periodo aún no se ha facturado. ' +
            'Márcala solo si lo pactaste con el deudor. Cambia "Debe hoy" y la vigencia del recibo; lo vencido y las cuotas no se mueven.')),
        h('span', { className: 'rg-corr-tot' }, '+ ' + Mo.monto(posT))),
      conMes.length > 1 && conMes.map(fila)),
    h('div', { className: 'rg-nota' }, h(Ico, { name: 'clipboard', size: 15, sw: 2.2 }),
      h('span', null, 'El recibo es un aviso de cobro: no registra nada. Lo que debe hoy vale ' + (vig ? 'hasta el ' + fmtD(vig) + ', cuando vence su próxima cuota.' : 'para el ' + fmtD(hoy) + '.'))),
    h('div', { className: 'rg-acc' },
      h('button', { className: 'v4m-btn neutro', onClick: props.onClose }, 'Cancelar'),
      h('button', { className: 'btn-primary', onClick: function(){ props.onGenerar({ hasta: hoy, interesMes: marcas }); } },
        h(Ico, { name: 'download', size: 15, sw: 2.3 }), ' Generar el recibo (PDF)')));
}
