// public/js/vistas/PortfolioView.js — Rendimiento: cuanto rinde cada prestamo y como va el negocio (3.7.0).
//
// Rediseno aprobado por el PO sobre un prototipo navegable con los datos del fixture. Reemplaza a las
// tarjetas de una columna (una por prestamo, pensadas para la ventana de 460 px) por:
//   1. una franja de cuatro cifras (ganancia obtenida, rentabilidad de la cartera, capital colocado y
//      saldo en la calle);
//   2. una TABLA de prestamos con filtros (activos, finalizados, en dolares, con perdida, todos) y orden
//      por columna; un clic en una fila abre el panel del deudor en Cartera (`onNameClick`, el mismo de
//      los nombres del Resumen);
//   3. el "Analisis del negocio" que vivia en el Resumen (decision del PO): `RzFlujo` y `RzComposicion`,
//      importados de DashView sin tocarlos.
//
// NINGUNA formula nueva de dinero: cada fila es el modelo del prestamo de Cartera (`modeloDeudor`), la
// ganancia es `gananciaDePrestamo` (la del Resumen y el panel: la franja suma lo mismo que la tarjeta de
// ganancias, Bug #68). Lo unico nuevo son los dos cocientes de la RENTABILIDAD (ver `rdFila`): la
// mensual y la acumulada, en dos columnas lado a lado (decision del PO tras ver las dos sobre el fixture).
// Nombres de nivel superior con prefijo rd/Rd/RD_ (el arnes aplana los modulos).

import { usdLinea } from '../componentes/CifraUSD.js';
import { copToUsd, fmt, fmtD, fmtUSD } from '../core/format.js';
import { h, useMemo, useState } from '../core/react.js';
import { diasEntre } from '../core/dominio.js';
import { modeloDeudor, opModalidad, opIniciales, opPesoEstado } from '../core/operacion.js';
import { nowStr, properCase } from '../core/ui.js';
import { modeloResumen, RzFlujo, RzComposicion } from './DashView.js';

var RD_FILTROS = [['activos', 'Activos'], ['finalizados', 'Finalizados'], ['usd', 'En dólares'], ['perdida', 'Con pérdida'], ['todos', 'Todos']];
var RD_PASA = {
  activos: function(r){ return r.m.activo; },
  finalizados: function(r){ return !r.m.activo; },
  usd: function(r){ return r.esUSD; },
  perdida: function(r){ return r.perdida; },
  todos: function(){ return true; }
};
var RD_ESTADO = { mora: ['En mora', 'r'], hoy: ['Vence hoy', 'y'], semana: ['Esta semana', 'y'], aldia: ['Al día', 'g'],
  abierto: ['Crédito abierto', 'b'], finalizado: ['Finalizado', 'n'], cancelado: ['Cancelado', 'r'], condonado: ['Condonado', 'y'] };
// [clave de orden, rotulo, alineacion]
var RD_COLUMNAS = [['nombre', 'Préstamo', 'l'], ['capital', 'Capital prestado', 'r'], ['recuperado', 'Recuperado', 'l'],
  ['ganancia', 'Ganancia', 'r'], ['mes', 'Rent. mensual', 'r'], ['rent', 'Rent. acumulada', 'r'], ['saldo', 'Saldo', 'r'], ['estado', 'Estado', 'c']];

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

function RdCifra(p){
  return h('div', { className: 'rd-cifra' },
    h('div', { className: 'rd-cifra-l' }, p.l),
    h('div', { className: 'rd-cifra-v' + (p.tono ? ' ' + p.tono : '') }, p.v),
    p.s && h('div', { className: 'rd-cifra-s' }, p.s),
    p.barra != null && h('div', { className: 'rd-cifra-barra' }, h('div', { style: { width: Math.max(0, Math.min(100, p.barra)) + '%' } })));
}

export function PortfolioView(props){
  var loans = props.loans || [], pays = props.pays || [];
  var hoy = nowStr();
  var onNameClick = props.onNameClick || function(){};
  var onNav = props.onNav || function(){};
  var filas = useMemo(function(){ return rdFilas(loans, pays, hoy); }, [loans, pays, hoy]);
  var M = useMemo(function(){ return modeloResumen(loans, pays, hoy); }, [loans, pays, hoy]);
  var _f = useState(function(){ return loans.some(function(l){ return l.estado === 'Activo'; }) ? 'activos' : 'todos'; });
  var filtro = _f[0], setFiltro = _f[1];
  var _o = useState({ k: 'mes', dir: -1 }); var orden = _o[0], setOrden = _o[1];

  if (!loans.length) return h('div', { className: 'rd' },
    h('div', { className: 'rd-cab' }, h('h1', null, 'Rendimiento'), h('p', null, 'Cuánto rinde cada préstamo y cómo va el negocio.')),
    h('div', { className: 'rd-card rd-vacio' }, 'Todavía no hay préstamos. Cuando registres el primero, aquí verás cuánto rinde.'));

  // ── Las cifras de arriba ──────────────────────────────────────────────────
  var activas = filas.filter(function(r){ return r.m.activo; });
  var ganTotal = filas.reduce(function(s, r){ return s + r.m.gp.cop; }, 0);
  var prestadoTodo = filas.reduce(function(s, r){ return s + r.m.orig; }, 0);
  var colocado = activas.reduce(function(s, r){ return s + r.m.orig; }, 0);
  var recuperado = activas.reduce(function(s, r){ return s + r.m.recCap; }, 0);
  var saldo = activas.reduce(function(s, r){ return s + r.m.saldo; }, 0);
  var pctRec = colocado > 0 ? recuperado / colocado * 100 : 0;

  // ── La tabla ──────────────────────────────────────────────────────────────
  var vis = filas.filter(RD_PASA[filtro]).slice().sort(function(a, b){
    var x = a.clave[orden.k], y = b.clave[orden.k];
    var c = typeof x === 'string' ? x.localeCompare(y) : x - y;
    return c * orden.dir || a.clave.nombre.localeCompare(b.clave.nombre);
  });
  var maxRent = vis.reduce(function(s, r){ return r.m.esPrest ? s : Math.max(s, r.rent); }, 0) || 1;
  var maxMes = vis.reduce(function(s, r){ return r.m.esPrest ? s : Math.max(s, r.mes); }, 0) || 1;
  function ordenar(k){ setOrden(orden.k === k ? { k: k, dir: -orden.dir } : { k: k, dir: k === 'nombre' ? 1 : -1 }); }

  // Una celda de rentabilidad (mensual o acumulada): el porcentaje, su barra relativa a su columna y,
  // debajo, cuanto lleva el prestamo (solo en la acumulada) y, en dolares, la cifra medida en pesos.
  function rentCelda(r, k, v, vCOP, max, nota){
    var m = r.m;
    return h('td', { className: 'rd-n rd-col-' + k },
      h('div', { className: 'rd-rent' + (m.esPrest ? ' nada' : '') }, m.esPrest ? '—' : rdPct(v)),
      !m.esPrest && h('div', { className: 'rd-rent-b' }, h('div', { style: { width: Math.max(0, v / max * 100) + '%' } })),
      m.esPrest ? h('div', { className: 'rd-sub' }, 'sin interés') : [
        nota && h('div', { key: 'n', className: 'rd-sub' }, nota),
        r.esUSD && Math.abs(v - vCOP) >= 0.0005 && h('div', { key: 'p', className: 'rd-sub' }, 'en pesos ' + rdPct(vCOP))]);
  }

  function fila(r){
    var m = r.m, l = r.l, est = RD_ESTADO[m.estado] || ['', 'n'];
    var notas = [];
    if (r.condonado > 0) notas.push(h('div', { key: 'c', className: 'rd-nota y' }, 'condonó ' + fmt(r.condonado)));
    if (r.intPerdido > 0) notas.push(h('div', { key: 'i', className: 'rd-nota r' }, 'perdió ' + fmt(r.intPerdido) + ' de intereses'));
    if (r.perdido > 0) notas.push(h('div', { key: 'k', className: 'rd-nota r' }, 'perdió ' + fmt(r.perdido) + ' de capital'));
    if (r.efTRM < 0) notas.push(h('div', { key: 't', className: 'rd-nota r' }, 'efecto TRM −' + fmt(-r.efTRM)));
    return h('tr', { key: l.id, className: 'rd-fila' + (m.activo ? '' : ' cerrado'), title: 'Abrir ' + properCase(l.nombre) + ' en Cartera',
        onClick: function(){ onNameClick(l.nombre, l.id); } },
      h('td', { className: 'rd-col-nombre' },
        h('div', { className: 'rd-quien' },
          h('div', { className: 'rd-av e-' + m.estado }, opIniciales(l.nombre)),
          h('div', { className: 'rd-quien-c' },
            h('div', { className: 'rd-nom' }, properCase(l.nombre), r.esUSD && h('span', { className: 'dp-usdtag' }, 'USD')),
            h('div', { className: 'rd-sub' }, opModalidad(l.modalidad, true) + ' · ' +
              (m.activo ? 'desde ' + fmtD(l.fechaInicio) : 'cerrado el ' + fmtD(m.fechaFin || l.fechaInicio)))))),
      h('td', { className: 'rd-n rd-col-capital' }, fmt(m.orig), r.esUSD && usdLinea(fmtUSD(r.capUSD))),
      h('td', { className: 'rd-col-recuperado' },
        h('div', { className: 'rd-rec' },
          h('div', { className: 'rd-barra' }, h('div', { style: { width: m.pct + '%' } })),
          h('span', { className: 'rd-rec-p' }, m.pct + ' %'))),
      h('td', { className: 'rd-n rd-col-ganancia' },
        h('div', { className: 'rd-gan' + (m.gp.cop > 0 ? ' g' : '') }, (m.gp.cop > 0 ? '+' : '') + fmt(m.gp.cop)),
        r.esUSD && !m.esPrest && usdLinea((m.gp.usd > 0 ? '+' : '') + fmtUSD(m.gp.usd || 0)),
        notas),
      rentCelda(r, 'mes', r.mes, r.mesCOP, maxMes, null),
      rentCelda(r, 'rent', r.rent, r.rentCOP, maxRent, rdMeses(r.meses)),
      h('td', { className: 'rd-n rd-col-saldo' }, m.activo
        ? [fmt(m.saldo), r.esUSD && h('div', { key: 'u' }, usdLinea(copToUsd(m.saldo, m.trm)))]
        : h('span', { className: 'rd-sub' }, '—')),
      h('td', { className: 'rd-c rd-col-estado' }, h('span', { className: 'rd-chip ' + est[1] }, est[0])));
  }

  return h('div', { className: 'rd' },
    h('div', { className: 'rd-cab' },
      h('h1', null, 'Rendimiento'),
      h('p', null, 'Cuánto rinde cada préstamo y cómo va el negocio.')),

    h('div', { className: 'rd-cifras' },
      h(RdCifra, { l: 'Ganancia obtenida', v: fmt(ganTotal), tono: 'g', s: ['Últimos 12 meses: ', h('b', { key: 'b' }, fmt(M.ganancia12))] }),
      h(RdCifra, { l: 'Rentabilidad de la cartera', v: rdPct(prestadoTodo > 0 ? ganTotal / prestadoTodo : 0),
        s: ['Ganancia sobre ', h('b', { key: 'b' }, fmt(prestadoTodo)), ' prestados en total'] }),
      h(RdCifra, { l: 'Capital colocado', v: fmt(colocado), barra: pctRec,
        s: [h('b', { key: 'b' }, activas.length), ' préstamo' + (activas.length === 1 ? '' : 's') + ' activo' + (activas.length === 1 ? '' : 's') + ' · ',
            h('b', { key: 'c' }, Math.round(pctRec) + ' %'), ' recuperado'] }),
      h(RdCifra, { l: 'Saldo en la calle', v: fmt(saldo), s: 'Lo que falta por recuperar de los activos' })),

    h('div', { className: 'rd-card' },
      h('div', { className: 'rd-card-h' },
        h('div', { className: 'rd-filtros' }, RD_FILTROS.map(function(f){
          var n = filas.filter(RD_PASA[f[0]]).length;
          return h('button', { key: f[0], className: 'rd-filtro' + (filtro === f[0] ? ' on' : ''), onClick: function(){ setFiltro(f[0]); } },
            f[1], h('span', null, n));
        })),
        h('div', { className: 'rd-ayuda' }, 'Rent. mensual = la acumulada ÷ los meses del préstamo · Rent. acumulada = ganancia obtenida ÷ capital prestado')),
      vis.length ? h('div', { className: 'rd-tabla' },
        h('table', { className: 'rd-t' },
          h('thead', null, h('tr', null, RD_COLUMNAS.map(function(c){
            var on = orden.k === c[0];
            return h('th', { key: c[0], className: 'rd-' + c[2] + ' rd-col-' + c[0] + (on ? ' on' : '') },
              h('button', { onClick: function(){ ordenar(c[0]); } }, c[1],
                h('span', { className: 'rd-flecha' }, on ? (orden.dir > 0 ? '↑' : '↓') : '↕')));
          }))),
          h('tbody', null, vis.map(fila))))
        : h('div', { className: 'rd-vacio' }, 'Ningún préstamo en este filtro.'),
      h('div', { className: 'rd-pie' }, vis.length + ' préstamo' + (vis.length === 1 ? '' : 's') + ' · Toca uno para abrirlo en Cartera')),

    h('div', { className: 'rd-sec' }, 'Análisis del negocio', h('span', null, 'Flujo de caja de 12 meses y dónde está tu capital')),
    h('div', { className: 'rz rd-analisis' },
      h(RzFlujo, { M: M, hoy: hoy, pays: pays, onNav: onNav, onNameClick: onNameClick }),
      h(RzComposicion, { M: M, hoy: hoy, pays: pays, onNav: onNav, onNameClick: onNameClick })));
}
