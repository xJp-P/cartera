// public/js/modales/CondonarModal.js — Condonar intereses en mora.
//
// El acuerdo que este modal ejecuta: "devuelveme el capital y te perdono los
// intereses" (o una parte). Lo que hace NO es registrar un pago: MODIFICA LA
// OBLIGACION. El interes vencido deja de deberse, el capital sigue intacto, y no
// entra ni sale un peso de caja.
//
// ── POR QUE HACIA FALTA UNA HERRAMIENTA PROPIA ────────────────────────────────
// Los tres caminos que ya existian mentian de formas distintas. El peor era
// `Liquidar`, que es el mas tentador porque es el unico que cierra limpio: registra
// como RECIBIDO el interes que en realidad se perdono, inflando a la vez "Cobros del
// Mes" y "Ganancias". `Abono` deja las cuotas vencidas vivas y el credito no cierra
// nunca. Y `abono + cierre forzoso` da los numeros exactos pero marca el credito
// 'Cancelado', que Rendimiento pinta como "Perdida total" aunque se haya recuperado
// el 100% del capital.
//
// ── EL MONTO ESCRITO (post-4.1.5, aprobado por el PO sobre un prototipo) ───────
// Ademas de elegir cuotas se puede ESCRIBIR cuanto se condona. El monto se reparte de
// la cuota MAS VIEJA a la mas nueva entre las marcadas (`planCondonacion`, espejo del
// endpoint): las que alcanza quedan «Condonadas» y, si cae a mitad de una, esa queda
// condonada EN PARTE y sigue vencida por lo que falta. Arriba de la lista, el antes y
// el despues de lo vencido, de «Debes hoy» y de la mora, con los helpers de siempre
// sobre una copia de las cuotas (`aplicarCondonacion`): el modal no calcula nada propio.
//
// ── QUE NO HACE ESTE MODAL ────────────────────────────────────────────────────
// No cobra. Despues de condonar, el capital se cobra por la via normal (Registrar
// cobro), y el credito cierra como 'Finalizado' por la rama de siempre.

import { ABtn, Fld, Modal } from '../componentes/base.js';
import { copToUsd, fmt, fmtD, fmtNumInput, parseNum, parseDecimalInput } from '../core/format.js';
import { esDiario, estadoDiario, computeLiquidacion, diasEntre, planCondonacion, aplicarCondonacion } from '../core/dominio.js';
import { opModalidad } from '../core/operacion.js';
import { h, useState } from '../core/react.js';
import { _submitGuard, nowStr } from '../core/ui.js';
import { esAbono } from '../core/ids.js';

export function CondonarModal(props){
  var loan=props.loan, allPays=props.pays||[], onConfirm=props.onConfirm, onClose=props.onClose;
  var esUSD=loan.moneda==='USD';
  var trm=+loan.trmAcordada||0;
  var diario=esDiario(loan);
  var money=function(cop){ return esUSD?copToUsd(cop,trm):fmt(cop); };
  var hoy=nowStr();

  var loanPays=allPays.filter(function(p){ return String(p.prestamoId)===String(loan.id); });
  // Mismo filtro que el backend: regulares En Mora (los '-ab-' quedan fuera), de la mas vieja a la mas nueva.
  var mora=loanPays.filter(function(p){ return p.estadoPago==='En Mora'&&!esAbono(p); })
    .sort(function(a,b){ return String(a.fechaPago).localeCompare(String(b.fechaPago))||((a.cuotaN||0)-(b.cuotaN||0)); });
  // En un credito abierto no hay cuotas: el interes se deriva del tiempo.
  var dev=diario?estadoDiario(loan, loanPays, hoy):null;

  // Seleccion: todas marcadas de entrada. Desmarcar las viejas permite condonar las recientes.
  var s1=useState(mora.map(function(p){ return p.id; })); var sel=s1[0]; var setSel=s1[1];
  var s2=useState(''); var obs=s2[0]; var setObs=s2[1];
  var s3=useState(false); var sending=s3[0]; var setSending=s3[1];
  var s4=useState(''); var montoTxt=s4[0]; var setMontoTxt=s4[1];   // '' = todo lo condonable

  function toggle(id){ setSel(sel.indexOf(id)!==-1?sel.filter(function(x){ return x!==id; }):sel.concat([id])); }

  var elegidas=mora.filter(function(p){ return sel.indexOf(p.id)!==-1; });
  var totalCond=diario?Math.round(dev?dev.interesPendiente:0):planCondonacion(elegidas, null).total;
  // El monto escrito, en pesos. En un credito en dolares se escribe en dolares y se pasa a pesos a la
  // TRM pactada; si coincide con todo lo condonable (medio centavo de tolerancia) se ancla al total exacto.
  var montoCOP=null;
  if(String(montoTxt).trim()!==''){
    if(esUSD){
      var u=+parseDecimalInput(montoTxt)||0;
      montoCOP=trm>0&&Math.abs(u-totalCond/trm)<0.005?totalCond:Math.round(u*trm);
    } else montoCOP=+parseNum(montoTxt)||0;
  }
  var plan=diario?null:planCondonacion(elegidas, montoCOP);
  var error=diario
    ?(montoCOP!=null&&!(montoCOP>0)?'cero':montoCOP!=null&&montoCOP>totalCond?'excede':null)
    :plan.error;
  var intCondonar=error?0:(montoCOP!=null?montoCOP:totalCond);
  var porId={}; if(plan) plan.filas.forEach(function(f){ porId[f.p.id]=f; });

  // El antes y el despues, con los helpers de siempre sobre una copia (no se escribe nada).
  var loanDesp=diario?Object.assign({}, loan, { interesesCondonados: Math.round(+loan.interesesCondonados||0)+intCondonar }):loan;
  var paysDesp=diario?loanPays:aplicarCondonacion(loanPays, plan);
  var liqA=computeLiquidacion(loan, loanPays, {}), liqD=computeLiquidacion(loanDesp, paysDesp, {});
  function vencidas(ps){ return ps.filter(function(p){ return p.estadoPago==='En Mora'&&!esAbono(p); })
    .sort(function(a,b){ return String(a.fechaPago).localeCompare(String(b.fechaPago)); }); }
  function sumaPend(ps){ return ps.reduce(function(s,p){ return s+Math.max(0,Math.round((p.cuotaTotal||0)-(p.partialPaid||0))); },0); }
  var vA=vencidas(loanPays), vD=vencidas(paysDesp);
  function vieja(v){ return v.length?(fmtD(v[0].fechaPago)+' · '+diasEntre(v[0].fechaPago,hoy)+' días'):'ninguna'; }

  var puede=intCondonar>0&&(diario||elegidas.length>0);

  function submit(){
    if(!puede) return;
    return _submitGuard(sending,setSending,function(){
      // En credito abierto no se manda seleccion: no hay cuotas que elegir.
      return onConfirm(loan.id, diario?null:elegidas.map(function(p){ return p.id; }), obs, montoCOP);
    });
  }

  function linea(label,antes,ahora,cls){
    return h('div',{className:'cdm-comp'+(cls?' '+cls:'')},
      h('span',{className:'cdm-comp-l'},label),
      antes!=null&&h('span',{className:'cdm-comp-a v4m-num'},antes),
      antes!=null&&h('span',{className:'cdm-flecha'},'→'),
      h('span',{className:'cdm-comp-d v4m-num'},ahora));
  }

  // ── ¿Cuanto? El campo, la regla dicha en una linea y su error ──
  var campoMonto=totalCond>0&&h('div',{className:'cdm-monto'},
    h(Fld,{label:'¿Cuánto vas a condonar?'},
      h('div',{className:'cdm-monto-f'},
        h('span',{className:'cdm-pre'},esUSD?'US$':'$'),
        h('input',{type:'text',inputMode:'decimal',className:'inp v4m-num',value:montoTxt,
          placeholder:esUSD?(trm>0?(totalCond/trm).toFixed(2):''):fmtNumInput(String(totalCond)),
          onChange:function(e){ setMontoTxt(esUSD?parseDecimalInput(e.target.value):fmtNumInput(e.target.value)); }}),
        h('button',{type:'button',className:'cdm-todo v4m-pulsa'+(montoTxt===''?' on':''),onClick:function(){ setMontoTxt(''); }},
          'Todo · '+money(totalCond)))),
    h('div',{className:'cdm-ayuda'}, diario
      ?'Se descuenta del interés devengado. El capital no cambia.'
      :h('span',null,'Se aplica de la cuota más vieja a la más nueva, solo entre las marcadas. Si el monto cae a mitad de una cuota, ',
        'esa cuota queda ',h('b',null,'condonada en parte'),' y sigue vencida por lo que falta.')),
    error==='excede'&&h('div',{className:'cdm-error v4m-caja-peligro'},
      (diario?'El crédito solo tiene ':'Las cuotas marcadas solo tienen ')+money(totalCond)+
      (diario?' de interés devengado por condonar.':' de intereses por condonar. Marca más cuotas o baja el monto.')),
    error==='cero'&&h('div',{className:'cdm-error v4m-caja-peligro'},'Escribe un monto mayor que cero.'));

  // ── Asi queda: el antes y el despues ──
  var resultado=intCondonar>0&&h('div',{className:'cdm-res v4m-grupo'},
    h('div',{className:'cdm-res-t'},'Así queda el crédito'),
    linea('Intereses que perdonas', null, '−'+money(intCondonar), 'fuerte'),
    diario
      ?linea('Interés devengado', money(dev.interesPendiente), money(dev.interesPendiente-intCondonar))
      :linea('Lo vencido', money(sumaPend(vA)), money(sumaPend(vD))),
    linea('Debes hoy (liquidar todo)', money(liqA.total), money(liqD.total)),
    !diario&&linea('Cuotas vencidas', String(vA.length), String(vD.length)),
    !diario&&linea('La más antigua', vieja(vA), vieja(vD)),
    linea('Capital', null, money(diario?dev.capitalVivo:liqA.capitalPendiente)+' · sin cambios', 'suave'),
    linea('Caja', null, 'no entra ni sale dinero', 'suave'));

  // ── Cada cuota vencida: su casilla y lo que le pasaria ──
  var listaUI=!diario&&mora.length>0?h('div',{className:'cdm-lista'},
    mora.map(function(p){
      var on=sel.indexOf(p.id)!==-1, f=porId[p.id], c=f?f.condonar:0;
      var interes=Math.round(p.interesPeriodo||0), cap=Math.round(p.abonoCapital||0), ab=Math.round(p.partialPaid||0);
      var efecto=!on?h('span',{className:'cdm-ef nada'},'no marcada')
        :c<=0?h('span',{className:'cdm-ef nada'},'sin cambio')
        :f.saldada&&f.abonado<=0?h('span',{className:'cdm-ef cond'},'Condonada')
        :f.saldada?h('span',{className:'cdm-ef cond'},'Saldada')
        :f.parcial?h('span',{className:'cdm-ef parte'},'En parte · queda '+money(f.quedaDebiendo))
        :h('span',{className:'cdm-ef parte'},'Queda el capital · '+money(f.quedaDebiendo));
      return h('label',{key:p.id,className:'cdm-cuota'+(on?' on':'')+(c>0?' toca':'')},
        h('input',{type:'checkbox',checked:on,onChange:function(){ toggle(p.id); }}),
        h('div',{className:'cdm-cuota-i'},
          h('div',{className:'cdm-cuota-t'},
            h('b',null,'Cuota #'+p.cuotaN),
            h('span',{className:'cdm-muted'},'venció el '+fmtD(p.fechaPago)+' · '+diasEntre(p.fechaPago,hoy)+' días'),
            h('span',{className:'cdm-esp'}),
            h('span',{className:'cdm-int v4m-num'},money(interes))),
          h('div',{className:'cdm-cuota-s'},
            c>0?h('span',null,'se condonan ',h('b',{className:'cdm-c'},money(c)),c<interes?' de '+money(interes):'')
               :h('span',{className:'cdm-muted'},'intereses de la cuota'),
            cap>0&&h('span',{className:'cdm-muted'},' · capital '+money(cap)+' (sigue debiéndose)'),
            ab>0&&h('span',{className:'cdm-muted'},' · ya abonó '+money(ab)),
            h('span',{className:'cdm-esp'}), efecto)));
    })):null;

  return h(Modal,{onClose:onClose,tall:true,wide:true},
    h('div',null,
      h('div',{className:'v4m-tit'},'Condonar intereses'),
      h('div',{className:'cdm-sub'},loan.nombre,' · ',opModalidad(loan.modalidad),esUSD?' · USD':'')),

    // ── Que es esto, dicho antes de nada ──
    // El aviso va ARRIBA a proposito: la confusion que este modal viene a eliminar es
    // creer que perdonar intereses es una forma de cobrarlos.
    h('div',{className:'cdm-aviso v4m-caja-aviso'},
      h('b',null,'Esto no registra ningún pago. '),
      'Reduce lo que el cliente debe: los intereses que perdonas dejan de cobrarse y el capital queda intacto. ',
      'No entra dinero, así que no aparece en los cobros del mes.'),

    !diario&&mora.length===0
      ? h('div',{className:'cdm-vacio v4m-grupo'},'Este crédito no tiene cuotas vencidas: no hay intereses que condonar.')
      : diario&&totalCond<=0
        ? h('div',{className:'cdm-vacio v4m-grupo'},'Este crédito no tiene interés devengado pendiente: no hay nada que condonar.')
        : h('div',null,
            campoMonto,
            resultado,
            !diario&&h('div',{className:'cdm-cab'},'CUOTAS VENCIDAS',h('span',{className:'cdm-esp'}),
              h('button',{type:'button',className:'cdm-todo v4m-pulsa',onClick:function(){ setSel(sel.length===mora.length?[]:mora.map(function(p){ return p.id; })); }},
                sel.length===mora.length?'Ninguna':'Todas')),
            listaUI),

    h(Fld,{label:'Motivo del acuerdo'},
      h('input',{type:'text',value:obs,onChange:function(e){ setObs(e.target.value); },
        placeholder:'Opcional — queda en la cuota y en el Historial',className:'inp'})),

    intCondonar>0&&h('div',{className:'cdm-nota'},
      'Queda en el Historial y se puede deshacer desde ahí. ',
      diario?'Después podrás cobrar el capital normalmente.'
            :'Cada cuota guarda cuánto se le condonó: las que quedan saldadas dicen «Condonada» en el cronograma. Después cobra el resto con «Registrar cobro».'),

    h('div',{className:'cdm-acc'},
      h('button',{onClick:onClose,className:'v4m-pulsa cdm-cancelar'},'Cancelar'),
      h(ABtn,{tono:'aviso',icon:'alert',
        label:sending?'Condonando…':(intCondonar>0?('Condonar '+money(intCondonar)):'Condonar intereses'),
        disabled:!puede||sending,
        onClick:submit})));
}
