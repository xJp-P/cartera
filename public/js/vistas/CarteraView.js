// public/js/vistas/CarteraView.js — Cartera: deudores y prestamos en una sola pantalla (3.5.0;
// fusiona las viejas pestanas Cartera y Deudores).
//
// A la izquierda, las personas (con sus prestamos activos como chips), ordenadas por lo que
// necesita atencion primero. A la derecha, el panel del deudor elegido. El prestamo deja de vivir
// en dos lugares (la tarjeta de Cartera y el perfil del deudor): vive en uno.
//
// `props.foco` ({nombre, loanId, payId}) abre un deudor concreto: es como llegan aqui los nombres
// del Resumen y la busqueda global. App remonta la vista (key) con cada foco nuevo.
//
// `props.memoria` (3.6.0) es lo que la pestana recuerda entre visitas: el filtro, el orden, el
// deudor abierto y, si el usuario eligio uno, su prestamo ({filtro, orden, sel, loan}). Vive en App
// porque la vista se DESMONTA al cambiar de pestana; antes, al volver, el filtro regresaba a
// "Activos" y el panel al primero de la lista. Se escribe en cada clic que cambia algo de eso (no
// en un efecto: lo que se recuerda es lo que el usuario eligio, y asi lo prueba `operacion` G).
// 3.7.0: ademas SOBREVIVE AL CIERRE de la app. Cada escritura avisa a `props.onMemoria`, que en App
// es `ctGuardarMemoria` (localStorage, como el tema y el menu); App la lee una vez al arrancar con
// `ctLeerMemoria`, que valida cada campo: un dato viejo o corrupto nunca rompe la vista.
//
// REDISEÑO v4 (aprobado por el PO sobre el prototipo; integrado pestaña por pestaña, fase 3). MISMO
// comportamiento que la vista de 3.7.1: los filtros con su conteo, el orden, la busqueda por nombre o
// telefono, la memoria, el foco, el primero de la lista abierto en escritorio y el panel encima bajo
// 1.100 px. Las cifras salen de `modeloDeudor`, sin formulas nuevas: la barra del encabezado solo SUMA
// los saldos de cada deudor segun su estado. Cambia la presentacion:
//   - un encabezado con lo que esta en la calle, una barra que lo reparte por estado (al dia, cobra
//     pronto, en mora, credito abierto) y su leyenda: cada estado en dos renglones (el rotulo con su
//     conteo arriba y el monto abajo), para que el conteo no quede pegado al monto (reporte del PO);
//   - los filtros como pastillas y el orden como un selector de la misma familia;
//   - la lista es UNA tarjeta con filas separadas por lineas y, en "Lo urgente primero", agrupada por
//     estado con su encabezado (cuantos y cuanto suman);
//   - en cada fila, el avatar con el tono del estado, los prestamos como chips neutros con su punto y
//     una barra fina de lo que ya volvio con su porcentaje;
//   - el panel del deudor con el diseño nuevo (la raiz lleva `.v4p`, como la de Cobros).
// Estilos en public/css/cartera.css (`.v4t`, `.ctv-*`), sobre cobros.css (buscador, puntos, barra
// segmentada) y panel.css. Prefijo `ctv`/`CTV_` (el arnes aplana los modulos en un ambito).

import { DeudorPanel } from '../componentes/DeudorPanel.js';
import { Ico } from '../componentes/iconos.js';
import { fmt, fmtN, fmtUSD } from '../core/format.js';
import { modeloDeudor, opModalidad, opIniciales, opCorta, opRel, opPesoEstado } from '../core/operacion.js';
import { h, useEffect, useMemo, useState } from '../core/react.js';
import { addDays, contiene, properCase } from '../core/ui.js';
import { usdLinea } from '../componentes/CifraUSD.js';
import { V4Dinero, v4PuedeAnimar } from './DashView.js';
import { CbvSegbar } from './CobrosView.js';

var CT_FILTROS = [['activos', 'Activos'], ['mora', 'En mora'], ['semana', 'Cobran esta semana'], ['usd', 'En dólares'], ['inactivos', 'Sin préstamos activos'], ['todos', 'Todos']];
var CT_ORDEN = [['prioridad', 'Lo urgente primero'], ['saldo', 'Mayor saldo'], ['nombre', 'Nombre'], ['recientes', 'Préstamo más reciente']];
// Los grupos de la lista en "Lo urgente primero", en el orden de `opPesoEstado`.
var CTV_GRUPO = { mora: 'mora', hoy: 'pronto', semana: 'pronto', aldia: 'aldia', abierto: 'abierto', inactivo: 'inactivo' };
var CTV_GRUPOS = { mora: ['En mora', 'crit'], pronto: ['Cobran esta semana', 'warn'], aldia: ['Al día', 'good'], abierto: ['Crédito abierto', 'info'], inactivo: ['Sin préstamos activos', 'track'] };

// La memoria en disco (3.7.0). Se guarda SOLO lo que la vista sabe restaurar, y al leerla se
// descarta lo que ya no tiene sentido: un filtro u orden que no existe, un deudor que no es texto. Si
// el deudor guardado ya no esta en la cartera, la vista abre el primero de la lista (como siempre).
var CT_CLAVE = 'carteraMemoria';
export function ctLeerMemoria(){
  var m;
  try { m = JSON.parse(localStorage.getItem(CT_CLAVE)); } catch (_) { return {}; }
  if (!m || typeof m !== 'object') return {};
  var out = {};
  if (CT_FILTROS.some(function(f){ return f[0] === m.filtro; })) out.filtro = m.filtro;
  if (CT_ORDEN.some(function(o){ return o[0] === m.orden; })) out.orden = m.orden;
  if (m.sel === null || (typeof m.sel === 'string' && m.sel)){ out.sel = m.sel; out.loan = typeof m.loan === 'string' && m.loan ? m.loan : null; }
  return out;
}
export function ctGuardarMemoria(mem){
  try { localStorage.setItem(CT_CLAVE, JSON.stringify({ filtro: mem.filtro, orden: mem.orden, sel: mem.sel, loan: mem.loan })); } catch (_) {}
}

// Que deudores deja pasar cada filtro (sobre `modeloDeudor`).
function ctPasa(hoy){
  return {
    activos: function(x){ return x.activos.length > 0; },
    mora: function(x){ return x.moraN > 0; },
    semana: function(x){ return x.prox && x.prox.p.fechaPago <= addDays(hoy, 7); },
    usd: function(x){ return x.activos.some(function(m){ return m.esUSD; }); },
    inactivos: function(x){ return x.activos.length === 0; },
    todos: function(){ return true; }
  };
}
// 3.6.0 — el filtro con el que abre la pestana: el que el usuario dejo la ultima vez. Si se llega
// con un foco (un nombre del Resumen o de la busqueda) y esa persona no pasa ese filtro, se abre
// uno donde si aparezca: el panel no puede mostrar a alguien que la lista esconde.
function ctFiltroInicial(foco, mem, deudores, loans, pays, hoy){
  var f = foco && foco.filtro ? foco.filtro : (mem.filtro || 'activos');
  var d = foco && foco.nombre ? deudores.filter(function(x){ return x.nombre === foco.nombre; })[0] : null;
  if (!d) return f;
  var pasa = ctPasa(hoy), x = modeloDeudor(d, loans, pays, hoy);
  return pasa[f] && pasa[f](x) ? f : pasa.activos(x) ? 'activos' : 'todos';
}
function ctvPl(n, s, p){ return n + ' ' + (n === 1 ? s : (p || s + 's')); }

export function CarteraView(props){
  var loans = props.loans, pays = props.pays, hoy = props.hoy, foco = props.foco;
  var mem = props.memoria || {};
  function guardar(){ if (props.onMemoria) props.onMemoria(mem); }
  var _q = useState(''); var q = _q[0], setQ = _q[1];
  // El filtro con el que se abre queda en la memoria: si un foco lo cambio, al volver por el menu
  // la pestana no puede abrir un filtro que esconda al deudor del panel.
  var _f = useState(function(){ var f = ctFiltroInicial(foco, mem, props.deudores, loans, pays, hoy); mem.filtro = f; guardar(); return f; }); var filtro = _f[0], setFiltro = _f[1];
  var _o = useState(mem.orden || 'prioridad'); var orden = _o[0], setOrden = _o[1];
  var _w = useState(window.innerWidth); var ancho = _w[0], setAncho = _w[1];
  useEffect(function(){
    function r(){ setAncho(window.innerWidth); }
    window.addEventListener('resize', r); return function(){ window.removeEventListener('resize', r); };
  }, []);
  // Ventana angosta (la minima de la app es 1.000 px): la lista ocupa todo y el panel se abre encima.
  var superpuesto = ancho < 1100;

  var todos = useMemo(function(){ return props.deudores.map(function(d){ return modeloDeudor(d, loans, pays, hoy); }); }, [props.deudores, loans, pays, hoy]);
  var cuenta = function(fn){ return todos.filter(fn).length; };
  var pasa = ctPasa(hoy);
  // Un filtro que se quedo sin nadie (el recordado, o "En mora" tras cobrar la ultima cuota
  // vencida) esconde su boton: la lista cae a "Activos" en vez de quedar vacia sin un boton
  // encendido. El estado conserva la eleccion del usuario.
  var filtroVivo = pasa[filtro] && (filtro === 'activos' || filtro === 'todos' || cuenta(pasa[filtro]) > 0) ? filtro : 'activos';
  var lista = todos.filter(pasa[filtroVivo]).filter(function(x){
    if (!q) return true;
    return contiene(x.nombre, q) || (x.d.telefono || '').indexOf(q.trim()) !== -1;
  });
  lista.sort(function(a, b){
    if (orden === 'saldo') return b.saldo - a.saldo;
    if (orden === 'nombre') return a.nombre.localeCompare(b.nombre);
    if (orden === 'recientes'){ var fa = a.mods.reduce(function(m, x){ return x.loan.fechaInicio > m ? x.loan.fechaInicio : m; }, ''), fb = b.mods.reduce(function(m, x){ return x.loan.fechaInicio > m ? x.loan.fechaInicio : m; }, ''); return fb.localeCompare(fa); }
    var pa = a.activos.length ? opPesoEstado(a.estado) : 9, pb = b.activos.length ? opPesoEstado(b.estado) : 9;
    return pa - pb || b.moraDias - a.moraDias || (a.prox && b.prox ? a.prox.p.fechaPago.localeCompare(b.prox.p.fechaPago) : (a.prox ? -1 : b.prox ? 1 : 0)) || b.saldo - a.saldo;
  });

  // El deudor abierto: el del foco; si no, el que estaba abierto la ultima vez, si sigue existiendo
  // (`null` = el usuario cerro el panel, y se respeta); si no, el primero de la lista.
  var recuerda = !(foco && foco.nombre) && mem.sel !== undefined &&
    (mem.sel === null || props.deudores.some(function(d){ return d.nombre === mem.sel; }));
  var inicial = foco && foco.nombre ? foco.nombre : recuerda ? mem.sel : (!superpuesto && lista[0] ? lista[0].nombre : null);
  var loanIni = foco && foco.nombre ? (foco.loanId || null) : recuerda ? (mem.loan || null) : null;
  // Lo que se abre queda en la memoria, tambien el primero de la lista que la vista eligio sola:
  // es el perfil que el usuario tenia a la vista al irse.
  var _s = useState(function(){ if (inicial !== null){ mem.sel = inicial; mem.loan = loanIni; guardar(); } return inicial; }); var sel = _s[0], setSel = _s[1];
  var _fl = useState(foco && foco.loanId ? { loan: foco.loanId, pay: foco.payId } : loanIni ? { loan: loanIni } : null); var focoL = _fl[0], setFocoL = _fl[1];
  // Las entradas animadas solo con la ventana visible (y sin "reducir movimiento"); va al final para
  // no mover el orden de los demas estados.
  var _an = useState(v4PuedeAnimar); var anima = _an[0];
  var deudorSel = sel ? props.deudores.filter(function(d){ return d.nombre === sel; })[0] : null;
  function abrir(nombre, loanId){ setSel(nombre); setFocoL(loanId ? { loan: loanId } : null); mem.sel = nombre; mem.loan = loanId || null; guardar(); }
  function filtrar(f){ setFiltro(f); mem.filtro = f; guardar(); }

  var activos = todos.filter(function(x){ return x.activos.length; });
  var calle = activos.reduce(function(s, x){ return s + x.saldo; }, 0);
  var prestado = activos.reduce(function(s, x){ return s + x.prestado; }, 0);
  var pctRec = prestado ? Math.round((1 - calle / prestado) * 100) : 0;
  // La calle por estado: la suma de los saldos de cada deudor, segun su estado (`modeloDeudor`).
  var porEstado = { aldia: { v: 0, n: 0 }, pronto: { v: 0, n: 0 }, mora: { v: 0, n: 0 }, abierto: { v: 0, n: 0 } };
  activos.forEach(function(x){ var g = porEstado[CTV_GRUPO[x.estado]]; if (g){ g.v += x.saldo; g.n++; } });

  function fila(x, i){
    var on = sel === x.nombre;
    var tono = x.estado === 'mora' ? 'crit' : (x.estado === 'hoy' || x.estado === 'semana') ? 'warn' : x.estado === 'abierto' ? 'info' : '';
    var linea = x.estado === 'mora' ? h('span', { className: 'crit' }, fmt(x.mora) + ' vencidos · ' + ctvPl(x.moraDias, 'día'))
      : x.prox ? h('span', { className: x.prox.p.fechaPago === hoy ? 'warn' : '' }, 'próxima ' + opCorta(x.prox.p.fechaPago) + ' · ' + opRel(hoy, x.prox.p.fechaPago))
      : x.activos.length ? h('span', { className: 'info' }, 'crédito abierto')
      : h('span', null, x.ultimo ? 'último pago ' + opCorta(x.ultimo.fecha) : 'sin movimientos');
    var pct = x.prestado > 0 ? Math.max(0, Math.min(100, Math.round((1 - x.saldo / x.prestado) * 100))) : 0;
    return h('button', { key: x.nombre, className: 'ctv-fila' + (on ? ' on' : '') + (x.activos.length ? '' : ' inactivo'), style: { '--i': i }, onClick: function(){ abrir(x.nombre, null); } },
      h('span', { className: 'ctv-av' + (tono ? ' ' + tono : '') }, opIniciales(x.nombre)),
      h('span', { className: 'ctv-c' },
        h('span', { className: 'ctv-1' },
          h('span', { className: 'ctv-nombre' }, properCase(x.nombre)),
          x.activos.length > 0 && h('span', { className: 'ctv-saldo' }, fmt(x.saldo))),
        h('span', { className: 'ctv-2' }, linea, x.saldoUSD > 0 && usdLinea(fmtUSD(x.saldoUSD), null, 'span')),
        x.activos.length > 0 && h('span', { className: 'ctv-chips' },
          x.activos.map(function(m){
            return h('span', { key: m.loan.id, className: 'ctv-chip e-' + m.estado, title: opModalidad(m.loan.modalidad) + ' · debe ' + fmt(m.saldo),
                onClick: function(e){ e.stopPropagation(); abrir(x.nombre, m.loan.id); } },
              h('i', null), (m.esUSD ? 'USD ' + fmtN(m.loan.montoOrigen) : fmt(m.loan.montoOrigen)) + ' · ' + opModalidad(m.loan.modalidad, true));
          }),
          x.cerrados.length > 0 && h('span', { className: 'ctv-chip cerrado' }, '+' + x.cerrados.length + ' cerrado' + (x.cerrados.length > 1 ? 's' : ''))),
        x.activos.length > 0 && h('span', { className: 'ctv-meter', title: pct + '% del capital prestado ya volvió' },
          h('span', { className: 'pista' }, h('i', { style: { width: pct + '%' } })), h('span', { className: 'pct' }, pct + '%'))));
  }

  // En "Lo urgente primero" la lista se agrupa por estado (los grupos ya vienen contiguos por el orden).
  var cuerpo;
  if (!lista.length) cuerpo = h('div', { className: 'ctv-vacio' }, 'Nadie coincide con la búsqueda.');
  else if (orden === 'prioridad'){
    var bloques = [], actual = null, k = 0;
    lista.forEach(function(x){
      var g = x.activos.length ? (CTV_GRUPO[x.estado] || 'aldia') : 'inactivo';
      if (g !== actual){
        actual = g;
        var del = lista.filter(function(y){ return (y.activos.length ? (CTV_GRUPO[y.estado] || 'aldia') : 'inactivo') === g; });
        var suma = del.reduce(function(s, y){ return s + (y.activos.length ? (g === 'mora' ? y.mora : y.saldo) : 0); }, 0);
        bloques.push(h('div', { key: 'g' + g, className: 'ctv-grupo-h' },
          h('span', { className: 'cbv-dot ' + CTV_GRUPOS[g][1] }), h('span', { className: 't' }, CTV_GRUPOS[g][0]), h('span', { className: 'n' }, del.length),
          g !== 'inactivo' && h('span', { className: 'v' + (g === 'mora' ? ' crit' : '') }, fmt(suma), h('span', { className: 'vl' }, g === 'mora' ? ' vencidos' : ' en la calle'))));
      }
      bloques.push(fila(x, k++));
    });
    cuerpo = bloques;
  } else cuerpo = lista.map(fila);

  var panel = deudorSel && h(DeudorPanel, Object.assign({ key: sel + '|' + (focoL ? focoL.loan : ''), deudor: deudorSel, loans: loans, pays: pays, hoy: hoy,
    focoLoan: focoL ? focoL.loan : null, focoPay: focoL ? focoL.pay : null, superpuesto: superpuesto, datosPago: props.datosPago, showToast: props.showToast, onPay: props.onPay,
    onLoan: function(id){ mem.loan = id; guardar(); }, onClose: function(){ abrir(null, null); } }, props.acciones));

  return h('div', { className: 'op ct v4t v4p' + (sel ? ' con-panel' : '') + (anima ? ' anima' : '') },
    h('div', { className: 'op-main ct-main' },
      h('section', { className: 'v4-card ctv-hero', style: { '--i': 0 } },
        h('div', { className: 'ctv-hero-top' },
          h('div', { style: { minWidth: 0 } },
            h('div', { className: 'cbv-kl' }, 'En la calle'),
            h('div', { className: 'ctv-hero-v' }, h(V4Dinero, { v: calle, animar: true })),
            h('div', { className: 'cbv-hero-s' }, 'de ' + fmt(prestado) + ' prestados · ' + pctRec + '% ya volvió')),
          h('button', { className: 'v4-btn pri sm', onClick: props.onNuevo }, h(Ico, { name: 'plus', size: 14, sw: 2.6 }), 'Préstamo')),
        h(CbvSegbar, { partes: [
          { k: 'aldia', l: 'Al día', tono: 'good', v: porEstado.aldia.v, d: ctvPl(porEstado.aldia.n, 'deudor', 'deudores') },
          { k: 'pronto', l: 'Cobran esta semana', tono: 'warn', v: porEstado.pronto.v, d: ctvPl(porEstado.pronto.n, 'deudor', 'deudores') },
          { k: 'mora', l: 'Con mora', tono: 'crit', v: porEstado.mora.v, d: ctvPl(porEstado.mora.n, 'deudor', 'deudores') },
          { k: 'abierto', l: 'Crédito abierto', tono: 'info', v: porEstado.abierto.v, d: ctvPl(porEstado.abierto.n, 'deudor', 'deudores') }] }),
        h('div', { className: 'ctv-ley' },
          [['aldia', 'Al día', 'good'], ['pronto', 'Esta semana', 'warn'], ['mora', 'Con mora', 'crit'], ['abierto', 'Abierto', 'info']].map(function(e){
            var g = porEstado[e[0]];
            return h('div', { key: e[0], className: 'ctv-ley-f' + (g.n ? '' : ' vacia') },
              h('span', { className: 'k' }, h('span', { className: 'cbv-dot ' + e[2] }), e[1], h('span', { className: 'n' }, g.n)),
              h('b', null, fmt(g.v)));
          }))),
      h('div', { className: 'cbv-buscar', style: { '--i': 1 } }, h(Ico, { name: 'search', size: 16, sw: 2 }),
        h('input', { value: q, onChange: function(e){ setQ(e.target.value); }, placeholder: 'Buscar deudor o teléfono' }),
        q && h('button', { className: 'cbv-icono plano', title: 'Borrar la búsqueda', onClick: function(){ setQ(''); } }, h(Ico, { name: 'x', size: 13, sw: 2.4 }))),
      h('div', { className: 'ctv-filtros', style: { '--i': 1 } },
        CT_FILTROS.map(function(f){
          var n = cuenta(pasa[f[0]]);
          if (!n && f[0] !== 'activos' && f[0] !== 'todos') return null;
          return h('button', { key: f[0], className: 'ctv-filtro' + (filtroVivo === f[0] ? ' on' : ''), onClick: function(){ filtrar(f[0]); } }, f[1], h('span', null, n));
        })),
      h('section', { key: 'l' + filtroVivo + '|' + orden, className: 'v4-card ctv-lista', style: { '--i': 2 } },
        h('div', { className: 'ctv-lista-h' },
          h('span', { className: 't' }, ctvPl(lista.length, 'deudor', 'deudores')),
          h('label', { className: 'ctv-orden' }, h('span', null, 'Ordenar'),
            h('select', { value: orden, onChange: function(e){ setOrden(e.target.value); mem.orden = e.target.value; guardar(); } },
              CT_ORDEN.map(function(o){ return h('option', { key: o[0], value: o[0] }, o[1]); })),
            h(Ico, { name: 'chevdown', size: 13, sw: 2.4 }))),
        h('div', { className: 'ctv-filas' }, cuerpo))),
    panel ? h('div', { className: 'op-lado' + (superpuesto ? ' superpuesto' : '') }, panel)
      : !superpuesto && h('div', { className: 'op-lado' },
          h('div', { className: 'v4-card ctv-elige' },
            h('span', { className: 'ico' }, h(Ico, { name: 'users', size: 22, sw: 2 })),
            h('div', { className: 'v4-titulo' }, 'Elige un deudor de la lista'),
            h('p', null, 'Verás aquí sus préstamos, su cronograma, lo que ha pagado y todas sus acciones, sin salir de la lista.'))));
}
