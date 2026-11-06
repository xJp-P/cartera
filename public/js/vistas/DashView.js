// public/js/vistas/DashView.js — Resumen: el centro de mando de la cartera.
//
// 3.4.0 reemplazo al Inicio de cuatro tarjetas fijas (v1.9.1) por una rejilla de 12 columnas que llena
// todo el ancho. 3.7.0 (decision del PO): el "Analisis del negocio" -flujo de caja y composicion del
// capital- se MUDO a Rendimiento, que los importa de aqui (`RzFlujo`, `RzComposicion`, `modeloResumen`).
// 3.7.1: el Resumen HIBRIDO que el PO aprobo sobre el prototipo, tal cual:
//   1. la bienvenida (fecha, saludo, acciones) con el dia en TRES puntos que llevan a Cobros;
//   2. tres cifras en una franja: en la calle, cobrado en el mes, ganancia del mes;
//   3. tres tarjetas de la MISMA altura, de izquierda a derecha: Por cobrar (lo vencido y lo de hoy,
//      una fila por persona, y lo de esta semana) · Meta del mes · Ultimos movimientos;
//   4. el enlace al analisis, en Rendimiento.
// Salieron la Agenda de cobro, el Radar y los KPI "En mora" y "Posicion neta" de 3.4.0: el modelo los
// reemplaza por los puntos del encabezado y "Por cobrar".
//
// Todas las cifras salen de los helpers del dominio (cobrosDe, imputarCobros, gananciaDe,
// pendCuota, estadoDiario): ninguna formula nueva de dinero. Los estilos viven en styles.css
// (prefijo `.rz-`). Los nombres de nivel superior llevan prefijo rz/Rz/RZ_ porque el arnes de
// pruebas aplana todos los modulos en un solo ambito y un nombre repetido lo romperia.

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

// ── 1. ENCABEZADO: la fecha, el saludo, el dia en tres puntos y las acciones ─────
// Cada punto que tiene algo lleva a Cobros en su tramo (hoy, la semana, lo vencido).
function RzHero(p){
  var M = p.M, met = p.metrics, hoy = p.hoy, d = rzFecha(hoy), hr = new Date().getHours();
  var hoyCuotas = met.hoy || [], mora = met.mora || [];
  var totHoy = hoyCuotas.reduce(function(s, x){ return s + pendCuota(x); }, 0);
  var semana = (met.proximos || []).reduce(function(s, x){ return s + pendCuota(x); }, 0);
  function punto(color, contenido, ir){
    return h('li', { className: ir ? 'ir' : null, onClick: ir || null, title: ir ? 'Ver en Cobros' : null },
      h('i', { style: { background: color } }), h('span', null, contenido));
  }
  function btn(ico, txt, fn, pri){ return h('button', { className: 'rz-btn' + (pri ? ' pri' : ''), onClick: fn }, h(Ico, { name: ico, size: 15, color: pri ? '#fff' : 'var(--text2)', sw: 2.3 }), txt); }
  return h('div', { className: 'rz-card rz-full rz-hero' },
    h('div', { style: { minWidth: 0, flex: '1 1 420px' } },
      h('div', { className: 'rz-fecha' }, RZ_DIAS[d.getDay()] + ' ' + d.getDate() + ' de ' + RZ_MESES[d.getMonth()]),
      h('div', { className: 'rz-saludo' }, hr < 12 ? 'Buenos días' : hr < 19 ? 'Buenas tardes' : 'Buenas noches'),
      h('ul', { className: 'rz-puntos' },
        hoyCuotas.length
          ? punto('var(--yellow)', ['Hoy vencen ', h('b', { key: 'a', className: 'y' }, rzPl(hoyCuotas.length, 'cuota')), ' por ', h('b', { key: 'b' }, fmt(totHoy)), '.'],
              function(){ p.onNav('cobros', 'hoy'); })
          : punto('var(--text3)', 'Hoy no vence ninguna cuota.'),
        semana > 0
          ? punto('var(--blue)', ['En los próximos 7 días entran ', h('b', { key: 'a' }, fmt(semana)), '.'], function(){ p.onNav('cobros', 'semana'); })
          : punto('var(--text3)', 'En los próximos 7 días no vence ninguna cuota.'),
        mora.length
          ? punto('var(--red)', ['Tienes ', h('b', { key: 'a', className: 'r' }, fmt(met.totalMora) + ' vencidos'), ' en ' + rzPl(mora.length, 'cuota') + ' de ' +
              rzPl(M.deudoresMora, 'deudor', 'deudores') + '.'], function(){ p.onNav('cobros', 'vencido'); })
          : punto('var(--green)', h('b', { className: 'g' }, 'Toda la cartera está al día.')))),
    h('div', { className: 'rz-acciones' },
      btn('plus', 'Nuevo préstamo', p.onNewLoan, true),
      btn('dollar', 'Cobros', function(){ p.onNav('cobros'); }),
      btn('users', 'Cartera', function(){ p.onNav('cartera'); }),
      btn('calc', 'Calculadora', function(){ p.onNav('calculadora'); })));
}

// ── 2. TRES CIFRAS, en una sola franja ──────────────────────────────────────────
function RzCifras(p){
  var M = p.M, mesNom = rzMesDe(rzYm(p.hoy));
  var pctRec = M.prestado > 0 ? Math.round((1 - M.vivo / M.prestado) * 100) : 0;
  return h('div', { className: 'rz-full rz-cifras' },
    h('div', { className: 'rz-cifra' },
      h('div', { className: 'rz-cifra-l' }, 'En la calle'),
      h('div', { className: 'rz-cifra-v' }, fmt(M.vivo)),
      h('div', { className: 'rz-cifra-barra' }, h('div', { style: { width: Math.max(0, Math.min(100, pctRec)) + '%' } })),
      h('div', { className: 'rz-cifra-s' }, pctRec + '% de lo prestado ya volvió')),
    h('div', { className: 'rz-cifra' },
      h('div', { className: 'rz-cifra-l' }, 'Cobrado en ' + mesNom),
      h('div', { className: 'rz-cifra-v' }, fmt(p.metrics.recibido)),
      h('div', { className: 'rz-cifra-s' }, 'Toda la caja del mes: cuotas, parciales y abonos')),
    h('div', { className: 'rz-cifra' },
      h('div', { className: 'rz-cifra-l' }, 'Ganancia de ' + mesNom),
      h('div', { className: 'rz-cifra-v g' }, fmt(M.gananciaMes)),
      h('div', { className: 'rz-cifra-s' }, 'Últimos 12 meses: ', h('b', null, fmt(M.ganancia12)))));
}

// ── 3. POR COBRAR: lo vencido y lo de hoy, y lo que entra esta semana ──────────────
// Sale de `bandejaCobro` (la de Cobros): cuotas del cronograma de prestamos activos, sin pagar, con
// lo que falta de cada una (`pendCuota`). "Para cobrar ya" trae a TODAS las personas en una lista que
// se desplaza y llena el alto de la tarjeta, como la Meta y los movimientos (`.rz-pc-lista`, sin tope en
// linea: regla de 3.4.1). "Esta semana" muestra hasta RZ_PC_MAX cuotas y anuncia el resto, que se abre
// en Cobros.
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
function RzPcFila(p){
  return h('button', { className: 'rz-pc-fila', onClick: p.onClick },
    h('span', { className: 'rz-pc-av ' + (p.tono || '') }, p.av),
    h('span', { className: 'rz-pc-c' },
      h('span', { className: 'rz-pc-nom' }, p.nombre),
      h('span', { className: 'rz-pc-det' + (p.detTono ? ' ' + p.detTono : '') }, p.detalle)),
    h('span', { className: 'rz-pc-monto' }, p.monto, p.usd && usdLinea(p.usd, null, 'span')));
}
function RzPcSeccion(p){
  return h('div', { className: 'rz-pc-sec' + (p.desplaza ? ' desplaza' : '') },
    h('div', { className: 'rz-pc-sec-h' },
      h('span', { className: 'rz-pc-sec-t' }, h('i', { style: { background: p.color } }), p.titulo),
      p.total != null && h('b', { className: 'rz-pc-sec-tot' }, p.total)),
    !p.filas.length ? h('div', { className: 'rz-pc-vacio' }, h(Ico, { name: 'check', size: 15, color: 'var(--green)', sw: 2.4 }), p.vacio)
      : p.desplaza ? h('div', { className: 'rz-scroll rz-pc-lista' }, p.filas) : p.filas,
    p.mas && h('button', { className: 'rz-pc-mas', onClick: p.onMas }, p.mas, ' →'));
}
function RzPorCobrar(p){
  var filas = p.filas, hoy = p.hoy, onNav = p.onNav, onNameClick = p.onNameClick;
  var ya = rzParaCobrar(filas, hoy);
  var vencidas = filas.filter(function(f){ return f.tramo === 'vencido'; });
  var totYa = ya.reduce(function(s, g){ return s + g.total; }, 0);
  var filasYa = ya.map(function(g){
    var det = g.venc
      ? rzPl(g.venc, 'cuota vencida', 'cuotas vencidas') + ' · hace ' + rzPl(g.dias, 'día') + (g.hoyN ? ' · y ' + rzPl(g.hoyN, 'vence', 'vencen') + ' hoy' : '')
      : (g.hoyN > 1 ? g.hoyN + ' cuotas vencen hoy' : 'vence hoy');
    return h(RzPcFila, { key: g.nombre, av: opIniciales(g.nombre), tono: g.venc ? 'r' : 'y', nombre: properCase(g.nombre),
      detalle: det, detTono: g.venc ? 'r' : 'y', monto: fmt(g.total), usd: g.todoUSD && g.usd ? fmtUSD(g.usd) : null,
      onClick: function(){ onNameClick(g.nombre, g.loanId); } });
  });
  var semana = filas.filter(function(f){ return f.tramo === 'semana'; });
  var totSemana = semana.reduce(function(s, f){ return s + f.pend; }, 0);
  var filasSem = semana.slice(0, RZ_PC_MAX).map(function(f){
    var d = rzFecha(f.p.fechaPago);
    return h(RzPcFila, { key: f.p.id, av: h('span', { className: 'rz-pc-dia' }, h('b', null, d.getDate()), RZ_DIAS[d.getDay()].slice(0, 3)),
      tono: 'd', nombre: properCase(f.l.nombre), detalle: 'cuota ' + f.p.cuotaN + (f.p.partialPaid > 0 ? ' · ya abonó una parte' : ''),
      monto: fmt(f.pend), usd: f.l.moneda === 'USD' && f.l.trmAcordada > 0 ? fmtUSD(f.pend / f.l.trmAcordada) : null,
      onClick: function(){ onNameClick(f.l.nombre, f.l.id, f.p.id); } });
  });
  return h(RzCard, { className: 'rz-cobrar', icono: 'calendar', color: 'var(--blue)', titulo: 'Por cobrar',
      sub: 'Lo vencido y lo de hoy, y lo que entra esta semana',
      acciones: h('button', { className: 'rz-link', onClick: function(){ onNav('cobros', vencidas.length ? 'vencido' : null); } }, 'Cobros →') },
    h('div', { className: 'rz-pc-secciones' },
      h(RzPcSeccion, { color: vencidas.length ? 'var(--red)' : 'var(--yellow)', titulo: 'Para cobrar ya', total: ya.length ? fmt(totYa) : null,
        filas: filasYa, vacio: 'Nada vencido ni nada que venza hoy.', desplaza: true }),
      h(RzPcSeccion, { color: 'var(--blue)', titulo: 'Esta semana', total: semana.length ? fmt(totSemana) : null,
        filas: filasSem, vacio: 'Nada vence en los próximos 7 días.',
        mas: semana.length > RZ_PC_MAX ? 'y ' + rzPl(semana.length - RZ_PC_MAX, 'cuota') + ' más' : null,
        onMas: function(){ onNav('cobros', 'semana'); } })));
}

// ── 4. META DEL MES: cuanto de lo que vence en el mes ya entro ────────────────────
function RzAnillo(p){
  var r = 54, c = 2 * Math.PI * r, pct = Math.max(0, p.pct || 0), lleno = Math.min(pct, 100) / 100 * c;
  var col = pct > 100 ? 'var(--gold)' : 'var(--green)';
  return h('svg', { width: 140, height: 140, viewBox: '0 0 140 140', style: { flexShrink: 0 } },
    h('circle', { cx: 70, cy: 70, r: r, style: { fill: 'none', stroke: 'var(--bg4)', strokeWidth: 12 } }),
    h('circle', { cx: 70, cy: 70, r: r, transform: 'rotate(-90 70 70)', strokeDasharray: lleno + ' ' + c,
      style: { fill: 'none', stroke: col, strokeWidth: 12, strokeLinecap: 'round', transition: 'stroke-dasharray .6s ease' } }),
    h('text', { x: 70, y: 70, textAnchor: 'middle', style: { fontSize: 27, fontWeight: 700, fill: 'var(--text)', fontFamily: "'Cascadia Code','Consolas',monospace" } }, p.txt),
    h('text', { x: 70, y: 90, textAnchor: 'middle', style: { fontSize: 11, fill: 'var(--text3)' } }, p.sub));
}
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
function RzMetaMes(p){
  var _m = useState(rzYm(p.hoy)); var mes = _m[0], setMes = _m[1];
  var M = p.M;
  var r = useMemo(function(){ return rzMetaDelMes(p.pays, mes); }, [p.pays, mes]);
  var recibido = r.cobrado + r.moraRec;
  var pct = r.esperado > 0 ? Math.round(recibido / r.esperado * 100) : null;
  return h(RzCard, { className: 'rz-meta', icono: 'shield', color: 'var(--green)', titulo: 'Meta del mes', sub: 'Lo que vence en el mes frente a lo que ya entró',
      acciones: h('div', { className: 'rz-mes-nav' },
        h('button', { onClick: function(){ setMes(rzMesMover(mes, -1)); }, title: 'Mes anterior' }, h(Ico, { name: 'chevleft', size: 14, color: 'var(--blue)', sw: 2.5 })),
        h('span', null, rzMesDe(mes) + ' ' + mes.slice(0, 4)),
        h('button', { onClick: function(){ setMes(rzMesMover(mes, 1)); }, title: 'Mes siguiente' }, h(Ico, { name: 'chevright', size: 14, color: 'var(--blue)', sw: 2.5 }))) },
    h('div', { className: 'rz-ring-wrap' },
      h(RzAnillo, { pct: pct || 0, txt: pct == null ? '—' : pct + '%', sub: pct > 100 ? 'meta superada' : 'de la meta' }),
      h('div', { className: 'rz-filas' },
        h('div', { className: 'rz-fila' }, h('span', null, h('i', { className: 'rz-dot', style: { background: 'var(--text3)' } }), 'Meta (vence en el mes)'), h('b', null, fmt(r.esperado))),
        h('div', { className: 'rz-fila' }, h('span', null, h('i', { className: 'rz-dot', style: { background: 'var(--green)' } }), 'Cobrado del mes'), h('b', { style: { color: 'var(--green)' } }, fmt(r.cobrado))),
        r.moraRec > 0 && h('div', { className: 'rz-fila' }, h('span', null, h('i', { className: 'rz-dot', style: { background: 'var(--gold)' } }), 'Mora recuperada'), h('b', { style: { color: 'var(--gold)' } }, fmt(r.moraRec))),
        h('div', { className: 'rz-fila' }, h('span', null, h('i', { className: 'rz-dot', style: { background: 'var(--yellow)' } }), 'Falta por cobrar'), h('b', null, fmt(r.falta))))),
    // Sin tope en linea: la lista llena el alto que la rejilla le da a la tarjeta (styles.css,
    // `.rz-meta-lista`). Mas de 4 cuotas ya no caben en 250 px: `larga` fija ese minimo.
    r.pend.length > 0 && h('div', { className: 'rz-lista rz-scroll rz-meta-lista' + (r.pend.length > 4 ? ' larga' : '') },
      r.pend.map(function(x){
        var l = M.loanMap[x.prestamoId], mora = x.estadoPago === 'En Mora';
        return h('div', { key: x.id, className: 'rz-li', onClick: function(){ p.onNameClick(x.nombreCliente); } },
          h('div', { style: { minWidth: 0 } },
            h('div', { className: 'rz-li-n' }, properCase(x.nombreCliente)),
            h('div', { className: 'rz-li-s', style: mora ? { color: 'var(--red)' } : null }, 'Cuota ' + x.cuotaN + ' · ' + (mora ? 'vencida ' : 'vence ') + rzRel(p.hoy, x.fechaPago))),
          h('div', null,
            h('div', { className: 'rz-li-v', style: { color: mora ? 'var(--red)' : 'var(--text)' } }, fmt(pendCuota(x))),
            rzUsd(l, pendCuota(x)) && usdLinea(rzUsd(l, pendCuota(x)),{fontSize: 10.5, textAlign: 'right'})));
      })),
    r.pend.length === 0 && r.esperado > 0 && h('div', { className: 'rz-nota', style: { color: 'var(--green)' } }, 'Todas las cuotas de ' + rzMesDe(mes) + ' están cobradas.'));
}

// ── 5. FLUJO DE CAJA: 12 meses de historia + 3 de proyeccion ─────────────────────
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

// ── 6. COMPOSICION: donde esta el capital ────────────────────────────────────────
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

// ── 8. MOVIMIENTOS: la caja mas reciente, agrupada por dia ───────────────────────
function RzMovimientos(p){
  var hoy = p.hoy, lista = p.M.recientes.slice(0, 16);
  var mesHoy = rzYm(hoy), totMes = p.M.recientes.reduce(function(s, e){ return rzYm(e.fecha) === mesHoy ? s + e.cop : s; }, 0);
  var bloques = [], ultimo = null;
  lista.forEach(function(e, i){
    if (e.fecha !== ultimo){ ultimo = e.fecha; var d = diasEntre(e.fecha, hoy);
      bloques.push(h('div', { key: 'd' + e.fecha, className: 'rz-mov-dia' }, d === 0 ? 'Hoy' : d === 1 ? 'Ayer' : fmtD(e.fecha))); }
    var pay = e.pay, tipo, ico, ac;
    if (esCorte(pay)){ tipo = 'Corte de interés diario'; ico = 'clock'; ac = 'blue'; }
    else if (esAbono(pay)){ tipo = 'Abono a capital'; ico = 'dollar'; ac = 'blue'; }
    else if (pay.estadoPago !== 'Pagado'){ tipo = 'Abono parcial · cuota ' + pay.cuotaN; ico = 'receipt'; ac = 'yellow'; }
    else { tipo = 'Cuota ' + pay.cuotaN + (e.n > 1 ? ' · pago final' : ''); ico = 'check'; ac = 'green'; }
    bloques.push(h('div', { key: pay.id + '|' + e.fecha + '|' + e.k + '|' + i, className: 'rz-mv', onClick: function(){ p.onNameClick(pay.nombreCliente); } },
      h('div', { className: 'rz-mv-ico', style: { background: 'var(--' + ac + '-bg)' } }, h(Ico, { name: ico, size: 13, color: 'var(--' + ac + ')', sw: 2.4 })),
      h('div', { style: { flex: 1, minWidth: 0 } },
        h('div', { className: 'rz-li-n' }, properCase(pay.nombreCliente)),
        h('div', { className: 'rz-li-s' }, tipo)),
      h('div', { style: { textAlign: 'right' } },
        h('div', { className: 'rz-li-v', style: { color: 'var(--green)' } }, '+ ' + fmt(e.cop)),
        rzUsd(e.loan, e.cop) && usdLinea(rzUsd(e.loan, e.cop),{fontSize: 10.5}))));
  });
  return h(RzCard, { className: 'rz-mov', icono: 'receipt', color: 'var(--green)', titulo: 'Últimos movimientos',
      sub: h('span', null, 'Entraron ', h('b', { className: 'mono', style: { color: 'var(--green)' } }, fmt(totMes)), ' en ' + rzMesDe(mesHoy)),
      acciones: h('button', { className: 'rz-link', onClick: function(){ p.onNav('historial'); } }, 'Historial →') },
    // 3.7.0: la lista llena la tarjeta (misma regla que la Meta, `.rz-mov-lista`): sin tope en linea.
    lista.length ? h('div', { className: 'rz-scroll rz-mov-lista' }, bloques) : h('div', { className: 'rz-nota' }, 'Todavía no hay cobros registrados.'));
}

// ── LA VISTA ────────────────────────────────────────────────────────────────────
export function DashView(props){
  var metrics = props.metrics, loans = props.loans || [], pays = props.pays || [];
  var onNav = props.onNav, onNameClick = props.onNameClick || function(){};
  var onNewLoan = props.onNewLoan || function(){ onNav('cartera'); };
  var hoy = nowStr();
  var M = useMemo(function(){ return modeloResumen(loans, pays, hoy); }, [loans, pays, hoy]);
  var filas = useMemo(function(){ return bandejaCobro(loans, pays, hoy); }, [loans, pays, hoy]);

  if (props.isEmpty) return h('div', { className: 'rz' },
    h('div', { className: 'rz-card rz-full rz-hero', style: { padding: '48px 28px', justifyContent: 'center', textAlign: 'center', flexDirection: 'column' } },
      h(Ico, { name: 'briefcase', size: 44, color: 'var(--green)' }),
      h('div', { className: 'rz-saludo', style: { marginTop: 12 } }, 'Tu cartera empieza aquí'),
      h('div', { className: 'rz-insight' }, 'Registra tu primer préstamo y este resumen se llenará con tus cobros, lo que vence y tu ganancia.'),
      h('button', { className: 'rz-btn pri', style: { marginTop: 18 }, onClick: onNewLoan }, h(Ico, { name: 'plus', size: 15, color: '#fff', sw: 2.3 }), 'Nuevo préstamo')));

  var comun = { M: M, hoy: hoy, pays: pays, metrics: metrics, onNav: onNav, onNameClick: onNameClick };
  return h('div', { className: 'rz' },
    h(RzHero, Object.assign({ onNewLoan: onNewLoan }, comun)),
    h(RzCifras, comun),
    // Una fila de tres tarjetas de la misma altura, de izquierda a derecha: lo que hay que cobrar,
    // el mes (meta) y lo que ya entro (movimientos).
    h(RzPorCobrar, Object.assign({ filas: filas }, comun)),
    h(RzMetaMes, comun),
    h(RzMovimientos, comun),
    h('div', { className: 'rz-full rz-analisis' },
      h('button', { className: 'rz-analisis-h', onClick: function(){ onNav('rendimiento'); } },
        h(Ico, { name: 'trending', size: 15, color: 'var(--text3)', sw: 2.2 }),
        h('span', null, 'Análisis del negocio'),
        h('span', { className: 'rz-analisis-s' }, 'el flujo de caja y dónde está tu capital, ahora en Rendimiento →'))));
}
