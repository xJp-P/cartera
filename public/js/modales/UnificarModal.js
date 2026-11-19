// public/js/modales/UnificarModal.js — UNIFICAR los prestamos activos de un deudor en uno nuevo.
//
// Aprobado por el PO sobre un prototipo con un caso real (post-4.0.0). Arriba, la FECHA de la
// unificacion (hoy por defecto; puede ser retroactiva: todo se calcula a ese dia). Luego cuatro
// bloques, de arriba a abajo, en el orden en que se decide:
//   1. Que se une: cada prestamo con lo que debe hoy (= su "Liquidar hoy"), y el total.
//   2. Que hacer con los intereses vencidos (cuatro opciones, con su efecto en una linea).
//   3. Las condiciones del prestamo nuevo.
//   4. La comparativa: si siguen como van vs. unificado (cuota por mes, ultimo pago, total y
//      ganancia por cobrar), con la diferencia en una frase.
// El cronograma del nuevo va plegado. Todo sale de `planUnificacion` (core/unificacion.js); el
// server lo recalcula con su espejo y rechaza si no coincide (`esperado`).
// En dolares, las cifras van en dolares (como en los documentos de un credito en dolares).

import { h, useState, useMemo } from '../core/react.js';
import { Modal, Fld } from '../componentes/base.js';
import { Ico } from '../componentes/iconos.js';
import { fmt, fmtUSD } from '../core/format.js';
import { _submitGuard } from '../core/ui.js';
import { opModalidad } from '../core/operacion.js';
import { MODALIDAD_DIARIA } from '../core/dominio.js';
import { primerPagoRegular } from '../core/calculo.js';
import { planUnificacion, limitesFecha } from '../core/unificacion.js';

var MES3 = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
function fCorta(iso, conAnio){
  if (!iso) return '—';
  var d = new Date(String(iso).slice(0, 10) + 'T12:00:00');
  return d.getDate() + ' ' + MES3[d.getMonth()] + (conAnio === false ? '' : ' ' + d.getFullYear());
}
function pct(t){ return (+t).toLocaleString('es-CO', { maximumFractionDigits: 3 }) + '%'; }
function masFrecuente(arr, def){
  var c = {}; arr.forEach(function(x){ c[x] = (c[x] || 0) + 1; });
  return Object.keys(c).sort(function(a, b){ return c[b] - c[a]; })[0] || def;
}
var UN_MODALIDADES = ['Capital + Intereses', 'Intereses', MODALIDAD_DIARIA];

export function UnificarModal(props){
  var hoy = props.hoy, todos = props.loans, pays = props.pays;
  // Una sola moneda por unificacion: la de la mayoria (con dos monedas, un selector).
  var monedas = todos.map(function(l){ return l.moneda || 'COP'; }).filter(function(m, i, a){ return a.indexOf(m) === i; });
  var sMon = useState(masFrecuente(todos.map(function(l){ return l.moneda || 'COP'; }), 'COP')); var moneda = sMon[0], setMoneda = sMon[1];
  var candidatos = todos.filter(function(l){ return (l.moneda || 'COP') === moneda; });
  var sSel = useState(function(){ var o = {}; todos.forEach(function(l){ o[l.id] = true; }); return o; }); var sel = sSel[0], setSel = sSel[1];
  var elegidos = candidatos.filter(function(l){ return sel[l.id]; });
  // La fecha de la unificacion (por defecto hoy): todo se calcula a ese dia.
  var sFecha = useState(hoy); var fecha = sFecha[0], setFecha = sFecha[1];
  // El interes ya corrido se decide POR CREDITO (todas desmarcadas por defecto, decision del PO).
  var sCorr = useState({}); var corridos = sCorr[0], setCorridos = sCorr[1];
  var sGan = useState({}); var gan = sGan[0], setGan = sGan[1];
  var sDest = useState('repartir'); var destino = sDest[0], setDestino = sDest[1];
  var sK = useState('6'); var cuotasK = sK[0], setCuotasK = sK[1];
  var sMod = useState(masFrecuente(candidatos.map(function(l){ return l.modalidad; }).filter(function(m){ return UN_MODALIDADES.indexOf(m) !== -1; }), 'Capital + Intereses'));
  var modalidad = sMod[0], setModalidad = sMod[1];
  var sFrec = useState(masFrecuente(candidatos.map(function(l){ return l.frecuencia || 'Mensual'; }), 'Mensual')); var frecuencia = sFrec[0], setFrecuencia = sFrec[1];
  var sTasa = useState(''); var tasa = sTasa[0], setTasa = sTasa[1];
  // Plazo por defecto: las cuotas que le faltan al prestamo que termina de ultimo.
  var plazoIni = Math.max.apply(null, [1].concat(candidatos.map(function(l){
    return pays.filter(function(p){ return String(p.prestamoId) === String(l.id) && p.estadoPago !== 'Pagado' && String(p.id).indexOf('-ab-') === -1; }).length;
  })));
  var sPlazo = useState(String(plazoIni)); var plazo = sPlazo[0], setPlazo = sPlazo[1];
  var sPP = useState(''); var primerPago = sPP[0], setPrimerPago = sPP[1];
  var sModo = useState(null); var modoPP = sModo[0], setModoPP = sModo[1];
  var sCrono = useState(false); var verCrono = sCrono[0], setVerCrono = sCrono[1];
  var sDoc = useState(true); var genDoc = sDoc[0], setGenDoc = sDoc[1];
  var sEnv = useState(false); var sending = sEnv[0], setSending = sEnv[1];

  var diario = modalidad === MODALIDAD_DIARIA;
  var ppEfectivo = primerPago || primerPagoRegular(fecha, frecuencia);
  var opciones = { fecha: fecha, corridos: corridos, ganancias: gan, destino: destino, cuotasReparto: +cuotasK || 1,
    nuevo: { modalidad: modalidad, frecuencia: frecuencia, tasaMensual: tasa === '' ? undefined : +String(tasa).replace(',', '.'),
      plazo: modalidad === 'Capital + Intereses' ? (+plazo || 1) : 12, primerPago: ppEfectivo, primerPeriodo: modoPP || undefined } };
  var plan = useMemo(function(){ return elegidos.length ? planUnificacion(elegidos, pays, hoy, opciones) : null; },
    [elegidos.map(function(l){ return l.id; }).join(','), JSON.stringify(opciones)]);
  var N = plan && plan.nuevo;
  var info = N && N.info;
  // La moneda visible: en dolares, cada cifra a la TRM de su prestamo; los totales, a la TRM que
  // reparte los pesos entre los dolares de todos (la misma con que el server fija el nuevo).
  var esUSD = moneda === 'USD';
  var trmU = (function(){
    if (!esUSD || !plan) return 1;
    var cop = 0, usd = 0;
    plan.traslados.forEach(function(t){ cop += t.capital + t.interes; usd += (t.capital + t.interes) / (+t.loan.trmAcordada || 1); });
    return usd > 0 ? cop / usd : 1;
  })();
  function M(cop, trm){ return esUSD ? fmtUSD((cop || 0) / (trm || trmU)) : fmt(cop); }

  function fila(t){
    var Ml = function(cop){ return M(cop, t.loan.trmAcordada); };
    var l = t.loan, on = !!sel[l.id];
    var det = [];
    if (t.intVencido > 0) det.push('intereses vencidos ' + Ml(t.intVencido));
    if (t.conCorrido) det.push('interés corrido ' + Ml(t.corrido.monto));
    if (t.abonado > 0) det.push('ya abonó ' + Ml(t.abonado));
    if (t.gananciaPU > 0) det.push('ganancia pactada ' + Ml(t.gananciaPU));
    var estado = t.vencido > 0 ? 'con cuotas vencidas' : (t.pagadas > 0 ? t.pagadas + ' de ' + (t.pagadas + t.abiertas.length) + ' cuotas pagadas' : 'sin cuotas pagadas');
    return h('div', { key: l.id, className: 'un-prest' + (on ? '' : ' off') },
      h('label', { className: 'un-prest-l' },
        h('input', { type: 'checkbox', checked: on, onChange: function(){ var o = Object.assign({}, sel); o[l.id] = !on; setSel(o); } }),
        h('span', null,
          h('b', null, (esUSD ? fmtUSD(l.montoOrigen) : fmt(l.montoOrigen)) + ' · ' + pct(+l.tasaMensual) + ' · ' + opModalidad(l.modalidad, true)),
          h('small', null, 'Desde el ' + fCorta(l.fechaInicio) + ' · ' + estado + (det.length ? ' · ' + det.join(' · ') : '')))),
      h('div', { className: 'un-prest-v' }, on ? Ml(t.total) : '—',
        on && (t.interes > 0 || t.aCapital > 0) && h('small', null, 'capital ' + Ml(t.capital) + (t.interes > 0 ? ' + int. ' + Ml(t.interes) : ''))),
      on && t.gananciaPU > 0 && h('label', { className: 'un-sub-check' },
        h('input', { type: 'checkbox', checked: gan[l.id] !== false, onChange: function(){ var o = Object.assign({}, gan); o[l.id] = gan[l.id] === false; setGan(o); } }),
        'Trasladar la ganancia pactada completa (' + Ml(t.gananciaPU) + '): todavía no vence'));
  }

  // Todos los traslados (tambien los no elegidos, para pintar su fila).
  var todosT = useMemo(function(){ return planUnificacion(candidatos, pays, hoy, { fecha: fecha, corridos: corridos, ganancias: gan }).traslados; },
    [moneda, fecha, JSON.stringify(corridos), JSON.stringify(gan)]);
  var limites = useMemo(function(){ return limitesFecha(elegidos.length ? elegidos : candidatos, pays, hoy); }, [elegidos.map(function(l){ return l.id; }).join(',')]);

  // ── EL INTERES YA CORRIDO, CREDITO POR CREDITO ──
  // Cada prestamo con su periodo en curso: cuanto interes ya corrio, cuantos dias de cuantos, desde
  // cuando, cuando vence su cuota y cuantos dias le faltan, y cuanto trae esa cuota de interes.
  var conCorrido = plan ? plan.traslados.filter(function(t){ return t.corrido.aplica && t.corrido.monto > 0; }) : [];
  var todosMarcados = conCorrido.length > 0 && conCorrido.every(function(t){ return !!corridos[t.loan.id]; });
  function marcarTodos(v){ var o = Object.assign({}, corridos); conCorrido.forEach(function(t){ o[t.loan.id] = v; }); setCorridos(o); }
  function filaCorrido(t){
    var Ml = function(cop){ return M(cop, t.loan.trmAcordada); };
    var c = t.corrido, l = t.loan, on = !!corridos[l.id];
    var p = c.diasPeriodo > 0 ? Math.min(100, Math.round(c.dias / c.diasPeriodo * 100)) : 0;
    var sinPeriodo = !c.aplica || c.monto <= 0;
    var detalle = c.enGracia ? 'En días de gracia hasta el ' + fCorta(c.graciaHasta) + ': todavía no corre interés'
      : c.sinCuotas ? 'Ya no le quedan cuotas por vencer: el interés no sigue corriendo (lo vencido ya está arriba)'
      : c.dias === 0 ? 'Su periodo empieza ese mismo día: no ha corrido interés'
      : c.dias + ' de ' + c.diasPeriodo + ' días (desde el ' + fCorta(c.desde, false) + ')' +
        (c.proximo ? ' · su cuota vence el ' + fCorta(c.proximo, false) + (c.faltan > 0 ? ', faltan ' + c.faltan + (c.faltan === 1 ? ' día' : ' días') : ', ese mismo día') : '');
    return h('label', { key: l.id, className: 'un-corr' + (sinPeriodo ? ' off' : '') + (on ? ' on' : '') },
      h('input', { type: 'checkbox', checked: on, disabled: sinPeriodo,
        onChange: function(){ var o = Object.assign({}, corridos); o[l.id] = !on; setCorridos(o); } }),
      h('span', { className: 'un-corr-t' },
        h('b', null, (esUSD ? fmtUSD(l.montoOrigen) : fmt(l.montoOrigen)) + ' · ' + pct(+l.tasaMensual)),
        h('small', null, detalle),
        !sinPeriodo && c.diasPeriodo > 0 && h('i', { className: 'un-barra' }, h('i', { style: { width: p + '%' } }))),
      h('span', { className: 'un-corr-v' }, sinPeriodo ? '—' : Ml(c.monto),
        !sinPeriodo && c.interesCuota > 0 && h('small', null, 'de ' + Ml(c.interesCuota) + ' de la cuota')));
  }

  function opcion(val, titulo, efecto){
    var on = (plan ? plan.destino : destino) === val;
    return h('label', { key: val, className: 'un-op' + (on ? ' v4m-elegida-info' : '') },
      h('input', { type: 'radio', name: 'un-destino', checked: on, onChange: function(){ setDestino(val); } }),
      h('span', null, h('b', null, titulo), h('small', null, efecto)));
  }
  var I = plan ? plan.interes : 0;
  // La primera cuota si los intereses fueran a ella (para rotular la opcion con su cifra exacta).
  var primeraAlt = useMemo(function(){
    if (!plan || diario) return 0;
    var alt = planUnificacion(elegidos, pays, hoy, Object.assign({}, opciones, { destino: 'primera' }));
    return alt.nuevo.primeraCuota;
  }, [plan]);
  var k = modalidad === 'Intereses' ? Math.max(1, +cuotasK || 1) : (N ? N.filas.length : 0);
  var parte = k ? Math.floor(I / k) : 0;

  // Lo que viaja al server: las DECISIONES, y lo que el usuario vio (`esperado`) para que el server,
  // que lo recalcula todo, rechace si algo cambio en el camino.
  function cuerpoPeticion(){
    return { loanIds: elegidos.map(function(l){ return l.id; }), fecha: fecha, corridos: corridos, ganancias: gan,
      destino: plan.destino, cuotasReparto: +cuotasK || 6,
      nuevo: { modalidad: N.modalidad, frecuencia: N.frecuencia, tasaMensual: N.tasaMensual, plazo: N.plazo,
        primerPago: N.primerPago, primerPeriodo: N.modoPP || 'proporcional' },
      esperado: { capital: plan.capital, interes: plan.interes } };
  }
  var dif = plan && plan.diferencia;
  var alarga = plan && N.ultima && plan.actual.ultima && N.ultima > plan.actual.ultima;

  return h(Modal, { onClose: props.onClose, wide: true, tall: true },
    h('div', null, h('div', { className: 'v4m-tit' }, 'Unificar préstamos'),
      h('div', { className: 'un-sub' }, props.deudor + ' · ' + candidatos.length + ' préstamos activos' + (monedas.length > 1 ? '' : (moneda === 'USD' ? ' en dólares' : ' en pesos')))),
    monedas.length > 1 && h('div', { className: 'v4m-seg un-seg' }, monedas.map(function(m){
      return h('button', { key: m, className: moneda === m ? 'on' : '', onClick: function(){ setMoneda(m); } }, m === 'USD' ? 'En dólares' : 'En pesos');
    })),

    // ── LA FECHA DE LA UNIFICACION ──
    h('div', { className: 'un-fecha' },
      h(Fld, { label: 'Fecha de la unificación' }, h('input', { className: 'inp' + (plan && plan.errorFecha ? ' v4m-b-peligro' : ''), type: 'date',
        value: fecha, min: limites.min, max: limites.max,
        onChange: function(e){ setFecha(e.target.value || hoy); setPrimerPago(''); setModoPP(null); } })),
      h('div', { className: 'un-fecha-t' },
        plan && plan.errorFecha ? h('span', { className: 'un-error' }, plan.errorFecha)
          : fecha === hoy ? 'Hoy. Si la unificación se acordó antes, elige ese día: lo que se debía, los días corridos y el préstamo nuevo se calculan a esa fecha.'
          : h('span', null, h('b', null, 'Unificación retroactiva: '), 'todo se calcula al ' + fCorta(fecha) + '. Lo que vencía después de ese día era una cuota por vencer, no vencida.'),
        limites.min && h('small', null, 'Puede ser desde el ' + fCorta(limites.min) + ' (ese día ' + limites.motivo + ') hasta hoy.'))),

    // ── 1. LO QUE SE UNE ──
    h('div', { className: 'un-bloque' },
      h('div', { className: 'un-bloque-t' }, h('span', null, '1'), 'Lo que se une', h('em', null, fecha === hoy ? 'debe hoy' : 'debía el ' + fCorta(fecha, false))),
      todosT.map(fila),
      plan && h('div', { className: 'un-total' },
        h('div', null, h('b', null, 'Pasa al préstamo nuevo'),
          h('small', null, 'capital ' + M(plan.capital) + (plan.interes > 0 ? ' + intereses ' + M(plan.interes) : ''))),
        h('div', { className: 'un-total-v' }, M(plan.total))),

      // El interes ya corrido: una casilla por credito, con su desglose.
      plan && conCorrido.length > 0 && h('div', { className: 'v4m-casilla un-corridos' },
        h('label', { className: 'un-corr-cab' },
          h('input', { type: 'checkbox', checked: todosMarcados, onChange: function(){ marcarTodos(!todosMarcados); } }),
          h('span', null, h('b', null, 'Cobrar el interés que ya corrió en las cuotas en curso'),
            h('small', null, 'Corre desde la última cuota de cada préstamo hasta la fecha de la unificación. El préstamo nuevo cobra desde esa fecha, así que no se cobra dos veces; lo que no marques no se cobra nunca.')),
          h('span', { className: 'un-corr-tot' }, M(plan.corridoCobrado), h('small', null, 'de ' + M(plan.corridoTotal)))),
        plan.traslados.filter(function(t){ return t.corrido.aplica || t.corrido.enGracia || t.corrido.sinCuotas; }).map(filaCorrido))),

    // ── 2. LOS INTERESES ──
    plan && I > 0 && h('div', { className: 'un-bloque' },
      h('div', { className: 'un-bloque-t' }, h('span', null, '2'), 'Los intereses (' + M(I) + '): ¿qué hacemos con ellos?'),
      h('div', { className: 'v4m-grupo un-grupo' },
        !diario && opcion('repartir', modalidad === 'Intereses' ? 'Repartirlos en las primeras cuotas' : 'Repartirlos entre todas las cuotas',
          modalidad === 'Intereses' ? 'Solo intereses no tiene plazo fijo: tú eliges en cuántas cuotas (+ ' + M(parte) + ' en cada una)'
            : '+ ' + M(parte) + ' en cada una de las ' + k + ' cuotas, sin intereses encima'),
        !diario && destino === 'repartir' && modalidad === 'Intereses' && h('div', { className: 'un-k' }, 'En las primeras',
          h('input', { className: 'inp', inputMode: 'numeric', value: cuotasK, onChange: function(e){ setCuotasK(e.target.value.replace(/\D/g, '')); } }), 'cuotas'),
        !diario && opcion('primera', 'Mandarlos a la primera cuota', 'La primera cuota sube a ' + M(primeraAlt) + '; las demás quedan normales'),
        diario && h('div', { className: 'un-hint un-k-nota' }, 'Un crédito abierto no tiene cuotas donde cargarlos: se suman a su capital o se condonan.'),
        opcion('capital', 'Sumarlos al capital', 'El capital del nuevo queda en ' + M(plan.capital + I) + ' y esos intereses también generan interés'),
        opcion('condonar', 'Condonarlos', 'Se perdonan ' + M(I) + ': quedan registrados como intereses condonados'))),

    // ── 3. EL PRESTAMO NUEVO ──
    plan && h('div', { className: 'un-bloque' },
      h('div', { className: 'un-bloque-t' }, h('span', null, plan.interes > 0 ? '3' : '2'), 'El préstamo nuevo'),
      h('div', { className: 'un-campos' },
        h(Fld, { label: 'Modalidad' }, h('select', { className: 'inp', value: modalidad, onChange: function(e){ setModalidad(e.target.value); } },
          UN_MODALIDADES.map(function(m){ return h('option', { key: m, value: m }, opModalidad(m)); }))),
        !diario && h(Fld, { label: 'Frecuencia' }, h('select', { className: 'inp', value: frecuencia, onChange: function(e){ setFrecuencia(e.target.value); setPrimerPago(''); setModoPP(null); } },
          ['Mensual', 'Quincenal', 'Semanal'].map(function(f){ return h('option', { key: f, value: f }, f); }))),
        !diario && h(Fld, { label: 'Primer pago' }, h('input', { className: 'inp', type: 'date', value: ppEfectivo,
          onChange: function(e){ setPrimerPago(e.target.value); setModoPP(null); } }),
          N.cuotasYaVencidas > 0 ? h('div', { className: 'un-hint un-error' }, 'Con esta fecha, ' + (N.cuotasYaVencidas === 1 ? 'la primera cuota ya venció' : N.cuotasYaVencidas + ' cuotas ya vencieron') + ': nacerían en mora.')
            : h('div', { className: 'un-hint' }, (info && info.irregular ? info.dias + ' días' : 'Un periodo') + (fecha === hoy ? ' después de hoy' : ' después de la unificación'))),
        h(Fld, { label: 'Tasa mensual (%)' }, h('input', { className: 'inp', inputMode: 'decimal', value: tasa === '' ? String(N.tasaMensual).replace('.', ',') : tasa,
          onChange: function(e){ setTasa(e.target.value.replace(/[^\d,.]/g, '')); } }),
          h('div', { className: 'un-hint' }, 'Ponderada ', h('button', { onClick: function(){ setTasa(''); } }, pct(plan.tasaPonderada)),
            ' · la más alta ', h('button', { onClick: function(){ setTasa(String(plan.tasaMax).replace('.', ',')); } }, pct(plan.tasaMax)))),
        modalidad === 'Capital + Intereses' && h(Fld, { label: 'Cuotas' }, h('input', { className: 'inp', inputMode: 'numeric', value: plazo,
          onChange: function(e){ setPlazo(e.target.value.replace(/\D/g, '')); } }))),
      !diario && info && info.irregular && (+N.tasaMensual > 0) && h('div', { className: 'v4m-grupo un-grupo un-pp' },
        [[info.caso === 'gracia' ? 'completo' : 'proporcional', info.caso === 'gracia' ? 'Perdonar ' + info.graciaDias + ' días' : 'Cobrar solo los ' + info.dias + ' días',
          info.caso === 'gracia' ? info.interesCompleto : info.interesProporcional],
         [info.caso === 'gracia' ? 'proporcional' : 'completo', info.caso === 'gracia' ? 'Cobrar los ' + info.dias + ' días' : 'Cobrar el periodo completo',
          info.caso === 'gracia' ? info.interesProporcional : info.interesCompleto]].map(function(o){
          var on = (N.modoPP || info.modoPorDefecto) === o[0];
          return h('label', { key: o[0], className: 'un-op' + (on ? ' v4m-elegida-info' : '') },
            h('input', { type: 'radio', name: 'un-pp', checked: on, onChange: function(){ setModoPP(o[0]); } }),
            h('span', null, h('b', null, o[1]), h('small', null, 'La primera cuota cobra ' + M(o[2]) + ' de interés')));
        }))),

    // ── 4. LA COMPARATIVA ──
    plan && !diario && h('div', { className: 'un-bloque' },
      h('div', { className: 'un-bloque-t' }, h('span', null, plan.interes > 0 ? '4' : '3'), 'Cómo queda'),
      h('table', { className: 'un-comp' },
        h('thead', null, h('tr', null, h('th', null, ''), h('th', null, 'Si siguen como van'), h('th', null, 'Unificado'))),
        h('tbody', null,
          h('tr', null, h('td', null, 'Cuota por mes'),
            h('td', null, M(plan.actual.porMes), plan.actual.vencido > 0 && h('small', null, 'y ' + M(plan.actual.vencido) + ' vencidos' + (fecha === hoy ? ' hoy' : ' a esa fecha'))),
            h('td', null, h('b', null, M(N.porMes)), N.primeraCuota !== N.cuota && h('small', null, 'la primera: ' + M(N.primeraCuota)))),
          h('tr', null, h('td', null, 'Último pago'), h('td', null, fCorta(plan.actual.ultima)), h('td', null, fCorta(N.ultima))),
          h('tr', null, h('td', null, 'Total por cobrar'), h('td', null, M(plan.actual.total)), h('td', null, M(N.totalCobro))),
          h('tr', { className: 'gan' }, h('td', null, 'Ganancia por cobrar'), h('td', null, M(plan.gananciaHoy)), h('td', null, h('b', null, M(plan.gananciaNuevo)))))),
      h('div', { className: 'un-dif ' + (dif > 0 ? 'mas' : dif < 0 ? 'menos' : '') },
        dif === 0 ? 'Ganarías lo mismo que si siguen como van.'
          : h('span', null, 'Ganarías ', h('b', null, M(Math.abs(dif)) + (dif > 0 ? ' más' : ' menos')), ' que si siguen como van',
            dif > 0 && alarga ? ': el capital queda prestado más tiempo (hasta el ' + fCorta(N.ultima) + ').' : '.')),
      plan.actual.proyectado && h('div', { className: 'un-hint' }, 'Los préstamos sin plazo fijo se proyectan hasta el último pago del nuevo.'),
      h('button', { className: 'un-ver', onClick: function(){ setVerCrono(!verCrono); } },
        verCrono ? 'Ocultar el cronograma del préstamo nuevo' : 'Ver el cronograma del préstamo nuevo', h(Ico, { name: verCrono ? 'chevdown' : 'chevright', size: 13, sw: 2.3 })),
      verCrono && h('table', { className: 'un-crono' },
        h('thead', null, h('tr', { className: 'v4m-crono-th' }, ['#', 'Vence', 'Interés', 'Abono a capital', 'Valor cuota', 'Saldo'].map(function(t){ return h('th', { key: t }, t); }))),
        h('tbody', null, N.filas.slice(0, modalidad === 'Intereses' ? Math.max(+plazo || 12, k) : N.filas.length).map(function(f){
          return h('tr', { key: f.n, className: 'v4m-crono-tr' }, h('td', null, f.n), h('td', null, fCorta(f.fecha)),
            h('td', null, M(f.interes), f.carga > 0 && h('small', null, 'incluye ' + M(f.carga) + ' trasladados')),
            h('td', null, M(f.capital)), h('td', null, h('b', null, M(f.cuota))), h('td', null, M(f.saldo)));
        })))),
    plan && diario && h('div', { className: 'un-bloque' },
      h('div', { className: 'un-bloque-t' }, h('span', null, plan.interes > 0 ? '4' : '3'), 'Cómo queda'),
      h('div', { className: 'un-hint' }, 'Crédito abierto de ' + M(N.monto) + ' al ' + pct(N.tasaMensual) + ' mensual: unos ' +
        M(Math.round(N.monto * N.tasaMensual / 100)) + ' de interés por mes, que bajan con cada abono a capital.')),

    // ── QUE PASA CON LOS DE HOY Y LOS BOTONES ──
    plan && h('div', { className: 'v4m-caja-info un-nota' }, h(Ico, { name: 'alert', size: 15, sw: 2.2 }),
      h('span', null, 'Los ' + elegidos.length + ' préstamos se cierran como ', h('b', null, 'unificados'), '. Lo que ya pagaron sigue registrado',
        plan.traslados.some(function(t){ return t.abonado > 0; }) ? ' (también los abonos a cuotas sin saldar: ' + M(plan.traslados.reduce(function(s, t){ return s + t.abonado; }, 0)) + ')' : '',
        '. No entra ni sale dinero: la deuda pasa entera al préstamo nuevo. Se puede deshacer desde el Historial.')),
    plan && h('label', { className: 'v4m-check' }, h('input', { type: 'checkbox', checked: genDoc, onChange: function(){ setGenDoc(!genDoc); } }), 'Generar la constancia de unificación para el cliente'),
    h('div', { className: 'un-acc' },
      h('button', { className: 'v4m-btn neutro', disabled: !plan || !!plan.errorFecha, onClick: function(){ props.onPropuesta(plan); } },
        h(Ico, { name: 'receipt', size: 15, sw: 2.3 }), 'Propuesta para el cliente (PDF)'),
      h('button', { className: 'btn-primary', disabled: sending || !plan || elegidos.length < 2 || !!plan.errorFecha,
        onClick: function(){ _submitGuard(sending, setSending, function(){ return props.onConfirmar(cuerpoPeticion(), plan, genDoc); }); } },
        sending ? 'Unificando…' : elegidos.length < 2 ? 'Elige al menos dos préstamos' : 'Unificar ' + elegidos.length + ' préstamos')));
}
