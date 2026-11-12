// public/js/modales/CronogramaPdfModal.js — antes de imprimir el cronograma, decide su valor de liquidacion.
//
// El cronograma PDF cierra con un bloque "Valor de liquidacion": lo que el deudor tendria que
// entregar para cancelar el credito. Ese valor puede incluir o no el interes del mes en curso,
// y esa es una decision comercial del administrador (se cobra solo si se pacto), la MISMA que
// toma la casilla de Liquidar deuda. Hasta 3.0.1 el PDF salia siempre sin ese interes, asi que
// el papel que recibia el cliente podia no coincidir con lo que luego se le cobraba.
//
// Se abre SOLO cuando la pregunta tiene respuesta (`preguntaInteresMes`, dominio.js). Quien
// lo abre decide eso; el modal no se pregunta a si mismo si debia existir.
//
// No escribe nada en la BD: arma el PDF con lo que ya esta en pantalla, como el Estado de
// Liquidacion. Por eso no usa `_submitGuard`; la guarda local solo evita dos ventanas de
// impresion por un doble clic.
//
// Props: loan, pays, onClose, y opcionales `titulo` / `mensaje` / `okLabel` para el flujo de
// prestamo nuevo, donde este modal REEMPLAZA la confirmacion "¿Generar el cronograma?".

import { Modal } from '../componentes/base.js';
import { Ico } from '../componentes/iconos.js';
import { CheckInteresMes } from '../componentes/CheckInteresMes.js';
import { computeLiquidacion, proximoVencimiento, periodoEnCursoDe } from '../core/dominio.js';
import { copToUsd, fmt, fmtD } from '../core/format.js';
import { h, useState } from '../core/react.js';
import { nowStr } from '../core/ui.js';
import { opModalidad } from '../core/operacion.js';
import { generateCronogramaPDF } from '../pdf/cronograma.js';
import { usdLinea } from '../componentes/CifraUSD.js';

export function CronogramaPdfModal(props){
  var loan=props.loan, pays=props.pays||[], onClose=props.onClose;
  // Nace DESMARCADA, igual que en Liquidar deuda: el interes del mes solo se cobra si se pacto.
  var ipm=useState(false); var incluyeProxMes=ipm[0]; var setIncluyeProxMes=ipm[1];
  var bz=useState(false); var busy=bz[0]; var setBusy=bz[1];
  // 3.2.0 — dias a cobrar si el periodo en curso es irregular (null = los ya corridos).
  var dpm=useState(null); var diasProxMes=dpm[0]; var setDiasProxMes=dpm[1];
  var esUSD=loan.moneda==='USD';
  var hoy=nowStr();
  // La cifra en pantalla es la que va a imprimir el PDF: mismo helper, misma opcion.
  var L=computeLiquidacion(loan,pays,{incluyeProxMes:incluyeProxMes,diasProxMes:diasProxMes,hasta:hoy});
  // Con dias cobrados de un periodo irregular, la cifra vale hasta donde cubren esos dias; si
  // no, hasta la proxima cuota (3.1.0).
  var pv=L.incluyeProxMes ? (L.periodoIrregular ? L.validoHasta : proximoVencimiento(loan,pays,hoy)) : null;
  // El mismo desglose que imprime el pie del PDF, para que pantalla y papel se lean igual.
  var detalle='Capital '+fmt(L.capitalPendiente)+
    (L.intMora>0?' + mora '+fmt(L.intMora):'')+
    (L.moraConsolidada>0?' + mora consolidada '+fmt(L.moraConsolidada):'')+
    (L.partialPend>0?' \u2212 parciales '+fmt(L.partialPend):'')+
    (L.intExtra>0?(L.periodoIrregular?' + interés de '+L.diasCobrados+' días':' + interés '+periodoEnCursoDe(L.frecuencia))+' '+fmt(L.intExtra):'');

  function descargar(){
    if(busy) return;
    setBusy(true);
    try{
      generateCronogramaPDF(loan,pays,document.documentElement.getAttribute('data-theme')==='dark',
        {incluyeProxMes:incluyeProxMes,diasProxMes:diasProxMes});
    } finally {
      if(onClose) onClose();
    }
  }

  return h(Modal,{onClose:onClose},
    h('div',{className:'v4m-tit',style:{display:'flex',alignItems:'center',gap:8}},
      h(Ico,{name:'download',size:16,color:'var(--blue)',sw:2.4}),props.titulo||'Descargar cronograma'),
    h('div',{style:{fontSize:12,color:'var(--text3)',marginBottom:props.mensaje?10:14}},
      loan.nombre+' \u2022 '+opModalidad(loan.modalidad)+' \u2022 '+loan.tasaMensual+'% mensual'),
    props.mensaje&&h('div',{style:{fontSize:13,color:'var(--text2)',marginBottom:12,lineHeight:1.5}},props.mensaje),
    h('div',{style:{fontSize:12,color:'var(--text3)',marginBottom:12,lineHeight:1.5}},
      'El cronograma termina con el valor de liquidación: lo que el deudor tendría que entregar para cancelar el crédito.'),
    h(CheckInteresMes,{L:L,checked:incluyeProxMes,onChange:function(){setIncluyeProxMes(!incluyeProxMes);},onDias:setDiasProxMes}),
    h('div',{className:'v4m-total',style:{borderRadius:12,padding:'12px 14px',marginBottom:14}},
      h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',gap:10}},
        h('div',null,
          h('div',{className:'v4m-total-l',style:{fontSize:10,fontWeight:600,letterSpacing:.5}},'VALOR DE LIQUIDACIÓN EN EL PDF'),
          h('div',{style:{fontSize:10,color:'var(--text3)',marginTop:2}},detalle)),
        h('div',{style:{textAlign:'right'}},
          h('div',{className:'mono v4m-total-v',style:{fontSize:20,fontWeight:700}},fmt(L.total)),
          esUSD&&usdLinea(copToUsd(L.total,loan.trmAcordada),{fontSize:11,fontWeight:500}))),
      L.incluyeProxMes&&h('div',{style:{fontSize:11,color:'var(--text2)',marginTop:8,lineHeight:1.45}},
        pv ? 'El PDF dirá que este valor es válido hasta el '+fmtD(pv)+(L.periodoIrregular?', hasta donde cubren los '+L.diasCobrados+' días.':', la fecha de la próxima cuota.')
           : 'El PDF dirá que este valor está calculado al día de hoy.')),
    h('button',{onClick:descargar,disabled:busy,className:'btn-primary',style:{marginBottom:6,display:'flex',alignItems:'center',justifyContent:'center',gap:8,cursor:busy?'wait':'pointer'}},
      h(Ico,{name:'download',size:15,color:'#fff',sw:2.2}),props.okLabel||'Descargar PDF'),
    h('button',{onClick:onClose,className:'btn-primary',style:{background:'var(--bg3)',border:'1px solid var(--border)',color:'var(--text2)'}},'Cancelar'));
}
