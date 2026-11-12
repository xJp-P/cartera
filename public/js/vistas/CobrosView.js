// public/js/vistas/CobrosView.js — Cobros: la bandeja del dia (3.5.0; reemplaza a la pestana Pagos).
//
// Pregunta que responde: "¿que tengo que cobrar y a quien?". Cada cuota en su tramo de urgencia,
// lo vencido agrupado por credito (un cobro en cascada salda todo lo de ese credito), el pago de una
// cuota a un clic y el deudor al lado, sin modal. Y en "Cobrado", toda la caja del mes por dia,
// repartida con `imputarCobros` (interes + capital + efecto TRM = caja, evento por evento).
//
// REDISEÑO v4 (aprobado por el PO sobre el prototipo; integrado pestaña por pestaña, fase 2). MISMO
// comportamiento y MISMOS datos que la vista de 3.5.0: bandejaCobro, los tramos, el acordeon de lo
// vencido (plegado por defecto), "Mas adelante" plegado, el modo Cobrado con imputarCobros, el panel
// del deudor al lado y el buscador. Cambia la presentacion:
//   - un encabezado con la cifra total, el selector "Por cobrar / Cobrado" con la pastilla que se
//     desliza, y una barra horizontal que reparte lo por cobrar en los cinco tramos (cada tramo es
//     ademas un filtro, en la barra y en su tarjeta);
//   - cada tramo es una tarjeta con sus filas separadas por lineas, sin bordes de color;
//   - en Cobrado, la caja del mes con su barra intereses / capital y la lista por dia;
//   - el panel del deudor con el diseño nuevo (la raiz lleva `.v4p`, como la de Cartera).
// Estilos en public/css/cobros.css (`.v4c`, `.cbv-*`); los del panel, en public/css/panel.css. La barra
// segmentada (`CbvSegbar`) la reutilizan Cartera y Rendimiento, y el selector (`CbvSeg`), Rendimiento. Prefijo `cbv`/`CBV_` (el arnes aplana los modulos en
// un ambito).

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
import { V4Dinero, V4Chip, v4PuedeAnimar } from './DashView.js';

// [clave, rotulo, tono del punto y de la barra]
var CBV_TRAMOS = [
  ['vencido', 'Vencido', 'crit'],
  ['hoy', 'Hoy', 'warn'],
  ['semana', 'Próximos 7 días', 'info'],
  ['mes', 'Este mes', 'muted'],
  ['despues', 'Más adelante', 'track']
];
function cbvMes(key, delta){ var d = new Date(+key.slice(0, 4), +key.slice(5, 7) - 1 + delta, 1); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
function cbvUsd(l, cop){ return l && l.moneda === 'USD' ? usdLinea(copToUsd(cop, l.trmAcordada)) : null; }
function cbvPl(n, s, p){ return n + ' ' + (n === 1 ? s : (p || s + 's')); }

// Control segmentado con la pastilla que se desliza (el selector de tema de Control TC).
export function CbvSeg(p){
  var i = p.opciones.findIndex(function(o){ return o[0] === p.valor; });
  return h('div', { className: 'cbv-seg', style: { '--n': p.opciones.length, '--k': Math.max(0, i) } },
    h('span', { className: 'cbv-seg-thumb' }),
    p.opciones.map(function(o){
      return h('button', { key: o[0], className: o[0] === p.valor ? 'on' : '', onClick: function(){ p.onChange(o[0]); } }, o[1]);
    }));
}
// Barra segmentada (Control TC .ds-segbar) con su globo por segmento.
export function CbvSegbar(p){
  var total = p.partes.reduce(function(s, x){ return s + Math.max(0, x.v); }, 0);
  if (!(total > 0)) return h('div', { className: 'cbv-segbar vacia' }, h('span', { className: 'seg track', style: { flex: 1 } }));
  var vivas = p.partes.filter(function(x){ return x.v > 0; });
  return h('div', { className: 'cbv-segbar' + (p.onClick ? ' clic' : '') + (p.className ? ' ' + p.className : '') }, vivas.map(function(x, i){
    var lado = i === 0 ? ' start' : i === vivas.length - 1 ? ' end' : '';
    return h('span', { key: x.k, className: 'seg ' + x.tono + (p.activo && p.activo !== x.k ? ' apagado' : ''), tabIndex: 0, style: { flexGrow: x.v, '--i': i },
        onClick: p.onClick ? function(){ p.onClick(x.k); } : null },
      h('span', { className: 'v4-tip' + lado }, h('b', null, fmt(x.v)), h('span', null, x.l + (x.d ? ' · ' + x.d : '') + ' · ' + Math.round(x.v / total * 100) + '%')));
  }));
}

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
  var _an = useState(v4PuedeAnimar); var anima = _an[0];
  useEffect(function(){
    function r(){ setAncho(window.innerWidth); }
    window.addEventListener('resize', r); return function(){ window.removeEventListener('resize', r); };
  }, []);
  // Ventana angosta (la minima de la app es 1.000 px): la lista ocupa todo y el panel se abre encima.
  var superpuesto = ancho < 1100;

  var filas = bandejaCobro(loans, pays, hoy).filter(function(f){ return !q || payMatchesQuery(f.p, q); });
  var tot = {};
  CBV_TRAMOS.forEach(function(t){ tot[t[0]] = { n: 0, cop: 0, deudores: {} }; });
  filas.forEach(function(f){ var t = tot[f.tramo]; t.n++; t.cop += f.pend; t.deudores[f.p.nombreCliente] = 1; });
  var visibles = filas.filter(function(f){ return tramo === 'todo' || f.tramo === tramo; });

  function elegir(f){ setSel({ nombre: f.l.nombre, loanId: f.l.id, payId: f.p.id }); }
  function avatar(nombre, tono){ return h('span', { className: 'cbv-av' + (tono ? ' ' + tono : '') }, opIniciales(nombre)); }
  function fila(f, enGrupo, i){
    var p = f.p, l = f.l, on = sel && sel.payId === p.id, parcial = (p.partialPaid || 0) > 0;
    var tono = f.tramo === 'vencido' ? 'crit' : f.tramo === 'hoy' ? 'warn' : '';
    var vence = h('div', { className: 'cbv-vence' },
      h('div', null, opCorta(p.fechaPago)),
      f.tramo === 'vencido'
        ? h('div', { className: 's crit' }, cbvPl(-f.dias, 'día') + ' de mora')
        : h('div', { className: 's' + (f.tramo === 'hoy' ? ' warn' : '') }, opRel(hoy, p.fechaPago)));
    return h('div', { key: p.id, className: 'cbv-fila' + (on ? ' on' : '') + (enGrupo ? ' en-grupo' : ''), style: { '--i': i || 0 }, onClick: function(){ elegir(f); } },
      enGrupo
        ? h('div', { className: 'cbv-quien' }, h('span', { className: 'cbv-guia' }), h('span', { className: 'cbv-cuota-n' }, 'Cuota ' + p.cuotaN + (l.modalidad === 'Intereses' ? '' : ' de ' + l.plazoMeses)))
        : h('div', { className: 'cbv-quien' },
            avatar(p.nombreCliente, tono),
            h('div', { className: 'cbv-quien-c' },
              h('div', { className: 'cbv-nombre' }, properCase(p.nombreCliente)),
              h('div', { className: 'cbv-sub' }, opModalidad(l.modalidad, true) + (l.moneda === 'USD' ? ' · USD' : '') + ' · cuota ' + p.cuotaN + (l.modalidad === 'Intereses' ? '' : ' de ' + l.plazoMeses)))),
      vence,
      h('div', { className: 'cbv-monto' },
        h('div', { className: 'v' + (f.tramo === 'vencido' ? ' crit' : '') }, fmt(f.pend)),
        cbvUsd(l, f.pend),
        parcial && h('div', { className: 'cbv-sub info' }, 'ya abonó ' + fmt(p.partialPaid))),
      h('div', { className: 'cbv-acc', onClick: function(e){ e.stopPropagation(); } },
        h('button', { className: 'cbv-icono', title: 'Factura de cobro (PDF) para enviarle', onClick: function(){ generateFacturaCobro(p, l, pays, props.datosPago); } }, h(Ico, { name: 'receipt', size: 15, sw: 2 })),
        h('button', { className: 'v4-btn ghost sm cbv-pago', title: 'Registrar el pago de esta cuota', onClick: function(){ props.onPay(p); } }, h(Ico, { name: 'check', size: 14, sw: 2.6 }), 'Pagó')));
  }
  // Lo vencido se agrupa por credito: si alguien debe tres cuotas, se ve como UNA deuda y se cobra de
  // una vez con el cobro en cascada. Con 2 o mas cuotas el grupo es un ACORDEON plegado (decision del
  // PO): la fila dice cuantas cuotas, cuanto suman y los dias de la mas vieja.
  // Dos clics distintos (ajuste del PO en la integracion): el chevron SOLO pliega o despliega las
  // cuotas; el resto de la fila abre al deudor en el panel. El chevron es un boton propio y no deja
  // que su clic llegue a la fila. Lo que el usuario eligio con el chevron (abierto o cerrado) manda;
  // sin eleccion, el grupo se abre solo si la cuota elegida esta adentro.
  function grupos(fs){
    var porLoan = {}, orden = [];
    fs.forEach(function(f){ if (!porLoan[f.l.id]){ porLoan[f.l.id] = []; orden.push(f.l.id); } porLoan[f.l.id].push(f); });
    return orden.map(function(id, gi){
      var g = porLoan[id], l = g[0].l, total = g.reduce(function(s, f){ return s + f.pend; }, 0);
      if (g.length === 1) return fila(g[0], false, gi);
      var on = sel && sel.loanId === id;
      var abierto = abiertos[id] !== undefined ? !!abiertos[id] : !!(on && sel.payId && g.some(function(f){ return f.p.id === sel.payId; }));
      function alternar(e){
        e.stopPropagation();
        var x = Object.assign({}, abiertos); x[id] = !abierto; setAbiertos(x);
      }
      function verDeudor(){ setSel({ nombre: l.nombre, loanId: l.id, payId: null }); }
      return h('div', { key: 'g' + id, className: 'cbv-grupo' + (on ? ' on' : '') + (abierto ? ' abierto' : ''), style: { '--i': gi } },
        h('div', { className: 'cbv-fila cbv-grupo-h', title: 'Ver a ' + properCase(l.nombre) + ' en el panel', onClick: verDeudor },
          h('div', { className: 'cbv-quien' },
            h('button', { type: 'button', className: 'cbv-chev', 'aria-expanded': abierto, title: abierto ? 'Ocultar las cuotas' : 'Ver las cuotas una por una', onClick: alternar },
              h(Ico, { name: 'chevright', size: 14, sw: 2.4 })),
            avatar(l.nombre, 'crit'),
            h('div', { className: 'cbv-quien-c' },
              h('div', { className: 'cbv-nombre' }, properCase(l.nombre)),
              h('div', { className: 'cbv-sub' }, opModalidad(l.modalidad, true) + (l.moneda === 'USD' ? ' · USD' : '') + ' · ' + g.length + ' cuotas vencidas'))),
          h('div', { className: 'cbv-vence' }, h('div', { className: 'crit' }, cbvPl(-g[0].dias, 'día') + ' de mora'), h('div', { className: 's' }, 'la más vieja')),
          h('div', { className: 'cbv-monto' }, h('div', { className: 'v crit' }, fmt(total)), cbvUsd(l, total)),
          h('div', { className: 'cbv-acc', onClick: function(e){ e.stopPropagation(); } },
            // El recibo de cobro general es del DEUDOR, no de este credito (decision del PO).
            h('button', { className: 'cbv-icono', title: 'Recibo de cobro general (PDF): toda su deuda vencida y sus opciones de pago', onClick: function(){
              generateReciboGeneral(loans.filter(function(x){ return x.nombre === l.nombre; }), pays, props.datosPago, { hasta: hoy }); } },
              h(Ico, { name: 'clipboard', size: 15, sw: 2 })),
            h('button', { className: 'v4-btn pri sm', title: 'Cobrar lo que entregue, en cascada: intereses vencidos, capital vencido y abono', onClick: function(){ props.acciones.onCobro(l); } },
              h(Ico, { name: 'dollar', size: 14, sw: 2.4 }), 'Cobrar'))),
        abierto && h('div', { className: 'cbv-grupo-cuotas' }, g.map(function(f, k){ return fila(f, true, k); })));
    });
  }

  var secciones = CBV_TRAMOS.filter(function(t){ return tramo === 'todo' || tramo === t[0]; }).map(function(t, si){
    var fs = visibles.filter(function(f){ return f.tramo === t[0]; });
    if (!fs.length) return null;
    var n = Object.keys(tot[t[0]].deudores).length;
    return h('section', { key: t[0], className: 'v4-card cbv-sec t-' + t[0], style: { '--i': si + 2 } },
      h('div', { className: 'cbv-sec-h' },
        h('span', { className: 'cbv-dot ' + t[2] }),
        h('span', { className: 'cbv-sec-t' }, t[1]),
        h('span', { className: 'cbv-sec-n' }, cbvPl(fs.length, 'cuota') + ' · ' + cbvPl(n, 'deudor', 'deudores')),
        h('span', { className: 'cbv-sec-v' + (t[0] === 'vencido' ? ' crit' : '') }, h(V4Dinero, { v: tot[t[0]].cop }))),
      h('div', { className: 'cbv-filas' },
        t[0] === 'vencido' ? grupos(fs)
          // Lo de mas de 30 dias no es trabajo de hoy: plegado, a un clic, para no alargar la bandeja.
          : t[0] === 'despues' && tramo === 'todo' && !verDespues
            ? h('button', { className: 'cbv-mas', onClick: function(){ setVerDespues(true); } },
                'Mostrar las ' + fs.length + ' cuotas que vencen después de 30 días', h(Ico, { name: 'chevdown', size: 14, sw: 2.4 }))
            : fs.map(function(f, i){ return fila(f, false, i); })));
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
        var tipo, tono;
        if (esCorte(p)){ tipo = 'Corte de interés'; tono = 'info'; }
        else if (esAbono(p)){ tipo = /liquidaci/i.test(p.observaciones || '') ? 'Liquidación' : 'Abono a capital'; tono = 'info'; }
        else if (p.estadoPago !== 'Pagado'){ tipo = 'Abono parcial · cuota ' + p.cuotaN; tono = 'warn'; }
        else { tipo = 'Cuota ' + p.cuotaN + (evs.length > 1 && k === evs.length - 1 ? ' · pago final' : evs.length > 1 ? ' · abono' : ''); tono = 'good'; }
        eventos.push({ p: p, l: l, e: e, tipo: tipo, tono: tono });
      });
    });
    eventos.sort(function(a, b){ return b.e.fecha.localeCompare(a.e.fecha) || String(b.p.paidAt || '').localeCompare(String(a.p.paidAt || '')); });
  }
  // caja = intereses + capital + efecto TRM, evento por evento (imputarCobros). El efecto se muestra
  // aparte: sin el, las dos primeras cifras no suman lo que entro.
  var totCob = eventos.reduce(function(a, x){ a.cop += x.e.cop; a.int += x.e.interes; a.cap += x.e.capital; a.aj += (x.e.ajuste || 0); return a; }, { cop: 0, int: 0, cap: 0, aj: 0 });
  var nombreMes = OP_MESES[+mes.slice(5, 7) - 1];

  var lista = null;
  if (modo === 'cobrado'){
    var bloques = [], ult = null;
    eventos.forEach(function(x, i){
      if (x.e.fecha !== ult){ ult = x.e.fecha; var dd = opFecha(x.e.fecha);
        var delDia = eventos.filter(function(y){ return y.e.fecha === x.e.fecha; }).reduce(function(s, y){ return s + y.e.cop; }, 0);
        bloques.push(h('div', { key: 'd' + x.e.fecha, className: 'cbv-dia' },
          h('span', null, (x.e.fecha === hoy ? 'Hoy · ' : '') + OP_DIAS[dd.getDay()] + ' ' + dd.getDate() + ' de ' + OP_MESES[dd.getMonth()]), h('b', null, fmt(delDia)))); }
      var on = sel && sel.loanId === x.l.id;
      var ico = x.tono === 'good' ? 'check' : x.tono === 'warn' ? 'receipt' : esCorte(x.p) ? 'clock' : 'dollar';
      bloques.push(h('div', { key: x.p.id + i, className: 'cbv-fila cobrada' + (on ? ' on' : ''), style: { '--i': i }, onClick: function(){ setSel({ nombre: x.l.nombre, loanId: x.l.id, payId: x.p.id }); } },
        h('div', { className: 'cbv-quien' }, h('span', { className: 'cbv-ico' }, h(Ico, { name: ico, size: 14, sw: 2.3 })),
          h('div', { className: 'cbv-quien-c' }, h('div', { className: 'cbv-nombre' }, properCase(x.p.nombreCliente)),
            h('div', { className: 'cbv-sub' }, h('span', { className: 'v4-tag ' + x.tono }, x.tipo), x.l.moneda === 'USD' ? ' USD' : ''))),
        h('div', { className: 'cbv-split' },
          x.e.interes > 0 && h('span', null, 'interés ', h('b', null, fmt(x.e.interes))),
          x.e.capital > 0 && h('span', null, 'capital ', h('b', null, fmt(x.e.capital)))),
        h('div', { className: 'cbv-monto' }, h('div', { className: 'v good' }, '+ ' + fmt(x.e.cop)),
          x.l.moneda === 'USD' && (x.p.montoUSDRecibido > 0 && eventos.filter(function(y){ return y.p.id === x.p.id; }).length === 1
            ? usdLinea(fmtUSD(x.p.montoUSDRecibido)) : cbvUsd(x.l, x.e.cop))),
        h('div', { className: 'cbv-acc' })));
    });
    lista = bloques.length
      ? h('section', { key: 'cob' + mes, className: 'v4-card cbv-sec cbv-cobrado', style: { '--i': 2 } }, h('div', { className: 'cbv-filas' }, bloques))
      : h('div', { className: 'v4-card cbv-vacio' }, h('span', { className: 'ok' }, h(Ico, { name: 'clock', size: 16, sw: 2.2 })), 'No entró dinero en ' + nombreMes + '.');
  }

  // ── Encabezado: la cifra, la barra y los tramos (o el resumen de la caja del mes) ─────────
  var totalPend = filas.reduce(function(s, f){ return s + f.pend; }, 0);
  var nDeud = Object.keys(filas.reduce(function(a, f){ a[f.p.nombreCliente] = 1; return a; }, {})).length;
  var dHoy = opFecha(hoy);
  var hero = modo === 'cobrar'
    ? h('section', { className: 'v4-card cbv-hero', style: { '--i': 0 } },
        h('div', { className: 'cbv-hero-top' },
          h('div', null,
            h('div', { className: 'cbv-kl' }, 'Por cobrar'),
            h('div', { className: 'cbv-hero-v' }, h(V4Dinero, { v: totalPend, animar: true })),
            h('div', { className: 'cbv-hero-s' }, cbvPl(filas.length, 'cuota') + ' de ' + cbvPl(nDeud, 'deudor', 'deudores') + (q ? ' · filtrado por "' + q + '"' : ''))),
          h(CbvSeg, { valor: modo, onChange: setModo, opciones: [['cobrar', 'Por cobrar'], ['cobrado', 'Cobrado']] })),
        h(CbvSegbar, { activo: tramo === 'todo' ? null : tramo, onClick: function(k){ setTramo(tramo === k ? 'todo' : k); },
          partes: CBV_TRAMOS.map(function(t){ return { k: t[0], l: t[1], tono: t[2], v: tot[t[0]].cop, d: cbvPl(tot[t[0]].n, 'cuota') }; }) }),
        h('div', { className: 'cbv-tramos' }, CBV_TRAMOS.map(function(t){
          var on = tramo === t[0], v = tot[t[0]];
          return h('button', { key: t[0], className: 'cbv-tramo' + (on ? ' on' : '') + (v.n ? '' : ' vacio'), 'aria-pressed': on, title: on ? 'Ver todos los tramos' : 'Ver solo ' + t[1].toLowerCase(),
              onClick: function(){ setTramo(on ? 'todo' : t[0]); } },
            h('div', { className: 'l' }, h('span', { className: 'cbv-dot ' + t[2] }), t[1], on && h(Ico, { name: 'x', size: 12, sw: 2.6 })),
            h('div', { className: 'v' + (t[0] === 'vencido' && v.n ? ' crit' : '') }, h(V4Dinero, { v: v.cop })),
            h('div', { className: 's' }, v.n ? cbvPl(v.n, 'cuota') : 'nada'));
        })))
    : h('section', { className: 'v4-card cbv-hero', style: { '--i': 0 } },
        h('div', { className: 'cbv-hero-top' },
          h('div', null,
            h('div', { className: 'cbv-kl' }, 'Entró en caja'),
            h('div', { className: 'cbv-hero-v good' }, h(V4Dinero, { v: totCob.cop, animar: true })),
            h('div', { className: 'cbv-hero-s' }, cbvPl(eventos.length, 'movimiento') + ' en ' + nombreMes + ' ' + mes.slice(0, 4))),
          h('div', { className: 'cbv-hero-der' },
            h('div', { className: 'v4-mesnav' },
              h('button', { onClick: function(){ setMes(cbvMes(mes, -1)); }, title: 'Mes anterior' }, h(Ico, { name: 'chevleft', size: 14, sw: 2.4 })),
              h('span', null, nombreMes + ' ' + mes.slice(0, 4)),
              h('button', { onClick: function(){ setMes(cbvMes(mes, 1)); }, title: 'Mes siguiente' }, h(Ico, { name: 'chevright', size: 14, sw: 2.4 }))),
            h(CbvSeg, { valor: modo, onChange: setModo, opciones: [['cobrar', 'Por cobrar'], ['cobrado', 'Cobrado']] }))),
        h(CbvSegbar, { key: 'sb' + mes, partes: [
          { k: 'int', l: 'Intereses', tono: 'good', v: totCob.int },
          { k: 'cap', l: 'Capital devuelto', tono: 'muted', v: totCob.cap }] }),
        h('div', { className: 'cbv-tramos cbv-caja' },
          h('div', { className: 'cbv-tramo quieto' }, h('div', { className: 'l' }, h('span', { className: 'cbv-dot good' }), 'De eso, intereses'), h('div', { className: 'v' }, h(V4Dinero, { v: totCob.int }))),
          h('div', { className: 'cbv-tramo quieto' }, h('div', { className: 'l' }, h('span', { className: 'cbv-dot muted' }), 'Capital devuelto'), h('div', { className: 'v' }, h(V4Dinero, { v: totCob.cap }))),
          Math.abs(totCob.aj) > 5 && h('div', { className: 'cbv-tramo quieto' }, h('div', { className: 'l' }, h('span', { className: 'cbv-dot ' + (totCob.aj < 0 ? 'crit' : 'good') }), 'Efecto TRM'),
            h('div', { className: 'v ' + (totCob.aj < 0 ? 'crit' : 'good') }, (totCob.aj < 0 ? '- ' : '+ '), h(V4Dinero, { v: Math.abs(totCob.aj) })),
            h('div', { className: 's' }, 'dólares cobrados a otra TRM')),
          h('div', { className: 'cbv-tramo quieto' }, h('div', { className: 'l' }, h('span', { className: 'cbv-dot track' }), 'Movimientos'), h('div', { className: 'v' }, eventos.length))));

  // ── Panel lateral ─────────────────────────────────────────────────────────────
  var deudorSel = sel ? props.deudores.filter(function(d){ return d.nombre === sel.nombre; })[0] : null;
  var acciones = props.acciones;
  var panel = deudorSel
    ? h(DeudorPanel, Object.assign({ key: sel.nombre + '|' + sel.loanId, deudor: deudorSel, loans: loans, pays: pays, hoy: hoy, focoLoan: sel.loanId, focoPay: sel.payId,
        onClose: function(){ setSel(null); }, superpuesto: superpuesto, datosPago: props.datosPago, showToast: props.showToast, onPay: props.onPay }, acciones))
    : !superpuesto && h('aside', { className: 'v4-card cbv-lado', style: { '--i': 1 } },
        h('div', { className: 'cbv-lado-h' }, h('div', { className: 'v4-titulo' }, 'Tu día de cobro'), h(V4Chip, { tono: tot.hoy.n ? 'warn' : 'good' }, tot.hoy.n ? cbvPl(tot.hoy.n, 'cuota') + ' hoy' : 'Nada vence hoy')),
        h('div', { className: 'cbv-kl' }, 'Para cobrar hoy'),
        h('div', { className: 'cbv-lado-v' }, h(V4Dinero, { v: tot.hoy.cop, animar: true })),
        h('div', { className: 'cbv-lado-filas' },
          h('div', { className: 'cbv-lado-f' }, h('span', null, h('span', { className: 'cbv-dot crit' }), 'Vencido'), h('b', { className: tot.vencido.cop ? 'crit' : '' }, fmt(tot.vencido.cop))),
          h('div', { className: 'cbv-lado-f' }, h('span', null, h('span', { className: 'cbv-dot info' }), 'Próximos 7 días'), h('b', null, fmt(tot.semana.cop))),
          h('div', { className: 'cbv-lado-f' }, h('span', null, h('span', { className: 'cbv-dot muted' }), 'Resto del mes'), h('b', null, fmt(tot.mes.cop)))),
        h('div', { className: 'cbv-lado-tip' }, h(Ico, { name: 'sparkle', size: 15, sw: 2 }),
          h('span', null, 'Toca una cuota para ver al deudor aquí al lado, con su cronograma y todas sus acciones, sin salir de la lista. ', h('b', null, 'Pagó'), ' registra esa cuota; ', h('b', null, 'Cobrar'), ' reparte lo que te entregue en cascada.')));

  return h('div', { className: 'op v4c v4p' + (sel ? ' con-panel' : '') + (anima ? ' anima' : '') },
    h('div', { className: 'op-main' },
      h('div', { className: 'cbv-fecha' }, OP_DIAS[dHoy.getDay()] + ' ' + dHoy.getDate() + ' de ' + OP_MESES[dHoy.getMonth()]),
      hero,
      h('div', { className: 'cbv-buscar', style: { '--i': 1 } }, h(Ico, { name: 'search', size: 16, sw: 2 }),
        h('input', { value: q, onChange: function(e){ setQ(e.target.value); }, placeholder: 'Buscar por nombre o código de factura (FC-…)' }),
        q && h('button', { className: 'cbv-icono plano', title: 'Borrar la búsqueda', onClick: function(){ setQ(''); } }, h(Ico, { name: 'x', size: 13, sw: 2.4 }))),
      modo === 'cobrar'
        ? (secciones.length ? h('div', { className: 'cbv-lista', key: 'l' + tramo }, secciones)
            : h('div', { className: 'v4-card cbv-vacio' }, h('span', { className: 'ok' }, h(Ico, { name: 'check', size: 16, sw: 2.6 })), q ? 'Nada coincide con la búsqueda.' : 'No hay nada por cobrar en este tramo.'))
        : lista),
    panel && h('div', { className: 'op-lado' + (superpuesto ? ' superpuesto' : '') }, panel));
}
