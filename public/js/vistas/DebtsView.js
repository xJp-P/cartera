// public/js/vistas/DebtsView.js — Mis Deudas: lo que el usuario debe, agrupado por acreedor (v1.12.0).
//
// El estado global sigue viviendo en `App` y baja por PROPS (las deudas, recargar, nueva deuda, el
// movimiento, editar y eliminar). Sin Context API y sin store.
//
// REDISEÑO v4 (aprobado por el PO sobre el prototipo, integrado pestaña por pestaña). MISMO
// comportamiento que la vista de v1.12.0 / v2.9.x: los acreedores agrupados sin distinguir mayusculas,
// en Activos e Inactivos; el acordeon de DOS niveles con la altura animada (WAAPI); el ledger pedido
// por deuda al abrirla, con su cache por FIRMA y su "Reintentar"; la fila de apertura sintetizada desde
// `monto_original`; el saldo corrido por fila; "+ Cargo" (tambien en las pagadas, que asi se reactivan),
// "Abonar" mientras haya saldo, editar y eliminar; y la barra fina de la tarjeta cerrada con su mismo
// gate (`activa && !trivial && !open`), calculada con el mismo `pctAbonado`. Cambia la presentacion:
//   - el encabezado dividido: a la izquierda lo que debes y cuanto llevas abonado de lo cargado; a la
//     derecha A QUIEN se lo debes (barra segmentada por acreedor con su lista). Son SUMAS de los campos
//     que ya trae cada deuda (saldo_pendiente, monto_original, total_cargos, total_abonos): ninguna
//     formula nueva;
//   - cada acreedor es una tarjeta; dentro, sus deudas Activas y Finalizadas, y cada deuda es una
//     cuenta corriente: Cargado − Abonado = Saldo, su avance y sus movimientos como una lista limpia;
//   - colores solo para el estado, en etiquetas suaves: el abono en verde, el cargo en rojo, la
//     apertura en azul. El saldo ya no va en amarillo.
// Estilos en public/css/deudas.css (`.v4d`, prefijo `dbv-`). Nombres de nivel superior con prefijo
// dbv/DBV_ (el arnes aplana los modulos en un ambito).

import { Ico } from '../componentes/iconos.js';
import { API } from '../core/api.js';
import { fmt, fmtD } from '../core/format.js';
import { h, useEffect, useMemo, useState } from '../core/react.js';
import { properCase } from '../core/ui.js';
import { V4Dinero, V4Chip, v4PuedeAnimar } from './DashView.js';
import { CbvSegbar } from './CobrosView.js';

// Etiqueta de cada movimiento: [rotulo, tono].
var DBV_TAG = { apertura: ['Apertura', 'info'], cargo: ['Cargo', 'crit'], abono: ['Abono', 'good'] };
function dbvPl(n, s, p){ return n + ' ' + (n === 1 ? s : (p || s + 's')); }
function dbvIni(nombre){
  var p = String(nombre || '').trim().split(/\s+/).filter(Boolean);
  return ((p[0] || '?').charAt(0) + (p[1] ? p[1].charAt(0) : '')).toUpperCase();
}

// ── PROGRESO DE UNA DEUDA — una sola definicion, dos superficies ───────────────
// Mide lo ABONADO sobre lo CARGADO (apertura + cargos posteriores), que es la misma base dinamica de
// QA5: en una cuenta que crece, medir contra el monto de apertura haria que el progreso pasara del 100%.
// Blindado contra datos incompletos: cualquier campo ausente, nulo o no numerico cae a 0 por el `+x||0`,
// y el guard `cargado>0` cierra la division por cero — una cuenta abierta en 0 y todavia sin cargos no
// tiene progreso que medir, asi que devuelve 0 en vez de `NaN` o `Infinity`, que llegarian al CSS.
export function dbvPctAbonado(d){
  var cargado = (+d.monto_original || 0) + (+d.total_cargos || 0);
  var abonado = +d.total_abonos || 0;
  if (!(cargado > 0) || !(abonado > 0)) return 0;
  return Math.max(0, Math.min(100, Math.round((abonado / cargado) * 100)));
}

// ── EL LEDGER DE UNA DEUDA ──────────────────────────────────────────────────────
// El movimiento de APERTURA no existe en `pagos_deudas`: el saldo inicial vive en
// `mis_deudas.monto_original`, en OTRA tabla. Por eso el estado de cuenta anunciaba "1 movimiento" y
// "Cargos $1.400.000" bajo un saldo de $2.110.000 (Bug #54). Se sintetiza aqui, en la VISTA, sin tocar
// el esquema. Con `monto_original` en 0 no hubo apertura: la cuenta arranco vacia y sintetizar una fila
// de $0 seria ruido. Devuelve las filas del mas viejo al mas nuevo, cada una con su saldo corrido.
export function dbvMovimientos(d, pagosApi){
  var pagos = (pagosApi || []).slice();
  // GET /api/debts/:id los devuelve del mas nuevo al mas viejo; el saldo corrido se calcula al reves.
  // `sort` es estable, asi que los del mismo dia conservan el orden de insercion tras invertir.
  pagos.reverse();
  pagos.sort(function(a, b){ return String(a.fecha_pago || '').localeCompare(String(b.fecha_pago || '')); });
  var base = +d.monto_original || 0;
  var apertura = { id: 'apertura-' + d.id, tipo: 'apertura', fecha_pago: (d.fecha_creacion || '').slice(0, 10), monto_pagado: base, notas: d.concepto || '' };
  var saldo = 0;
  return (base > 0 ? [apertura].concat(pagos) : pagos).map(function(m){
    saldo += (m.tipo === 'abono' ? -(+m.monto_pagado || 0) : (+m.monto_pagado || 0));
    return { m: m, saldo: saldo };
  });
}

export function DebtsView(props){
  var debts = props.debts || [];
  var onReload = props.onReload, onNew = props.onNew, onPay = props.onPay, onEdit = props.onEdit, onDelete = props.onDelete;
  var sExp = useState({}); var expanded = sExp[0]; var setExpanded = sExp[1];
  // Ledger por deuda: { [id]: {firma, pagos, error} }. GET /api/debts NO trae los movimientos (solo los
  // totales), asi que se piden por deuda al abrirla.
  var sMovs = useState({}); var movs = sMovs[0]; var setMovs = sMovs[1];
  // Segundo nivel: cada deuda nace GUARDADA. Con varios prestamos del mismo acreedor, abrir el perfil
  // volcaba todos los ledgers a la vez y la pantalla se hacia ilegible.
  var sExpD = useState({}); var expDebt = sExpD[0]; var setExpDebt = sExpD[1];
  var _an = useState(v4PuedeAnimar); var anima = _an[0];
  function toggleExpand(key){ setExpanded(function(prev){ var n = Object.assign({}, prev); n[key] = !n[key]; return n; }); }
  function toggleDebt(id){ setExpDebt(function(prev){ var n = Object.assign({}, prev); n[id] = !n[id]; return n; }); }

  // Cifras del encabezado: SUMAS de los campos de cada deuda activa.
  var stats = useMemo(function(){
    var activas = debts.filter(function(d){ return d.estado === 'Activa'; });
    var totalActiva = activas.reduce(function(s, d){ return s + (+d.saldo_pendiente || 0); }, 0);
    var cargado = activas.reduce(function(s, d){ return s + (+d.monto_original || 0) + (+d.total_cargos || 0); }, 0);
    var abonado = activas.reduce(function(s, d){ return s + (+d.total_abonos || 0); }, 0);
    return { totalActiva: totalActiva, count: debts.length, activas: activas.length, pagadas: debts.length - activas.length, cargado: cargado, abonado: abonado,
      pct: cargado > 0 && abonado > 0 ? Math.max(0, Math.min(100, Math.round(abonado / cargado * 100))) : 0 };
  }, [debts]);

  // Agrupacion por acreedor (sin distinguir mayusculas); nombre en Proper Case.
  var grupos = useMemo(function(){
    // timestamp robusto desde "YYYY-MM-DD HH:MM:SS" o "YYYY-MM-DD" (0 si invalido).
    function parseTs(s){ var t = new Date(String(s || '').replace(' ', 'T')).getTime(); return isNaN(t) ? 0 : t; }
    var map = {};
    debts.forEach(function(d){
      var key = (d.acreedor || '').trim().toLowerCase();
      if (!map[key]) map[key] = { key: key, nombre: properCase(d.acreedor), deudas: [], totalActiva: 0, activas: 0, pagadas: 0, oldestTs: Infinity };
      var g = map[key];
      g.deudas.push(d);
      g.oldestTs = Math.min(g.oldestTs, parseTs(d.fecha_creacion)); // deuda mas antigua del acreedor
      if (d.estado === 'Activa'){ g.totalActiva += (+d.saldo_pendiente || 0); g.activas++; } else { g.pagadas++; }
    });
    // Orden DESC por la deuda mas antigua (QA4): el acreedor con la deuda mas reciente arriba.
    return Object.keys(map).map(function(k){ return map[k]; })
      .sort(function(a, b){ return b.oldestTs - a.oldestTs || a.nombre.localeCompare(b.nombre); });
  }, [debts]);

  // ── Carga perezosa del ledger ───────────────────────────────────────────────────
  // La FIRMA es el estado economico de la deuda: si cambia (se registro un abono o un cargo), el ledger
  // cacheado caduco y se vuelve a pedir. Sin esto, tras abonar la tarjeta seguiria mostrando los
  // movimientos viejos hasta recargar la vista.
  function firmaDeuda(d){ return [d.id, d.saldo_pendiente, d.total_cargos, d.total_abonos, d.monto_original].join('|'); }
  // Derivado puro: que deudas visibles necesitan su ledger (solo el detalle que el usuario abrio).
  var pendientes = [];
  grupos.forEach(function(g){
    if (!expanded[g.key]) return;
    g.deudas.forEach(function(d){
      if (!expDebt[d.id]) return;
      var c = movs[d.id];
      if (!c || c.firma !== firmaDeuda(d)) pendientes.push(d);
    });
  });
  // Clave estable: cuando no queda nada pendiente es '', y el efecto no se vuelve a disparar (si
  // dependiera de `movs` se realimentaria en bucle).
  var clavePendientes = pendientes.map(firmaDeuda).join(',');
  useEffect(function(){
    if (!clavePendientes) return;
    var vivo = true;
    pendientes.forEach(function(d){
      var f = firmaDeuda(d);
      API.get('/api/debts/' + d.id).then(function(r){
        if (!vivo) return;
        // Los helpers de API resuelven `null` en vez de rechazar: sin marcar el error la tarjeta se
        // quedaria en "Cargando..." para siempre.
        setMovs(function(prev){ var n = Object.assign({}, prev); n[d.id] = { firma: f, pagos: (r && r.pagos) || [], error: !r }; return n; });
      });
    });
    return function(){ vivo = false; };
  }, [clavePendientes]);

  // ── Despliegue: se anima la ALTURA, para que se VEA desplegarse (v2.9.3) ───────────
  // WAAPI mide el contenido y anima entre dos alturas concretas, en las dos direcciones (ver el
  // comentario de `.acc` en deudas.css). El estado previo se guarda EN EL PROPIO NODO (`_accOpen`), no
  // en un ref por clave: un nodo recien creado no lo tiene, asi que el primer render coloca la altura
  // sin animar y no hereda estado viejo al volver a la vista. Sin animacion (reducir movimiento o la
  // ventana oculta, `v4PuedeAnimar`) la altura se coloca de una vez.
  function animarPanel(el, abrir){
    var alto = el.scrollHeight;
    el.style.overflow = 'hidden';
    var anim = el.animate(
      [{ height: (abrir ? 0 : alto) + 'px', opacity: abrir ? 0 : 1 }, { height: (abrir ? alto : 0) + 'px', opacity: abrir ? 1 : 0 }],
      // 380 ms con una curva pareja (la estandar de Material): una curva muy cargada al arranque se ve
      // como un salto y luego una cola lenta, no como un despliegue.
      { duration: 380, easing: 'cubic-bezier(.4,0,.2,1)' });
    // El estado FINAL se fija ya: si el contenido crece mientras esta abierto (se abre una deuda
    // dentro), `auto` lo acompaña solo. Dejarlo en pixeles lo recortaria.
    el.style.height = abrir ? 'auto' : '0px';
    el.style.opacity = abrir ? '1' : '0';
    anim.onfinish = function(){ if (abrir){ el.style.overflow = ''; el.style.opacity = ''; } };
  }
  useEffect(function(){
    var reduce = !v4PuedeAnimar();
    var paneles = document.querySelectorAll('.v4d [data-acc]');
    for (var i = 0; i < paneles.length; i++){
      var el = paneles[i];
      var abrir = el.getAttribute('data-open') === '1';
      if (el._accOpen === abrir) continue;
      var primera = (el._accOpen === undefined);
      el._accOpen = abrir;
      if (primera || reduce){
        el.style.height = abrir ? 'auto' : '0px';
        el.style.overflow = abrir ? '' : 'hidden';
        el.style.opacity = '';
        continue;
      }
      animarPanel(el, abrir);
    }
  });

  // La barra de avance. La consumen el encabezado, el detalle de la deuda (con su rotulo y su
  // porcentaje) y la linea fina de la tarjeta cerrada: una sola implementacion, para que no puedan
  // pintar progresos distintos. Con `pct` en 0 se dibuja la PISTA vacia: es informacion ("todavia sin
  // abonar"); el relleno solo se monta si hay algo que mostrar.
  function barra(pct, clase){ return h('div', { className: 'dbv-barra' + (clase ? ' ' + clase : '') }, pct > 0 ? h('i', { style: { width: pct + '%' } }) : null); }

  function movRow(x){
    var m = x.m, t = DBV_TAG[m.tipo] || DBV_TAG.cargo;
    return h('div', { key: m.id, className: 'dbv-mov' },
      h('span', { className: 'v4-tag ' + t[1] }, t[0]),
      h('div', { className: 'dbv-mov-c' },
        // `pagos_deudas.fecha_pago` puede venir como 'YYYY-MM-DD HH:MM:SS'; `fmtD` le concatena
        // 'T12:00:00' y sin recortar sale Invalid Date.
        h('div', { className: 'f' }, fmtD(String(m.fecha_pago || '').slice(0, 10))),
        m.notas && h('div', { className: 'n' }, m.notas)),
      // El saldo corrido por fila es lo que vuelve el ledger auto-verificable: se sigue la cuenta sin
      // sumar de cabeza.
      h('div', { className: 'dbv-mov-v' },
        h('div', { className: 'v ' + (m.tipo === 'abono' ? 'good' : '') }, (m.tipo === 'abono' ? '− ' : '+ ') + fmt(m.monto_pagado)),
        h('div', { className: 's' }, 'saldo ' + fmt(x.saldo))));
  }

  // Tarjeta de UNA deuda (segundo nivel del acordeon), tratada como CUENTA CORRIENTE. La cabecera
  // (titulo, saldo y estado) siempre se ve; el detalle —la aritmetica, el ledger y las acciones— se
  // despliega al hacer clic. El detalle NO se monta condicionalmente: se queda en el DOM dentro de
  // `.acc`, que anima su altura (una transicion necesita los dos estados presentes).
  function debtCard(d, i){
    var open = !!expDebt[d.id];
    var cargosExtra = +d.total_cargos || 0, abonado = +d.total_abonos || 0;
    // Base dinamica (QA5): lo cargado es el monto original MAS los cargos posteriores.
    var cargado = (+d.monto_original || 0) + cargosExtra;
    var saldo = +d.saldo_pendiente || 0;
    var pct = dbvPctAbonado(d);
    var cache = movs[d.id];
    var filas = dbvMovimientos(d, cache && cache.pagos);
    // Una deuda con un solo cargo y sin abonos no necesita explicarse: la cuenta repetiria el mismo
    // numero tres veces.
    var trivial = cargosExtra === 0 && abonado === 0;
    var activa = d.estado === 'Activa';
    // Pista util sin abrir: si lo cargado supera el monto de apertura, la cuenta crecio.
    var sub = 'Abierta el ' + fmtD((d.fecha_creacion || '').slice(0, 10)) + (cargosExtra > 0 ? (' · cargado ' + fmt(cargado)) : '');
    return h('div', { key: d.id, className: 'dbv-deuda' + (open ? ' abierta' : '') + (activa ? '' : ' pagada'), style: { '--i': i } },
      h('div', { className: 'dbv-deuda-h', onClick: function(){ toggleDebt(d.id); } },
        h('span', { className: 'acc-chev' + (open ? ' open' : '') }, h(Ico, { name: 'chevright', size: 14, sw: 2.4 })),
        h('div', { className: 'dbv-deuda-c' },
          h('div', { className: 't' }, d.titulo || d.concepto || 'Deuda'),
          h('div', { className: 's' }, sub)),
        h('div', { className: 'dbv-deuda-v' },
          h('span', { className: 'l' }, 'Saldo pendiente'),
          h('b', { className: activa ? '' : 'good' }, fmt(saldo))),
        h(V4Chip, { tono: activa ? 'warn' : 'good' }, d.estado)),
      // ── El avance en la tarjeta CERRADA (v2.9.4): la misma barra del detalle, fina, en el borde de
      // la cabecera. Va FUERA del panel `.acc` a proposito: dentro entraria en la animacion de altura.
      // Tres condiciones, cada una por su motivo:
      //   `!open`   — es la version RESUMEN: abierta, el detalle ya trae la barra rotulada;
      //   `!trivial`— MISMO gate que el detalle: una deuda de un cargo y sin abonos no dibuja progreso
      //               en ninguna de las dos vistas (si no, se contradirian);
      //   `activa`  — una Pagada ya lo dice con su chip y su saldo en cero.
      (activa && !trivial && !open) ? barra(pct, 'fina') : null,
      h('div', { className: 'acc', 'data-acc': 'd-' + d.id, 'data-open': open ? '1' : '0' },
        // 1 — La aritmetica, visible: Cargado − Abonado = Saldo. El rotulo del avance dice que mide:
        // en una cuenta que crece, un progreso hacia el 100% RETROCEDE cuando entra un cargo.
        !trivial ? h('div', { className: 'dbv-sec' },
          h('div', { className: 'dbv-cuenta' },
            h('div', null, h('span', null, 'Cargado'), h('b', null, fmt(cargado))),
            h('span', { className: 'dbv-op' }, '−'),
            h('div', null, h('span', null, 'Abonado'), h('b', { className: 'good' }, fmt(abonado))),
            h('span', { className: 'dbv-op' }, '='),
            h('div', null, h('span', null, 'Saldo'), h('b', { className: 'fuerte' }, fmt(saldo)))),
          h('div', { className: 'dbv-avance' },
            h('div', { className: 'dbv-avance-h' },
              h('span', null, abonado > 0 ? ('Abonado ' + fmt(abonado) + ' de ' + fmt(cargado)) : 'Sin abonos todavía'),
              h('b', null, pct + '%')),
            barra(pct)))
          : null,
        // 2 — El ledger, sin modales de por medio. El fallo ofrece salida: borrar la entrada del cache
        // la vuelve a poner en la cola.
        h('div', { className: 'dbv-sec' },
          h('div', { className: 'dbv-sec-t' }, cache && !cache.error ? dbvPl(filas.length, 'movimiento') : 'Movimientos'),
          !cache
            ? h('div', { className: 'dbv-nota' }, 'Cargando movimientos…')
            : cache.error
              ? h('div', { className: 'dbv-nota warn' }, 'No se pudieron cargar los movimientos.',
                  h('button', { className: 'v4-btn ghost sm', onClick: function(){ setMovs(function(prev){ var n = Object.assign({}, prev); delete n[d.id]; return n; }); } }, 'Reintentar'))
              : h('div', { className: 'dbv-movs' }, filas.slice().reverse().map(movRow))),
        // 3 — Acciones. Un cargo tambien REACTIVA una deuda ya pagada, asi que se ofrece siempre; el
        // abono solo mientras haya saldo que abonar.
        h('div', { className: 'dbv-sec dbv-acc' },
          h('button', { className: 'cbv-icono', title: 'Editar', onClick: function(){ onEdit(d); } }, h(Ico, { name: 'edit', size: 15, sw: 2 })),
          h('button', { className: 'cbv-icono peligro', title: 'Eliminar', onClick: function(){ onDelete(d); } }, h(Ico, { name: 'trash', size: 15, sw: 2 })),
          h('div', { className: 'dbv-hueco' }),
          h('button', { className: 'v4-btn ghost sm', title: 'Registrar un cargo (aumenta la deuda)', onClick: function(){ onPay(d, 'cargo'); } }, h(Ico, { name: 'plus', size: 14, sw: 2.4 }), 'Cargo'),
          activa ? h('button', { className: 'v4-btn pri sm', onClick: function(){ onPay(d, 'abono'); } }, h(Ico, { name: 'dollar', size: 14, sw: 2.4 }), 'Abonar') : null)));
  }

  // Un acreedor (primer nivel del acordeon): su tarjeta, y dentro sus deudas Activas y Finalizadas.
  function groupBlock(g, gi){
    var open = !!expanded[g.key];
    var act = g.deudas.filter(function(d){ return d.estado === 'Activa'; }).sort(function(a, b){ return (+b.saldo_pendiente || 0) - (+a.saldo_pendiente || 0); });
    var fin = g.deudas.filter(function(d){ return d.estado !== 'Activa'; });
    var detalle = [], k = 0;
    if (act.length){ detalle.push(h('div', { key: 'a', className: 'dbv-cat' }, 'Activas')); act.forEach(function(d){ detalle.push(debtCard(d, k++)); }); }
    if (fin.length){ detalle.push(h('div', { key: 'f', className: 'dbv-cat' }, 'Finalizadas')); fin.forEach(function(d){ detalle.push(debtCard(d, k++)); }); }
    // Un acreedor sin deudas activas no dice "0 deudas activas": dice cuantas pago.
    var sub = g.activas > 0 ? dbvPl(g.activas, 'deuda activa', 'deudas activas') + (g.pagadas > 0 ? ' · ' + dbvPl(g.pagadas, 'pagada') : '')
      : dbvPl(g.pagadas, 'deuda pagada', 'deudas pagadas');
    return h('section', { key: g.key, className: 'v4-card dbv-acreedor' + (open ? ' abierto' : ''), style: { '--i': gi + 2 } },
      h('div', { className: 'dbv-acreedor-h', onClick: function(){ toggleExpand(g.key); } },
        h('span', { className: 'dbv-av' + (g.totalActiva > 0 ? '' : ' saldada') }, dbvIni(g.nombre)),
        h('div', { className: 'dbv-acreedor-c' },
          h('div', { className: 't' }, g.nombre),
          h('div', { className: 's' }, sub)),
        h('div', { className: 'dbv-acreedor-v' },
          h('span', { className: 'l' }, g.totalActiva > 0 ? 'Le debes' : 'Saldado'),
          h('b', { className: g.totalActiva > 0 ? '' : 'good' }, fmt(g.totalActiva))),
        h('span', { className: 'acc-chev' + (open ? ' open' : '') }, h(Ico, { name: 'chevright', size: 16, sw: 2.2 }))),
      h('div', { className: 'acc', 'data-acc': 'g-' + g.key, 'data-open': open ? '1' : '0' },
        h('div', { className: 'dbv-deudas' }, detalle)));
  }

  // Primer nivel dividido en Activos (>= 1 deuda Activa) e Inactivos (todas Pagadas). Cada bloque
  // hereda el orden de `grupos`.
  var activos = grupos.filter(function(g){ return g.activas > 0; });
  var inactivos = grupos.filter(function(g){ return g.activas === 0; });
  var bloques = [], gi = 0;
  if (activos.length){ bloques.push(h('div', { key: 'sa', className: 'dbv-grupo' }, h('span', { className: 'cbv-dot warn' }), 'Activos', h('span', { className: 'n' }, activos.length))); activos.forEach(function(g){ bloques.push(groupBlock(g, gi++)); }); }
  if (inactivos.length){ bloques.push(h('div', { key: 'si', className: 'dbv-grupo' }, h('span', { className: 'cbv-dot good' }), 'Inactivos', h('span', { className: 'n' }, inactivos.length))); inactivos.forEach(function(g){ bloques.push(groupBlock(g, gi++)); }); }

  // A quien le debes: el saldo activo por acreedor (los cinco mayores y "Otros").
  var porAcreedor = activos.map(function(g){ return { k: g.key, l: g.nombre, v: g.totalActiva }; }).sort(function(a, b){ return b.v - a.v; });
  if (porAcreedor.length > 6){ var resto = porAcreedor.slice(5).reduce(function(s, x){ return s + x.v; }, 0); porAcreedor = porAcreedor.slice(0, 5).concat([{ k: 'otros', l: 'Otros ' + (porAcreedor.length - 5), v: resto }]); }

  return h('div', { className: 'v4d' + (anima ? ' anima' : '') },
    h('div', { className: 'dbv-intro', style: { '--i': -1 } },
      h('span', null, 'Lo que tú debes, por acreedor. Cada deuda es una cuenta: sus cargos, sus abonos y su saldo.'),
      h('div', { className: 'dbv-intro-acc' },
        h('button', { className: 'v4-btn ghost sm', onClick: onReload }, h(Ico, { name: 'refresh', size: 14, sw: 2.2 }), 'Actualizar'),
        h('button', { className: 'v4-btn pri sm', onClick: onNew }, h(Ico, { name: 'plus', size: 14, sw: 2.6 }), 'Nueva deuda'))),

    debts.length === 0
      ? h('section', { className: 'v4-card dbv-vacio', style: { '--i': 0 } },
          h('span', { className: 'ico' }, h(Ico, { name: 'wallet', size: 22, sw: 2 })),
          h('div', { className: 'v4-titulo' }, 'No tienes deudas registradas'),
          h('p', null, 'Usa «Nueva deuda» para registrar lo que debes. Cada abono y cada cargo quedará en su cuenta, con su saldo.'))
      : [
        h('section', { key: 'hero', className: 'v4-card dbv-hero', style: { '--i': 0 } },
          h('div', { className: 'dbv-hero-a' },
            h('div', { className: 'cbv-kl' }, 'Debes en total'),
            h('div', { className: 'dbv-hero-v' }, h(V4Dinero, { v: stats.totalActiva, animar: true })),
            h('div', { className: 'cbv-hero-s' }, dbvPl(stats.activas, 'deuda activa', 'deudas activas') + ' con ' + dbvPl(activos.length, 'acreedor', 'acreedores') + (stats.pagadas ? ' · ' + dbvPl(stats.pagadas, 'pagada') : '')),
            h('div', { className: 'dbv-avance' },
              h('div', { className: 'dbv-avance-h' },
                h('span', null, stats.abonado > 0 ? 'Llevas abonado ' + fmt(stats.abonado) + ' de ' + fmt(stats.cargado) : 'Todavía sin abonos'),
                h('b', null, stats.pct + '%')),
              barra(stats.pct))),
          h('div', { className: 'dbv-hero-b' },
            h('div', { className: 'dbv-hero-b-h' }, h('span', null, 'A quién le debes'), h('b', null, fmt(stats.totalActiva))),
            porAcreedor.length
              ? [h(CbvSegbar, { key: 'sb', partes: porAcreedor.map(function(x, i){ return { k: x.k, l: x.l, tono: 's' + (i + 1), v: x.v }; }) }),
                 h('div', { key: 'li', className: 'rdv-comp-lista' }, porAcreedor.map(function(x, i){
                   return h('div', { key: x.k, className: 'rdv-comp-f', style: { '--i': i } },
                     h('span', { className: 'cbv-dot s' + (i + 1) }), h('span', { className: 'nm' }, x.l), h('span', { className: 'v' }, fmt(x.v)),
                     h('span', { className: 'pc' }, Math.round(x.v / (stats.totalActiva || 1) * 100) + '%'));
                 }))]
              : h('div', { className: 'dbv-nota' }, 'No tienes deudas activas: todo está saldado.'))),
        h('div', { key: 'lista', className: 'dbv-lista' }, bloques)
      ]);
}
