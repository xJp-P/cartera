// public/js/vistas/CarteraView.js — Cartera: deudores y prestamos en una sola pantalla (3.5.0;
// fusiona las viejas pestanas Cartera y Deudores).
//
// A la izquierda, las personas (con sus prestamos activos como chips), ordenadas por lo que
// necesita atencion primero. A la derecha, el panel del deudor elegido. El prestamo deja de vivir
// en dos lugares (la tarjeta de Cartera y el perfil del deudor): vive en uno.
//
// `props.foco` ({nombre, loanId, payId}) abre un deudor concreto: es como llegan aqui los nombres
// del Resumen y la busqueda global. App remonta la vista (key) con cada foco nuevo.

import { DeudorPanel } from '../componentes/DeudorPanel.js';
import { Ico } from '../componentes/iconos.js';
import { fmt, fmtN, fmtUSD } from '../core/format.js';
import { modeloDeudor, opModalidad, opIniciales, opCorta, opRel, opPesoEstado } from '../core/operacion.js';
import { h, useEffect, useMemo, useState } from '../core/react.js';
import { addDays, properCase } from '../core/ui.js';

var CT_FILTROS = [['activos', 'Activos'], ['mora', 'En mora'], ['semana', 'Cobran esta semana'], ['usd', 'En dólares'], ['inactivos', 'Sin préstamos activos'], ['todos', 'Todos']];
var CT_ORDEN = [['prioridad', 'Lo urgente primero'], ['saldo', 'Mayor saldo'], ['nombre', 'Nombre'], ['recientes', 'Préstamo más reciente']];

export function CarteraView(props){
  var loans = props.loans, pays = props.pays, hoy = props.hoy, foco = props.foco;
  var _q = useState(''); var q = _q[0], setQ = _q[1];
  var _f = useState(foco && foco.filtro ? foco.filtro : 'activos'); var filtro = _f[0], setFiltro = _f[1];
  var _o = useState('prioridad'); var orden = _o[0], setOrden = _o[1];
  var _w = useState(window.innerWidth); var ancho = _w[0], setAncho = _w[1];
  useEffect(function(){
    function r(){ setAncho(window.innerWidth); }
    window.addEventListener('resize', r); return function(){ window.removeEventListener('resize', r); };
  }, []);
  // Ventana angosta (la minima de la app es 1.000 px): la lista ocupa todo y el panel se abre encima.
  var superpuesto = ancho < 1100;

  var todos = useMemo(function(){ return props.deudores.map(function(d){ return modeloDeudor(d, loans, pays, hoy); }); }, [props.deudores, loans, pays, hoy]);
  var cuenta = function(fn){ return todos.filter(fn).length; };
  var pasa = {
    activos: function(x){ return x.activos.length > 0; },
    mora: function(x){ return x.moraN > 0; },
    semana: function(x){ return x.prox && x.prox.p.fechaPago <= addDays(hoy, 7); },
    usd: function(x){ return x.activos.some(function(m){ return m.esUSD; }); },
    inactivos: function(x){ return x.activos.length === 0; },
    todos: function(){ return true; }
  };
  var lista = todos.filter(pasa[filtro]).filter(function(x){
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

  var inicial = foco && foco.nombre ? foco.nombre : (!superpuesto && lista[0] ? lista[0].nombre : null);
  var _s = useState(inicial); var sel = _s[0], setSel = _s[1];
  var _fl = useState(foco && foco.loanId ? { loan: foco.loanId, pay: foco.payId } : null); var focoL = _fl[0], setFocoL = _fl[1];
  var deudorSel = sel ? props.deudores.filter(function(d){ return d.nombre === sel; })[0] : null;

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
    return h('button', { key: x.nombre, className: 'ct-fila' + (on ? ' on' : '') + (x.activos.length ? '' : ' inactivo'), onClick: function(){ setSel(x.nombre); setFocoL(null); } },
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
                onClick: function(e){ e.stopPropagation(); setSel(x.nombre); setFocoL({ loan: m.loan.id }); } },
              h('i', null), (m.esUSD ? 'USD ' + fmtN(m.loan.montoOrigen) : fmt(m.loan.montoOrigen)) + ' · ' + opModalidad(m.loan.modalidad, true));
          }),
          x.cerrados.length > 0 && h('span', { className: 'ct-chip cerrado' }, '+' + x.cerrados.length + ' cerrado' + (x.cerrados.length > 1 ? 's' : ''))),
        x.activos.length > 0 && h('div', { className: 'ct-prog', title: pct + '% del capital prestado ya volvió' }, h('div', { style: { width: pct + '%' } }))));
  }

  var panel = deudorSel && h(DeudorPanel, Object.assign({ key: sel + '|' + (focoL ? focoL.loan : ''), deudor: deudorSel, loans: loans, pays: pays, hoy: hoy,
    focoLoan: focoL ? focoL.loan : null, focoPay: focoL ? focoL.pay : null, superpuesto: superpuesto, datosPago: props.datosPago, showToast: props.showToast, onPay: props.onPay,
    onClose: function(){ setSel(null); } }, props.acciones));

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
          return h('button', { key: f[0], className: 'op-filtro' + (filtro === f[0] ? ' on' : ''), onClick: function(){ setFiltro(f[0]); } }, f[1], h('span', null, n));
        }),
        h('select', { className: 'ct-orden', value: orden, onChange: function(e){ setOrden(e.target.value); } },
          CT_ORDEN.map(function(o){ return h('option', { key: o[0], value: o[0] }, o[1]); }))),
      lista.length ? h('div', { className: 'ct-lista' }, lista.map(fila)) : h('div', { className: 'op-vacio' }, 'Nadie coincide con la búsqueda.')),
    panel ? h('div', { className: 'op-lado' + (superpuesto ? ' superpuesto' : '') }, panel)
      : !superpuesto && h('div', { className: 'op-lado' }, h('div', { className: 'cb-lado' }, h('div', { className: 'op-vacio' }, 'Elige un deudor de la lista.'))));
}
