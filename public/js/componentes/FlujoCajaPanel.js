// public/js/componentes/FlujoCajaPanel.js — panel de Flujo de Caja Real.
//
// Extraido de `app.js` en la Etapa 3 (B7) del refactor. Codigo VERBATIM.
//
// Va en componentes/ y no en modales/ porque NO es un modal: no superpone ni
// bloquea, es un panel expandible dentro del panel del deudor (DeudorPanel, 3.5.0).
//
// Reconstruye lo que REALMENTE entro y cuando, a partir de `flujoCajaDe`. Es la
// destino de una de las aristas componente->componente de la app: DeudorPanel lo usa.

import { Ico } from '../componentes/iconos.js';
import { flujoCajaDe } from '../core/dominio.js';
import { copToUsd, fmtD, fmtN } from '../core/format.js';
import { h, useState } from '../core/react.js';
import { usdLinea } from './CifraUSD.js';

// ── FlujoCajaPanel (v2.2.0) ───────────────────────────────────────────────────
// Panel expandible con el historial REAL de movimientos de un prestamo (no el cronograma
// teorico). Se usa en el perfil del deudor, tanto en creditos cerrados como en activos.
// Estado propio: cada tarjeta abre y cierra el suyo sin que el padre tenga que enhebrarlo.
export function FlujoCajaPanel(props){
  var loan=props.loan,pays=props.pays||[];
  var op=useState(false); var abierto=op[0]; var setAbierto=op[1];
  var fj=flujoCajaDe(loan,pays);
  if(!fj.eventos.length) return null;
  var esUSD=loan.moneda==='USD';
  var trm=loan.trmAcordada||1;
  // Efecto TRM: hueco entre la caja y la composicion de la cuota (Fase 2). Solo se materializa
  // en prestamos USD; el filtro de $5 descarta el residuo de redondeo de las filas legacy del
  // Bug #43, que no es informacion para el usuario sino ruido historico de 1-3 pesos.
  var hayAjuste=fj.eventos.some(function(e){return Math.abs(e.ajuste)>5;});
  var uSub=function(cop){return esUSD?usdLinea(copToUsd(cop,trm),{fontSize:9,fontWeight:400}):null;};
  var th=function(txt,alin,w){return h('th',{style:{textAlign:alin||'left',padding:'5px 4px',color:'var(--text3)',fontWeight:600,fontSize:9,letterSpacing:.3,width:w}},txt);};
  var td=function(kids,alin,color,extra){return h('td',{style:Object.assign({padding:'6px 4px',textAlign:alin||'left',color:color||'var(--text)',verticalAlign:'top'},extra||{})},kids);};

  return h('div',{style:{marginTop:8}},
    h('button',{onClick:function(){setAbierto(!abierto);},
      style:{display:'flex',alignItems:'center',gap:6,padding:'7px 11px',borderRadius:8,fontSize:12,fontWeight:600,fontFamily:'inherit',
        background:abierto?'var(--blue-bg)':'transparent',border:'1px solid '+(abierto?'var(--blue)':'var(--border)'),
        color:abierto?'var(--blue)':'var(--text2)',cursor:'pointer',transition:'all .15s'}},
      h(Ico,{name:abierto?'chevdown':'chevright',size:13,color:abierto?'var(--blue)':'var(--text2)',sw:2.2}),
      abierto?'Ocultar flujo de caja':'Ver flujo de caja'),

    abierto&&h('div',{style:{marginTop:9}},
      h('div',{style:{fontSize:9,color:'var(--text3)',fontWeight:600,letterSpacing:.5,marginBottom:5}},
        'FLUJO DE CAJA REAL · '+fj.eventos.length+' movimiento'+(fj.eventos.length!==1?'s':'')),
      h('div',{style:{overflowX:'auto'}},
        h('table',{style:{width:'100%',borderCollapse:'collapse',fontSize:11}},
          h('thead',null,h('tr',{style:{borderBottom:'1px solid var(--border2)'}},
            th('#','left',22),th('Recaudado','left',72),th('Concepto'),
            th('Interés','right',62),th('Capital','right',62),
            // La columna solo aparece cuando hay desfase cambiario que explicar (prestamos USD
            // cuya cuota quedo Pagada con menos COP de los proyectados). En COP nunca se muestra.
            hayAjuste?th('Efecto TRM','right',66):null,
            th('Ingreso','right',68),th('Saldo','right',66))),
          h('tbody',{className:'mono'},
            fj.eventos.map(function(e){
              // Concepto: el tipo de movimiento + su referencia. Los abonos guardan un cuotaN
              // artificial (maxN+1), asi que NO se muestra como numero de cuota.
              var concepto=e.esAbono
                ? (/liquidacion/i.test(e.obs)?'Liquidación':'Abono a capital')
                : (e.parcialEnCurso?'Pago parcial cuota #'+e.cuotaN:'Cuota #'+e.cuotaN);
              var nota=null;
              if(e.parcialEnCurso) nota=h('div',{style:{fontSize:9,color:'var(--yellow)',marginTop:1,fontFamily:'var(--font)'}},'no salda la cuota');
              else if(e.atraso!==null&&e.atraso>0) nota=h('div',{style:{fontSize:9,color:e.atraso>7?'var(--red)':'var(--yellow)',marginTop:1,fontFamily:'var(--font)'}},'vencía '+fmtD(e.vence).replace(/ de \d+$/,'')+' · +'+e.atraso+' día'+(e.atraso!==1?'s':''));
              else if(e.atraso!==null&&e.atraso<=0) nota=h('div',{style:{fontSize:9,color:'var(--green)',marginTop:1,fontFamily:'var(--font)'}},e.atraso<0?'anticipado':'puntual');
              return h('tr',{key:e.n,style:{borderBottom:'1px solid var(--bg3)'}},
                td(String(e.n),'left','var(--text3)'),
                td(fmtD(e.fecha).replace(/ de /g,' '),'left','var(--text2)'),
                td([h('div',{key:'c',style:{fontFamily:'var(--font)',color:'var(--text)'}},concepto),nota],'left'),
                td(fmtN(e.interes),'right','var(--yellow)'),
                td(fmtN(e.capital),'right','var(--blue)'),
                hayAjuste?td(e.ajuste===0?'—':fmtN(e.ajuste),'right',e.ajuste<0?'var(--red)':(e.ajuste>0?'var(--green)':'var(--text3)')):null,
                td([h('span',{key:'v',style:{fontWeight:600}},fmtN(e.cop)),
                    e.inferido?h('span',{key:'a',style:{color:'var(--text3)'}},'*'):null,
                    esUSD?uSub(e.cop):null],'right','var(--green)'),
                td(fmtN(e.saldo),'right',e.saldo===0?'var(--green)':'var(--text3)'));
            }),
            h('tr',{style:{borderTop:'1px solid var(--border2)'}},
              td('Totales','left','var(--text2)',{fontFamily:'var(--font)',fontWeight:600}),
              td('','left'),td('','left'),
              td(fmtN(fj.totales.interes),'right','var(--yellow)',{fontWeight:600}),
              td(fmtN(fj.totales.capital),'right','var(--blue)',{fontWeight:600}),
              hayAjuste?td(fmtN(fj.totales.ajuste),'right',fj.totales.ajuste<0?'var(--red)':'var(--green)',{fontWeight:600}):null,
              td([h('span',{key:'t',style:{fontWeight:600}},fmtN(fj.totales.ingreso)),esUSD?uSub(fj.totales.ingreso):null],'right','var(--green)'),
              td('','right'))))),
      (fj.inferidos>0||hayAjuste)&&h('div',{style:{fontSize:9,color:'var(--text3)',lineHeight:1.5,marginTop:7,borderTop:'1px solid var(--bg3)',paddingTop:6}},
        fj.inferidos>0?h('div',{key:'inf'},
          h('span',{style:{color:'var(--text2)'}},'*'),' Monto reconstruido del valor de la cuota: son cobros anteriores a que la app registrara el efectivo exacto. La fecha sí es la real de recaudo.'):null,
        hayAjuste?h('div',{key:'trm',style:{marginTop:fj.inferidos>0?4:0}},
          h('span',{style:{color:'var(--text2)'}},'Efecto TRM: '),'diferencia entre los pesos que entraron y el valor de la cuota a la TRM pactada. El cliente entregó los dólares completos; la brecha es cambiaria, no un saldo por cobrar. Interés + Capital + Efecto TRM = Ingreso.'):null)));
}

// ── FlujoCajaPanelV4 (rediseño v4) ────────────────────────────────────────────
// El mismo panel con el sistema de diseño v4: MISMOS datos y textos (`flujoCajaDe`, las mismas
// columnas, notas y aclaraciones); cambia la presentacion: estilos por clase (`fcv-`, en
// public/css/cobros.css bajo `.v4p`) en vez de en linea, cifras en tinta neutra y el color reservado
// al estado (atraso, efecto TRM negativo, saldo en cero). Lo pinta el panel del deudor solo cuando
// vive en una pestaña ya rediseñada (`DeudorPanel` con `v4`); la integracion es pestaña por pestaña,
// asi que mientras Cartera no se rediseñe, su panel sigue con `FlujoCajaPanel`.
export function FlujoCajaPanelV4(props){
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
