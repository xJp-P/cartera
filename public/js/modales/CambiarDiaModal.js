// public/js/modales/CambiarDiaModal.js — Cambiar el dia de pago de un prestamo (3.5.0).
//
// Hasta 3.4.1 este flujo vivia DENTRO del perfil del deudor (DebtorModal), que reemplazaba su
// propio contenido por el formulario. Con el perfil convertido en panel lateral se extrajo a su
// propio modal, decision del PO.
//
// - El backend es AUTORITATIVO: solo recibe `nuevoDia` y computa todo (`/cambiar-dia-pago`). Este
//   modal replica el calculo SOLO para el preview, y tras confirmar muestra lo que el backend
//   devolvio, no lo que se calculo aqui. `tests/operacion.js` (E) compara los dos.
// - Cuota transitoria: interes prorrateado a los DIAS REALES de su periodo, desde la ultima cuota
//   ya FACTURADA (pagada o en mora) hasta la nueva fecha; capital intacto.
// - Las cuotas EN MORA NO SE TOCAN (3.5.0, Bug #78): siguen vencidas y se cobran aparte. Hasta
//   3.4.1 se borraban y su interes se consolidaba en la primera cuota nueva, cuyo prorrateo corria
//   desde la ultima cuota PAGADA: los meses en mora se cobraban dos veces.
// - "Nunca adelantar el cobro" (v1.16.1): si el nuevo dia caeria antes de la cuota ya agendada, la
//   primera cuota se proyecta al mes siguiente.
// - La base es el saldo del MOTOR, con la formula de /recalculate: original menos el capital de las
//   cuotas pagadas y en mora y de los abonos a capital (Bug #79: los abonos no se restaban).
//
// Solo se ofrece donde el backend lo acepta (`opPuedeCambiarDia`: Intereses o C+I, Mensual).

import { Modal } from '../componentes/base.js';
import { Ico } from '../componentes/iconos.js';
import { API, showError } from '../core/api.js';
import { copToUsd, fmt } from '../core/format.js';
import { pendCuota } from '../core/dominio.js';
import { esAbono } from '../core/ids.js';
import { h, useState } from '../core/react.js';
import { _submitGuard } from '../core/ui.js';

function cdPayDate(startISO,cuotaN,dp){var d=new Date(startISO+'T12:00:00');d.setDate(1);d.setMonth(d.getMonth()+cuotaN);d.setDate(Math.min(dp,new Date(d.getFullYear(),d.getMonth()+1,0).getDate()));return d.toISOString().split('T')[0];}
function cdAddMes(iso){var d=new Date(iso+'T12:00:00');d.setDate(1);d.setMonth(d.getMonth()+1);return d.toISOString().split('T')[0];}
function cdFechaCorta(iso){if(!iso)return '';var d=new Date(iso+'T12:00:00');var M=['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];return d.getDate()+' '+M[d.getMonth()];}
function cdFechaLarga(iso){if(!iso)return '';var d=new Date(iso+'T12:00:00');var M=['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];return d.getDate()+' de '+M[d.getMonth()]+' de '+d.getFullYear();}

// Lo que el formulario necesita del prestamo: espejo de la FASE 1 de `/cambiar-dia-pago`.
function contextoCambioDia(loan,pays){
  var lp=pays.filter(function(p){return p.prestamoId===loan.id;});
  var regulares=lp.filter(function(p){return !esAbono(p);});
  var enMora=regulares.filter(function(p){return p.estadoPago==='En Mora';});
  // Consumidas = pagadas y en mora: el cronograma nuevo empieza despues de ellas.
  var consumidas=regulares.filter(function(p){return p.estadoPago==='Pagado'||p.estadoPago==='En Mora';});
  var fechas=consumidas.map(function(p){return p.fechaPago;}).sort();
  var origCOP=loan.moneda==='USD'?Math.round(loan.montoOrigen*loan.trmAcordada):Math.round(loan.montoOrigen);
  var capConsumido=consumidas.reduce(function(s,p){return s+p.abonoCapital;},0);
  var capAbonos=lp.filter(function(p){return esAbono(p)&&p.estadoPago==='Pagado';}).reduce(function(s,p){return s+p.abonoCapital;},0);
  return {
    saldo:Math.max(0,origCOP-capAbonos-capConsumido),
    moraCount:enMora.length,
    moraPendiente:enMora.reduce(function(s,p){return s+pendCuota(p);},0),
    // Sin cuotas facturadas, el interes corre desde la gracia pactada (Bug #73), como en el backend.
    lastSettled:fechas.length?fechas[fechas.length-1]:(loan.fechaInicioIntereses||loan.fechaInicio),
    regularConsumed:consumidas.length
  };
}

// El preview de la cuota transitoria para un dia dado. Replica el calculo del backend.
function previewCambioDia(loan,ctx,nuevoDia){
  var diaActual=loan.diaPago;
  var validNuevo=nuevoDia>=1&&nuevoDia<=31&&nuevoDia!==diaActual&&ctx.saldo>0;
  var tasaMensual=+loan.tasaMensual||0;
  var base=loan.fechaBaseCronograma||loan.fechaInicio;
  var lastSettled=ctx.lastSettled||loan.fechaInicio;
  var nextN=(ctx.regularConsumed||0)+1;
  var diasReales=0,intProrrateado=0,primera='';
  if(validNuevo){
    // Misma regla "nunca adelantar" que el backend: si el nuevo dia caeria antes de la cuota ya
    // agendada (dia menor en el mismo mes), la 1a cuota se proyecta al mes siguiente.
    var origNext=cdPayDate(base,nextN,diaActual);
    var naive=cdPayDate(base,nextN,nuevoDia);
    var baseCron=naive<origNext?cdAddMes(base):base;
    primera=cdPayDate(baseCron,nextN,nuevoDia);
    diasReales=Math.max(1,Math.round((new Date(primera+'T12:00:00')-new Date(lastSettled+'T12:00:00'))/86400000));
    intProrrateado=Math.round(ctx.saldo*(tasaMensual/100)*diasReales/30);
  }
  var intMesNormal=Math.round(ctx.saldo*tasaMensual/100);
  // Capital de la cuota (misma logica que buildSchedule): 0 en Intereses; en C+I = PMT - interes normal.
  var r=tasaMensual/100;
  var n=Math.max(1,(+loan.plazoMeses||12)-(ctx.regularConsumed||0));
  var pmt=r===0?ctx.saldo/n:ctx.saldo*r*Math.pow(1+r,n)/(Math.pow(1+r,n)-1);
  var capitalCuota=loan.modalidad==='Intereses'?0:Math.max(0,Math.round(pmt-intMesNormal));
  return {
    valido:validNuevo, diaActual:diaActual, tasaMensual:tasaMensual, primera:primera, diasReales:diasReales,
    desde:lastSettled, intProrrateado:intProrrateado, capitalCuota:capitalCuota,
    primeraCuotaTotal:capitalCuota+intProrrateado,
    cuotaRecurrente:loan.modalidad==='Intereses'?intMesNormal:Math.round(pmt)
  };
}

export function CambiarDiaModal(props){
  var loan=props.loan,onClose=props.onClose;
  var sd=useState(''); var nuevoDiaTxt=sd[0]; var setNuevoDiaTxt=sd[1];
  var sr=useState(null); var resultado=sr[0]; var setResultado=sr[1];
  var ss=useState(false); var sending=ss[0]; var setSending=ss[1];
  var esUSD=loan.moneda==='USD';
  var ctx=contextoCambioDia(loan,props.pays||[]);
  var nuevoDia=parseInt(nuevoDiaTxt,10);
  var pv=previewCambioDia(loan,ctx,nuevoDia);
  var filaD={display:'flex',justifyContent:'space-between',padding:'7px 0',borderTop:'1px solid var(--bg)',fontSize:12};

  // ── Comprobante: lo que el backend REGISTRO ──
  if(resultado){
    var rs=resultado;
    var totalRs=rs.primeraCuota&&rs.primeraCuota.cuotaTotal||pv.primeraCuotaTotal;
    return h(Modal,{onClose:onClose},
      h('div',{style:{display:'flex',alignItems:'center',gap:8,marginBottom:6}},
        h('div',{style:{width:32,height:32,borderRadius:99,background:'var(--green-bg)',display:'flex',alignItems:'center',justifyContent:'center'}},h(Ico,{name:'check',size:18,color:'var(--green)',sw:2.5})),
        h('div',{style:{fontWeight:700,fontSize:16,color:'var(--text)'}},'Día de pago actualizado')),
      h('div',{style:{fontSize:12,color:'var(--text3)',marginBottom:14}},loan.nombre+' • '+loan.modalidad),
      h('div',{style:{background:'var(--green-bg)',border:'1px solid var(--green-bd)',borderRadius:12,padding:'14px',marginBottom:12}},
        h('div',{style:{fontSize:10,color:'var(--green)',fontWeight:600,letterSpacing:.5,marginBottom:4}},'PRÓXIMA CUOTA'),
        h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'flex-end',gap:10}},
          h('div',null,
            h('div',{style:{fontSize:13,color:'var(--text)',fontWeight:600}},(rs.primeraCuota&&rs.primeraCuota.fechaPago)?cdFechaLarga(rs.primeraCuota.fechaPago):('Día '+rs.nuevoDia)),
            h('div',{style:{fontSize:11,color:'var(--text3)',marginTop:2}},'Primer cobro · luego el día '+rs.nuevoDia+' de cada mes')),
          h('div',{style:{textAlign:'right'}},
            h('div',{className:'mono',style:{fontSize:22,fontWeight:700,color:'var(--green)'}},fmt(totalRs)),
            esUSD&&h('div',{className:'mono',style:{fontSize:11,color:'var(--blue)'}},copToUsd(totalRs,loan.trmAcordada))))),
      h('div',{style:{background:'var(--bg3)',borderRadius:12,padding:'4px 14px',marginBottom:12,border:'1px solid var(--border)'}},
        h('div',{style:{fontSize:10,color:'var(--text3)',fontWeight:600,letterSpacing:.5,padding:'10px 0 6px'}},'DESGLOSE DE LA CUOTA TRANSITORIA'),
        (rs.capitalCuota||0)>0&&h('div',{style:filaD},
          h('span',{style:{color:'var(--text2)'}},'Capital de la cuota'),
          h('span',{className:'mono',style:{color:'var(--text)',fontWeight:500}},fmt(rs.capitalCuota))),
        h('div',{style:filaD},
          h('span',{style:{color:'var(--text2)'}},'Intereses prorrateados ('+(rs.diasReales||pv.diasReales)+' días)'),
          h('span',{className:'mono',style:{color:'var(--yellow)',fontWeight:500}},fmt(rs.prorrateo||pv.intProrrateado))),
        h('div',{style:{display:'flex',justifyContent:'space-between',padding:'9px 0 4px',borderTop:'2px solid var(--border)',fontSize:13}},
          h('span',{style:{color:'var(--text)',fontWeight:700}},'Total cuota transitoria'),
          h('span',{className:'mono',style:{color:'var(--green)',fontWeight:700}},fmt(rs.cuotaTotalTransitoria||totalRs)))),
      (rs.moraCount||0)>0&&h('div',{style:{background:'var(--red-bg)',border:'1px solid var(--red-bd)',borderRadius:10,padding:'10px 12px',marginBottom:12,fontSize:12,color:'var(--text2)',lineHeight:1.5}},
        'Las '+rs.moraCount+' cuota'+(rs.moraCount>1?'s':'')+' vencida'+(rs.moraCount>1?'s':'')+' ('+fmt(rs.moraPendiente||0)+') siguen igual: se cobran aparte, con Registrar cobro.'),
      h('div',{style:{background:'var(--bg3)',borderRadius:10,padding:'10px 12px',marginBottom:14,fontSize:12,color:'var(--text2)',display:'flex',justifyContent:'space-between',alignItems:'center'}},
        h('span',null,'Cuotas siguientes (cada día '+rs.nuevoDia+')'),
        h('span',{className:'mono',style:{color:'var(--text)',fontWeight:600}},fmt(rs.cuotasRecurrentes||pv.cuotaRecurrente))),
      h('button',{onClick:onClose,className:'btn-primary',style:{background:'var(--green2)',color:'#fff',border:'none'}},'Cerrar'));
  }

  // ── Formulario con el preview ──
  // Guarda anti doble-submit (Bug #29): el endpoint no es idempotente, y el campo del dia sigue
  // editable mientras el POST viaja; un segundo request con otro dia SI pasa el filtro del backend
  // y rueda `fechaBaseCronograma` un mes extra.
  function confirmar(){
    if(!pv.valido){showError('Ingresa un día válido (1-31, distinto al actual)');return;}
    _submitGuard(sending,setSending,function(){
      return API.post('/api/loans/'+loan.id+'/cambiar-dia-pago',{nuevoDia:nuevoDia}).then(function(r){
        // API.post nunca rechaza (atrapa y resuelve null): todas las salidas pasan por aqui.
        if(!r)return;
        if(r.error){showError(r.error);return;}
        setResultado(r);
        if(props.onReload)props.onReload();
      });
    });
  }
  var activo=pv.valido&&!sending;
  return h(Modal,{onClose:onClose},
    h('div',{style:{fontWeight:700,fontSize:17,color:'var(--text)',marginBottom:2,display:'flex',alignItems:'center',gap:8}},
      h(Ico,{name:'calendar',size:16,color:'var(--blue)',sw:2}),'Cambiar día de pago'),
    h('div',{style:{fontSize:12,color:'var(--text3)',marginBottom:14}},loan.nombre+' • '+loan.modalidad+' • '+pv.tasaMensual+'% mensual'),
    h('div',{style:{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:12}},
      h('div',{style:{background:'var(--bg3)',borderRadius:10,padding:'10px 12px',border:'1px solid var(--border)'}},
        h('div',{style:{fontSize:10,color:'var(--text3)',fontWeight:600,letterSpacing:.5}},'DÍA ACTUAL'),
        h('div',{style:{fontSize:18,fontWeight:700,color:'var(--text)',marginTop:2}},pv.diaActual)),
      h('div',{style:{background:'var(--blue-bg)',borderRadius:10,padding:'10px 12px',border:'1px solid var(--blue-bd)'}},
        h('div',{style:{fontSize:10,color:'var(--blue)',fontWeight:600,letterSpacing:.5}},'NUEVO DÍA'),
        h('input',{type:'number',min:1,max:31,value:nuevoDiaTxt,onChange:function(e){setNuevoDiaTxt(e.target.value);},placeholder:'1-31',autoFocus:true,style:{width:'100%',background:'transparent',border:'none',outline:'none',fontSize:18,fontWeight:700,color:'var(--blue)',marginTop:2,padding:0,fontFamily:'inherit'}}))),
    ctx.moraCount>0&&h('div',{style:{background:'var(--red-bg)',border:'1px solid var(--red-bd)',borderRadius:10,padding:'10px 12px',marginBottom:12,fontSize:11,color:'var(--text2)',lineHeight:1.5}},
      h('div',{style:{fontWeight:700,color:'var(--red)',marginBottom:4,display:'flex',alignItems:'center',gap:5}},h(Ico,{name:'alert',size:12,color:'var(--red)',sw:2.4}),' '+ctx.moraCount+' CUOTA'+(ctx.moraCount>1?'S':'')+' VENCIDA'+(ctx.moraCount>1?'S':'')),
      ctx.saldo>0
        ? 'No cambian: siguen vencidas ('+fmt(ctx.moraPendiente)+') y se cobran aparte, con Registrar cobro. El cambio solo mueve las cuotas por vencer.'
        : 'Todo lo que queda por pagar está en cuotas vencidas: no hay cuotas por vencer a las que cambiarles el día. Cóbralas con Registrar cobro.'),
    pv.valido?h('div',{style:{background:'var(--bg3)',borderRadius:12,padding:'4px 14px',marginBottom:12,border:'1px solid var(--border)'}},
      h('div',{style:{fontSize:10,color:'var(--text3)',fontWeight:600,letterSpacing:.5,padding:'10px 0 6px'}},'DESGLOSE DE LA CUOTA TRANSITORIA'),
      pv.capitalCuota>0&&h('div',{style:filaD},
        h('div',null,
          h('div',{style:{color:'var(--text2)'}},'Capital de la cuota'),
          h('div',{style:{fontSize:10,color:'var(--text3)',marginTop:1}},'Amortización (igual que una cuota normal)')),
        h('span',{className:'mono',style:{color:'var(--text)',fontWeight:500}},fmt(pv.capitalCuota))),
      h('div',{style:filaD},
        h('div',null,
          h('div',{style:{color:'var(--text2)'}},'Intereses prorrateados ('+pv.diasReales+' días)'),
          h('div',{style:{fontSize:10,color:'var(--text3)',marginTop:1}},'Del '+cdFechaCorta(pv.desde)+' (última cuota ya facturada) al '+cdFechaCorta(pv.primera)+' · saldo × ('+pv.tasaMensual+'%/30) × '+pv.diasReales+' días')),
        h('span',{className:'mono',style:{color:'var(--yellow)',fontWeight:500}},fmt(pv.intProrrateado))),
      h('div',{style:{display:'flex',justifyContent:'space-between',padding:'9px 0 4px',borderTop:'2px solid var(--border)',fontSize:13}},
        h('span',{style:{color:'var(--text)',fontWeight:700}},'Total cuota transitoria'),
        h('span',{className:'mono',style:{color:'var(--green)',fontWeight:700}},fmt(pv.primeraCuotaTotal)))):
      h('div',{style:{background:'var(--bg3)',borderRadius:10,padding:'14px',marginBottom:12,fontSize:12,color:'var(--text3)',textAlign:'center'}},'Ingresa un nuevo día (1-31) distinto al actual para ver el desglose'),
    pv.valido&&h('div',{style:{background:'var(--green-bg)',border:'1px solid var(--green-bd)',borderRadius:12,padding:'12px 14px',marginBottom:12,display:'flex',justifyContent:'space-between',alignItems:'center'}},
      h('div',null,
        h('div',{style:{fontSize:10,color:'var(--green)',fontWeight:600,letterSpacing:.5}},'PRIMERA CUOTA ('+cdFechaLarga(pv.primera)+')'),
        h('div',{style:{fontSize:10,color:'var(--text3)',marginTop:2}},'A partir de la 2a cuota: '+fmt(pv.cuotaRecurrente)+' el día '+nuevoDia+' de cada mes')),
      h('div',{style:{textAlign:'right'}},
        h('div',{className:'mono',style:{fontSize:20,fontWeight:700,color:'var(--green)'}},fmt(pv.primeraCuotaTotal)),
        esUSD&&h('div',{className:'mono',style:{fontSize:11,color:'var(--blue)'}},copToUsd(pv.primeraCuotaTotal,loan.trmAcordada)))),
    h('button',{onClick:confirmar,disabled:!activo,className:'btn-primary',style:{background:activo?'var(--blue-bg)':'var(--bg3)',border:'1px solid '+(activo?'var(--blue-bd)':'var(--border)'),color:activo?'var(--blue)':'var(--text3)',marginBottom:6,cursor:activo?'pointer':'not-allowed'}},sending?'Procesando...':'Confirmar cambio'),
    h('button',{onClick:onClose,className:'btn-primary',style:{background:'var(--bg3)',border:'1px solid var(--border)',color:'var(--text2)'}},'Cancelar'));
}
