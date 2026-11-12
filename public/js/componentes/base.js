// public/js/componentes/base.js — los tres primitivos de UI de los modales (rediseño v4).
//
// `Modal` (contenedor), `Fld` (etiqueta + campo) y `ABtn` (boton de accion) van juntos porque son el kit
// con el que estan construidos 15 de los 16 modales de la app (el 16, ConfirmModal, arma su propia
// tarjeta con las mismas clases). Su aspecto vive en public/css/modales.css (prefijo `v4m-`): fondo
// oscuro con desenfoque, la tarjeta entra con fundido y escala, campos de 44 px y botones con color
// semantico. Aqui no hay estilos en linea.
//
// DOS DETALLES DE COMPORTAMIENTO QUE NO SE TOCAN:
//  - `Modal`: el fondo NO cierra (QA3). Solo cierran la X y los botones de accion, para no perder datos
//    de un formulario a medio llenar por un clic.
//  - `ABtn`: la prop opcional `disabled` (v1.18.1) es la que permite a las guardas anti doble-submit
//    apagar el boton (sin `onClick` mientras esta apagado).

import { h } from '../core/react.js';
import { Ico } from './iconos.js';

// `tall` da mas alto (92vh) y `wide` mas ancho (720 px) a los formularios largos.
export function Modal(props){
  var children = props.children, onClose = props.onClose, tall = props.tall, wide = props.wide;
  return h('div', { className: 'v4m-overlay' },
    h('div', { className: 'v4m-sheet' + (wide ? ' ancho' : '') + (tall ? ' alto' : ''), role: 'dialog', 'aria-modal': 'true' },
      h('button', { className: 'v4m-x', onClick: onClose, title: 'Cerrar', 'aria-label': 'Cerrar' }, h(Ico, { name: 'x', size: 15, sw: 2.4 })),
      h('div', { className: 'v4m-body' }, children)));
}

export function Fld(props){
  return h('div', { className: 'v4m-fld' }, h('div', { className: 'v4m-fld-l' }, props.label), props.children);
}

// `tono` es el color semantico del boton: 'pri' (la accion principal, negro sobre blanco o al reves),
// 'peligro' (lo irreversible, en rojo), 'aviso', 'info' o 'neutro' (por defecto).
var ABTN_TONOS = ['pri', 'peligro', 'aviso', 'info', 'neutro'];
export function ABtn(props){
  var dis = !!props.disabled;
  var tono = ABTN_TONOS.indexOf(props.tono) !== -1 ? props.tono : 'neutro';
  return h('button', { className: 'v4m-btn ' + tono, onClick: dis ? undefined : props.onClick, disabled: dis },
    h(Ico, { name: props.icon, size: 15, sw: 2.3 }), props.label);
}
