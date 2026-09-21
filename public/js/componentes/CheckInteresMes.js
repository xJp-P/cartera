// public/js/componentes/CheckInteresMes.js — la casilla "Cobrar el interes del mes en curso".
//
// La comparten los dos lugares donde se decide el valor de liquidacion: `LiquidarModal`
// (antes de cerrar el credito) y `CronogramaPdfModal` (antes de imprimir el cronograma,
// que cierra con ese mismo valor). Vive aqui para que las dos pantallas pregunten lo
// mismo con las mismas palabras, la misma explicacion y la misma cifra: dos redacciones
// de una misma decision comercial acaban diciendo cosas distintas.
//
// Recibe el objeto de `computeLiquidacion` que la pantalla ya calculo (`L`) y no calcula
// nada por su cuenta. Si el credito no puede cobrar ese interes (`L.aplicaInteres`
// falso: Prestamo, Pago Unico, tasa 0) no se dibuja.

import { h } from '../core/react.js';
import { fmt } from '../core/format.js';

// En un credito abierto el devengo ya corre al dia, asi que el mes opcional es un
// cobro HACIA ADELANTE; en los de cuotas es el mes en curso que aun no se facturo.
export function etiquetaInteresMes(L) {
  return L && L.esDiario ? 'Interes del proximo mes' : 'Interes del mes en curso';
}

export function CheckInteresMes(props) {
  var L = props.L, checked = !!props.checked, onChange = props.onChange;
  if (!L || !L.aplicaInteres) return null;
  var lbl = etiquetaInteresMes(L);
  // El texto viejo ("¿Incluir 1 mes de interes adicional?") preguntaba sin dar contexto:
  // no decia de donde sale ese mes ni cuando corresponde cobrarlo. Ahora dice QUE se
  // cobra, POR QUE existe (se liquida a mitad de ciclo) y CUANDO activarlo.
  return h('label',{style:{display:'flex',alignItems:'flex-start',gap:10,background:'var(--bg3)',border:'1px solid '+(checked?'var(--yellow)':'var(--border)'),borderRadius:10,padding:'11px 12px',marginBottom:12,cursor:'pointer',transition:'border-color .2s'}},
    h('input',{type:'checkbox',checked:checked,onChange:onChange,style:{width:16,height:16,accentColor:'var(--yellow)',cursor:'pointer',margin:'1px 0 0',flex:'none'}}),
    h('span',{style:{flex:1}},
      h('span',{style:{display:'flex',justifyContent:'space-between',gap:8}},
        h('span',{style:{fontSize:13,color:'var(--text)',fontWeight:500}},'Cobrar el '+lbl.toLowerCase()),
        h('span',{className:'mono',style:{fontSize:12,color:'var(--yellow)',whiteSpace:'nowrap'}},'+ '+fmt(L.intProxMes))),
      h('span',{style:{display:'block',fontSize:11,color:'var(--text3)',marginTop:4,lineHeight:1.45}},
        L.esDiario
          ? 'El interes ya esta cobrado al dia de hoy. Activalo solo si pactaste cobrarle ademas el mes siguiente.'
          : 'El credito se cierra antes del proximo vencimiento, asi que ese mes aun no se ha facturado. Activalo solo si lo pactaste con el deudor.')));
}
