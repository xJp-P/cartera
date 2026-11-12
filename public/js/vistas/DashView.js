// public/js/vistas/DashView.js — Resumen: el centro de mando de la cartera.
//
// Historia: 3.4.0 reemplazo al Inicio de cuatro tarjetas por una rejilla de 12 columnas; 3.7.0 (decision
// del PO) mudo el "Analisis del negocio" -flujo de caja y composicion del capital- a Rendimiento, que lo
// importa de aqui (`RzFlujo`, `RzComposicion`, `modeloResumen`); 3.7.1 fue el Resumen hibrido.
//
// REDISEÑO v4 (aprobado por el PO sobre el prototipo, integrado pestaña por pestaña): el sistema de
// diseño de Control TC v7 (paleta, Inter, tarjetas, chips, pastillas, cifras con el "$" pequeño y
// entradas animadas). Las piezas estan en el bloque "EL RESUMEN v4", mas abajo; sus estilos, en
// public/css/resumen.css (`.v4-*`), sobre la base global de public/css/base.css.
//
// Todas las cifras salen de los helpers del dominio (cobrosDe, imputarCobros, gananciaDe, pendCuota,
// estadoDiario) agregados en `modeloResumen`, `rzMetaDelMes` y `rzParaCobrar`: ninguna formula nueva de
// dinero. Lo unico nuevo del rediseño es la COMPARACION con el mismo tramo del mes anterior (los mismos
// eventos de caja y de ganancia, filtrados del dia 1 al de hoy del mes pasado) y la rentabilidad de la
// cartera, que es la cifra de Rendimiento. Los nombres de nivel superior llevan prefijo rz/Rz/RZ_/v4/V4
// porque el arnes de pruebas aplana todos los modulos en un solo ambito y un nombre repetido lo romperia.

import { Ico } from '../componentes/iconos.js';
import { cobrosDe, imputarCobros, pendCuota, esDiario, estadoDiario, gananciaDe, diasEntre } from '../core/dominio.js';
import { copToUsd, fmt, fmtD, fmtUSD } from '../core/format.js';
import { h, useEffect, useMemo, useRef, useState } from '../core/react.js';
import { nowStr, properCase } from '../core/ui.js';
import { bandejaCobro, opIniciales } from '../core/operacion.js';
import { esAbono, esCorte, esCuotaRegular } from '../core/ids.js';
import { usdLinea } from '../componentes/CifraUSD.js';

var RZ_MESES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
var RZ_MES3 = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
var RZ_DIAS = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
var RZ_PALETA = ['var(--green)','var(--blue)','var(--purple)','var(--yellow)','#db6d28','#39c5cf','var(--text3)'];

// ── utilidades ────────────────────────────────────────────────────────────────
function rzFecha(iso){ return new Date(iso + 'T12:00:00'); }
function rzYm(iso){ return String(iso).slice(0, 7); }
function rzMesDe(key){ return RZ_MESES[parseInt(key.slice(5, 7), 10) - 1]; }
function rzMesMover(key, delta){ var d = new Date(parseInt(key.slice(0, 4), 10), parseInt(key.slice(5, 7), 10) - 1 + delta, 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
function rzOrigCOP(l){ return l.moneda === 'USD' ? Math.round(l.montoOrigen * l.trmAcordada) : Math.round(l.montoOrigen); }
function rzCompacto(n){
  var a = Math.abs(n || 0), s = n < 0 ? '-' : '';
  if (a >= 1e9) return s + '$' + (a / 1e9).toFixed(1).replace('.', ',') + ' MM';
  if (a >= 1e6) return s + '$' + (a / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace('.', ',') + ' M';
  if (a >= 1e3) return s + '$' + Math.round(a / 1e3) + ' k';
  return s + '$' + Math.round(a);
}
function rzRel(hoy, iso){
  var d = diasEntre(hoy, iso);
  if (d === 0) return 'hoy'; if (d === 1) return 'mañana'; if (d === -1) return 'ayer';
  return d > 0 ? 'en ' + d + ' días' : 'hace ' + (-d) + ' días';
}
function rzUsd(l, cop){ return l && l.moneda === 'USD' ? copToUsd(cop, l.trmAcordada) : null; }
function rzPl(n, s, p){ return n + ' ' + (n === 1 ? s : (p || s + 's')); }
// La modalidad se guarda sin tildes (es un valor interno que comparan backend y frontend); aqui
// solo se ROTULA con la ortografia completa de la pestaña. Nunca reescribir el dato.
var RZ_MODALIDAD = { 'Capital + Intereses': 'Capital + Intereses', 'Intereses': 'Intereses', 'Prestamo': 'Préstamo',
  'Pago Unico': 'Pago único', 'Interes Diario': 'Interés diario' };
function rzModalidad(m){ return RZ_MODALIDAD[m] || m; }

// ── el modelo: todo lo que la pantalla necesita, en una pasada ───────────────────
export function modeloResumen(loans, pays, hoy){
  var loanMap = {}, paysPor = {};
  loans.forEach(function(l){ loanMap[l.id] = l; });
  pays.forEach(function(p){ (paysPor[p.prestamoId] = paysPor[p.prestamoId] || []).push(p); });
  var activos = loans.filter(function(l){ return l.estado === 'Activo'; });

  var por = activos.map(function(l){
    var lp = paysPor[l.id] || [];
    var orig = rzOrigCOP(l);
    var capImp = lp.reduce(function(a, p){ return a + imputarCobros(p).totales.capital; }, 0);
    var vivo = Math.max(0, orig - Math.round(capImp));
    var reg = lp.filter(esCuotaRegular);
    var mora = reg.filter(function(p){ return p.estadoPago === 'En Mora'; });
    var moraMonto = mora.reduce(function(s, p){ return s + pendCuota(p); }, 0);
    var masVieja = mora.map(function(p){ return p.fechaPago; }).sort()[0];
    var prox = reg.filter(function(p){ return p.estadoPago === 'Pendiente'; })
      .sort(function(a, b){ return a.fechaPago.localeCompare(b.fechaPago) || a.cuotaN - b.cuotaN; })[0] || null;
    var dev = esDiario(l) ? estadoDiario(l, lp, hoy).interesPendiente : 0;
    var dProx = prox ? diasEntre(hoy, prox.fechaPago) : null;
    var estado = mora.length ? 'mora' : (prox && dProx === 0) ? 'hoy' : (prox && dProx <= 7) ? 'semana' : esDiario(l) ? 'abierto' : 'aldia';
    return { loan: l, nombre: l.nombre, orig: orig, vivo: vivo, pct: orig > 0 ? Math.round((1 - vivo / orig) * 100) : 0,
      moraN: mora.length, moraMonto: moraMonto, diasMora: masVieja ? diasEntre(masVieja, hoy) : 0,
      prox: prox, dProx: dProx, parcial: reg.some(function(p){ return p.estadoPago !== 'Pagado' && (p.partialPaid || 0) > 0; }),
      dev: dev, estado: estado };
  });

  // Mora agrupada por deudor: cuantos deudores tienen mora (la frase del encabezado).
  var moraPor = {};
  pays.forEach(function(p){
    if (!esCuotaRegular(p) || p.estadoPago !== 'En Mora') return;
    var l = loanMap[p.prestamoId]; if (!l || l.estado !== 'Activo') return;
    var g = moraPor[p.nombreCliente] = moraPor[p.nombreCliente] || { nombre: p.nombreCliente, total: 0, n: 0, vieja: p.fechaPago, usd: l.moneda === 'USD' };
    g.total += pendCuota(p); g.n++; if (p.fechaPago < g.vieja) g.vieja = p.fechaPago;
  });
  var moraGrupos = Object.keys(moraPor).map(function(k){ return moraPor[k]; }).sort(function(a, b){ return a.vieja.localeCompare(b.vieja); });

  // Caja, ganancia y proyeccion por mes (12 hacia atras + 3 hacia adelante).
  var mesHoy = rzYm(hoy);
  var porMes = {};
  function mm(k){ return porMes[k] = porMes[k] || { caja: 0, interes: 0, ganancia: 0, proy: 0, cajaDia: {} }; }
  var recientes = [];
  pays.forEach(function(p){
    var l = loanMap[p.prestamoId];
    imputarCobros(p).eventos.forEach(function(e){
      var m = mm(rzYm(e.fecha)); m.caja += e.cop; m.interes += e.interes;
      if (rzYm(e.fecha) === mesHoy) m.cajaDia[e.fecha] = (m.cajaDia[e.fecha] || 0) + e.cop;
    });
    gananciaDe(p, l && l.moneda === 'USD').eventos.forEach(function(e){ mm(rzYm(e.fecha)).ganancia += e.ganancia; });
    if (esCuotaRegular(p) && p.estadoPago !== 'Pagado' && rzYm(p.fechaPago) >= mesHoy) mm(rzYm(p.fechaPago)).proy += pendCuota(p);
    var evs = cobrosDe(p);
    evs.forEach(function(e, k){ recientes.push({ pay: p, loan: l, fecha: e.fecha, cop: e.cop, k: k, n: evs.length }); });
  });
  recientes.sort(function(a, b){ return b.fecha.localeCompare(a.fecha) || String(b.pay.paidAt || '').localeCompare(String(a.pay.paidAt || '')); });

  var meses = [];
  for (var i = -11; i <= 3; i++){
    var k = rzMesMover(mesHoy, i), m = mm(k);
    meses.push({ key: k, label: RZ_MES3[parseInt(k.slice(5, 7), 10) - 1], anio: k.slice(0, 4), caja: Math.round(m.caja),
      interes: Math.round(m.interes), capital: Math.max(0, Math.round(m.caja - m.interes)), ganancia: Math.round(m.ganancia),
      proy: i >= 0 ? Math.round(m.proy) : 0, futuro: i > 0, actual: i === 0 });
  }
  // Cobrado acumulado dia a dia en el mes en curso (la curva del KPI).
  var dHoy = parseInt(hoy.slice(8, 10), 10), acum = 0, curva = [];
  for (var d = 1; d <= dHoy; d++){ acum += mm(mesHoy).cajaDia[mesHoy + '-' + String(d).padStart(2, '0')] || 0; curva.push(acum); }

  return { loanMap: loanMap, activos: activos, por: por, moraGrupos: moraGrupos, meses: meses, curva: curva, recientes: recientes,
    vivo: por.reduce(function(s, x){ return s + x.vivo; }, 0), prestado: por.reduce(function(s, x){ return s + x.orig; }, 0),
    devengo: por.reduce(function(s, x){ return s + x.dev; }, 0), abiertos: por.filter(function(x){ return esDiario(x.loan); }).length,
    movMes: recientes.filter(function(e){ return rzYm(e.fecha) === mesHoy; }).length,
    gananciaMes: Math.round(mm(mesHoy).ganancia), ganancia12: meses.slice(0, 12).reduce(function(s, x){ return s + x.ganancia; }, 0),
    deudoresMora: moraGrupos.length, diasMoraMax: moraGrupos.length ? diasEntre(moraGrupos[0].vieja, hoy) : 0 };
}

// ── piezas pequenas ─────────────────────────────────────────────────────────────
function RzCard(p){
  return h('section', { className: 'rz-card ' + (p.className || ''), style: p.style },
    (p.titulo || p.acciones) && h('div', { className: 'rz-head' },
      h('div', { style: { minWidth: 0 } },
        h('div', { className: 'rz-title' }, p.icono && h(Ico, { name: p.icono, size: 16, color: p.color || 'var(--text2)', sw: 2.2 }), p.titulo),
        p.sub && h('div', { className: 'rz-sub' }, p.sub)),
      p.acciones),
    h('div', { className: 'rz-body', style: p.bodyStyle }, p.children));
}
function RzSeg(p){
  return h('div', { className: 'rz-seg' }, p.opciones.map(function(o){
    return h('button', { key: o[0], className: p.valor === o[0] ? 'on' : '', onClick: function(){ p.onCambio(o[0]); } }, o[1]);
  }));
}

// ── POR COBRAR: lo vencido y lo de hoy, y lo que entra esta semana ───────────────
// Sale de `bandejaCobro` (la de Cobros): cuotas del cronograma de prestamos activos, sin pagar, con lo
// que falta de cada una (`pendCuota`). "Esta semana" muestra hasta RZ_PC_MAX cuotas y anuncia el resto.
var RZ_PC_MAX = 6;
// "Para cobrar ya": lo vencido y lo de hoy, UNA fila por persona, la mora mas vieja primero.
function rzParaCobrar(filas, hoy){
  var por = {};
  filas.forEach(function(f){
    if (f.tramo !== 'vencido' && f.tramo !== 'hoy') return;
    var g = por[f.l.nombre] = por[f.l.nombre] || { nombre: f.l.nombre, loanId: f.l.id, total: 0, venc: 0, hoyN: 0, vieja: null, usd: 0, todoUSD: true };
    g.total += f.pend;
    if (f.tramo === 'vencido'){ g.venc++; if (!g.vieja || f.p.fechaPago < g.vieja) g.vieja = f.p.fechaPago; }
    else g.hoyN++;
    if (f.l.moneda === 'USD' && f.l.trmAcordada > 0) g.usd += f.pend / f.l.trmAcordada; else g.todoUSD = false;
  });
  return Object.keys(por).map(function(k){ var g = por[k]; g.dias = g.vieja ? diasEntre(g.vieja, hoy) : 0; return g; })
    .sort(function(a, b){ return b.dias - a.dias || b.total - a.total; });
}

// ── META DEL MES ─────────────────────────────────────────────────────────────────
// La meta de un mes: lo que VENCE en el mes frente a lo que ya entro (regla "Recaudo del mes",
// v1.9.2). Solo cuotas del cronograma (`esCuotaRegular`): ni abonos ni CORTES de interes diario.
// Hasta 3.3.0 la tarjeta del Inicio excluia solo los abonos, asi que un corte —un evento ya
// consumado, no una cuota que vence— se sumaba a la vez a la meta y a lo recibido y el porcentaje
// salia distinto del de "Cobros del Mes", que si lo excluia (medido en el fixture: 123% contra 125%).
function rzMetaDelMes(pays, mes){
  var deMes = pays.filter(function(x){ return esCuotaRegular(x) && x.fechaPago.slice(0, 7) === mes; });
  var esperado = deMes.reduce(function(s, x){ return s + x.cuotaTotal; }, 0);
  var aTiempo = 0, moraRec = 0;
  pays.forEach(function(x){
    if (!esCuotaRegular(x) || x.estadoPago !== 'Pagado' || !x.fechaRecaudo || x.fechaRecaudo.slice(0, 7) !== mes) return;
    var v = x.montoCOPRecibido || x.cuotaTotal;
    if (x.fechaPago.slice(0, 7) === mes) aTiempo += v; else moraRec += v;
  });
  var parciales = deMes.reduce(function(s, x){ return x.estadoPago !== 'Pagado' ? s + (x.partialPaid || 0) : s; }, 0);
  var pend = deMes.filter(function(x){ return x.estadoPago !== 'Pagado'; }).sort(function(a, b){ return a.fechaPago.localeCompare(b.fechaPago); });
  return { esperado: esperado, cobrado: aTiempo + parciales, moraRec: moraRec, pend: pend,
    falta: pend.reduce(function(s, x){ return s + pendCuota(x); }, 0) };
}

// ── ANALISIS DEL NEGOCIO (vive en Rendimiento desde 3.7.0, que lo importa de aqui) ──────
// 1. FLUJO DE CAJA: 12 meses de historia + 3 de proyeccion
function rzTopeEje(max){
  if (max <= 0) return 1;
  var p = Math.pow(10, Math.floor(Math.log10(max))), steps = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
  for (var i = 0; i < steps.length; i++) if (steps[i] * p >= max) return steps[i] * p;
  return 10 * p;
}
export function RzFlujo(p){
  var ref = useRef(null);
  var _w = useState(760); var W = _w[0], setW = _w[1];
  var _h = useState(null); var hov = _h[0], setHov = _h[1];
  var _m = useState('caja'); var modo = _m[0], setModo = _m[1];
  useEffect(function(){
    if (!ref.current || typeof ResizeObserver === 'undefined') return;
    var ro = new ResizeObserver(function(es){ var w = Math.round(es[0].contentRect.width); if (w > 0) setW(w); });
    ro.observe(ref.current);
    return function(){ ro.disconnect(); };
  }, []);
  var meses = p.M.meses, H = 240, pl = 58, pr = 10, pt = 14, pb = 30;
  var alto = function(m){ return modo === 'caja' ? m.caja + m.proy : m.ganancia; };
  var tope = rzTopeEje(Math.max.apply(null, meses.map(alto).concat([1])));
  // Acotado a 0: con el menu abierto en un telefono el contenedor llega a medir menos que los
  // margenes del eje, y un ancho negativo es un <rect> invalido (error en consola).
  var n = meses.length, slot = Math.max(0, (W - pl - pr) / n), bw = Math.min(40, slot * .62);
  var y = function(v){ return pt + (H - pt - pb) * (1 - v / tope); };
  var hist = meses.slice(0, 12);
  var tCaja = hist.reduce(function(s, m){ return s + m.caja; }, 0), tInt = hist.reduce(function(s, m){ return s + m.interes; }, 0);
  var tGan = hist.reduce(function(s, m){ return s + m.ganancia; }, 0), tProy = meses.slice(12).reduce(function(s, m){ return s + m.proy; }, 0) + meses[11].proy;
  var mejor = hist.slice().sort(function(a, b){ return b.caja - a.caja; })[0];
  var grid = [0, .25, .5, .75, 1].map(function(f){ return f * tope; });
  var els = [];
  grid.forEach(function(v, i){
    els.push(h('line', { key: 'g' + i, x1: pl, x2: W - pr, y1: y(v), y2: y(v), style: { stroke: 'var(--border)', strokeWidth: 1, strokeDasharray: i === 0 ? '' : '3 4' } }));
    els.push(h('text', { key: 'gt' + i, x: pl - 8, y: y(v) + 4, textAnchor: 'end', style: { fontSize: 10.5, fill: 'var(--text3)' } }, rzCompacto(v)));
  });
  meses.forEach(function(m, i){
    var cx = pl + slot * i + slot / 2, x = cx - bw / 2, on = hov === i;
    if (m.actual) els.push(h('rect', { key: 'hoy' + i, x: pl + slot * i + 1, y: pt - 6, width: Math.max(0, slot - 2), height: H - pt - pb + 6, rx: 8, style: { fill: 'var(--yellow-bg)', opacity: .55 } }));
    if (modo === 'caja'){
      var yI = y(m.interes), yC = y(m.interes + m.capital), yP = y(m.caja + m.proy);
      if (m.interes > 0) els.push(h('rect', { key: 'i' + i, x: x, y: yI, width: bw, height: y(0) - yI, rx: 3, style: { fill: 'var(--green)', opacity: on || hov == null ? 1 : .55 } }));
      if (m.capital > 0) els.push(h('rect', { key: 'c' + i, x: x, y: yC, width: bw, height: yI - yC, rx: 3, style: { fill: 'var(--blue)', opacity: on || hov == null ? .9 : .45 } }));
      if (m.proy > 0) els.push(h('rect', { key: 'p' + i, x: x, y: yP, width: bw, height: yC - yP, rx: 3, style: { fill: 'url(#rzRayas)', stroke: 'var(--text3)', strokeDasharray: '3 3', strokeWidth: 1 } }));
    } else {
      var yG = y(m.ganancia);
      if (m.ganancia > 0) els.push(h('rect', { key: 'g' + i, x: x, y: yG, width: bw, height: y(0) - yG, rx: 3, style: { fill: 'var(--gold)', opacity: on || hov == null ? 1 : .55 } }));
    }
    els.push(h('text', { key: 'l' + i, x: cx, y: H - 10, textAnchor: 'middle',
      style: { fontSize: 11, fill: m.actual ? 'var(--yellow)' : m.futuro ? 'var(--text3)' : 'var(--text2)', fontWeight: m.actual ? 700 : 500 } },
      m.label + (m.label === 'ene' ? " '" + m.anio.slice(2) : '')));
    els.push(h('rect', { key: 'hit' + i, x: pl + slot * i, y: 0, width: slot, height: H, style: { fill: 'transparent', cursor: 'crosshair' },
      onMouseEnter: function(){ setHov(i); }, onMouseLeave: function(){ setHov(null); } }));
  });
  var tip = null;
  if (hov != null){
    var m = meses[hov], cx = pl + slot * hov + slot / 2;
    var filas = modo === 'caja'
      ? [m.caja > 0 && ['Intereses', m.interes, 'var(--green)'], m.caja > 0 && ['Capital', m.capital, 'var(--blue)'],
         m.proy > 0 && [m.actual ? 'Falta del mes' : 'Por vencer', m.proy, 'var(--text3)'], ['Ganancia', m.ganancia, 'var(--gold)']]
      : [['Ganancia', m.ganancia, 'var(--gold)'], ['Caja total', m.caja, 'var(--text2)']];
    tip = h('div', { className: 'rz-tip', style: { left: Math.max(100, Math.min(W - 100, cx)), top: 0 } },
      h('div', { className: 't' }, rzMesDe(m.key) + ' ' + m.anio + (m.actual ? ' · en curso' : m.futuro ? ' · proyección' : '')),
      filas.filter(Boolean).map(function(f){ return h('div', { key: f[0], className: 'f' }, h('span', null, h('i', { className: 'rz-dot', style: { background: f[2] } }), f[0]), h('b', null, fmt(f[1]))); }),
      modo === 'caja' && m.caja > 0 && h('div', { className: 'f', style: { borderTop: '1px solid var(--border)', paddingTop: 5, marginTop: 6 } }, h('span', null, 'Entró en caja'), h('b', null, fmt(m.caja))));
  }
  return h(RzCard, { className: 'rz-flujo', icono: 'activity', color: 'var(--green)', titulo: 'Flujo de caja',
      sub: 'Lo que entró cada mes, separado en intereses y capital, y lo que viene en los próximos tres',
      acciones: h(RzSeg, { valor: modo, onCambio: setModo, opciones: [['caja', 'Caja'], ['ganancia', 'Ganancia']] }) },
    h('div', { className: 'rz-resumen-flujo' },
      h('div', null, 'Cobrado en 12 meses', h('b', null, fmt(tCaja))),
      h('div', null, 'De eso, intereses', h('b', { style: { color: 'var(--green)' } }, fmt(tInt))),
      h('div', null, 'Ganancia 12 meses', h('b', { style: { color: 'var(--gold)' } }, fmt(tGan))),
      h('div', null, 'Por cobrar (este mes y 3 más)', h('b', { style: { color: 'var(--text2)' } }, fmt(tProy))),
      mejor && mejor.caja > 0 && h('div', null, 'Mejor mes', h('b', null, rzMesDe(mejor.key).slice(0, 1).toUpperCase() + rzMesDe(mejor.key).slice(1) + ' · ' + rzCompacto(mejor.caja)))),
    h('div', { ref: ref, className: 'rz-chart' },
      h('svg', { width: W, height: H, style: { display: 'block', overflow: 'visible' } },
        h('defs', null, h('pattern', { id: 'rzRayas', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' },
          h('rect', { width: 2.5, height: 6, style: { fill: 'var(--text3)', opacity: .45 } }))),
        els),
      tip),
    h('div', { className: 'rz-leyenda' },
      modo === 'caja' ? [
        h('span', { key: 'a' }, h('i', { style: { background: 'var(--green)' } }), 'Intereses cobrados'),
        h('span', { key: 'b' }, h('i', { style: { background: 'var(--blue)' } }), 'Capital devuelto'),
        h('span', { key: 'c' }, h('i', { style: { background: 'var(--bg4)', border: '1px dashed var(--text3)' } }), 'Por cobrar (cuotas pendientes)')]
      : h('span', null, h('i', { style: { background: 'var(--gold)' } }), 'Ganancia real (intereses netos de pérdida cambiaria)')));
}

// 2. COMPOSICION: donde esta el capital
export function RzComposicion(p){
  var _t = useState('deudor'); var tab = _t[0], setTab = _t[1];
  var _s = useState(null); var sel = _s[0], setSel = _s[1];
  var por = p.M.por.filter(function(x){ return x.vivo > 0; });
  var total = por.reduce(function(s, x){ return s + x.vivo; }, 0);
  var grupos = {};
  por.forEach(function(x){
    var k = tab === 'deudor' ? properCase(x.nombre) : tab === 'moneda' ? (x.loan.moneda === 'USD' ? 'Dólares (USD)' : 'Pesos (COP)') : rzModalidad(x.loan.modalidad);
    grupos[k] = (grupos[k] || 0) + x.vivo;
  });
  var lista = Object.keys(grupos).map(function(k){ return { k: k, v: grupos[k] }; }).sort(function(a, b){ return b.v - a.v; });
  if (lista.length > 6){ var otros = lista.slice(5).reduce(function(s, x){ return s + x.v; }, 0); lista = lista.slice(0, 5).concat([{ k: 'Otros ' + (lista.length - 5), v: otros }]); }
  var r = 58, c = 2 * Math.PI * r, acc = 0;
  var arcos = lista.map(function(g, i){
    var len = total > 0 ? g.v / total * c : 0, off = acc; acc += len;
    return h('circle', { key: g.k, cx: 80, cy: 80, r: r, transform: 'rotate(-90 80 80)', strokeDasharray: Math.max(0, len - 2) + ' ' + c, strokeDashoffset: -off,
      onMouseEnter: function(){ setSel(i); }, onMouseLeave: function(){ setSel(null); },
      style: { fill: 'none', stroke: RZ_PALETA[i % RZ_PALETA.length], strokeWidth: sel === i ? 26 : 20, transition: 'stroke-width .15s', cursor: 'pointer', opacity: sel == null || sel === i ? 1 : .35 } });
  });
  var foco = sel != null ? lista[sel] : null;
  var top1 = lista[0] ? lista[0].v / (total || 1) : 0, top3 = lista.slice(0, 3).reduce(function(s, x){ return s + x.v; }, 0) / (total || 1);
  var nota = tab === 'deudor'
    ? h('div', { className: 'rz-nota' }, h('b', null, Math.round(top3 * 100) + '%'), ' de tu capital está en los 3 deudores más grandes', top1 >= .3 ? h('span', null, ' — y ', h('b', { style: { color: 'var(--yellow)' } }, Math.round(top1 * 100) + '% en uno solo'), '.') : '.')
    : tab === 'moneda'
      ? h('div', { className: 'rz-nota' }, h('b', null, Math.round(((grupos['Dólares (USD)'] || 0) / (total || 1)) * 100) + '%'), ' del capital en la calle está en dólares: su valor en pesos se mueve con la TRM.')
      : h('div', { className: 'rz-nota' }, 'La modalidad con más capital es ', h('b', null, lista[0] ? lista[0].k : '—'), '.');
  return h(RzCard, { className: 'rz-comp', icono: 'briefcase', color: 'var(--purple)', titulo: 'Dónde está tu capital', sub: 'Capital en la calle (' + rzCompacto(total) + ')',
      acciones: h(RzSeg, { valor: tab, onCambio: function(v){ setTab(v); setSel(null); }, opciones: [['deudor', 'Deudor'], ['modalidad', 'Modalidad'], ['moneda', 'Moneda']] }) },
    h('div', { className: 'rz-donut-wrap' },
      h('svg', { width: 160, height: 160, viewBox: '0 0 160 160', style: { flexShrink: 0 } },
        h('circle', { cx: 80, cy: 80, r: r, style: { fill: 'none', stroke: 'var(--bg3)', strokeWidth: 20 } }),
        arcos,
        h('text', { x: 80, y: 78, textAnchor: 'middle', style: { fontSize: foco ? 20 : 22, fontWeight: 700, fill: 'var(--text)', fontFamily: "'Cascadia Code','Consolas',monospace" } },
          foco ? Math.round(foco.v / (total || 1) * 100) + '%' : lista.length),
        h('text', { x: 80, y: 97, textAnchor: 'middle', style: { fontSize: 10.5, fill: 'var(--text3)' } },
          foco ? rzCompacto(foco.v) : (tab === 'deudor' ? 'deudores' : tab === 'moneda' ? 'monedas' : 'modalidades'))),
      h('div', { className: 'rz-donut-leg' }, lista.map(function(g, i){
        return h('div', { key: g.k, className: 'rz-leg' + (sel === i ? ' on' : ''), onMouseEnter: function(){ setSel(i); }, onMouseLeave: function(){ setSel(null); },
            onClick: function(){ if (tab === 'deudor' && g.k.indexOf('Otros') !== 0) p.onNameClick(p.M.por.filter(function(x){ return properCase(x.nombre) === g.k; })[0].nombre); } },
          h('i', { className: 'rz-dot', style: { background: RZ_PALETA[i % RZ_PALETA.length], margin: 0 } }),
          h('span', { className: 'nm' }, g.k),
          h('span', { className: 'pc' }, Math.round(g.v / (total || 1) * 100) + '%'));
      }))),
    nota);
}

// ═════════════════════════════════════════════════════════════════════════════════
// EL RESUMEN v4 — el rediseño que aprobo el PO sobre el prototipo (estilos en resumen.css, `.v4-*`)
// ═════════════════════════════════════════════════════════════════════════════════
// Piezas, de arriba abajo:
//   1. Encabezado: el estado de la cartera, la fecha, el saludo, las acciones y el dia en tres
//      pastillas que llevan a Cobros en su tramo (hoy, los proximos 7 dias, lo vencido).
//   2. Tres cifras con su mini-grafico: en la calle (anillo de lo que ya volvio), cobrado en el mes
//      (barras dia a dia) y ganancia del mes (barras de 12 meses); las dos ultimas, comparadas con el
//      mismo tramo del mes anterior.
//   3. Por cobrar (5) · Meta del mes (4) · Ultimos movimientos (3), a la misma altura.
//   4. Rendimiento: la rentabilidad de la cartera (la MISMA cifra de la pestaña Rendimiento: ganancia
//      historica / capital prestado) y la caja de los ultimos 12 meses.

function v4Pct(x){ return (Math.round(x * 10) / 10).toLocaleString('es-CO', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' %'; }
// Respeta "reducir movimiento" del sistema (en Windows, los efectos de animacion apagados).
var v4Reduce = typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Una cifra en pesos con el "$" pequeno y atenuado. Cuenta desde 0 al montarse (900 ms, ease-out) y,
// cuando cambia, desde el valor anterior. Solo anima si el navegador pinta cuadros: con la ventana
// oculta requestAnimationFrame no corre y la cifra muestra su valor final, no un cero.
function v4PuedeAnimar(){ return !v4Reduce && typeof document !== 'undefined' && !document.hidden; }
function V4Dinero(p){
  var v = Math.round(p.v || 0);
  var animar = p.animar && v4PuedeAnimar();
  var _c = useState(animar ? 0 : v); var cur = _c[0], setCur = _c[1];
  var desde = useRef(animar ? 0 : v);
  useEffect(function(){
    var from = desde.current; desde.current = v;
    if (from === v || !v4PuedeAnimar()) { setCur(v); return; }
    var raf, t0 = null;
    function paso(t){
      if (t0 === null) t0 = t;
      var k = Math.min(1, (t - t0) / 900), e = 1 - Math.pow(1 - k, 3);
      setCur(Math.round(from + (v - from) * e));
      if (k < 1) raf = requestAnimationFrame(paso);
    }
    raf = requestAnimationFrame(paso);
    return function(){ cancelAnimationFrame(raf); setCur(v); };
  }, [v]);
  var txt = fmt(cur).replace(/^-?\$\s*/, '');
  return h('span', { className: 'v4-dinero' + (p.className ? ' ' + p.className : '') }, h('span', { className: 'cur' }, '$'), txt);
}

function V4Chip(p){
  return h('span', { className: 'v4-chip ' + (p.tono || 'neutral'), title: p.title || null },
    p.icono && h(Ico, { name: p.icono, size: 12, sw: 2.4 }), p.children);
}
// Variacion frente al mismo tramo del mes anterior. Sin base (mes pasado en cero) no se inventa un %.
function V4Delta(p){
  if (!(p.antes > 0)) return h(V4Chip, { tono: 'neutral' }, 'nuevo este mes');
  var d = (p.ahora - p.antes) / p.antes * 100;
  var sube = d >= 0;
  return h(V4Chip, { tono: sube ? 'good' : 'crit', title: 'Frente a ' + p.etiqueta + ': ' + fmt(p.antes) },
    h('span', { className: 'flecha' }, sube ? '↗' : '↘'), (sube ? '+' : '') + Math.round(d) + ' %');
}

// ── 1. ENCABEZADO ────────────────────────────────────────────────────────────────
function V4Head(p){
  var M = p.M, met = p.metrics, d = rzFecha(p.hoy), hr = new Date().getHours();
  var hoyCuotas = met.hoy || [], mora = met.mora || [];
  var totHoy = hoyCuotas.reduce(function(s, x){ return s + pendCuota(x); }, 0);
  var semana = (met.proximos || []).reduce(function(s, x){ return s + pendCuota(x); }, 0);
  function pastilla(key, tono, rot, valor, detalle, ir){
    return h('button', { key: key, className: 'v4-pill ' + tono + (ir ? '' : ' quieta'), onClick: ir || null, title: ir ? 'Ver en Cobros' : null, style: { '--i': key } },
      h('span', { className: 'dot' }),
      h('span', { className: 'rot' }, rot),
      valor && h('b', null, valor),
      detalle && h('span', { className: 'det' }, detalle),
      ir && h(Ico, { name: 'chevright', size: 14, sw: 2.2 }));
  }
  return h('div', { className: 'v4-head' },
    h('div', { className: 'v4-head-top' },
      h('div', { className: 'v4-estado' },
        mora.length
          ? h(V4Chip, { tono: 'crit' }, h('span', { className: 'pulso' }), rzPl(M.deudoresMora, 'deudor', 'deudores') + ' en mora')
          : h(V4Chip, { tono: 'good' }, h('span', { className: 'pulso' }), 'Cartera al día'),
        h('span', { className: 'v4-fecha' }, RZ_DIAS[d.getDay()] + ' ' + d.getDate() + ' de ' + RZ_MESES[d.getMonth()] + ' · ' + rzPl(M.activos.length, 'préstamo activo', 'préstamos activos'))),
      h('div', { className: 'v4-acciones' },
        h('button', { className: 'v4-btn ghost', onClick: function(){ p.onNav('calculadora'); } }, h(Ico, { name: 'calc', size: 15, sw: 2 }), 'Calculadora'),
        h('button', { className: 'v4-btn ghost', onClick: function(){ p.onNav('cobros'); } }, h(Ico, { name: 'dollar', size: 15, sw: 2 }), 'Cobros'),
        h('button', { className: 'v4-btn pri', onClick: p.onNewLoan }, h(Ico, { name: 'plus', size: 15, sw: 2.4 }), 'Nuevo préstamo'))),
    h('h1', { className: 'v4-saludo' }, hr < 12 ? 'Buenos días' : hr < 19 ? 'Buenas tardes' : 'Buenas noches'),
    h('div', { className: 'v4-pills' },
      hoyCuotas.length
        ? pastilla(1, 'warn', 'Hoy vencen', fmt(totHoy), rzPl(hoyCuotas.length, 'cuota'), function(){ p.onNav('cobros', 'hoy'); })
        : pastilla(1, 'muted', 'Hoy no vence ninguna cuota'),
      semana > 0
        ? pastilla(2, 'info', 'Próximos 7 días', fmt(semana), 'por entrar', function(){ p.onNav('cobros', 'semana'); })
        : pastilla(2, 'muted', 'Nada vence en los próximos 7 días'),
      mora.length
        ? pastilla(3, 'crit', 'Vencido', fmt(met.totalMora), rzPl(mora.length, 'cuota') + ' de ' + rzPl(M.deudoresMora, 'deudor', 'deudores'), function(){ p.onNav('cobros', 'vencido'); })
        : pastilla(3, 'good', 'Toda la cartera está al día')));
}

// ── 2. TRES CIFRAS ───────────────────────────────────────────────────────────────
// Barras con su globo al pasar el mouse (CSS puro).
function V4Barras(p){
  var max = Math.max.apply(null, p.items.map(function(x){ return x.v; }).concat([1]));
  return h('div', { className: 'v4-barras' + (p.className ? ' ' + p.className : '') }, p.items.map(function(x, i){
    var alto = x.v > 0 ? Math.max(6, Math.round(x.v / max * 100)) : 0;
    var lado = i < 2 ? ' start' : i > p.items.length - 3 ? ' end' : '';
    return h('span', { key: i, className: 'b' + (x.on ? ' on' : '') + (x.futuro ? ' futuro' : '') + (x.v > 0 ? '' : ' vacia'), tabIndex: x.v > 0 ? 0 : -1, style: { '--i': i } },
      h('i', { style: { height: alto + '%' } }),
      x.v > 0 && h('span', { className: 'v4-tip' + lado }, h('b', null, fmt(x.v)), h('span', null, x.t)));
  }));
}
function V4Anillo(p){
  var r = 30, c = 2 * Math.PI * r, pct = Math.max(0, Math.min(100, p.pct || 0)), len = pct / 100 * c;
  return h('svg', { className: 'v4-anillo', width: 76, height: 76, viewBox: '0 0 76 76' },
    h('circle', { cx: 38, cy: 38, r: r, className: 'pista' }),
    h('circle', { cx: 38, cy: 38, r: r, className: 'val', transform: 'rotate(-90 38 38)', strokeDasharray: len + ' ' + c, style: { '--c': c } }),
    h('text', { x: 38, y: 42, textAnchor: 'middle' }, Math.round(pct) + '%'));
}
function V4Cifras(p){
  var M = p.M, met = p.metrics, hoy = p.hoy, mes = RZ_MESES[rzFecha(hoy).getMonth()];
  var pctRec = M.prestado > 0 ? (1 - M.vivo / M.prestado) * 100 : 0;
  var ant = p.antes;
  // La curva es el cobrado ACUMULADO del mes: dia a dia sale de restar el punto anterior.
  var dias = M.curva.map(function(v, i){ return v - (i ? M.curva[i - 1] : 0); });
  var dHoy = dias.length, dMes = new Date(rzFecha(hoy).getFullYear(), rzFecha(hoy).getMonth() + 1, 0).getDate();
  var itemsDias = [];
  for (var i = 0; i < dMes; i++) itemsDias.push({ v: i < dHoy ? dias[i] : 0, futuro: i >= dHoy, on: i === dHoy - 1, t: (i + 1) + ' de ' + mes });
  var mejor = dias.reduce(function(b, v, i){ return v > b.v ? { v: v, i: i } : b; }, { v: 0, i: -1 });
  var itemsGan = M.meses.slice(0, 12).map(function(m, i){ return { v: m.ganancia, on: i === 11, t: rzMesDe(m.key) + ' ' + m.anio }; });
  return h('div', { className: 'v4-kpis' },
    h('div', { className: 'v4-card v4-kpi', style: { '--i': 0 } },
      h('div', { className: 'v4-kpi-h' }, h('span', { className: 'v4-kpi-l' }, 'En la calle'), h(V4Chip, { tono: 'neutral' }, rzPl(M.activos.length, 'activo'))),
      h('div', { className: 'v4-kpi-row' },
        h('div', null,
          h('div', { className: 'v4-kpi-v' }, h(V4Dinero, { v: M.vivo, animar: true })),
          h('div', { className: 'v4-kpi-s' }, 'de ', h('b', null, fmt(M.prestado)), ' prestados')),
        h(V4Anillo, { pct: pctRec })),
      h('div', { className: 'v4-kpi-pie' },
        h('span', { className: 'v4-leyenda' }, h('i', { className: 'azul' }), Math.round(pctRec) + '% ya volvió'),
        M.devengo > 0 && h('span', { className: 'v4-leyenda' }, '+ ', h('b', null, fmt(M.devengo)), ' devengado en créditos abiertos'))),
    h('div', { className: 'v4-card v4-kpi', style: { '--i': 1 } },
      h('div', { className: 'v4-kpi-h' }, h('span', { className: 'v4-kpi-l' }, 'Cobrado en ' + mes), h(V4Delta, { ahora: met.recibido, antes: ant.caja, etiqueta: ant.etiqueta })),
      h('div', { className: 'v4-kpi-v' }, h(V4Dinero, { v: met.recibido, animar: true })),
      h('div', { className: 'v4-kpi-s' }, rzPl(M.movMes, 'movimiento') + ' entre cuotas, parciales y abonos'),
      h(V4Barras, { items: itemsDias, className: 'dias' }),
      h('div', { className: 'v4-kpi-pie' },
        h('span', null, 'Día a día'),
        mejor.i >= 0 && h('span', null, 'Mejor día: ', h('b', null, (mejor.i + 1) + ' de ' + mes)))),
    h('div', { className: 'v4-card v4-kpi', style: { '--i': 2 } },
      h('div', { className: 'v4-kpi-h' }, h('span', { className: 'v4-kpi-l' }, 'Ganancia de ' + mes), h(V4Delta, { ahora: M.gananciaMes, antes: ant.gan, etiqueta: ant.etiqueta })),
      h('div', { className: 'v4-kpi-v g' }, h(V4Dinero, { v: M.gananciaMes, animar: true })),
      h('div', { className: 'v4-kpi-s' }, 'Últimos 12 meses: ', h('b', null, fmt(M.ganancia12))),
      h(V4Barras, { items: itemsGan, className: 'meses' }),
      h('div', { className: 'v4-kpi-pie' }, h('span', null, RZ_MES3[parseInt(M.meses[0].key.slice(5, 7), 10) - 1] + ' ' + M.meses[0].anio), h('span', null, mes))));
}

// ── 3a. POR COBRAR ───────────────────────────────────────────────────────────────
// "Para cobrar ya" (lo vencido y lo de hoy, una fila por persona, `rzParaCobrar`) se desplaza dentro de
// una lista que llena la tarjeta; "Esta semana" muestra hasta RZ_PC_MAX cuotas y anuncia el resto.
function V4Fila(p){
  return h('button', { className: 'v4-fila', onClick: p.onClick, style: { '--i': p.i || 0 } },
    p.av,
    h('span', { className: 'v4-fila-c' },
      h('span', { className: 'n' }, p.nombre),
      h('span', { className: 's' + (p.sTono ? ' ' + p.sTono : '') }, p.detalle)),
    h('span', { className: 'v4-fila-v' }, p.monto, p.usd && usdLinea(p.usd, null, 'span')));
}
function V4Avatar(p){ return h('span', { className: 'v4-av' + (p.alerta ? ' alerta' : p.hoy ? ' hoy' : '') }, opIniciales(p.nombre)); }
function V4PorCobrar(p){
  var filas = p.filas, hoy = p.hoy, onNav = p.onNav, onNameClick = p.onNameClick;
  var ya = rzParaCobrar(filas, hoy);
  var vencidas = filas.filter(function(f){ return f.tramo === 'vencido'; });
  var totYa = ya.reduce(function(s, g){ return s + g.total; }, 0);
  var semana = filas.filter(function(f){ return f.tramo === 'semana'; });
  var totSemana = semana.reduce(function(s, f){ return s + f.pend; }, 0);
  var filasYa = ya.map(function(g, i){
    var det = g.venc
      ? rzPl(g.venc, 'cuota vencida', 'cuotas vencidas') + ' · hace ' + rzPl(g.dias, 'día') + (g.hoyN ? ' · y ' + rzPl(g.hoyN, 'vence', 'vencen') + ' hoy' : '')
      : (g.hoyN > 1 ? g.hoyN + ' cuotas vencen hoy' : 'vence hoy');
    return h(V4Fila, { key: g.nombre, i: i, av: h(V4Avatar, { nombre: g.nombre, alerta: g.venc > 0, hoy: !g.venc }), nombre: properCase(g.nombre),
      detalle: det, sTono: g.venc ? 'crit' : 'warn', monto: fmt(g.total), usd: g.todoUSD && g.usd ? fmtUSD(g.usd) : null,
      onClick: function(){ onNameClick(g.nombre, g.loanId); } });
  });
  var filasSem = semana.slice(0, RZ_PC_MAX).map(function(f, i){
    var d = rzFecha(f.p.fechaPago);
    return h(V4Fila, { key: f.p.id, i: i, av: h('span', { className: 'v4-dia' }, h('b', null, d.getDate()), RZ_DIAS[d.getDay()].slice(0, 3)),
      nombre: properCase(f.l.nombre), detalle: 'Cuota ' + f.p.cuotaN + (f.p.partialPaid > 0 ? ' · ya abonó una parte' : ''),
      monto: fmt(f.pend), usd: f.l.moneda === 'USD' && f.l.trmAcordada > 0 ? fmtUSD(f.pend / f.l.trmAcordada) : null,
      onClick: function(){ onNameClick(f.l.nombre, f.l.id, f.p.id); } });
  });
  function vacio(txt){ return h('div', { className: 'v4-vacio' }, h('span', { className: 'ok' }, h(Ico, { name: 'check', size: 14, sw: 2.6 })), txt); }
  return h('section', { className: 'v4-card v4-cobrar', style: { '--i': 3 } },
    h('div', { className: 'v4-card-h' },
      h('div', null, h('div', { className: 'v4-titulo' }, 'Por cobrar'), h('div', { className: 'v4-sub' }, 'Lo vencido y lo de hoy, y lo que entra esta semana')),
      h('button', { className: 'v4-link', onClick: function(){ onNav('cobros', vencidas.length ? 'vencido' : null); } }, 'Cobros', h(Ico, { name: 'chevright', size: 14, sw: 2.2 }))),
    h('div', { className: 'v4-pc' },
      h('div', { className: 'v4-pc-sec desplaza' },
        h('div', { className: 'v4-pc-h' },
          h('span', { className: 't' }, h('i', { className: vencidas.length ? 'crit' : 'warn' }), 'Para cobrar ya', ya.length > 0 && h('span', { className: 'n' }, ya.length)),
          ya.length > 0 && h('b', null, fmt(totYa))),
        filasYa.length ? h('div', { className: 'v4-lista v4-pc-lista' }, filasYa) : vacio('Nada vencido ni nada que venza hoy.')),
      h('div', { className: 'v4-pc-sec' },
        h('div', { className: 'v4-pc-h' },
          h('span', { className: 't' }, h('i', { className: 'info' }), 'Esta semana', semana.length > 0 && h('span', { className: 'n' }, semana.length)),
          semana.length > 0 && h('b', null, fmt(totSemana))),
        filasSem.length ? filasSem : vacio('Nada vence en los próximos 7 días.'),
        semana.length > RZ_PC_MAX && h('button', { className: 'v4-mas', onClick: function(){ onNav('cobros', 'semana'); } }, 'y ' + rzPl(semana.length - RZ_PC_MAX, 'cuota') + ' más', h(Ico, { name: 'chevright', size: 13, sw: 2.2 })))));
}

// ── 3b. META DEL MES ─────────────────────────────────────────────────────────────
function V4Meta(p){
  var _m = useState(rzYm(p.hoy)); var mes = _m[0], setMes = _m[1];
  var M = p.M;
  var r = useMemo(function(){ return rzMetaDelMes(p.pays, mes); }, [p.pays, mes]);
  var recibido = r.cobrado + r.moraRec;
  var pct = r.esperado > 0 ? Math.round(recibido / r.esperado * 100) : null;
  var nombreMes = rzMesDe(mes);
  var lleno = pct == null ? 0 : Math.min(100, pct);
  return h('section', { className: 'v4-card v4-meta', style: { '--i': 4 } },
    h('div', { className: 'v4-card-h' },
      h('div', null, h('div', { className: 'v4-titulo' }, 'Meta del mes'), h('div', { className: 'v4-sub' }, 'Lo que vence en el mes frente a lo que ya entró')),
      h('div', { className: 'v4-mesnav' },
        h('button', { onClick: function(){ setMes(rzMesMover(mes, -1)); }, title: 'Mes anterior' }, h(Ico, { name: 'chevleft', size: 14, sw: 2.4 })),
        h('span', null, nombreMes + ' ' + mes.slice(0, 4)),
        h('button', { onClick: function(){ setMes(rzMesMover(mes, 1)); }, title: 'Mes siguiente' }, h(Ico, { name: 'chevright', size: 14, sw: 2.4 })))),
    h('div', { className: 'v4-meta-top' },
      h('div', { className: 'v4-meta-pct' }, pct == null ? '—' : pct + '%'),
      pct == null ? h(V4Chip, { tono: 'neutral' }, 'Sin cuotas en el mes')
        : pct > 100 ? h(V4Chip, { tono: 'good', icono: 'check' }, 'Meta superada')
        : h(V4Chip, { tono: 'neutral' }, 'de la meta')),
    h('div', { className: 'v4-meta-barra' + (pct > 100 ? ' superada' : '') },
      h('div', { className: 'fill', key: mes, style: { width: lleno + '%' } })),
    h('div', { className: 'v4-meta-escala' }, h('span', null, '0'), h('span', null, '50%'), h('span', null, '100%')),
    h('div', { className: 'v4-meta-kv' },
      h('div', null, h('span', { className: 'k' }, h('i', { className: 'gris' }), 'Meta del mes'), h('b', null, fmt(r.esperado))),
      h('div', null, h('span', { className: 'k' }, h('i', { className: 'verde' }), 'Cobrado del mes'), h('b', { className: 'good' }, fmt(r.cobrado))),
      h('div', null, h('span', { className: 'k' }, h('i', { className: 'oro' }), 'Mora recuperada'), h('b', null, fmt(r.moraRec))),
      h('div', null, h('span', { className: 'k' }, h('i', { className: 'ambar' }), 'Falta por cobrar'), h('b', null, fmt(r.falta)))),
    // Sin tope de alto en linea: la lista llena la tarjeta (resumen.css, `.v4-meta-lista`).
    r.pend.length > 0
      ? h('div', { className: 'v4-lista v4-meta-lista' }, r.pend.map(function(x, i){
          var l = M.loanMap[x.prestamoId], mora = x.estadoPago === 'En Mora';
          return h('button', { key: x.id, className: 'v4-li', style: { '--i': i }, onClick: function(){ p.onNameClick(x.nombreCliente); } },
            h('span', { className: 'v4-li-c' },
              h('span', { className: 'n' }, properCase(x.nombreCliente)),
              h('span', { className: 's' + (mora ? ' crit' : '') }, 'Cuota ' + x.cuotaN + ' · ' + (mora ? 'vencida ' : 'vence ') + rzRel(p.hoy, x.fechaPago))),
            h('span', { className: 'v4-li-v' + (mora ? ' crit' : '') }, fmt(pendCuota(x)), rzUsd(l, pendCuota(x)) && usdLinea(rzUsd(l, pendCuota(x)), null, 'span')));
        }))
      : r.esperado > 0 && h('div', { className: 'v4-vacio' }, h('span', { className: 'ok' }, h(Ico, { name: 'check', size: 14, sw: 2.6 })), 'Todas las cuotas de ' + nombreMes + ' están cobradas.'));
}

// ── 3c. ULTIMOS MOVIMIENTOS: la caja mas reciente, agrupada por dia ──────────────
function V4Movimientos(p){
  var hoy = p.hoy, lista = p.M.recientes.slice(0, 16);
  var mesHoy = rzYm(hoy), totMes = p.M.recientes.reduce(function(s, e){ return rzYm(e.fecha) === mesHoy ? s + e.cop : s; }, 0);
  var bloques = [], ultimo = null;
  lista.forEach(function(e, i){
    if (e.fecha !== ultimo){
      ultimo = e.fecha;
      var dd = diasEntre(e.fecha, hoy);
      bloques.push(h('div', { key: 'd' + e.fecha, className: 'v4-mov-dia' }, dd === 0 ? 'Hoy' : dd === 1 ? 'Ayer' : fmtD(e.fecha)));
    }
    var pay = e.pay, tipo, tono, ico;
    if (esCorte(pay)){ tipo = 'Corte'; tono = 'info'; ico = 'clock'; }
    else if (esAbono(pay)){ tipo = 'Abono'; tono = 'info'; ico = 'dollar'; }
    else if (pay.estadoPago !== 'Pagado'){ tipo = 'Parcial'; tono = 'warn'; ico = 'receipt'; }
    else { tipo = 'Cuota ' + pay.cuotaN; tono = 'good'; ico = 'check'; }
    bloques.push(h('button', { key: pay.id + '|' + e.fecha + '|' + e.k + '|' + i, className: 'v4-mv', style: { '--i': i }, onClick: function(){ p.onNameClick(pay.nombreCliente); } },
      h('span', { className: 'v4-mv-ico ' + tono }, h(Ico, { name: ico, size: 13, sw: 2.4 })),
      h('span', { className: 'v4-li-c' },
        h('span', { className: 'n' }, properCase(pay.nombreCliente)),
        h('span', { className: 's' }, h('span', { className: 'v4-tag ' + tono }, tipo))),
      h('span', { className: 'v4-li-v good' }, '+ ' + fmt(e.cop), rzUsd(e.loan, e.cop) && usdLinea(rzUsd(e.loan, e.cop), null, 'span'))));
  });
  return h('section', { className: 'v4-card v4-mov', style: { '--i': 5 } },
    h('div', { className: 'v4-card-h' },
      h('div', null, h('div', { className: 'v4-titulo' }, 'Últimos movimientos'), h('div', { className: 'v4-sub' }, 'Entraron ', h('b', { className: 'good' }, fmt(totMes)), ' en ' + rzMesDe(mesHoy))),
      h('button', { className: 'v4-link', onClick: function(){ p.onNav('historial'); } }, 'Historial', h(Ico, { name: 'chevright', size: 14, sw: 2.2 }))),
    lista.length ? h('div', { className: 'v4-lista v4-mov-lista' }, bloques) : h('div', { className: 'v4-vacio' }, 'Todavía no hay cobros registrados.'));
}

// ── 4. RENDIMIENTO ───────────────────────────────────────────────────────────────
// La rentabilidad de la cartera es la de la pestaña Rendimiento: la ganancia historica (la de la
// tarjeta de App, `gananciaDe` sobre todas las filas) sobre el capital prestado en TODOS los prestamos.
function V4Rendimiento(p){
  var M = p.M, met = p.metrics, loans = p.loans;
  var prestadoTodo = loans.reduce(function(s, l){ return s + rzOrigCOP(l); }, 0);
  var rent = prestadoTodo > 0 ? met.totalInteresesRecibidos / prestadoTodo * 100 : 0;
  var hist = M.meses.slice(0, 12);
  var max = Math.max.apply(null, hist.map(function(m){ return m.caja; }).concat([1]));
  return h('section', { className: 'v4-card v4-rend', style: { '--i': 6 } },
    h('div', { className: 'v4-rend-txt' },
      h(V4Chip, { tono: 'neutral', icono: 'trending' }, 'Rendimiento'),
      h('div', { className: 'v4-rend-v' }, v4Pct(rent).replace(' %', ''), h('span', { className: 'pc' }, '%')),
      h('div', { className: 'v4-rend-l' }, 'rentabilidad de la cartera'),
      h('p', null, 'Ganaste ', h('b', null, fmt(M.ganancia12)), ' en los últimos 12 meses y ', h('b', null, fmt(met.totalInteresesRecibidos)),
        ' desde el inicio, sobre ', h('b', null, fmt(prestadoTodo)), ' prestados. El flujo de caja y dónde está tu capital, en Rendimiento.'),
      h('div', { className: 'v4-rend-acc' },
        h('button', { className: 'v4-btn ghost', onClick: function(){ p.onNav('rendimiento'); } }, 'Ver Rendimiento', h(Ico, { name: 'chevright', size: 14, sw: 2.4 })),
        h('span', { className: 'v4-rend-nota' }, 'Ganancia histórica ÷ capital prestado'))),
    h('div', { className: 'v4-rend-graf' },
      h('div', { className: 'v4-rend-gh' }, h('span', null, 'Caja de los últimos 12 meses'), h('span', { className: 'ley' }, h('i', { className: 'int' }), 'intereses', h('i', { className: 'cap' }), 'capital')),
      h('div', { className: 'v4-rend-barras' }, hist.map(function(m, i){
        var alto = m.caja / max * 100, hi = m.caja > 0 ? m.interes / m.caja * 100 : 0;
        return h('span', { key: m.key, className: 'col' + (m.actual ? ' on' : ''), tabIndex: 0, style: { '--i': i } },
          h('span', { className: 'barra', style: { height: Math.max(m.caja > 0 ? 4 : 0, alto) + '%' } },
            h('i', { className: 'cap', style: { height: (100 - hi) + '%' } }), h('i', { className: 'int', style: { height: hi + '%' } })),
          h('span', { className: 'mes' }, m.label),
          m.caja > 0 && h('span', { className: 'v4-tip' + (i < 2 ? ' start' : i > 9 ? ' end' : '') },
            h('b', null, fmt(m.caja)), h('span', null, rzMesDe(m.key) + ' ' + m.anio),
            h('span', null, 'Intereses ' + rzCompacto(m.interes) + ' · capital ' + rzCompacto(m.capital))));
      }))));
}

// El mismo tramo del mes anterior (del dia 1 al dia de hoy): con los mismos eventos de caja (`cobrosDe`)
// y de ganancia (`gananciaDe`) que el mes en curso, para comparar peras con peras.
function v4MismoTramo(pays, loanMap, hoy){
  var d = rzFecha(hoy), prev = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  var ym = prev.getFullYear() + '-' + String(prev.getMonth() + 1).padStart(2, '0');
  var ultimo = new Date(prev.getFullYear(), prev.getMonth() + 1, 0).getDate();
  var tope = ym + '-' + String(Math.min(d.getDate(), ultimo)).padStart(2, '0');
  var caja = 0, gan = 0;
  pays.forEach(function(p){
    cobrosDe(p).forEach(function(e){ if (e.fecha.slice(0, 7) === ym && e.fecha <= tope) caja += e.cop; });
    var l = loanMap[p.prestamoId];
    gananciaDe(p, l && l.moneda === 'USD').eventos.forEach(function(e){ if (e.fecha.slice(0, 7) === ym && e.fecha <= tope) gan += e.ganancia; });
  });
  return { caja: Math.round(caja), gan: Math.round(gan), etiqueta: RZ_MESES[prev.getMonth()] + ' (1 al ' + Math.min(d.getDate(), ultimo) + ')' };
}

// ── LA VISTA ─────────────────────────────────────────────────────────────────────
export function DashView(props){
  var metrics = props.metrics, loans = props.loans || [], pays = props.pays || [];
  var onNav = props.onNav, onNameClick = props.onNameClick || function(){};
  var onNewLoan = props.onNewLoan || function(){ onNav('cartera'); };
  var hoy = nowStr();
  var M = useMemo(function(){ return modeloResumen(loans, pays, hoy); }, [loans, pays, hoy]);
  var filas = useMemo(function(){ return bandejaCobro(loans, pays, hoy); }, [loans, pays, hoy]);
  var antes = useMemo(function(){ return v4MismoTramo(pays, M.loanMap, hoy); }, [pays, M, hoy]);
  var _a = useState(v4PuedeAnimar); var anima = _a[0];

  if (props.isEmpty) return h('div', { className: 'v4' },
    h('section', { className: 'v4-card v4-vacia' },
      h('span', { className: 'v4-vacia-ico' }, h(Ico, { name: 'briefcase', size: 26, sw: 2 })),
      h('h1', { className: 'v4-saludo' }, 'Tu cartera empieza aquí'),
      h('p', null, 'Registra tu primer préstamo y este resumen se llenará con tus cobros, lo que vence y tu ganancia.'),
      h('button', { className: 'v4-btn pri', onClick: onNewLoan }, h(Ico, { name: 'plus', size: 15, sw: 2.4 }), 'Nuevo préstamo')));

  var comun = { M: M, hoy: hoy, pays: pays, loans: loans, metrics: metrics, onNav: onNav, onNameClick: onNameClick };
  // Las entradas animadas solo si la ventana se ve (oculta, el reloj de animaciones no corre y las
  // tarjetas se quedarian en su primer cuadro, invisibles).
  return h('div', { className: 'v4' + (anima ? ' anima' : '') },
    h(V4Head, Object.assign({ onNewLoan: onNewLoan }, comun)),
    h(V4Cifras, Object.assign({ antes: antes }, comun)),
    h(V4PorCobrar, Object.assign({ filas: filas }, comun)),
    h(V4Meta, comun),
    h(V4Movimientos, comun),
    h(V4Rendimiento, comun));
}
