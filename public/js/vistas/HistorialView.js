// public/js/vistas/HistorialView.js — Historial: todo lo que se hizo en la app, dia por dia (3.7.0).
//
// Rediseno de 3.7.0 (pedido del PO): era una lista de tarjetas con las ultimas 100 acciones, sin filtros
// ni busqueda. Ahora:
//   - recibe el historial COMPLETO (`GET /api/activity?todo=1`) y lo agrupa por DIA (Hoy, Ayer,
//     "martes 28 de julio"), con la hora de cada accion;
//   - BUSCA sin distinguir tildes ni mayusculas (`contiene`, el de todos los buscadores de la app);
//   - filtra por PERIODO (hoy, 7 dias, 30 dias, este mes o un rango de fechas) y por TIPO (cobros,
//     prestamos, mis deudas, deshechos), cada filtro con su conteo;
//   - muestra de a `HS_PAGINA` acciones, con "Ver mas", para que un historial largo no cueste;
//   - "Ver en Cartera" cuando la accion nombra a un deudor de la cartera.
// El boton Deshacer y su candado LIFO quedan EXACTAMENTE como estaban (ver el bloque del candado).
// Nombres de nivel superior con prefijo hs/Hs/HS_ (el arnes de pruebas aplana los modulos).

import { Ico } from '../componentes/iconos.js';
import { h, useMemo, useState } from '../core/react.js';
import { addDays, contiene, nowStr, plegar, properCase } from '../core/ui.js';

// tipo -> [icono, tono, rotulo]. El tono es un color del tema ('deshacer' en purpura: una accion
// compensatoria destaca sin confundirse con un error -rojo- ni con un cobro -verde-).
var HS_TIPOS = {
  prestamo: ['plus', 'green', 'Nuevo préstamo'], edicion: ['edit', 'blue', 'Edición'], eliminacion: ['trash', 'red', 'Eliminación'],
  pago: ['check', 'green', 'Pago'], abono: ['dollar', 'yellow', 'Abono'], reestructuracion: ['calc', 'blue', 'Reestructuración'],
  cierre: ['alert', 'red', 'Cierre forzoso'], deshacer: ['refresh', 'purple', 'Deshecho'], 'cambio-fecha': ['calendar', 'blue', 'Cambio de fecha'],
  deuda: ['briefcase', 'text', 'Mis deudas'], condonacion: ['alert', 'yellow', 'Condonación']
};
var HS_GRUPOS = [['todos', 'Todo'], ['cobros', 'Cobros'], ['prestamos', 'Préstamos'], ['deudas', 'Mis deudas'], ['deshacer', 'Deshechos']];
var HS_GRUPO_DE = { pago: 'cobros', abono: 'cobros', prestamo: 'prestamos', edicion: 'prestamos', eliminacion: 'prestamos',
  reestructuracion: 'prestamos', 'cambio-fecha': 'prestamos', cierre: 'prestamos', condonacion: 'prestamos', deuda: 'deudas', deshacer: 'deshacer' };
var HS_PERIODOS = [['todo', 'Todo'], ['hoy', 'Hoy'], ['7', '7 días'], ['30', '30 días'], ['mes', 'Este mes'], ['rango', 'Elegir fechas']];
var HS_PAGINA = 120;
var HS_DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
var HS_MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

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
  var _q = useState(''); var q = _q[0], setQ = _q[1];
  var _p = useState('todo'); var periodo = _p[0], setPeriodo = _p[1];
  var _d = useState(function(){ return addDays(nowStr(), -29); }); var desde = _d[0], setDesde = _d[1];
  var _hh = useState(function(){ return nowStr(); }); var hasta = _hh[0], setHasta = _hh[1];
  var _g = useState('todos'); var grupo = _g[0], setGrupo = _g[1];
  var _l = useState(HS_PAGINA); var limite = _l[0], setLimite = _l[1];
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
    if (!onNameClick || HS_GRUPO_DE[it.tipo] === 'deudas') return null;
    var t = plegados[it.id] || '';
    for (var i = 0; i < deudores.length; i++) if (t.indexOf(deudores[i][1]) !== -1) return deudores[i][0];
    return null;
  }

  // ── CANDADO A (LIFO) EN LA UI ───────────────────────────────────────────────
  // El backend solo acepta deshacer la entrada 'disponible' MAS RECIENTE de cada agregado
  // (409 en cualquier otra). La UI refleja exactamente esa regla: se calcula el "head" por
  // scope y solo esa fila ofrece el boton activo. Las demas lo muestran apagado, explicando
  // cual hay que deshacer primero — mejor que ocultarlo, que dejaria al usuario sin saber por
  // que una operacion no se puede revertir. No depende de los filtros: el head se calcula sobre
  // el journal entero.
  var ujById = {}, headByScope = {};
  undoLog.forEach(function(u){
    ujById[u.id] = u;
    var k = u.scope_tipo + '|' + u.scope_id;
    // GET /api/undo llega ordenado por rowid DESC -> la primera 'disponible' de cada scope es el head.
    if (u.estado === 'disponible' && !headByScope[k]) headByScope[k] = u.id;
  });

  // ── Filtros: periodo -> busqueda -> tipo (los conteos de los tipos respetan los dos primeros) ──
  var rango = hsRango(periodo, hoy, desde, hasta);
  var enPeriodo = log.filter(function(it){
    var dia = String(it.fecha || '').slice(0, 10);
    return !rango || (dia >= rango[0] && dia <= rango[1]);
  });
  var buscados = q.trim() ? enPeriodo.filter(function(it){
    var t = HS_TIPOS[it.tipo];
    return contiene(it.mensaje + ' ' + (t ? t[2] : it.tipo), q);
  }) : enPeriodo;
  var cuenta = {};
  buscados.forEach(function(it){ var g = HS_GRUPO_DE[it.tipo] || 'otros'; cuenta[g] = (cuenta[g] || 0) + 1; });
  var vis = grupo === 'todos' ? buscados : buscados.filter(function(it){ return HS_GRUPO_DE[it.tipo] === grupo; });
  var pagina = vis.slice(0, limite);
  var nDias = {}; vis.forEach(function(it){ nDias[String(it.fecha || '').slice(0, 10)] = 1; });
  var porDia = {}; vis.forEach(function(it){ var d = String(it.fecha || '').slice(0, 10); porDia[d] = (porDia[d] || 0) + 1; });

  function fila(it){
    var t = HS_TIPOS[it.tipo] || ['activity', 'text', it.tipo];
    var uj = it.undo_id ? ujById[it.undo_id] : null;
    var esHead = uj && uj.estado === 'disponible' && headByScope[uj.scope_tipo + '|' + uj.scope_id] === uj.id;
    var bloqueada = uj && uj.estado === 'disponible' && !esHead;
    var yaDeshecha = uj && uj.estado === 'deshecho';
    // Cual es la operacion que hay que deshacer PRIMERO en este agregado (para el tooltip).
    var headEntry = uj ? ujById[headByScope[uj.scope_tipo + '|' + uj.scope_id]] : null;
    var motivo = bloqueada && headEntry
      ? 'Primero debes deshacer la operación más reciente de este ' + (uj.scope_tipo === 'debt' ? 'registro' : 'préstamo') + ': "' + headEntry.descripcion + '"'
      : '';
    var deudor = deudorDe(it);
    return h('div', { key: it.id, className: 'hs-fila' + (yaDeshecha ? ' revertida' : '') },
      h('div', { className: 'hs-hora mono' }, String(it.fecha || '').slice(11, 16)),
      h('div', { className: 'hs-ico t-' + t[1] }, h(Ico, { name: t[0], size: 14, color: 'var(--' + (t[1] === 'text' ? 'text2' : t[1]) + ')', sw: 2.2 })),
      h('div', { className: 'hs-c' },
        h('div', { className: 'hs-tipo t-' + t[1] }, t[2],
          yaDeshecha && h('span', { className: 'hs-revertida' }, 'Revertida')),
        h('div', { className: 'hs-msg' }, it.mensaje),
        // El motivo del bloqueo se muestra tambien inline: el tooltip nativo no existe en tactil.
        bloqueada && h('div', { className: 'hs-motivo' }, h(Ico, { name: 'clock', size: 11, color: 'var(--text3)', sw: 2.2 }), h('span', null, motivo))),
      h('div', { className: 'hs-acc' },
        deudor && h('button', { className: 'hs-link', title: 'Abrir ' + properCase(deudor) + ' en Cartera',
          onClick: function(){ onNameClick(deudor); } }, 'Ver en Cartera →'),
        // ── Accion de deshacer (solo el head LIFO la ofrece activa) ──
        (esHead || bloqueada) && h('button', {
          className: 'hs-deshacer' + (esHead ? ' on' : ''),
          onClick: esHead ? function(){ onUndo(uj); } : null,
          disabled: !esHead,
          title: esHead ? 'Revertir esta operación' : motivo },
          h(Ico, { name: 'refresh', size: 13, color: esHead ? 'var(--purple)' : 'var(--text3)', sw: 2.2 }), 'Deshacer')));
  }

  var bloques = [], ultimo = null;
  pagina.forEach(function(it){
    var dia = String(it.fecha || '').slice(0, 10);
    if (dia !== ultimo){
      ultimo = dia;
      bloques.push(h('div', { key: 'd' + dia, className: 'hs-dia' },
        h('span', null, hsDia(dia, hoy)), h('span', { className: 'hs-dia-n' }, hsPlural(porDia[dia] || 0, 'acción', 'acciones'))));
    }
    bloques.push(fila(it));
  });

  var filtrado = periodo !== 'todo' || grupo !== 'todos' || !!q.trim();
  return h('div', { className: 'hs' },
    h('div', { className: 'hs-cab' },
      h('div', null,
        h('h1', null, 'Historial'),
        h('p', null, log.length ? 'Todo lo que se hizo en la app, día por día. ' + hsPlural(log.length, 'acción registrada', 'acciones registradas') + '.'
          : 'Todo lo que se hizo en la app, día por día.')),
      h('button', { className: 'hs-actualizar', onClick: onRefresh }, h(Ico, { name: 'refresh', size: 14, color: 'var(--text2)' }), 'Actualizar')),

    log.length === 0
      ? h('div', { className: 'hs-card hs-vacio' },
          h(Ico, { name: 'activity', size: 32, color: 'var(--text3)' }),
          h('p', null, 'No hay acciones registradas aún'))
      : h('div', { className: 'hs-card' },
          h('div', { className: 'hs-barra' },
            h('div', { className: 'hs-buscar' },
              h(Ico, { name: 'search', size: 15, color: 'var(--text3)', sw: 2.2 }),
              h('input', { type: 'text', value: q, placeholder: 'Buscar por nombre, monto o acción', 'aria-label': 'Buscar en el historial',
                onChange: function(e){ con(setQ)(e.target.value); } }),
              q && h('button', { className: 'hs-limpiar', title: 'Borrar la búsqueda', onClick: function(){ con(setQ)(''); } }, h(Ico, { name: 'x', size: 13, color: 'var(--text3)', sw: 2.4 }))),
            h('div', { className: 'hs-periodos' }, HS_PERIODOS.map(function(p){
              return h('button', { key: p[0], className: 'hs-chip' + (periodo === p[0] ? ' on' : ''), onClick: function(){ con(setPeriodo)(p[0]); } }, p[1]);
            })),
            periodo === 'rango' && h('div', { className: 'hs-rango' },
              h('label', null, 'Desde', h('input', { type: 'date', value: desde, max: hasta || undefined, onChange: function(e){ con(setDesde)(e.target.value); } })),
              h('label', null, 'Hasta', h('input', { type: 'date', value: hasta, min: desde || undefined, onChange: function(e){ con(setHasta)(e.target.value); } })))),
          h('div', { className: 'hs-tipos' },
            HS_GRUPOS.map(function(g){
              var n = g[0] === 'todos' ? buscados.length : (cuenta[g[0]] || 0);
              return h('button', { key: g[0], className: 'hs-filtro' + (grupo === g[0] ? ' on' : ''), onClick: function(){ con(setGrupo)(g[0]); } },
                g[1], h('span', null, n));
            }),
            h('div', { className: 'hs-resumen' }, vis.length ? hsPlural(vis.length, 'acción', 'acciones') + ' · ' + hsPlural(Object.keys(nDias).length, 'día', 'días') : '')),
          vis.length
            ? h('div', { className: 'hs-lista' }, bloques,
                vis.length > pagina.length && h('button', { className: 'hs-mas', onClick: function(){ setLimite(limite + HS_PAGINA); } },
                  'Ver más (' + (vis.length - pagina.length) + ' restantes)'))
            : h('div', { className: 'hs-vacio' },
                h('p', null, 'Nada coincide con ' + (q.trim() ? 'la búsqueda y ' : '') + 'los filtros elegidos.'),
                filtrado && h('button', { className: 'hs-link', onClick: function(){ setQ(''); setPeriodo('todo'); setGrupo('todos'); setLimite(HS_PAGINA); } }, 'Ver todo el historial →'))));
}
