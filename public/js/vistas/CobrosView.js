// public/js/vistas/CobrosView.js — Cobros: la bandeja del dia (3.5.0; reemplaza a la pestana Pagos).
//
// Pregunta que responde: "¿que tengo que cobrar y a quien?". Cada cuota en su tramo de urgencia,
// lo vencido agrupado por credito (un cobro en cascada salda todo lo de ese credito), el pago de una
// cuota a un clic y el deudor al lado, sin modal. Y en "Cobrado", toda la caja del mes por dia,
// repartida con `imputarCobros` (interes + capital + efecto TRM = caja, evento por evento).

import { DeudorPanel } from '../componentes/DeudorPanel.js';
import { Ico } from '../componentes/iconos.js';
import { imputarCobros } from '../core/dominio.js';
import { copToUsd, fmt, fmtUSD } from '../core/format.js';
import { esAbono, esCorte } from '../core/ids.js';
import { bandejaCobro, opModalidad, opIniciales, opCorta, opRel, OP_MESES, OP_DIAS, opFecha } from '../core/operacion.js';
import { h, useEffect, useState } from '../core/react.js';
import { properCase, payMatchesQuery } from '../core/ui.js';
import { generateFacturaCobro } from '../pdf/factura-cobro.js';
import { generateReciboGeneral } from '../pdf/recibo-general.js';
import { usdLinea } from '../componentes/CifraUSD.js';

var CB_TRAMOS = [
  ['vencido', 'Vencido', 'red', 'alert'],
  ['hoy', 'Hoy', 'yellow', 'calendar'],
  ['semana', 'Próximos 7 días', 'yellow', 'clock'],
  ['mes', 'Este mes', 'blue', 'calendar'],
  ['despues', 'Más adelante', 'text3', 'clock']
];
function cbMes(key, delta){ var d = new Date(+key.slice(0, 4), +key.slice(5, 7) - 1 + delta, 1); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
function cbUsd(l, cop){ return l && l.moneda === 'USD' ? usdLinea(copToUsd(cop, l.trmAcordada)) : null; }

export function CobrosView(props){
  var loans = props.loans, pays = props.pays, hoy = props.hoy;
  var _m = useState('cobrar'); var modo = _m[0], setModo = _m[1];
  var _t = useState(props.tramo || 'todo'); var tramo = _t[0], setTramo = _t[1];
  var _q = useState(''); var q = _q[0], setQ = _q[1];
  var _s = useState(null); var sel = _s[0], setSel = _s[1];
  var _mes = useState(hoy.slice(0, 7)); var mes = _mes[0], setMes = _mes[1];
  var _w = useState(window.innerWidth); var ancho = _w[0], setAncho = _w[1];
  var _d = useState(false); var verDespues = _d[0], setVerDespues = _d[1];
  // Creditos con 2+ cuotas vencidas: plegados por defecto (decision del PO). { loanId: true } = abierto.
  var _a = useState({}); var abiertos = _a[0], setAbiertos = _a[1];
  useEffect(function(){
    function r(){ setAncho(window.innerWidth); }
    window.addEventListener('resize', r); return function(){ window.removeEventListener('resize', r); };
  }, []);
  // Ventana angosta (la minima de la app es 1.000 px): la lista ocupa todo y el panel se abre encima.
  var superpuesto = ancho < 1100;

  var filas = bandejaCobro(loans, pays, hoy).filter(function(f){ return !q || payMatchesQuery(f.p, q); });
  var tot = {};
  CB_TRAMOS.forEach(function(t){ tot[t[0]] = { n: 0, cop: 0, deudores: {} }; });
  filas.forEach(function(f){ var t = tot[f.tramo]; t.n++; t.cop += f.pend; t.deudores[f.p.nombreCliente] = 1; });
  var visibles = filas.filter(function(f){ return tramo === 'todo' || f.tramo === tramo; });

  function elegir(f){ setSel({ nombre: f.l.nombre, loanId: f.l.id, payId: f.p.id }); }
  function fila(f, enGrupo){
    var p = f.p, l = f.l, on = sel && sel.payId === p.id, parcial = (p.partialPaid || 0) > 0;
    var vence = f.tramo === 'vencido'
      ? h('div', null, h('div', null, opCorta(p.fechaPago)), h('div', { className: 'dp-sub', style: { color: 'var(--red)' } }, (-f.dias) + ' día' + (f.dias === -1 ? '' : 's') + ' de mora'))
      : h('div', null, h('div', null, opCorta(p.fechaPago)), h('div', { className: 'dp-sub', style: { color: f.tramo === 'hoy' ? 'var(--yellow)' : 'var(--text3)' } }, opRel(hoy, p.fechaPago)));
    return h('div', { key: p.id, className: 'cb-fila' + (on ? ' on' : '') + (enGrupo ? ' en-grupo' : '') + ' t-' + f.tramo, onClick: function(){ elegir(f); } },
      enGrupo ? h('div', { className: 'cb-quien' }, h('span', { className: 'cb-cuota-n' }, 'Cuota ' + p.cuotaN + (l.modalidad === 'Intereses' ? '' : ' de ' + l.plazoMeses)))
        : h('div', { className: 'cb-quien' },
            h('div', { className: 'op-avatar e-' + (f.tramo === 'vencido' ? 'mora' : f.tramo === 'hoy' ? 'hoy' : 'aldia') }, opIniciales(p.nombreCliente)),
            h('div', { style: { minWidth: 0 } },
              h('div', { className: 'cb-nombre' }, properCase(p.nombreCliente)),
              h('div', { className: 'dp-sub' }, opModalidad(l.modalidad, true) + (l.moneda === 'USD' ? ' · USD' : '') + ' · cuota ' + p.cuotaN + (l.modalidad === 'Intereses' ? '' : ' de ' + l.plazoMeses)))),
      h('div', { className: 'cb-vence' }, vence),
      h('div', { className: 'cb-monto r' },
        h('div', { className: 'mono', style: { color: f.tramo === 'vencido' ? 'var(--red)' : f.tramo === 'hoy' ? 'var(--yellow)' : 'var(--text)' } }, fmt(f.pend)),
        cbUsd(l, f.pend),
        parcial && h('div', { className: 'dp-sub', style: { color: 'var(--blue)' } }, 'ya abonó ' + fmt(p.partialPaid))),
      h('div', { className: 'cb-acc', onClick: function(e){ e.stopPropagation(); } },
        h('button', { className: 'op-icono', title: 'Factura de cobro (PDF) para enviarle', onClick: function(){ generateFacturaCobro(p, l, pays, props.datosPago); } }, h(Ico, { name: 'receipt', size: 15, color: 'var(--text2)', sw: 2.1 })),
        h('button', { className: 'op-btn ok sm', title: 'Registrar el pago de esta cuota', onClick: function(){ props.onPay(p); } }, h(Ico, { name: 'check', size: 14, color: 'var(--green)', sw: 2.6 }), 'Pagó')));
  }
  // Lo vencido se agrupa por credito: si alguien debe tres cuotas, se ve como UNA deuda y se cobra de
  // una vez con el cobro en cascada (intereses vencidos -> capital vencido -> abono). Con 2 o mas
  // cuotas el grupo es un ACORDEON plegado: la fila dice cuantas cuotas, cuanto suman y cuantos dias
  // tiene la mas vieja; el detalle cuota por cuota se abre con un clic (o solo, si la cuota elegida
  // esta adentro).
  function grupos(fs){
    var porLoan = {}, orden = [];
    fs.forEach(function(f){ if (!porLoan[f.l.id]){ porLoan[f.l.id] = []; orden.push(f.l.id); } porLoan[f.l.id].push(f); });
    return orden.map(function(id){
      var g = porLoan[id], l = g[0].l, total = g.reduce(function(s, f){ return s + f.pend; }, 0);
      if (g.length === 1) return fila(g[0], false);
      var on = sel && sel.loanId === id;
      var abierto = !!abiertos[id] || !!(on && sel.payId && g.some(function(f){ return f.p.id === sel.payId; }));
      function alternar(){
        var x = Object.assign({}, abiertos); x[id] = !abierto; setAbiertos(x);
        setSel({ nombre: l.nombre, loanId: l.id, payId: null });
      }
      return h('div', { key: 'g' + id, className: 'cb-grupo' + (on ? ' on' : '') + (abierto ? ' abierto' : '') },
        h('div', { className: 'cb-grupo-h', role: 'button', 'aria-expanded': abierto, title: abierto ? 'Ocultar las cuotas' : 'Ver las cuotas una por una', onClick: alternar },
          h('div', { className: 'cb-quien' },
            h('span', { className: 'cb-chev' }, h(Ico, { name: 'chevright', size: 15, color: 'var(--text2)', sw: 2.6 })),
            h('div', { className: 'op-avatar e-mora' }, opIniciales(l.nombre)),
            h('div', { style: { minWidth: 0 } },
              h('div', { className: 'cb-nombre' }, properCase(l.nombre)),
              h('div', { className: 'dp-sub' }, g.length + ' cuotas vencidas'))),
          h('div', { className: 'cb-vence' }, h('div', { style: { color: 'var(--red)', fontWeight: 600 } }, (-g[0].dias) + ' días de mora'), h('div', { className: 'dp-sub' }, 'la más vieja')),
          h('div', { className: 'cb-monto r' }, h('div', { className: 'mono', style: { color: 'var(--red)', fontWeight: 700 } }, fmt(total)), cbUsd(l, total)),
          h('div', { className: 'cb-acc', onClick: function(e){ e.stopPropagation(); } },
            // El recibo de cobro general es del DEUDOR, no de este credito: lleva toda su deuda
            // vencida y el estado de todos sus creditos activos (decision del PO).
            h('button', { className: 'op-icono', title: 'Recibo de cobro general (PDF): toda su deuda vencida y sus opciones de pago', onClick: function(){
              generateReciboGeneral(loans.filter(function(x){ return x.nombre === l.nombre; }), pays, props.datosPago, { hasta: hoy }); } },
              h(Ico, { name: 'clipboard', size: 15, color: 'var(--text2)', sw: 2.1 })),
            h('button', { className: 'op-btn pri sm', title: 'Cobrar lo que entregue, en cascada: intereses vencidos, capital vencido y abono', onClick: function(){ props.acciones.onCobro(l); } },
              h(Ico, { name: 'dollar', size: 14, color: '#fff', sw: 2.4 }), 'Cobrar'))),
        abierto && h('div', { className: 'cb-grupo-cuotas' }, g.map(function(f){ return fila(f, true); })));
    });
  }

  var secciones = CB_TRAMOS.filter(function(t){ return tramo === 'todo' || tramo === t[0]; }).map(function(t){
    var fs = visibles.filter(function(f){ return f.tramo === t[0]; });
    if (!fs.length) return null;
    var n = Object.keys(tot[t[0]].deudores).length;
    return h('div', { key: t[0], className: 'cb-sec' },
      h('div', { className: 'cb-sec-h', style: { color: 'var(--' + t[2] + ')' } },
        h(Ico, { name: t[3], size: 14, color: 'var(--' + t[2] + ')', sw: 2.4 }),
        h('span', null, t[1]), h('span', { className: 'cb-sec-n' }, fs.length + ' cuota' + (fs.length > 1 ? 's' : '') + ' · ' + n + ' deudor' + (n > 1 ? 'es' : '')),
        h('span', { className: 'cb-sec-v mono' }, fmt(tot[t[0]].cop))),
      t[0] === 'vencido' ? grupos(fs)
        // Lo de mas de 30 dias no es trabajo de hoy: plegado, a un clic, para no alargar la bandeja.
        : t[0] === 'despues' && tramo === 'todo' && !verDespues
          ? h('button', { className: 'cb-mas', onClick: function(){ setVerDespues(true); } }, 'Mostrar las ' + fs.length + ' cuotas que vencen después de 30 días')
          : fs.map(function(f){ return fila(f, false); }));
  }).filter(Boolean);

  // ── Cobrado: toda la caja del mes, por dia ────────────────────────────────────
  var eventos = [];
  if (modo === 'cobrado'){
    var loanMap = {}; loans.forEach(function(l){ loanMap[l.id] = l; });
    pays.forEach(function(p){
      var l = loanMap[p.prestamoId]; if (!l) return;
      if (q && !payMatchesQuery(p, q)) return;
      var evs = imputarCobros(p).eventos;
      evs.forEach(function(e, k){
        if (e.fecha.slice(0, 7) !== mes) return;
        var tipo = esCorte(p) ? 'Corte de interés' : esAbono(p) ? (/liquidaci/i.test(p.observaciones || '') ? 'Liquidación' : 'Abono a capital')
          : p.estadoPago !== 'Pagado' ? 'Abono parcial · cuota ' + p.cuotaN : 'Cuota ' + p.cuotaN + (evs.length > 1 && k === evs.length - 1 ? ' · pago final' : evs.length > 1 ? ' · abono' : '');
        eventos.push({ p: p, l: l, e: e, tipo: tipo });
      });
    });
    eventos.sort(function(a, b){ return b.e.fecha.localeCompare(a.e.fecha) || String(b.p.paidAt || '').localeCompare(String(a.p.paidAt || '')); });
  }
  // caja = intereses + capital + efecto TRM, evento por evento (imputarCobros). El efecto se muestra
  // aparte: sin el, las dos primeras cifras no suman lo que entro.
  var totCob = eventos.reduce(function(a, x){ a.cop += x.e.cop; a.int += x.e.interes; a.cap += x.e.capital; a.aj += (x.e.ajuste || 0); return a; }, { cop: 0, int: 0, cap: 0, aj: 0 });
  var cobrado = null;
  if (modo === 'cobrado'){
    var bloques = [], ult = null;
    eventos.forEach(function(x, i){
      if (x.e.fecha !== ult){ ult = x.e.fecha; var dd = opFecha(x.e.fecha);
        var delDia = eventos.filter(function(y){ return y.e.fecha === x.e.fecha; }).reduce(function(s, y){ return s + y.e.cop; }, 0);
        bloques.push(h('div', { key: 'd' + x.e.fecha, className: 'cb-dia' }, h('span', null, (x.e.fecha === hoy ? 'Hoy · ' : '') + OP_DIAS[dd.getDay()] + ' ' + dd.getDate() + ' de ' + OP_MESES[dd.getMonth()]), h('span', { className: 'mono' }, fmt(delDia)))); }
      var on = sel && sel.loanId === x.l.id;
      bloques.push(h('div', { key: x.p.id + i, className: 'cb-fila cobrada' + (on ? ' on' : ''), onClick: function(){ setSel({ nombre: x.l.nombre, loanId: x.l.id, payId: x.p.id }); } },
        h('div', { className: 'cb-quien' }, h('div', { className: 'op-avatar e-aldia' }, opIniciales(x.p.nombreCliente)),
          h('div', { style: { minWidth: 0 } }, h('div', { className: 'cb-nombre' }, properCase(x.p.nombreCliente)), h('div', { className: 'dp-sub' }, x.tipo + (x.l.moneda === 'USD' ? ' · USD' : '')))),
        h('div', { className: 'cb-split' },
          x.e.interes > 0 && h('span', null, 'interés ', h('b', { className: 'mono' }, fmt(x.e.interes))),
          x.e.capital > 0 && h('span', null, 'capital ', h('b', { className: 'mono' }, fmt(x.e.capital)))),
        h('div', { className: 'cb-monto r' }, h('div', { className: 'mono', style: { color: 'var(--green)' } }, '+ ' + fmt(x.e.cop)),
          x.l.moneda === 'USD' && (x.p.montoUSDRecibido > 0 && eventos.filter(function(y){ return y.p.id === x.p.id; }).length === 1
            ? usdLinea(fmtUSD(x.p.montoUSDRecibido)) : cbUsd(x.l, x.e.cop))),
        h('div', { className: 'cb-acc' })));
    });
    cobrado = h('div', null,
      h('div', { className: 'cb-mes' },
        h('button', { className: 'op-icono', onClick: function(){ setMes(cbMes(mes, -1)); } }, h(Ico, { name: 'chevleft', size: 15, color: 'var(--text2)', sw: 2.4 })),
        h('span', null, OP_MESES[+mes.slice(5, 7) - 1] + ' ' + mes.slice(0, 4)),
        h('button', { className: 'op-icono', onClick: function(){ setMes(cbMes(mes, 1)); } }, h(Ico, { name: 'chevright', size: 15, color: 'var(--text2)', sw: 2.4 }))),
      h('div', { className: 'cb-resumen' },
        h('div', null, h('div', { className: 'dp-fig-l' }, 'Entró en caja'), h('div', { className: 'dp-kpi-v mono', style: { color: 'var(--green)' } }, fmt(totCob.cop))),
        h('div', null, h('div', { className: 'dp-fig-l' }, 'De eso, intereses'), h('div', { className: 'dp-kpi-v mono' }, fmt(totCob.int))),
        h('div', null, h('div', { className: 'dp-fig-l' }, 'Capital devuelto'), h('div', { className: 'dp-kpi-v mono' }, fmt(totCob.cap))),
        Math.abs(totCob.aj) > 5 && h('div', null, h('div', { className: 'dp-fig-l' }, 'Efecto TRM'),
          h('div', { className: 'dp-kpi-v mono', style: { color: totCob.aj < 0 ? 'var(--red)' : 'var(--green)' } }, (totCob.aj < 0 ? '-' : '+') + fmt(Math.abs(totCob.aj))),
          h('div', { className: 'dp-fig-s' }, 'dólares cobrados a otra TRM')),
        h('div', null, h('div', { className: 'dp-fig-l' }, 'Movimientos'), h('div', { className: 'dp-kpi-v' }, eventos.length))),
      bloques.length ? h('div', { className: 'cb-lista' }, bloques) : h('div', { className: 'op-vacio' }, 'No entró dinero en ' + OP_MESES[+mes.slice(5, 7) - 1] + '.'));
  }

  // ── Panel lateral ─────────────────────────────────────────────────────────────
  var deudorSel = sel ? props.deudores.filter(function(d){ return d.nombre === sel.nombre; })[0] : null;
  var acciones = props.acciones;
  var panel = deudorSel
    ? h(DeudorPanel, Object.assign({ key: sel.nombre + '|' + sel.loanId, deudor: deudorSel, loans: loans, pays: pays, hoy: hoy, focoLoan: sel.loanId, focoPay: sel.payId,
        onClose: function(){ setSel(null); }, superpuesto: superpuesto, datosPago: props.datosPago, showToast: props.showToast, onPay: props.onPay }, acciones))
    : !superpuesto && h('div', { className: 'cb-lado' },
        h('div', { className: 'cb-lado-t' }, 'Tu día de cobro'),
        h('div', { className: 'cb-lado-big' }, h('div', { className: 'dp-fig-l' }, 'Para cobrar hoy'), h('div', { className: 'mono' }, fmt(tot.hoy.cop)),
          h('div', { className: 'dp-fig-s' }, tot.hoy.n ? tot.hoy.n + ' cuota' + (tot.hoy.n > 1 ? 's' : '') : 'ninguna cuota vence hoy')),
        h('div', { className: 'cb-lado-f' }, h('span', null, 'Vencido'), h('b', { className: 'mono', style: { color: 'var(--red)' } }, fmt(tot.vencido.cop))),
        h('div', { className: 'cb-lado-f' }, h('span', null, 'Próximos 7 días'), h('b', { className: 'mono' }, fmt(tot.semana.cop))),
        h('div', { className: 'cb-lado-f' }, h('span', null, 'Resto del mes'), h('b', { className: 'mono' }, fmt(tot.mes.cop))),
        h('div', { className: 'cb-lado-tip' }, h(Ico, { name: 'sparkle', size: 14, color: 'var(--blue)', sw: 2 }),
          h('span', null, 'Toca una cuota para ver al deudor aquí al lado, con su cronograma y todas sus acciones, sin salir de la lista. ', h('b', null, 'Pagó'), ' registra esa cuota; ', h('b', null, 'Cobrar'), ' reparte lo que te entregue en cascada.')));

  var totalPend = filas.reduce(function(s, f){ return s + f.pend; }, 0);
  var dHoy = opFecha(hoy);
  return h('div', { className: 'op' + (sel ? ' con-panel' : '') },
    h('div', { className: 'op-main' },
      h('div', { className: 'op-cab' },
        h('div', { style: { minWidth: 0 } },
          h('div', { className: 'op-titulo' }, 'Cobros'),
          h('div', { className: 'op-subt' }, OP_DIAS[dHoy.getDay()] + ' ' + dHoy.getDate() + ' de ' + OP_MESES[dHoy.getMonth()] + ' · ' + fmt(totalPend) + ' por cobrar en ' + filas.length + ' cuotas')),
        h('div', { className: 'op-seg' },
          h('button', { className: modo === 'cobrar' ? 'on' : '', onClick: function(){ setModo('cobrar'); } }, 'Por cobrar'),
          h('button', { className: modo === 'cobrado' ? 'on' : '', onClick: function(){ setModo('cobrado'); } }, 'Cobrado'))),
      h('div', { className: 'op-buscar' }, h(Ico, { name: 'search', size: 15, color: 'var(--text3)' }),
        h('input', { value: q, onChange: function(e){ setQ(e.target.value); }, placeholder: 'Buscar por nombre o código de factura (FC-…)' }),
        q && h('button', { className: 'op-icono', onClick: function(){ setQ(''); } }, h(Ico, { name: 'x', size: 13, color: 'var(--text3)' }))),
      modo === 'cobrar' && h('div', { className: 'cb-tramos' },
        CB_TRAMOS.map(function(t){
          var on = tramo === t[0], v = tot[t[0]];
          return h('button', { key: t[0], className: 'cb-tramo t-' + t[0] + (on ? ' on' : '') + (v.n ? '' : ' vacio'), style: on ? { borderColor: 'var(--' + (t[2] === 'text3' ? 'border2' : t[2]) + ')' } : null,
              onClick: function(){ setTramo(on ? 'todo' : t[0]); } },
            h('div', { className: 'cb-tramo-l', style: { color: v.n ? 'var(--' + t[2] + ')' : 'var(--text3)' } }, t[1]),
            h('div', { className: 'cb-tramo-v mono' }, fmt(v.cop)),
            h('div', { className: 'dp-fig-s' }, v.n ? v.n + ' cuota' + (v.n > 1 ? 's' : '') : 'nada'));
        })),
      modo === 'cobrar'
        ? (secciones.length ? h('div', { className: 'cb-lista' }, secciones)
            : h('div', { className: 'op-vacio grande' }, h(Ico, { name: 'check', size: 30, color: 'var(--green)' }), h('div', null, q ? 'Nada coincide con la búsqueda.' : 'No hay nada por cobrar en este tramo.')))
        : cobrado),
    panel && h('div', { className: 'op-lado' + (superpuesto ? ' superpuesto' : '') }, panel));
}
