// public/js/modales/CongelarModal.js — Congelar y descongelar un préstamo (post-4.1.6, Fase 1).
//
// Aprobado por el PO sobre una maqueta. Un préstamo congelado sigue Activo: lo vencido se sigue
// debiendo (se cobra, se condona y se liquida); desde la fecha del congelamiento NO corren intereses
// ni nacen cuotas, de forma indefinida, hasta descongelarlo a mano con el botón «Descongelar».
//
// ── LOS DÍAS DEL PERÍODO EN CURSO ─────────────────────────────────────────────
// Por defecto se COBRAN: la cuota en curso se vuelve la «cuota de cierre», con solo el interés de
// los días ya corridos (sin capital), y vence en su fecha de siempre. Con «Perdonarlos», esa cuota se
// quita y el interés se detiene desde el inicio del período. La ventana es DINÁMICA: al cambiar la
// fecha o la opción, las cifras y la vista previa del cronograma se mueven en vivo.
//
// ── DE DÓNDE SALEN LAS CIFRAS ─────────────────────────────────────────────────
// De `cgPlanCongelar` / `cgPlanDescongelar` (core/congelar.js), el espejo de las dos rutas y de las
// cuotas que el motor rehace después. La ventana no calcula nada propio; manda el backend, y la
// sección F de `tests/congelar.js` exige que la vista previa sea exactamente lo que queda.
//
// Prefijo `cgm-` (modales.css). Las dos se confirman con `_submitGuard` (los endpoints no son
// idempotentes: un doble clic intentaria congelar dos veces).

import { ABtn, Fld, Modal } from '../componentes/base.js';
import { copToUsd, fmt } from '../core/format.js';
import { pendCuota } from '../core/dominio.js';
import { cgPlanCongelar, cgPlanDescongelar } from '../core/congelar.js';
import { opModalidad, opCorta, opCortaAnio } from '../core/operacion.js';
import { h, useState } from '../core/react.js';
import { _submitGuard, nowStr } from '../core/ui.js';

function cgmPlural(n, una, varias){ return n + ' ' + (n === 1 ? una : varias); }
function cgmLinea(label, antes, ahora, cls, nota){
  return h('div', { className: 'cgm-comp' + (cls ? ' ' + cls : '') },
    h('span', { className: 'cgm-comp-l' }, label, nota && h('span', { className: 'cgm-comp-n' }, nota)),
    antes != null && h('span', { className: 'cgm-comp-a v4m-num' }, antes),
    antes != null && h('span', { className: 'cgm-flecha' }, '→'),
    h('span', { className: 'cgm-comp-d v4m-num' }, ahora));
}
// Una fila de la vista previa del cronograma: # · Vence · Interés · Capital · Cuota · Estado.
function cgmFila(money, p, tipo, sub){
  var chip = { mora: ['Vencida', 'crit'], cierre: ['Cierre', 'info'], quita: ['Se quita', 'suave'], reanuda: ['Primera', 'bien'], pend: ['Pendiente', 'suave'] }[tipo];
  return h('div', { key: p.id + '-' + tipo, className: 'cgm-f ' + tipo },
    h('span', { className: 'cgm-n' }, p.cuotaN),
    h('span', null, opCortaAnio(p.fechaPago), sub && h('div', { className: 'cgm-sub2' }, sub)),
    h('span', { className: 'r v4m-num' }, money(p.interesPeriodo)),
    h('span', { className: 'r v4m-num' }, money(Math.max(0, p.cuotaTotal - p.interesPeriodo))),
    h('span', { className: 'r v4m-num cgm-cuota' }, money(tipo === 'mora' ? pendCuota(p) : p.cuotaTotal)),
    h('span', { className: 'c' }, h('span', { className: 'cgm-chip ' + chip[1] }, chip[0])));
}
function cgmCab(){
  return h('div', { className: 'cgm-f cab' }, h('span', null, '#'), h('span', null, 'Vence'), h('span', { className: 'r' }, 'Interés'),
    h('span', { className: 'r' }, 'Capital'), h('span', { className: 'r' }, 'Cuota'), h('span', { className: 'c' }, 'Estado'));
}
function cgmHielo(texto){ return h('div', { className: 'cgm-hielo' }, h('span', null, '❄'), h('span', null, texto)); }

// ══ CONGELAR ════════════════════════════════════════════════════════════════════════
export function CongelarModal(props){
  var loan = props.loan, onClose = props.onClose, onConfirm = props.onConfirm;
  var hoy = props.hoy || nowStr();
  var esUSD = loan.moneda === 'USD', trm = +loan.trmAcordada || 0;
  var money = function(cop){ return esUSD ? copToUsd(cop, trm) : fmt(cop); };
  var s1 = useState(hoy); var desde = s1[0], setDesde = s1[1];
  var s2 = useState(false); var perdonar = s2[0], setPerdonar = s2[1];
  var s3 = useState(''); var obs = s3[0], setObs = s3[1];
  var s4 = useState(false); var sending = s4[0], setSending = s4[1];
  var plan = cgPlanCongelar(loan, props.pays || [], desde, perdonar, hoy);
  // Para las dos opciones (cobrar y perdonar) con la misma fecha: la ventana muestra las dos cifras.
  var conDias = plan.curso ? cgPlanCongelar(loan, props.pays || [], desde, false, hoy) : null;
  var curso = plan.curso, ok = plan.ok;

  function submit(){
    if (!ok) return;
    return _submitGuard(sending, setSending, function(){
      return onConfirm(loan.id, { desde: plan.F, perdonar: plan.perdona, observaciones: obs });
    });
  }

  // ── Los días del período en curso: cobrarlos o perdonarlos ──
  var opciones = curso && plan.dias > 0 && !plan.sinDias && h('div', { className: 'cgm-ops' },
    h('div', { className: 'cgm-ops-t' }, 'Los ' + cgmPlural(plan.dias, 'día', 'días') + ' del período en curso (del ' + opCorta(plan.inicio) + ' al ' + opCorta(plan.F) + ')'),
    h('label', { className: 'cgm-op' + (!perdonar ? ' on' : '') },
      h('input', { type: 'radio', name: 'cgm-dias', checked: !perdonar, onChange: function(){ setPerdonar(false); } }),
      h('div', null,
        h('div', { className: 'cgm-op-t' }, 'Cobrarlos: ', h('b', { className: 'v4m-num' }, money(conDias && conDias.ok ? conDias.cierre.cuota : plan.calculado + plan.carga))),
        h('div', { className: 'cgm-op-s' }, 'La cuota del ' + opCortaAnio(curso.fechaPago) + ' queda en ese valor (solo esos días de interés, sin capital) y vence en su fecha.'))),
    h('label', { className: 'cgm-op' + (perdonar ? ' on' : '') },
      h('input', { type: 'radio', name: 'cgm-dias', checked: perdonar, onChange: function(){ setPerdonar(true); } }),
      h('div', null,
        h('div', { className: 'cgm-op-t' }, 'Perdonarlos'),
        h('div', { className: 'cgm-op-s' }, 'La cuota del ' + opCortaAnio(curso.fechaPago) + ' se quita: el interés se detiene desde el ' + opCortaAnio(plan.inicio) + '.'))));
  var sinDias = curso && ok && plan.sinDias && h('div', { className: 'cgm-nota-caja v4m-grupo' },
    'Ese día empieza el período de la cuota del ' + opCortaAnio(curso.fechaPago) + ': no corrió ningún día, así que no hay intereses que cobrar. La cuota se quita.');

  // ── Así queda el crédito ──
  var resultado = ok && h('div', { className: 'cgm-res v4m-grupo' },
    h('div', { className: 'cgm-res-t' }, 'Así queda el crédito'),
    plan.vencidas.length > 0 && cgmLinea('Lo vencido', null, money(plan.vencidoMonto) + ' · se sigue debiendo', 'suave', ' (' + cgmPlural(plan.vencidas.length, 'cuota', 'cuotas') + ')'),
    plan.cierre
      ? cgmLinea('Cuota del ' + opCorta(curso.fechaPago), money(plan.cierre.antes), money(plan.cierre.cuota), 'fuerte', ' (la de cierre)')
      : cgmLinea('Cuota del ' + opCorta(curso.fechaPago), money(curso.cuotaTotal), 'se quita', 'fuerte'),
    plan.quitadas.filter(function(p){ return p.cuotaN !== curso.cuotaN; }).length > 0 && (function(){
      var q = plan.quitadas.filter(function(p){ return p.cuotaN !== curso.cuotaN; });
      return cgmLinea(q.length === 1 ? 'Cuota ' + q[0].cuotaN + ' (' + opCorta(q[0].fechaPago) + ')' : 'Cuotas ' + q[0].cuotaN + ' a ' + q[q.length - 1].cuotaN + ' (' + opCorta(q[0].fechaPago) + ' a ' + opCorta(q[q.length - 1].fechaPago) + ')', null, 'se quitan');
    })(),
    cgmLinea('Después', null, 'no se generan cuotas ni corren intereses', 'suave'),
    cgmLinea('Capital', null, money(plan.capital) + ' · sin cambios', 'suave'),
    plan.liqAntes === plan.liqDespues
      ? cgmLinea('Debes hoy (liquidar todo)', null, money(plan.liqDespues) + ' · sin cambios', 'suave')
      : cgmLinea('Debes hoy (liquidar todo)', money(plan.liqAntes), money(plan.liqDespues)),
    plan.intCursoAntes !== plan.intCursoDespues && cgmLinea('Si liquida con el interés del período en curso', money(plan.intCursoAntes), money(plan.intCursoDespues), null, ' (la casilla de Liquidar deuda)'));

  // ── La vista previa del cronograma: lo vencido queda, la cuota en curso se cierra (o se quita), el resto se quita ──
  var crono = ok && h('div', { className: 'cgm-crono' },
    h('div', { className: 'cgm-crono-t' }, 'Vista previa del cronograma'),
    cgmCab(),
    // Lo vencido no cambia: se muestran las 3 mas recientes y las anteriores en una linea (la lista
    // completa esta en el cronograma del panel).
    plan.vencidas.length > 3 && h('div', { className: 'cgm-mas' }, cgmPlural(plan.vencidas.length - 3, 'cuota vencida anterior', 'cuotas vencidas anteriores') + ' · se siguen debiendo'),
    plan.vencidas.slice(-3).map(function(p){ return cgmFila(money, p, p.estadoPago === 'En Mora' ? 'mora' : 'pend'); }),
    plan.cierre && cgmFila(money, plan.schedule.filter(function(p){ return p.cuotaN === curso.cuotaN; })[0] || curso, 'cierre',
      'cierre: ' + cgmPlural(plan.dias, 'día', 'días') + ' de interés, sin capital · antes ' + money(plan.cierre.antes)),
    cgmHielo('Congelado desde el ' + opCortaAnio(plan.F) + ' · no corren intereses ni se generan cuotas'),
    plan.quitadas.map(function(p){ return cgmFila(money, p, 'quita', 'no se cobra mientras esté congelado'); }));

  return h(Modal, { onClose: onClose, tall: true, wide: true },
    h('div', null,
      h('div', { className: 'v4m-tit' }, 'Congelar préstamo'),
      h('div', { className: 'cgm-subt' }, loan.nombre, ' · ', opModalidad(loan.modalidad), esUSD ? ' · USD' : '')),
    h('div', { className: 'cgm-aviso v4m-caja-info' },
      'Mientras esté congelado ', h('b', null, 'no corren intereses ni se generan cuotas'),
      '. El capital no cambia y se sigue debiendo, igual que lo vencido: puedes cobrarlo, abonar a capital o liquidar. ',
      'Queda congelado hasta que lo descongeles con el botón «Descongelar».'),
    h(Fld, { label: 'Congelar desde' },
      h('div', { className: 'cgm-fecha' },
        h('input', { type: 'date', className: 'inp', value: desde, max: hoy, onChange: function(e){ setDesde(e.target.value); } }),
        h('button', { type: 'button', className: 'cgm-hoy v4m-pulsa' + (desde === hoy ? ' on' : ''), onClick: function(){ setDesde(hoy); } }, 'Hoy'))),
    !ok && plan.error && h('div', { className: 'cgm-error v4m-caja-peligro' }, plan.error),
    opciones, sinDias, resultado, crono,
    h(Fld, { label: 'Motivo (opcional)' },
      h('input', { type: 'text', value: obs, onChange: function(e){ setObs(e.target.value); }, placeholder: 'Queda en el Historial', className: 'inp' })),
    ok && h('div', { className: 'cgm-nota' }, 'Queda en el Historial y se puede deshacer desde ahí. Mientras esté congelado no se puede reestructurar ni cambiar el día de pago.'),
    h('div', { className: 'cgm-acc' },
      h('button', { onClick: onClose, className: 'v4m-pulsa cgm-cancelar' }, 'Cancelar'),
      h(ABtn, { tono: 'info', icon: 'snow', label: sending ? 'Congelando…' : 'Congelar préstamo', disabled: !ok || sending, onClick: submit })));
}

// ══ DESCONGELAR ═════════════════════════════════════════════════════════════════════
export function DescongelarModal(props){
  var loan = props.loan, onClose = props.onClose, onConfirm = props.onConfirm;
  var hoy = props.hoy || nowStr();
  var esUSD = loan.moneda === 'USD', trm = +loan.trmAcordada || 0;
  var money = function(cop){ return esUSD ? copToUsd(cop, trm) : fmt(cop); };
  var esC = loan.modalidad === 'Capital + Intereses';
  var freq = loan.frecuencia || 'Mensual';
  var s1 = useState(hoy); var desde = s1[0], setDesde = s1[1];
  var s2 = useState(''); var primer = s2[0], setPrimer = s2[1];   // '' = el sugerido
  var s3 = useState(''); var obs = s3[0], setObs = s3[1];
  var s4 = useState(false); var sending = s4[0], setSending = s4[1];
  var plan = cgPlanDescongelar(loan, props.pays || [], desde, primer || null, hoy);
  var ok = plan.ok, ab = plan.abierto;

  function submit(){
    if (!ok) return;
    return _submitGuard(sending, setSending, function(){
      return onConfirm(loan.id, { desde: plan.D, primerPago: plan.primer, observaciones: obs });
    });
  }
  var sugeridoTxt = freq === 'Semanal' ? 'una semana después' : freq === 'Quincenal' ? 'dos semanas después' : 'el siguiente día ' + (+loan.diaPago || '');
  var p1 = plan.primera, nrm = plan.normal;
  var cierrePend = ok && ab && !ab.perdona ? plan.schedule.filter(function(p){ return p.cuotaN === +ab.cuotaN; })[0] : null;

  var resultado = ok && h('div', { className: 'cgm-res v4m-grupo' },
    h('div', { className: 'cgm-res-t' }, 'Así queda el crédito'),
    p1 && cgmLinea('Primera cuota (' + opCorta(p1.fechaPago) + ')', null, money(p1.cuotaTotal), 'fuerte'),
    p1 && cgmLinea('de eso, interés', null, money(p1.interesPeriodo), 'suave', ' (' + cgmPlural(plan.diasPrimera, 'día', 'días') + ' desde el ' + opCorta(plan.D) + ')'),
    p1 && esC && cgmLinea('de eso, capital', null, money(Math.max(0, p1.cuotaTotal - p1.interesPeriodo)), 'suave'),
    nrm && cgmLinea(esC ? 'Cuotas siguientes' : 'Después, cada cuota', null, money(nrm.cuotaTotal)),
    esC && cgmLinea('Cuotas que quedan', null, String(plan.restantes) + (plan.masPlazo ? ' · el plazo suma la cuota de cierre' : '')),
    esC && plan.ultima && cgmLinea('Última cuota', null, opCortaAnio(plan.ultima), 'suave', ' (el préstamo termina más tarde)'),
    cierrePend && cgmLinea('Cuota de cierre (' + opCorta(cierrePend.fechaPago) + ')', null, money(pendCuota(cierrePend)) + ' · se sigue debiendo', 'suave'),
    plan.vencidoMonto > 0 && cgmLinea('Lo vencido', null, money(plan.vencidoMonto) + ' · se sigue debiendo', 'suave'),
    cgmLinea('Capital', null, money(plan.capital) + ' · sin cambios', 'suave'));

  var proximas = ok ? plan.schedule.filter(function(p){ return p.cuotaN >= plan.N; }).slice(0, esC ? 4 : 3) : [];
  var crono = ok && proximas.length > 0 && h('div', { className: 'cgm-crono' },
    h('div', { className: 'cgm-crono-t' }, 'Vista previa de las próximas cuotas'),
    cgmCab(),
    cierrePend && cgmFila(money, cierrePend, 'cierre', 'cierre del congelamiento · se sigue debiendo'),
    cgmHielo('Congelado del ' + opCortaAnio(ab.desde) + ' al ' + opCortaAnio(plan.D) + ' · ' + cgmPlural(plan.diasCongelado, 'día', 'días') + ' sin intereses ni cuotas'),
    proximas.map(function(p, i){ return cgmFila(money, p, i === 0 ? 'reanuda' : 'pend', i === 0 ? cgmPlural(plan.diasPrimera, 'día', 'días') + ' de interés desde el ' + opCorta(plan.D) : null); }),
    esC && plan.restantes > proximas.length && h('div', { className: 'cgm-mas' }, 'y ' + cgmPlural(plan.restantes - proximas.length, 'cuota más', 'cuotas más') + ', hasta el ' + opCortaAnio(plan.ultima)));

  return h(Modal, { onClose: onClose, tall: true, wide: true },
    h('div', null,
      h('div', { className: 'v4m-tit' }, 'Descongelar préstamo'),
      h('div', { className: 'cgm-subt' }, loan.nombre, ' · ', opModalidad(loan.modalidad), esUSD ? ' · USD' : '',
        ab ? ' · congelado desde el ' + opCortaAnio(ab.desde) + (ok || plan.diasCongelado != null ? ' (' + cgmPlural(plan.diasCongelado || 0, 'día', 'días') + ')' : '') : '')),
    h('div', { className: 'cgm-aviso v4m-caja-bien' },
      'El interés vuelve a correr desde el día en que lo descongelas. Se conserva el día de pago: la primera cuota cobra los días reales y después vienen cuotas normales.',
      esC ? ' Quedan las mismas cuotas que faltaban: el préstamo termina más tarde.' : ''),
    h('div', { className: 'cgm-dos' },
      h(Fld, { label: 'Descongelar el' },
        h('div', { className: 'cgm-fecha' },
          h('input', { type: 'date', className: 'inp', value: desde, max: hoy, min: ab ? ab.desde : undefined, onChange: function(e){ setDesde(e.target.value); setPrimer(''); } }),
          h('button', { type: 'button', className: 'cgm-hoy v4m-pulsa' + (desde === hoy ? ' on' : ''), onClick: function(){ setDesde(hoy); setPrimer(''); } }, 'Hoy'))),
      h(Fld, { label: 'Primer pago' },
        h('div', { className: 'cgm-fecha' },
          h('input', { type: 'date', className: 'inp', value: primer || plan.sugerido || '', min: plan.D || undefined, onChange: function(e){ setPrimer(e.target.value); } }),
          primer && primer !== plan.sugerido && h('button', { type: 'button', className: 'cgm-hoy v4m-pulsa', onClick: function(){ setPrimer(''); } }, 'Sugerido')),
        h('div', { className: 'cgm-ayuda' }, plan.sugerido ? 'Sugerido: ' + opCortaAnio(plan.sugerido) + ' (' + sugeridoTxt + ') · puedes elegir otra fecha.' : ''))),
    !ok && plan.error && h('div', { className: 'cgm-error v4m-caja-peligro' }, plan.error),
    resultado, crono,
    h(Fld, { label: 'Motivo (opcional)' },
      h('input', { type: 'text', value: obs, onChange: function(e){ setObs(e.target.value); }, placeholder: 'Queda en el Historial', className: 'inp' })),
    ok && h('div', { className: 'cgm-nota' }, 'Queda en el Historial y se puede deshacer desde ahí.'),
    h('div', { className: 'cgm-acc' },
      h('button', { onClick: onClose, className: 'v4m-pulsa cgm-cancelar' }, 'Cancelar'),
      h(ABtn, { tono: 'pri', icon: 'refresh', label: sending ? 'Descongelando…' : 'Descongelar', disabled: !ok || sending, onClick: submit })));
}
