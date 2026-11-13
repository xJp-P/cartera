// public/js/vistas/HistorialView.js — Historial: todo lo que se hizo en la app, dia por dia (rediseño v4).
//
// El COMPORTAMIENTO es el de 3.7.0 (pedido del PO), sin cambios:
//   - recibe el historial COMPLETO (`GET /api/activity?todo=1`) y lo agrupa por DIA (Hoy, Ayer,
//     "martes 28 de julio"), con la hora de cada accion;
//   - BUSCA sin distinguir tildes ni mayusculas (`contiene`, el de todos los buscadores de la app);
//   - filtra por PERIODO (hoy, 7 dias, 30 dias, este mes o un rango de fechas) y por TIPO (cobros,
//     prestamos, mis deudas, deshechos), cada filtro con su conteo;
//   - muestra de a `HS_PAGINA` acciones, con "Ver mas", para que un historial largo no cueste;
//   - "Ver en Cartera" cuando la accion nombra a un deudor de la cartera;
//   - el boton Deshacer y su candado LIFO EXACTAMENTE como estaban (ver el bloque del candado): abre la
//     confirmacion de Deshacer de App (ConfirmUndoModal), con sus candados de tiempo y de caja.
//
// La PRESENTACION es la del prototipo v4 aprobado (estilos en public/css/historial.css, bajo `.v4h`):
//   - un encabezado con cuantas acciones hay en lo filtrado y la actividad de los ultimos 30 dias en
//     barras (los dias del periodo elegido resaltados; un clic en una barra muestra solo ese dia);
//   - el buscador, el periodo como control segmentado y los tipos como pastillas;
//   - la lista en una tarjeta: el dia como encabezado fijo, cada accion con su hora, un icono neutro y su
//     tipo en una etiqueta suave; Deshacer como boton sobrio (morado cuando se puede).
// Nombres de nivel superior con prefijo hs/Hs/HS_ (el arnes de pruebas aplana los modulos); clases `hsv-`.

import { Ico } from '../componentes/iconos.js';
import { h, useMemo, useState } from '../core/react.js';
import { addDays, contiene, nowStr, plegar, properCase } from '../core/ui.js';
import { v4PuedeAnimar } from './DashView.js';
import { CbvSeg } from './CobrosView.js';

// tipo -> [icono, tono de la etiqueta, rotulo]. 'deshacer' en purpura: una accion compensatoria destaca
// sin confundirse con un error (rojo) ni con un cobro (verde).
var HS_TIPOS = {
  prestamo: ['plus', 'good', 'Nuevo préstamo'], edicion: ['edit', 'info', 'Edición'], eliminacion: ['trash', 'crit', 'Eliminación'],
  pago: ['check', 'good', 'Pago'], abono: ['dollar', 'good', 'Abono'], reestructuracion: ['calc', 'info', 'Reestructuración'],
  cierre: ['alert', 'crit', 'Cierre forzoso'], deshacer: ['refresh', 'purple', 'Deshecho'], 'cambio-fecha': ['calendar', 'info', 'Cambio de fecha'],
  deuda: ['briefcase', 'neutral', 'Mis deudas'], condonacion: ['shield', 'warn', 'Condonación']
};
var HS_GRUPOS = [['todos', 'Todo'], ['cobros', 'Cobros'], ['prestamos', 'Préstamos'], ['deudas', 'Mis deudas'], ['deshacer', 'Deshechos']];
var HS_GRUPO_DE = { pago: 'cobros', abono: 'cobros', prestamo: 'prestamos', edicion: 'prestamos', eliminacion: 'prestamos',
  reestructuracion: 'prestamos', 'cambio-fecha': 'prestamos', cierre: 'prestamos', condonacion: 'prestamos', deuda: 'deudas', deshacer: 'deshacer' };
var HS_PERIODOS = [['todo', 'Todo'], ['hoy', 'Hoy'], ['7', '7 días'], ['30', '30 días'], ['mes', 'Este mes'], ['rango', 'Elegir fechas']];
var HS_PERIODO_TXT = { todo: 'en todo el historial', hoy: 'hoy', '7': 'en los últimos 7 días', '30': 'en los últimos 30 días', mes: 'este mes', rango: 'en las fechas elegidas' };
var HS_PAGINA = 120;
var HS_DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
var HS_MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
var HS_MES3 = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

// [desde, hasta] (inclusive, 'YYYY-MM-DD') del periodo elegido; null = sin limite.
export function hsRango(periodo, hoy, desde, hasta){
  if (periodo === 'hoy') return [hoy, hoy];
  if (periodo === '7') return [addDays(hoy, -6), hoy];
  if (periodo === '30') return [addDays(hoy, -29), hoy];
  if (periodo === 'mes') return [hoy.slice(0, 8) + '01', hoy];
  if (periodo === 'rango') return [desde || '0000-00-00', hasta || '9999-12-31'];
  return null;
}
// "Hoy", "Ayer" o "martes 28 de julio" (con el año si no es el actual).
export function hsDia(dia, hoy){
  if (dia === hoy) return 'Hoy';
  if (dia === addDays(hoy, -1)) return 'Ayer';
  var d = new Date(dia + 'T12:00:00');
  return HS_DIAS[d.getDay()] + ' ' + d.getDate() + ' de ' + HS_MESES[d.getMonth()] + (dia.slice(0, 4) !== hoy.slice(0, 4) ? ' de ' + dia.slice(0, 4) : '');
}
function hsPlural(n, uno, varios){ return n + ' ' + (n === 1 ? uno : varios); }

export function HistorialView(props){
  var log = props.actLog || [];
  var undoLog = props.undoLog || [];
  var onUndo = props.onUndo;
  var onRefresh = props.onRefresh;
  var onNameClick = props.onNameClick || null;
  var hoy = nowStr();
  // El orden de estos estados es contrato con `operacion` K (siembra por posicion): q, periodo, desde,
  // hasta, grupo, limite; la animacion va al final.
  var _q = useState(''); var q = _q[0], setQ = _q[1];
  var _p = useState('todo'); var periodo = _p[0], setPeriodo = _p[1];
  var _d = useState(function(){ return addDays(nowStr(), -29); }); var desde = _d[0], setDesde = _d[1];
  var _hh = useState(function(){ return nowStr(); }); var hasta = _hh[0], setHasta = _hh[1];
  var _g = useState('todos'); var grupo = _g[0], setGrupo = _g[1];
  var _l = useState(HS_PAGINA); var limite = _l[0], setLimite = _l[1];
  var _an = useState(v4PuedeAnimar); var anima = _an[0];
  // Cambiar un filtro vuelve a la primera pagina.
  function con(setter){ return function(v){ setter(v); setLimite(HS_PAGINA); }; }

  // Los deudores de la cartera, para "Ver en Cartera": el nombre mas LARGO que aparezca en el mensaje
  // (asi "Ana Maria Lopez" no se confunde con "Ana Maria"). Plegado una sola vez.
  var deudores = useMemo(function(){
    var vistos = {};
    (props.loans || []).forEach(function(l){ if (l.nombre && String(l.nombre).trim().length >= 4) vistos[l.nombre] = plegar(l.nombre); });
    return Object.keys(vistos).map(function(n){ return [n, vistos[n]]; }).sort(function(a, b){ return b[1].length - a[1].length; });
  }, [props.loans]);
  var plegados = useMemo(function(){
    var m = {};
    log.forEach(function(it){ m[it.id] = plegar(it.mensaje); });
    return m;
  }, [log]);
  function deudorDe(it){
    if (!onNameClick || HS_GRUPO_DE[it.tipo] === 'deudas') return null;   // en Mis Deudas el nombre es un acreedor
    var t = plegados[it.id] || '';
    for (var i = 0; i < deudores.length; i++) if (t.indexOf(deudores[i][1]) !== -1) return deudores[i][0];
    return null;
  }

  // ── CANDADO A (LIFO) EN LA UI ── solo el "head" de cada agregado (el journal mas reciente aun
  // disponible) ofrece Deshacer activo; las demas lo muestran apagado y dicen cual hay que deshacer
  // primero. El backend aplica la misma regla: esto solo la hace visible.
  var ujById = {}, headByScope = {};
  undoLog.forEach(function(u){
    ujById[u.id] = u;
    var k = u.scope_tipo + '|' + u.scope_id;
    if (u.estado === 'disponible' && !headByScope[k]) headByScope[k] = u.id;
  });

  // ── Filtros: periodo -> busqueda -> tipo (el conteo de cada tipo respeta periodo y busqueda) ──
  var rango = hsRango(periodo, hoy, desde, hasta);
  var enPeriodo = log.filter(function(it){
    var dia = String(it.fecha || '').slice(0, 10);
    return !rango || (dia >= rango[0] && dia <= rango[1]);
  });
  function pasaQ(it){ var t = HS_TIPOS[it.tipo]; return contiene(it.mensaje + ' ' + (t ? t[2] : it.tipo), q); }
  var buscados = q.trim() ? enPeriodo.filter(pasaQ) : enPeriodo;
  var cuenta = {};
  buscados.forEach(function(it){ var g = HS_GRUPO_DE[it.tipo] || 'otros'; cuenta[g] = (cuenta[g] || 0) + 1; });
  var vis = grupo === 'todos' ? buscados : buscados.filter(function(it){ return HS_GRUPO_DE[it.tipo] === grupo; });
  var pagina = vis.slice(0, limite);
  var nDias = {}; vis.forEach(function(it){ nDias[String(it.fecha || '').slice(0, 10)] = 1; });
  var porDia = {}; vis.forEach(function(it){ var d = String(it.fecha || '').slice(0, 10); porDia[d] = (porDia[d] || 0) + 1; });

  // La actividad de los ultimos 30 dias: con la busqueda y el tipo, SIN el periodo (el periodo se
  // resalta encima). Un clic en un dia lo elige como rango.
  var act = useMemo(function(){
    var cnt = {};
    log.forEach(function(it){
      if (q.trim() && !pasaQ(it)) return;
      if (grupo !== 'todos' && HS_GRUPO_DE[it.tipo] !== grupo) return;
      var d = String(it.fecha || '').slice(0, 10); cnt[d] = (cnt[d] || 0) + 1;
    });
    var out = [];
    for (var i = 29; i >= 0; i--){ var d = addDays(hoy, -i); out.push({ d: d, n: cnt[d] || 0 }); }
    return out;
  }, [log, q, grupo, hoy]);
  var maxAct = Math.max.apply(null, act.map(function(x){ return x.n; }).concat([1]));
  var totAct = act.reduce(function(s, x){ return s + x.n; }, 0);

  function fila(it, i){
    var t = HS_TIPOS[it.tipo] || ['activity', 'neutral', it.tipo];
    var uj = it.undo_id ? ujById[it.undo_id] : null;
    var esHead = uj && uj.estado === 'disponible' && headByScope[uj.scope_tipo + '|' + uj.scope_id] === uj.id;
    var bloqueada = uj && uj.estado === 'disponible' && !esHead;
    var yaDeshecha = uj && uj.estado === 'deshecho';
    var headEntry = uj ? ujById[headByScope[uj.scope_tipo + '|' + uj.scope_id]] : null;
    var motivo = bloqueada && headEntry
      ? 'Primero debes deshacer la operación más reciente de este ' + (uj.scope_tipo === 'debt' ? 'registro' : 'préstamo') + ': "' + headEntry.descripcion + '"'
      : '';
    var deudor = deudorDe(it);
    return h('div', { key: it.id, className: 'hsv-fila' + (yaDeshecha ? ' revertida' : ''), style: { '--i': i } },
      h('div', { className: 'hsv-hora' }, String(it.fecha || '').slice(11, 16)),
      h('span', { className: 'hsv-ico' }, h(Ico, { name: t[0], size: 14, sw: 2.2 })),
      h('div', { className: 'hsv-c' },
        h('div', { className: 'hsv-tipo' }, h('span', { className: 'v4-tag ' + t[1] }, t[2]),
          yaDeshecha && h('span', { className: 'v4-tag purple' }, 'Revertida')),
        h('div', { className: 'hsv-msg' }, it.mensaje),
        bloqueada && h('div', { className: 'hsv-motivo' }, h(Ico, { name: 'clock', size: 12, sw: 2.2 }), h('span', null, motivo))),
      h('div', { className: 'hsv-acc' },
        deudor && h('button', { className: 'v4-link', title: 'Abrir ' + properCase(deudor) + ' en Cartera',
          onClick: function(){ onNameClick(deudor); } }, 'Ver en Cartera', h(Ico, { name: 'chevright', size: 13, sw: 2.2 })),
        (esHead || bloqueada) && h('button', {
          className: 'hsv-deshacer' + (esHead ? ' on' : ''),
          onClick: esHead ? function(){ onUndo(uj); } : null,
          disabled: !esHead,
          title: esHead ? 'Revertir esta operación' : motivo },
          h(Ico, { name: 'refresh', size: 13, sw: 2.3 }), 'Deshacer')));
  }

  var bloques = [], ultimo = null, k = 0;
  pagina.forEach(function(it){
    var dia = String(it.fecha || '').slice(0, 10);
    if (dia !== ultimo){
      ultimo = dia;
      bloques.push(h('div', { key: 'd' + dia, className: 'hsv-dia' },
        h('span', null, hsDia(dia, hoy)), h('span', { className: 'n' }, hsPlural(porDia[dia] || 0, 'acción', 'acciones'))));
    }
    bloques.push(fila(it, k++));
  });

  var filtrado = periodo !== 'todo' || grupo !== 'todos' || !!q.trim();
  function elegirDia(d){ setDesde(d); setHasta(d); setPeriodo('rango'); setLimite(HS_PAGINA); }

  return h('div', { className: 'v4h' + (anima ? ' anima' : '') },
    h('div', { className: 'hsv-intro', style: { '--i': -1 } },
      h('span', null, 'Todo lo que se hizo en la app, día por día' + (log.length ? ' · ' + hsPlural(log.length, 'acción registrada', 'acciones registradas') : '') + '.'),
      h('button', { className: 'v4-btn ghost sm', onClick: onRefresh }, h(Ico, { name: 'refresh', size: 14, sw: 2.2 }), 'Actualizar')),

    log.length === 0
      ? h('section', { className: 'v4-card hsv-vacio', style: { '--i': 0 } },
          h('span', { className: 'ico' }, h(Ico, { name: 'activity', size: 22, sw: 2 })),
          h('div', { className: 'v4-titulo' }, 'Todavía no hay acciones registradas'),
          h('p', null, 'Cada préstamo, cobro, abono o ajuste que hagas quedará aquí, con su fecha y su hora.'))
      : [
        h('section', { key: 'hero', className: 'v4-card hsv-hero', style: { '--i': 0 } },
          h('div', { className: 'hsv-hero-top' },
            h('div', { className: 'hsv-cifra' },
              h('div', { className: 'cbv-kl' }, 'Acciones'),
              h('div', { className: 'hsv-cifra-v' }, vis.length.toLocaleString('es-CO')),
              h('div', { className: 'cbv-hero-s' }, (HS_PERIODO_TXT[periodo] || '') + (vis.length ? ' · en ' + hsPlural(Object.keys(nDias).length, 'día', 'días') : ''))),
            h('div', { className: 'hsv-act' },
              h('div', { className: 'hsv-act-h' }, h('span', null, 'Actividad de los últimos 30 días'), h('b', null, hsPlural(totAct, 'acción', 'acciones'))),
              h('div', { className: 'hsv-act-barras' }, act.map(function(x, i){
                var en = !rango || (x.d >= rango[0] && x.d <= rango[1]);
                var lado = i < 3 ? ' start' : i > 26 ? ' end' : '';
                return h('button', { key: x.d, className: 'b' + (en ? ' en' : '') + (x.n ? '' : ' vacia') + (x.d === hoy ? ' hoy' : ''), style: { '--i': i },
                    onClick: x.n ? function(){ elegirDia(x.d); } : null, tabIndex: x.n ? 0 : -1, 'aria-label': hsDia(x.d, hoy) + ': ' + x.n },
                  h('i', { style: { height: (x.n ? Math.max(8, x.n / maxAct * 100) : 0) + '%' } }),
                  h('span', { className: 'v4-tip' + lado }, h('b', null, hsPlural(x.n, 'acción', 'acciones')), h('span', null, hsDia(x.d, hoy))));
              })),
              h('div', { className: 'hsv-act-pie' }, h('span', null, (function(){ var f = new Date(act[0].d + 'T12:00:00'); return f.getDate() + ' ' + HS_MES3[f.getMonth()]; })()), h('span', null, 'hoy')))),
          h('div', { className: 'hsv-controles' },
            h('div', { className: 'cbv-buscar' },
              h(Ico, { name: 'search', size: 16, sw: 2 }),
              h('input', { type: 'text', value: q, placeholder: 'Buscar por nombre, monto o acción', 'aria-label': 'Buscar en el historial',
                onChange: function(e){ con(setQ)(e.target.value); } }),
              q && h('button', { className: 'cbv-icono plano', title: 'Borrar la búsqueda', onClick: function(){ con(setQ)(''); } }, h(Ico, { name: 'x', size: 13, sw: 2.4 }))),
            h(CbvSeg, { valor: periodo, onChange: con(setPeriodo), opciones: HS_PERIODOS })),
          periodo === 'rango' && h('div', { className: 'hsv-rango' },
            h('label', null, 'Desde', h('input', { type: 'date', value: desde, max: hasta || undefined, onChange: function(e){ con(setDesde)(e.target.value); } })),
            h('label', null, 'Hasta', h('input', { type: 'date', value: hasta, min: desde || undefined, onChange: function(e){ con(setHasta)(e.target.value); } }))),
          h('div', { className: 'ctv-filtros hsv-tipos' },
            HS_GRUPOS.map(function(g){
              var n = g[0] === 'todos' ? buscados.length : (cuenta[g[0]] || 0);
              return h('button', { key: g[0], className: 'ctv-filtro' + (grupo === g[0] ? ' on' : ''), onClick: function(){ con(setGrupo)(g[0]); } }, g[1], h('span', null, n));
            }))),
        h('section', { key: 'lista' + periodo + '|' + grupo, className: 'v4-card hsv-lista', style: { '--i': 1 } },
          vis.length
            ? [h('div', { key: 'f', className: 'hsv-filas' }, bloques),
               vis.length > pagina.length && h('button', { key: 'm', className: 'cbv-mas hsv-mas', onClick: function(){ setLimite(limite + HS_PAGINA); } },
                 'Ver más · ' + (vis.length - pagina.length) + ' restantes', h(Ico, { name: 'chevdown', size: 14, sw: 2.4 }))]
            : h('div', { className: 'hsv-nada' },
                h('span', { className: 'ico' }, h(Ico, { name: 'search', size: 18, sw: 2 })),
                h('p', null, 'Nada coincide con ' + (q.trim() ? 'la búsqueda y ' : '') + 'los filtros elegidos.'),
                filtrado && h('button', { className: 'v4-link', onClick: function(){ setQ(''); setPeriodo('todo'); setGrupo('todos'); setLimite(HS_PAGINA); } }, 'Ver todo el historial', h(Ico, { name: 'chevright', size: 13, sw: 2.2 }))))
      ]);
}
