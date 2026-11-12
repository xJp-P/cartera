// public/js/vistas/PortfolioView.js — Rendimiento: cuanto rinde cada prestamo y como va el negocio (3.7.0).
//
// 3.7.0 (aprobado por el PO sobre un prototipo navegable con el fixture): una franja de cuatro cifras
// (ganancia obtenida, rentabilidad de la cartera, capital colocado y saldo en la calle); una TABLA de
// prestamos con filtros (activos, finalizados, en dolares, con perdida, todos) y orden por columna, donde
// un clic en una fila abre el panel del deudor en Cartera (`onNameClick`, el mismo de los nombres del
// Resumen); y el "Analisis del negocio" que vivia en el Resumen (decision del PO).
//
// REDISEÑO v4 (aprobado por el PO sobre el prototipo, integrado pestaña por pestaña): el sistema de
// diseño de Control TC v7. Las cifras cuentan desde 0 (`V4Dinero`), la tabla lleva encabezados en
// minuscula, el estado en chip suave (`V4Chip`), la barra de recuperado en azul y las de rentabilidad en
// gris, y los filtros son las pastillas de Cartera (`.ctv-filtro`). El analisis se redibujo: el flujo de
// caja de 12 meses + 3 proyectados en barras (verdes los intereses, grises el capital, rayadas lo por
// cobrar) con su globo, y "Donde esta tu capital" como una barra segmentada (`CbvSegbar`) con su lista,
// en vez de la dona. Mismos datos de `modeloResumen`; estilos en public/css/rendimiento.css (`.v4r`,
// prefijo `rdv-`).
//
// NINGUNA formula nueva de dinero: cada fila es el modelo del prestamo de Cartera (`modeloDeudor`), la
// ganancia es `gananciaDePrestamo` (la del Resumen y el panel: la franja suma lo mismo que la tarjeta de
// ganancias, Bug #68). Lo unico propio son los dos cocientes de la RENTABILIDAD (ver `rdFila`): la
// mensual y la acumulada, en dos columnas lado a lado (decision del PO tras ver las dos sobre el fixture).
// Nombres de nivel superior con prefijo rd/Rd/rdv/Rdv/RDV_ (el arnes aplana los modulos).

import { usdLinea } from '../componentes/CifraUSD.js';
import { Ico } from '../componentes/iconos.js';
import { copToUsd, fmt, fmtD, fmtUSD } from '../core/format.js';
import { h, useMemo, useState } from '../core/react.js';
import { diasEntre } from '../core/dominio.js';
import { modeloDeudor, opModalidad, opIniciales, opPesoEstado } from '../core/operacion.js';
import { nowStr, properCase } from '../core/ui.js';
import { modeloResumen, rzModalidad, rzCompacto, V4Dinero, V4Chip, v4PuedeAnimar } from './DashView.js';
import { CbvSeg, CbvSegbar } from './CobrosView.js';

export function rdPct(x){
  return (Math.round((x || 0) * 1000) / 10).toLocaleString('es-CO', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' %';
}

// "en 23,8 meses" / "en 1 mes" / "en menos de un mes": cuanto lleva el prestamo (dias reales / 30).
export function rdMeses(meses){
  if (meses < 1) return 'en menos de un mes';
  var r = Math.round(meses * 10) / 10;
  return 'en ' + r.toLocaleString('es-CO', { maximumFractionDigits: 1 }) + (r === 1 ? ' mes' : ' meses');
}

// Una fila de la tabla a partir del modelo del prestamo.
// RENTABILIDAD, dos columnas lado a lado (decision del PO, 3.7.0):
//   - ACUMULADA = GANANCIA OBTENIDA / CAPITAL PRESTADO, desde el inicio. Premia la antiguedad.
//   - MENSUAL = la acumulada / los MESES que lleva el prestamo (dias reales / 30, la convencion de la
//     app), hasta hoy o hasta su ultimo cobro si ya cerro. Permite comparar un prestamo viejo con uno
//     nuevo y delata la mora (rinde menos que su tasa). Con menos de un mes se divide por 1: la mensual
//     nunca supera a la acumulada (un cobro adelantado a los pocos dias daria cifras absurdas).
// En un credito en dolares las dos se miden en DOLARES -ganancia nativa en USD sobre el capital en USD-:
// es la moneda del credito, y en pesos la perdida por TRM la rebajaria (esa va debajo, en gris). Un
// `Prestamo` (sin interes) no tiene rentabilidad: su ganancia es cero por regla.
export function rdFila(m, hoy){
  var l = m.loan, esUSD = m.esUSD;
  var capUSD = esUSD ? (+l.montoOrigen || 0) : 0;
  var rentCOP = m.orig > 0 ? m.gp.cop / m.orig : 0;
  var rentUSD = esUSD && capUSD > 0 ? (m.gp.usd || 0) / capUSD : 0;
  var rent = esUSD ? rentUSD : rentCOP;
  var fin = m.activo ? (hoy || nowStr()) : (m.fechaFin || hoy || nowStr());
  var meses = Math.max(0, diasEntre(l.fechaInicio, fin)) / 30;
  var div = Math.max(1, meses);
  var mes = rent / div, mesCOP = rentCOP / div;
  var perdido = Math.round(+l.capitalPerdido || 0);
  // Lo condonado: con el endpoint (2.9.0) va en su columna; por la via vieja (abono + cierre forzoso con
  // capital recuperado al 100%) son los intereses "perdidos" de un prestamo que el modelo ya marca `condonado`.
  var condonado = Math.round(+l.interesesCondonados || 0) + (m.condonado ? Math.round(+l.interesesPerdidos || 0) : 0);
  var intPerdido = (l.estado === 'Cancelado' && !m.condonado) ? Math.round(+l.interesesPerdidos || 0) : 0;
  // El efecto TRM de un `Prestamo` USD: el panel del deudor lo muestra con la misma cifra (`recTRM`).
  var efTRM = (m.esPrest && esUSD) ? m.recTRM : 0;
  return { m: m, l: l, esUSD: esUSD, capUSD: capUSD, rent: rent, rentCOP: rentCOP, mes: mes, mesCOP: mesCOP, meses: meses,
    perdido: perdido, condonado: condonado,
    intPerdido: intPerdido, efTRM: efTRM, perdida: perdido > 0 || intPerdido > 0 || condonado > 0 || efTRM < 0,
    clave: { nombre: properCase(l.nombre), capital: m.orig, recuperado: m.pct, ganancia: m.gp.cop, mes: m.esPrest ? -1 : mes,
             rent: m.esPrest ? -1 : rent, saldo: m.activo ? m.saldo : -1, estado: opPesoEstado(m.estado) } };
}

// Todos los prestamos, cada uno con el modelo de Cartera (se agrupan por deudor como en la app).
export function rdFilas(loans, pays, hoy){
  var nombres = [], out = [];
  loans.forEach(function(l){ if (nombres.indexOf(l.nombre) === -1) nombres.push(l.nombre); });
  nombres.forEach(function(n){ modeloDeudor({ nombre: n }, loans, pays, hoy).mods.forEach(function(m){ out.push(rdFila(m, hoy)); }); });
  return out;
}

var RDV_FILTROS = [['activos', 'Activos'], ['finalizados', 'Finalizados'], ['usd', 'En dólares'], ['perdida', 'Con pérdida'], ['todos', 'Todos']];
var RDV_PASA = {
  activos: function(r){ return r.m.activo; },
  finalizados: function(r){ return !r.m.activo; },
  usd: function(r){ return r.esUSD; },
  perdida: function(r){ return r.perdida; },
  todos: function(){ return true; }
};
var RDV_ESTADO = { mora: ['En mora', 'crit'], hoy: ['Vence hoy', 'warn'], semana: ['Esta semana', 'warn'], aldia: ['Al día', 'good'],
  abierto: ['Crédito abierto', 'info'], finalizado: ['Finalizado', 'neutral'], cancelado: ['Cancelado', 'crit'], condonado: ['Condonado', 'warn'] };
var RDV_COLUMNAS = [['nombre', 'Préstamo', 'l'], ['capital', 'Capital prestado', 'r'], ['recuperado', 'Recuperado', 'l'],
  ['ganancia', 'Ganancia', 'r'], ['mes', 'Rent. mensual', 'r'], ['rent', 'Rent. acumulada', 'r'], ['saldo', 'Saldo', 'r'], ['estado', 'Estado', 'c']];
var RDV_MESES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
function rdvMes(key){ return RDV_MESES[parseInt(key.slice(5, 7), 10) - 1]; }

// ── El flujo de caja: 12 meses + 3 proyectados ───────────────────────────────────────
// Barras apiladas en la caja de cada mes (intereses abajo, capital encima) y, en el mes en curso y los
// tres que vienen, lo que falta por cobrar, rayado. Modo Ganancia: la ganancia real de cada mes.
// El eje se escala al mes mas alto; el globo de cada barra la desglosa.
function RdvFlujo(p){
  var _m = useState('caja'); var modo = _m[0], setModo = _m[1];
  var meses = p.M.meses;
  var hist = meses.slice(0, 12);
  var tCaja = hist.reduce(function(s, m){ return s + m.caja; }, 0), tInt = hist.reduce(function(s, m){ return s + m.interes; }, 0);
  var tGan = hist.reduce(function(s, m){ return s + m.ganancia; }, 0), tProy = meses.slice(12).reduce(function(s, m){ return s + m.proy; }, 0) + meses[11].proy;
  var mejor = hist.slice().sort(function(a, b){ return b.caja - a.caja; })[0];
  var alto = function(m){ return modo === 'caja' ? m.caja + m.proy : m.ganancia; };
  var tope = Math.max.apply(null, meses.map(alto).concat([1]));
  return h('section', { className: 'v4-card rdv-flujo', style: { '--i': 4 } },
    h('div', { className: 'v4-card-h' },
      h('div', null, h('div', { className: 'v4-titulo' }, 'Flujo de caja'), h('div', { className: 'v4-sub' }, 'Lo que entró cada mes, en intereses y capital, y lo que viene en los próximos tres')),
      h(CbvSeg, { valor: modo, onChange: setModo, opciones: [['caja', 'Caja'], ['ganancia', 'Ganancia']] })),
    h('div', { className: 'rdv-stats' },
      h('div', null, h('span', null, 'Cobrado en 12 meses'), h('b', null, fmt(tCaja))),
      h('div', null, h('span', null, 'De eso, intereses'), h('b', null, fmt(tInt))),
      h('div', null, h('span', null, 'Ganancia 12 meses'), h('b', { className: 'good' }, fmt(tGan))),
      h('div', null, h('span', null, 'Por cobrar (este mes y 3 más)'), h('b', null, fmt(tProy))),
      mejor && mejor.caja > 0 && h('div', null, h('span', null, 'Mejor mes'), h('b', null, rdvMes(mejor.key).charAt(0).toUpperCase() + rdvMes(mejor.key).slice(1) + ' · ' + rzCompacto(mejor.caja)))),
    h('div', { className: 'rdv-graf' },
      h('div', { className: 'rdv-eje' }, [1, .5, 0].map(function(f){
        return h('div', { key: f, className: 'rdv-eje-l', style: { bottom: (f * 100) + '%' } }, h('span', null, rzCompacto(f * tope)));
      })),
      h('div', { className: 'rdv-barras', key: modo }, meses.map(function(m, i){
        var total = alto(m), hPct = total / tope * 100;
        var lado = i < 2 ? ' start' : i > meses.length - 3 ? ' end' : '';
        var partes = modo === 'caja'
          ? [m.proy > 0 && h('i', { key: 'p', className: 'proy', style: { flexGrow: m.proy } }),
             m.interes > 0 && h('i', { key: 'i', className: 'int', style: { flexGrow: m.interes } }),
             m.capital > 0 && h('i', { key: 'c', className: 'cap', style: { flexGrow: m.capital } })]
          : [m.ganancia > 0 && h('i', { key: 'g', className: 'gan', style: { flexGrow: m.ganancia } })];
        return h('div', { key: m.key, className: 'col' + (m.actual ? ' on' : '') + (m.futuro ? ' futuro' : ''), tabIndex: 0, style: { '--i': i } },
          h('div', { className: 'barra', style: { height: (total > 0 ? Math.max(1.5, hPct) : 0) + '%' } }, partes),
          h('span', { className: 'mes' }, m.label + (m.label === 'ene' ? " '" + m.anio.slice(2) : '')),
          (total > 0 || m.caja > 0) && h('span', { className: 'v4-tip' + lado },
            h('b', null, rdvMes(m.key).charAt(0).toUpperCase() + rdvMes(m.key).slice(1) + ' ' + m.anio + (m.actual ? ' · en curso' : m.futuro ? ' · proyección' : '')),
            modo === 'caja'
              ? [m.caja > 0 && h('span', { key: 'a', className: 'f' }, h('i', { className: 'int' }), 'Intereses', h('em', null, fmt(m.interes))),
                 m.caja > 0 && h('span', { key: 'b', className: 'f' }, h('i', { className: 'cap' }), 'Capital', h('em', null, fmt(m.capital))),
                 m.proy > 0 && h('span', { key: 'c', className: 'f' }, h('i', { className: 'proy' }), m.actual ? 'Falta del mes' : 'Por vencer', h('em', null, fmt(m.proy))),
                 m.caja > 0 && h('span', { key: 'd', className: 'f tot' }, 'Entró en caja', h('em', null, fmt(m.caja)))]
              : [h('span', { key: 'a', className: 'f' }, h('i', { className: 'gan' }), 'Ganancia', h('em', null, fmt(m.ganancia))),
                 h('span', { key: 'b', className: 'f' }, 'Caja total', h('em', null, fmt(m.caja)))]));
      }))),
    h('div', { className: 'rdv-ley' },
      modo === 'caja' ? [
        h('span', { key: 'a' }, h('i', { className: 'int' }), 'Intereses cobrados'),
        h('span', { key: 'b' }, h('i', { className: 'cap' }), 'Capital devuelto'),
        h('span', { key: 'c' }, h('i', { className: 'proy' }), 'Por cobrar (cuotas pendientes)')]
      : h('span', null, h('i', { className: 'gan' }), 'Ganancia real (intereses netos de pérdida cambiaria)')));
}

// ── Donde esta el capital ───────────────────────────────────────────────────────────
function RdvComposicion(p){
  var _t = useState('deudor'); var tab = _t[0], setTab = _t[1];
  var por = p.M.por.filter(function(x){ return x.vivo > 0; });
  var total = por.reduce(function(s, x){ return s + x.vivo; }, 0);
  var grupos = {};
  por.forEach(function(x){
    var k = tab === 'deudor' ? properCase(x.nombre) : tab === 'moneda' ? (x.loan.moneda === 'USD' ? 'Dólares (USD)' : 'Pesos (COP)') : rzModalidad(x.loan.modalidad);
    grupos[k] = (grupos[k] || 0) + x.vivo;
  });
  var lista = Object.keys(grupos).map(function(k){ return { k: k, v: grupos[k] }; }).sort(function(a, b){ return b.v - a.v; });
  if (lista.length > 6){ var otros = lista.slice(5).reduce(function(s, x){ return s + x.v; }, 0); lista = lista.slice(0, 5).concat([{ k: 'Otros ' + (lista.length - 5), v: otros }]); }
  var top1 = lista[0] ? lista[0].v / (total || 1) : 0, top3 = lista.slice(0, 3).reduce(function(s, x){ return s + x.v; }, 0) / (total || 1);
  var nota = tab === 'deudor'
    ? h('div', { className: 'rdv-nota' }, h('b', null, Math.round(top3 * 100) + '%'), ' de tu capital está en los 3 deudores más grandes', top1 >= .3 ? h('span', null, ' — y ', h('b', { className: 'warn' }, Math.round(top1 * 100) + '% en uno solo'), '.') : '.')
    : tab === 'moneda'
      ? h('div', { className: 'rdv-nota' }, h('b', null, Math.round(((grupos['Dólares (USD)'] || 0) / (total || 1)) * 100) + '%'), ' del capital en la calle está en dólares: su valor en pesos se mueve con la TRM.')
      : h('div', { className: 'rdv-nota' }, 'La modalidad con más capital es ', h('b', null, lista[0] ? lista[0].k : '—'), '.');
  return h('section', { className: 'v4-card rdv-comp', style: { '--i': 5 } },
    h('div', { className: 'v4-card-h' },
      h('div', null, h('div', { className: 'v4-titulo' }, 'Dónde está tu capital'), h('div', { className: 'v4-sub' }, 'Capital en la calle · ', h('b', null, fmt(total)))),
      h(CbvSeg, { valor: tab, onChange: setTab, opciones: [['deudor', 'Deudor'], ['modalidad', 'Modalidad'], ['moneda', 'Moneda']] })),
    h(CbvSegbar, { key: tab, partes: lista.map(function(g, i){ return { k: g.k, l: g.k, tono: 's' + (i + 1), v: g.v }; }) }),
    h('div', { className: 'rdv-comp-lista', key: 'l' + tab }, lista.map(function(g, i){
      var clic = tab === 'deudor' && g.k.indexOf('Otros') !== 0;
      return h(clic ? 'button' : 'div', { key: g.k, className: 'rdv-comp-f' + (clic ? ' clic' : ''), style: { '--i': i },
          onClick: clic ? function(){ p.onNameClick(p.M.por.filter(function(x){ return properCase(x.nombre) === g.k; })[0].nombre); } : null },
        h('span', { className: 'cbv-dot s' + (i + 1) }),
        h('span', { className: 'nm' }, g.k),
        h('span', { className: 'v' }, fmt(g.v)),
        h('span', { className: 'pc' }, Math.round(g.v / (total || 1) * 100) + '%'));
    })),
    nota);
}

export function PortfolioView(props){
  var loans = props.loans || [], pays = props.pays || [];
  var hoy = nowStr();
  var onNameClick = props.onNameClick || function(){};
  var filas = useMemo(function(){ return rdFilas(loans, pays, hoy); }, [loans, pays, hoy]);
  var M = useMemo(function(){ return modeloResumen(loans, pays, hoy); }, [loans, pays, hoy]);
  var _f = useState(function(){ return loans.some(function(l){ return l.estado === 'Activo'; }) ? 'activos' : 'todos'; });
  var filtro = _f[0], setFiltro = _f[1];
  var _o = useState({ k: 'mes', dir: -1 }); var orden = _o[0], setOrden = _o[1];
  var _an = useState(v4PuedeAnimar); var anima = _an[0];

  if (!loans.length) return h('div', { className: 'v4r' },
    h('section', { className: 'v4-card v4-vacia' },
      h('span', { className: 'v4-vacia-ico' }, h(Ico, { name: 'trending', size: 26, sw: 2 })),
      h('h1', { className: 'v4-saludo' }, 'Todavía no hay préstamos'),
      h('p', null, 'Cuando registres el primero, aquí verás cuánto rinde cada préstamo y cómo va el negocio.')));

  var activas = filas.filter(function(r){ return r.m.activo; });
  var ganTotal = filas.reduce(function(s, r){ return s + r.m.gp.cop; }, 0);
  var prestadoTodo = filas.reduce(function(s, r){ return s + r.m.orig; }, 0);
  var colocado = activas.reduce(function(s, r){ return s + r.m.orig; }, 0);
  var recuperado = activas.reduce(function(s, r){ return s + r.m.recCap; }, 0);
  var saldo = activas.reduce(function(s, r){ return s + r.m.saldo; }, 0);
  var pctRec = colocado > 0 ? recuperado / colocado * 100 : 0;
  var rentCartera = prestadoTodo > 0 ? ganTotal / prestadoTodo : 0;

  var vis = filas.filter(RDV_PASA[filtro]).slice().sort(function(a, b){
    var x = a.clave[orden.k], y = b.clave[orden.k];
    var c = typeof x === 'string' ? x.localeCompare(y) : x - y;
    return c * orden.dir || a.clave.nombre.localeCompare(b.clave.nombre);
  });
  var maxRent = vis.reduce(function(s, r){ return r.m.esPrest ? s : Math.max(s, r.rent); }, 0) || 1;
  var maxMes = vis.reduce(function(s, r){ return r.m.esPrest ? s : Math.max(s, r.mes); }, 0) || 1;
  function ordenar(k){ setOrden(orden.k === k ? { k: k, dir: -orden.dir } : { k: k, dir: k === 'nombre' ? 1 : -1 }); }

  function rentCelda(r, k, v, vCOP, max, nota){
    var m = r.m;
    return h('td', { className: 'rdv-n rdv-col-' + k },
      h('div', { className: 'rdv-rent' + (m.esPrest ? ' nada' : '') }, m.esPrest ? '—' : rdPct(v)),
      !m.esPrest && h('div', { className: 'rdv-rent-b' }, h('i', { style: { width: Math.max(0, v / max * 100) + '%' } })),
      m.esPrest ? h('div', { className: 'rdv-sub' }, 'sin interés') : [
        nota && h('div', { key: 'n', className: 'rdv-sub' }, nota),
        r.esUSD && Math.abs(v - vCOP) >= 0.0005 && h('div', { key: 'p', className: 'rdv-sub' }, 'en pesos ' + rdPct(vCOP))]);
  }
  function fila(r, i){
    var m = r.m, l = r.l, est = RDV_ESTADO[m.estado] || ['', 'neutral'];
    var tono = m.estado === 'mora' || m.estado === 'cancelado' ? 'crit' : (m.estado === 'hoy' || m.estado === 'semana') ? 'warn' : m.estado === 'abierto' ? 'info' : '';
    var notas = [];
    if (r.condonado > 0) notas.push(h('div', { key: 'c', className: 'rdv-nota-f warn' }, 'condonó ' + fmt(r.condonado)));
    if (r.intPerdido > 0) notas.push(h('div', { key: 'i', className: 'rdv-nota-f crit' }, 'perdió ' + fmt(r.intPerdido) + ' de intereses'));
    if (r.perdido > 0) notas.push(h('div', { key: 'k', className: 'rdv-nota-f crit' }, 'perdió ' + fmt(r.perdido) + ' de capital'));
    if (r.efTRM < 0) notas.push(h('div', { key: 't', className: 'rdv-nota-f crit' }, 'efecto TRM −' + fmt(-r.efTRM)));
    return h('tr', { key: l.id, className: 'rdv-fila' + (m.activo ? '' : ' cerrado'), style: { '--i': i }, title: 'Abrir ' + properCase(l.nombre) + ' en Cartera',
        onClick: function(){ onNameClick(l.nombre, l.id); } },
      h('td', { className: 'rdv-col-nombre' },
        h('div', { className: 'rdv-quien' },
          h('span', { className: 'cbv-av' + (tono ? ' ' + tono : '') }, opIniciales(l.nombre)),
          h('div', { className: 'rdv-quien-c' },
            h('div', { className: 'rdv-nom' }, properCase(l.nombre), r.esUSD && h('span', { className: 'dp-usdtag' }, 'USD')),
            h('div', { className: 'rdv-sub' }, opModalidad(l.modalidad, true) + ' · ' + (m.activo ? 'desde ' + fmtD(l.fechaInicio) : 'cerrado el ' + fmtD(m.fechaFin || l.fechaInicio)))))),
      h('td', { className: 'rdv-n rdv-col-capital' }, fmt(m.orig), r.esUSD && usdLinea(fmtUSD(r.capUSD))),
      h('td', { className: 'rdv-col-recuperado' },
        h('div', { className: 'rdv-rec' },
          h('div', { className: 'rdv-barra' }, h('i', { style: { width: m.pct + '%' } })),
          h('span', { className: 'rdv-rec-p' }, m.pct + ' %')),
        h('div', { className: 'rdv-rec-v' }, fmt(m.recCap)),
        r.esUSD && usdLinea(copToUsd(m.recCap, m.trm))),
      h('td', { className: 'rdv-n rdv-col-ganancia' },
        h('div', { className: 'rdv-gan' + (m.gp.cop > 0 ? ' good' : '') }, (m.gp.cop > 0 ? '+' : '') + fmt(m.gp.cop)),
        r.esUSD && !m.esPrest && usdLinea((m.gp.usd > 0 ? '+' : '') + fmtUSD(m.gp.usd || 0)),
        notas),
      rentCelda(r, 'mes', r.mes, r.mesCOP, maxMes, null),
      rentCelda(r, 'rent', r.rent, r.rentCOP, maxRent, rdMeses(r.meses)),
      h('td', { className: 'rdv-n rdv-col-saldo' }, m.activo
        ? [fmt(m.saldo), r.esUSD && h('div', { key: 'u' }, usdLinea(copToUsd(m.saldo, m.trm)))]
        : h('span', { className: 'rdv-sub' }, '—')),
      h('td', { className: 'rdv-c rdv-col-estado' }, h(V4Chip, { tono: est[1] }, est[0])));
  }

  return h('div', { className: 'v4r' + (anima ? ' anima' : '') },
    h('div', { className: 'rdv-intro', style: { '--i': -1 } }, 'Cuánto rinde cada préstamo y cómo va el negocio.'),

    h('section', { className: 'v4-card rdv-cifras', style: { '--i': 0 } },
      h('div', { className: 'rdv-cifra' },
        h('div', { className: 'cbv-kl' }, 'Ganancia obtenida'),
        h('div', { className: 'rdv-cifra-v good' }, h(V4Dinero, { v: ganTotal, animar: true })),
        h('div', { className: 'rdv-cifra-s' }, 'Últimos 12 meses: ', h('b', null, fmt(M.ganancia12)))),
      h('div', { className: 'rdv-cifra' },
        h('div', { className: 'cbv-kl' }, 'Rentabilidad de la cartera'),
        h('div', { className: 'rdv-cifra-v' }, rdPct(rentCartera).replace(' %', ''), h('span', { className: 'pc' }, '%')),
        h('div', { className: 'rdv-cifra-s' }, 'Ganancia sobre ', h('b', null, fmt(prestadoTodo)), ' prestados en total')),
      h('div', { className: 'rdv-cifra' },
        h('div', { className: 'cbv-kl' }, 'Capital colocado'),
        h('div', { className: 'rdv-cifra-v' }, h(V4Dinero, { v: colocado, animar: true })),
        h('div', { className: 'rdv-cifra-meter' }, h('i', { style: { width: Math.max(0, Math.min(100, pctRec)) + '%' } })),
        h('div', { className: 'rdv-cifra-s' }, h('b', null, activas.length), ' préstamo' + (activas.length === 1 ? '' : 's') + ' activo' + (activas.length === 1 ? '' : 's') + ' · ',
          h('b', null, Math.round(pctRec) + ' %'), ' recuperado')),
      h('div', { className: 'rdv-cifra' },
        h('div', { className: 'cbv-kl' }, 'Saldo en la calle'),
        h('div', { className: 'rdv-cifra-v' }, h(V4Dinero, { v: saldo, animar: true })),
        h('div', { className: 'rdv-cifra-s' }, 'Lo que falta por recuperar de los activos'))),

    h('section', { className: 'v4-card rdv-card', style: { '--i': 1 } },
      h('div', { className: 'rdv-card-h' },
        h('div', { className: 'ctv-filtros' }, RDV_FILTROS.map(function(f){
          var n = filas.filter(RDV_PASA[f[0]]).length;
          return h('button', { key: f[0], className: 'ctv-filtro' + (filtro === f[0] ? ' on' : ''), onClick: function(){ setFiltro(f[0]); } }, f[1], h('span', null, n));
        })),
        h('div', { className: 'rdv-ayuda' }, h(Ico, { name: 'sparkle', size: 13, sw: 2 }), 'Rent. mensual = la acumulada ÷ los meses del préstamo · Rent. acumulada = ganancia obtenida ÷ capital prestado')),
      vis.length ? h('div', { className: 'rdv-tabla' },
        h('table', { className: 'rdv-t' },
          h('thead', null, h('tr', null, RDV_COLUMNAS.map(function(c){
            var on = orden.k === c[0];
            return h('th', { key: c[0], className: 'rdv-' + c[2] + ' rdv-col-' + c[0] + (on ? ' on' : '') },
              h('button', { onClick: function(){ ordenar(c[0]); } }, c[1],
                h('span', { className: 'rdv-flecha' }, on ? (orden.dir > 0 ? '↑' : '↓') : '↕')));
          }))),
          h('tbody', { key: filtro + '|' + orden.k + '|' + orden.dir }, vis.map(fila))))
        : h('div', { className: 'rdv-vacio' }, 'Ningún préstamo en este filtro.'),
      h('div', { className: 'rdv-pie' }, vis.length + ' préstamo' + (vis.length === 1 ? '' : 's') + ' · Toca uno para abrirlo en Cartera')),

    h('div', { className: 'rdv-sec', style: { '--i': 3 } }, h('span', { className: 't' }, 'Análisis del negocio'), h('span', null, 'Flujo de caja de 12 meses y dónde está tu capital')),
    h('div', { className: 'rdv-analisis' },
      h(RdvFlujo, { M: M }),
      h(RdvComposicion, { M: M, onNameClick: onNameClick })));
}
