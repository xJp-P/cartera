// public/js/modales/ConfirmModal.js — Confirmacion generica reutilizable (rediseño v4).
//
// El estado global sigue en `App` y baja por PROPS; los callbacks suben igual. Sin Context API y sin store.
//
// Props: title, message, detail, checkLabel, okLabel, `tono` del boton de aceptar ('peligro' para lo
// irreversible, 'aviso', o 'pri' por defecto), onConfirm(checked) y onCancel. Un clic en el fondo
// cancela (a diferencia de `Modal`: aqui no hay formulario que perder). Aspecto en modales.css.

import { h, useState } from '../core/react.js';
import { Ico } from '../componentes/iconos.js';

export function ConfirmModal(props){
  var title = props.title || 'Confirmar', msg = props.message || '', detail = props.detail;
  var onOk = props.onConfirm, onNo = props.onCancel, okLabel = props.okLabel || 'Aceptar';
  var tono = props.tono === 'peligro' || props.tono === 'aviso' ? props.tono : 'pri';
  var chk = useState(false); var checked = chk[0], setChecked = chk[1];
  return h('div', { className: 'v4m-overlay confirm', onClick: onNo },
    h('div', { className: 'v4m-sheet v4m-confirm', role: 'alertdialog', 'aria-modal': 'true', onClick: function(e){ e.stopPropagation(); } },
      h('div', { className: 'v4m-confirm-c' },
        h('span', { className: 'v4m-confirm-ico ' + tono }, h(Ico, { name: tono === 'pri' ? 'check' : 'alert', size: 18, sw: 2.3 })),
        h('div', { className: 'v4m-confirm-t' }, title),
        h('div', { className: 'v4m-confirm-m' }, msg),
        detail && h('div', { className: 'v4m-confirm-d' }, detail),
        props.checkLabel && h('label', { className: 'v4m-check' },
          h('input', { type: 'checkbox', checked: checked, onChange: function(){ setChecked(!checked); } }),
          h('span', null, props.checkLabel))),
      h('div', { className: 'v4m-confirm-acc' },
        h('button', { className: 'v4m-btn neutro', onClick: onNo }, 'Cancelar'),
        h('button', { className: 'v4m-btn ' + tono, onClick: function(){ onOk(checked); } }, okLabel))));
}
