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
import { fmt, fmtD } from '../core/format.js';
import { periodoEnCursoDe } from '../core/dominio.js';

// En un credito abierto el devengo ya corre al dia, asi que el mes opcional es un
// cobro HACIA ADELANTE; en los de cuotas es el mes en curso que aun no se facturo.
// Con un periodo irregular en curso (3.2.0) no hay "mes": se cobran los dias elegidos.
// En Semanal y Quincenal (3.3.0) el periodo en curso es una semana o una quincena.
export function etiquetaInteresMes(L) {
  if (L && L.periodoIrregular) return 'Interés de ' + L.diasCobrados + ' días del periodo en curso';
  return L && L.esDiario ? 'Interés del próximo mes' : 'Interés ' + periodoEnCursoDe(L && L.frecuencia);
}

export function CheckInteresMes(props) {
  var L = props.L, checked = !!props.checked, onChange = props.onChange;
  if (!L || !L.aplicaInteres) return null;
  if (L.enGracia) return avisoGracia(L);
  if (L.periodoIrregular) return casillaPeriodoIrregular(L, checked, onChange, props.onDias);
  var lbl = etiquetaInteresMes(L);
  var esePeriodo = L.frecuencia === 'Semanal' ? 'esa semana' : L.frecuencia === 'Quincenal' ? 'esa quincena' : 'ese mes';
  // El texto viejo ("¿Incluir 1 mes de interes adicional?") preguntaba sin dar contexto:
  // no decia de donde sale ese mes ni cuando corresponde cobrarlo. Ahora dice QUE se
  // cobra, POR QUE existe (se liquida a mitad de ciclo) y CUANDO activarlo.
  return h('label',{className:'v4m-casilla',style:{display:'flex',alignItems:'flex-start',gap:10,borderRadius:10,padding:'11px 12px',marginBottom:12,cursor:'pointer',transition:'border-color .2s'}},
    h('input',{type:'checkbox',checked:checked,onChange:onChange,style:{width:16,height:16,cursor:'pointer',margin:'1px 0 0',flex:'none'}}),
    h('span',{style:{flex:1}},
      h('span',{style:{display:'flex',justifyContent:'space-between',gap:8}},
        h('span',{style:{fontSize:13,color:'var(--text)',fontWeight:500}},'Cobrar el '+lbl.toLowerCase()),
        h('span',{className:'mono',style:{fontSize:12,color:'var(--yellow)',whiteSpace:'nowrap'}},'+ '+fmt(L.intProxMes))),
      h('span',{style:{display:'block',fontSize:11,color:'var(--text3)',marginTop:4,lineHeight:1.45}},
        L.esDiario
          ? 'El interés ya está cobrado al día de hoy. Actívalo solo si pactaste cobrarle además el mes siguiente.'
          : 'El crédito se cierra antes del próximo vencimiento, así que '+esePeriodo+' aún no se ha facturado. Actívalo solo si lo pactaste con el deudor.')));
}

// ── Dentro de los dias de gracia (3.3.0, Fase 3, regla del PO) ───────────────
// Se perdonaron los dias muertos y el interes todavia no corre: no hay nada que cobrar por
// adelantado, asi que en vez de la casilla va un aviso que dice por que y desde cuando.
function avisoGracia(L) {
  return h('div',{style:{display:'flex',alignItems:'flex-start',gap:10,background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:10,padding:'11px 12px',marginBottom:12}},
    h('span',{style:{flex:1}},
      h('span',{style:{display:'flex',justifyContent:'space-between',gap:8}},
        h('span',{style:{fontSize:13,color:'var(--text)',fontWeight:500}},'Días de gracia: sin interés en curso'),
        h('span',{className:'mono',style:{fontSize:12,color:'var(--text3)',whiteSpace:'nowrap'}},fmt(0))),
      h('span',{style:{display:'block',fontSize:11,color:'var(--text3)',marginTop:4,lineHeight:1.45}},
        'Al crear el crédito se perdonaron los días muertos: el interés empieza a correr el '+fmtD(L.graciaHasta)+
        '. Si el deudor liquida antes, no se cobra interés por adelantado.')));
}

// ── Periodo irregular en curso: DIAS VARIABLES (3.2.0, Fase 3, regla del PO) ──
// El periodo que corre no es un mes (el tiempo muerto de un primer pago elegido, o la cuota
// que sigue a un cambio de dia), asi que la casilla no ofrece "un mes": ofrece DIAS. Por
// defecto los que ya corrieron (si se liquida al dia 10 de un periodo de 15, se cobran 10);
// el administrador los cambia con el campo o con los dos atajos, y la pantalla vuelve a
// llamar a `computeLiquidacion` con ellos, asi que la cifra y el total se mueven en vivo.
// Los controles de dias van FUERA del <label>: dentro, un clic en ellos marcaria la casilla.
function casillaPeriodoIrregular(L, checked, onChange, onDias) {
  var setDias = function (v) { if (onDias) onDias(v); };
  var atajo = function (txt, n) {
    var activo = L.diasCobrados === n;
    return h('button',{type:'button',onClick:function(){ setDias(n); },
      className:activo?'v4m-b-aviso':'',
      style:{fontSize:11,padding:'4px 9px',borderRadius:999,cursor:'pointer',
        border:activo?undefined:'1px solid var(--border)',
        background:activo?'rgba(210,153,34,.12)':'transparent',color:activo?'var(--yellow)':'var(--text2)'}},txt);
  };
  return h('div',{className:'v4m-casilla',style:{borderRadius:10,padding:'11px 12px',marginBottom:12,transition:'border-color .2s'}},
    h('label',{style:{display:'flex',alignItems:'flex-start',gap:10,cursor:'pointer'}},
      h('input',{type:'checkbox',checked:checked,onChange:onChange,style:{width:16,height:16,cursor:'pointer',margin:'1px 0 0',flex:'none'}}),
      h('span',{style:{flex:1}},
        h('span',{style:{display:'flex',justifyContent:'space-between',gap:8}},
          h('span',{style:{fontSize:13,color:'var(--text)',fontWeight:500}},'Cobrar el interés del periodo en curso'),
          h('span',{className:'mono',style:{fontSize:12,color:'var(--yellow)',whiteSpace:'nowrap'}},'+ '+fmt(L.intProxMes))),
        h('span',{style:{display:'block',fontSize:11,color:'var(--text3)',marginTop:4,lineHeight:1.45}},
          'Este periodo no es de un mes: va del '+fmtD(L.periodoDesde)+' al '+fmtD(L.periodoHasta)+' ('+L.diasPeriodo+
          ' días) y hoy van '+L.diasTranscurridos+'. Actívalo si pactaste cobrar el interés de esos días.'))),
    checked&&h('div',{style:{display:'flex',alignItems:'center',flexWrap:'wrap',gap:8,marginTop:10,paddingLeft:26}},
      h('span',{style:{fontSize:12,color:'var(--text2)'}},'Días a cobrar'),
      h('input',{type:'number',min:0,max:L.diasPeriodo,step:1,value:L.diasCobrados,
        onChange:function(e){ setDias(e.target.value===''?'':parseInt(e.target.value,10)); },
        className:'inp mono',style:{width:72,padding:'6px 8px',textAlign:'center'}}),
      h('span',{style:{fontSize:12,color:'var(--text3)'}},'de '+L.diasPeriodo),
      atajo('Hasta hoy ('+L.diasTranscurridos+')', L.diasTranscurridos),
      atajo('Todo el periodo ('+L.diasPeriodo+')', L.diasPeriodo)));
}
