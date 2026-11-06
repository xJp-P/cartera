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
// Dura lo que dura la sesion: al reabrir la app, la pestana arranca como siempre.

import { DeudorPanel } from '../componentes/DeudorPanel.js';
import { Ico } from '../componentes/iconos.js';
import { fmt, fmtN, fmtUSD } from '../core/format.js';
import { modeloDeudor, opModalidad, opIniciales, opCorta, opRel, opPesoEstado } from '../core/operacion.js';
import { h, useEffect, useMemo, useState } from '../core/react.js';
import { addDays, properCase } from '../core/ui.js';

var CT_FILTROS = [['activos', 'Activos'], ['mora', 'En mora'], ['semana', 'Cobran esta semana'], ['usd', 'En dólares'], ['inactivos', 'Sin préstamos activos'], ['todos', 'Todos']];
var CT_ORDEN = [['prioridad', 'Lo urgente primero'], ['saldo', 'Mayor saldo'], ['nombre', 'Nombre'], ['recientes', 'Préstamo más reciente']];

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

export function CarteraView(props){
  var loans = props.loans, pays = props.pays, hoy = props.hoy, foco = props.foco;
  var mem = props.memoria || {};
  var _q = useState(''); var q = _q[0], setQ = _q[1];
  // El filtro con el que se abre queda en la memoria: si un foco lo cambio, al volver por el menu
  // la pestana no puede abrir un filtro que esconda al deudor del panel.
  var _f = useState(function(){ var f = ctFiltroInicial(foco, mem, props.deudores, loans, pays, hoy); mem.filtro = f; return f; }); var filtro = _f[0], setFiltro = _f[1];
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
    var s = q.toLowerCase();
    return x.nombre.toLowerCase().indexOf(s) !== -1 || (x.d.telefono || '').indexOf(q) !== -1;
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
  var _s = useState(function(){ if (inicial !== null){ mem.sel = inicial; mem.loan = loanIni; } return inicial; }); var sel = _s[0], setSel = _s[1];
  var _fl = useState(foco && foco.loanId ? { loan: foco.loanId, pay: foco.payId } : loanIni ? { loan: loanIni } : null); var focoL = _fl[0], setFocoL = _fl[1];
  var deudorSel = sel ? props.deudores.filter(function(d){ return d.nombre === sel; })[0] : null;
  function abrir(nombre, loanId){ setSel(nombre); setFocoL(loanId ? { loan: loanId } : null); mem.sel = nombre; mem.loan = loanId || null; }
  function filtrar(f){ setFiltro(f); mem.filtro = f; }

  var activos = todos.filter(function(x){ return x.activos.length; });
  var calle = activos.reduce(function(s, x){ return s + x.saldo; }, 0);
  var prestado = activos.reduce(function(s, x){ return s + x.prestado; }, 0);
  var enMora = todos.filter(function(x){ return x.moraN > 0; });

  function fila(x){
    var on = sel === x.nombre;
    var linea = x.estado === 'mora' ? h('span', { style: { color: 'var(--red)' } }, fmt(x.mora) + ' vencidos · ' + x.moraDias + ' días')
      : x.prox ? h('span', { style: { color: x.prox.p.fechaPago === hoy ? 'var(--yellow)' : 'var(--text3)' } }, 'próxima ' + opCorta(x.prox.p.fechaPago) + ' · ' + opRel(hoy, x.prox.p.fechaPago))
      : x.activos.length ? h('span', { style: { color: 'var(--blue)' } }, 'crédito abierto')
      : h('span', null, x.ultimo ? 'último pago ' + opCorta(x.ultimo.fecha) : 'sin movimientos');
    var pct = x.prestado > 0 ? Math.round((1 - x.saldo / x.prestado) * 100) : 0;
    return h('button', { key: x.nombre, className: 'ct-fila' + (on ? ' on' : '') + (x.activos.length ? '' : ' inactivo'), onClick: function(){ abrir(x.nombre, null); } },
      h('div', { className: 'op-avatar e-' + x.estado }, opIniciales(x.nombre)),
      h('div', { className: 'ct-fila-c' },
        h('div', { className: 'ct-fila-1' },
          h('span', { className: 'cb-nombre' }, properCase(x.nombre)),
          h('span', { className: 'ct-saldo mono' }, x.activos.length ? fmt(x.saldo) : '')),
        h('div', { className: 'ct-fila-2' }, linea,
          x.saldoUSD > 0 && h('span', { className: 'dp-usd mono' }, fmtUSD(x.saldoUSD))),
        x.activos.length > 0 && h('div', { className: 'ct-chips' },
          x.activos.map(function(m){
            return h('span', { key: m.loan.id, className: 'ct-chip e-' + m.estado, title: opModalidad(m.loan.modalidad) + ' · debe ' + fmt(m.saldo),
                onClick: function(e){ e.stopPropagation(); abrir(x.nombre, m.loan.id); } },
              h('i', null), (m.esUSD ? 'USD ' + fmtN(m.loan.montoOrigen) : fmt(m.loan.montoOrigen)) + ' · ' + opModalidad(m.loan.modalidad, true));
          }),
          x.cerrados.length > 0 && h('span', { className: 'ct-chip cerrado' }, '+' + x.cerrados.length + ' cerrado' + (x.cerrados.length > 1 ? 's' : ''))),
        x.activos.length > 0 && h('div', { className: 'ct-prog', title: pct + '% del capital prestado ya volvió' }, h('div', { style: { width: pct + '%' } }))));
  }

  var panel = deudorSel && h(DeudorPanel, Object.assign({ key: sel + '|' + (focoL ? focoL.loan : ''), deudor: deudorSel, loans: loans, pays: pays, hoy: hoy,
    focoLoan: focoL ? focoL.loan : null, focoPay: focoL ? focoL.pay : null, superpuesto: superpuesto, datosPago: props.datosPago, showToast: props.showToast, onPay: props.onPay,
    onLoan: function(id){ mem.loan = id; }, onClose: function(){ abrir(null, null); } }, props.acciones));

  return h('div', { className: 'op' + (sel ? ' con-panel' : '') + ' ct' },
    h('div', { className: 'op-main ct-main' },
      h('div', { className: 'op-cab' },
        h('div', { style: { minWidth: 0 } },
          h('div', { className: 'op-titulo' }, 'Cartera'),
          h('div', { className: 'op-subt' }, activos.length + ' deudores activos · ' + fmt(calle) + ' en la calle' + (enMora.length ? ' · ' + enMora.length + ' en mora' : ''))),
        h('button', { className: 'op-btn pri', onClick: props.onNuevo }, h(Ico, { name: 'plus', size: 15, color: '#fff', sw: 2.5 }), 'Nuevo préstamo')),
      h('div', { className: 'ct-res' },
        h('div', null, h('div', { className: 'dp-fig-l' }, 'En la calle'), h('div', { className: 'mono' }, fmt(calle))),
        h('div', null, h('div', { className: 'dp-fig-l' }, 'Prestado'), h('div', { className: 'mono' }, fmt(prestado))),
        h('div', null, h('div', { className: 'dp-fig-l' }, 'Recuperado'), h('div', { className: 'mono', style: { color: 'var(--green)' } }, (prestado ? Math.round((1 - calle / prestado) * 100) : 0) + '%'))),
      h('div', { className: 'op-buscar' }, h(Ico, { name: 'search', size: 15, color: 'var(--text3)' }),
        h('input', { value: q, onChange: function(e){ setQ(e.target.value); }, placeholder: 'Buscar deudor o teléfono' }),
        q && h('button', { className: 'op-icono', onClick: function(){ setQ(''); } }, h(Ico, { name: 'x', size: 13, color: 'var(--text3)' }))),
      h('div', { className: 'ct-filtros' },
        CT_FILTROS.map(function(f){
          var n = cuenta(pasa[f[0]]);
          if (!n && f[0] !== 'activos' && f[0] !== 'todos') return null;
          return h('button', { key: f[0], className: 'op-filtro' + (filtroVivo === f[0] ? ' on' : ''), onClick: function(){ filtrar(f[0]); } }, f[1], h('span', null, n));
        }),
        h('select', { className: 'ct-orden', value: orden, onChange: function(e){ setOrden(e.target.value); mem.orden = e.target.value; } },
          CT_ORDEN.map(function(o){ return h('option', { key: o[0], value: o[0] }, o[1]); }))),
      lista.length ? h('div', { className: 'ct-lista' }, lista.map(fila)) : h('div', { className: 'op-vacio' }, 'Nadie coincide con la búsqueda.')),
    panel ? h('div', { className: 'op-lado' + (superpuesto ? ' superpuesto' : '') }, panel)
      : !superpuesto && h('div', { className: 'op-lado' }, h('div', { className: 'cb-lado' }, h('div', { className: 'op-vacio' }, 'Elige un deudor de la lista.'))));
}
