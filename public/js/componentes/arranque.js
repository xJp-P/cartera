// public/js/componentes/arranque.js — la ENTRADA a la app y las NOVEDADES de la version (rediseño v4,
// con el diseño de Control TC v7 aprobado por el PO). Estilos en public/css/arranque.css.
//
//   V4Arranque     lo que se ve mientras llegan los datos (antes, "Cargando..." con un circulo verde): la
//                  misma marca y la misma barra fina de la ventana de arranque (desktop/splash.js), para
//                  que el paso del splash a la app no se note. Aparece con un retardo de 280 ms: si los
//                  datos llegan antes (lo normal), no se ve nada.
//   NovedadesModal las novedades tras una actualizacion: "Novedades de la versión X", "Ya está instalada",
//                  una lista tipografica con la marca de cada cambio en gris y el titulo de cada novedad
//                  en negrita, y "Entendido" abajo. App la abre medio segundo despues de que la app
//                  carga, para no cortar la entrada del Resumen.
// Nombres de nivel superior unicos (el arnes de pruebas aplana los modulos): V4Arranque, NovedadesModal,
// v4nPartir, V4N_SIGLAS.

import { h, useEffect } from '../core/react.js';
import { Ico } from './iconos.js';

export function V4Arranque(){
  return h('div', { className: 'v4a', role: 'status', 'aria-label': 'Abriendo tus datos' },
    h('div', { className: 'v4a-c' },
      h('div', { className: 'v4a-marca', 'aria-hidden': 'true' }, h(Ico, { name: 'briefcase', size: 21, sw: 2 })),
      h('div', { className: 'v4a-nombre' }, 'Cartera'),
      h('div', { className: 'v4a-msg' }, 'Abriendo tus datos'),
      h('div', { className: 'v4a-barra', 'aria-hidden': 'true' }, h('i'))));
}

// Cuanto esperan las novedades despues de que la app entra (decision del PO): medio segundo, para no
// cortar la entrada escalonada del Resumen.
export var NOVEDADES_RETARDO_MS = 500;

// Una novedad puede traer su propio titulo, de dos formas:
//   - la de Control TC: "EL HISTORIAL, RENOVADO. Se lee como..." (titulo en mayusculas + punto);
//   - la que ya usan las entradas de Cartera: "Historial, renovado: todas tus acciones..." (una frase
//     corta, de hasta 8 palabras, antes de los dos puntos).
// El titulo va en negrita y en tipo oracion; las siglas se respetan. Sin titulo, el texto va tal cual.
var V4N_SIGLAS = { IA: 'IA', PDF: 'PDF', USD: 'USD', COP: 'COP', TRM: 'TRM', FC: 'FC', BD: 'BD' };
function v4nPartir(item){
  var s = String(item);
  var m = /^([A-ZÁÉÍÓÚÑÜ0-9][A-ZÁÉÍÓÚÑÜ0-9 ,"«»¿?¡!()'-]{3,}?)\.\s+(.+)$/.exec(s);
  if (m && m[1].split(' ').length >= 2) {
    var t = m[1].toLowerCase().split(' ').map(function(w){
      var k = w.replace(/[^a-záéíóúñü]/g, '').toUpperCase();
      return V4N_SIGLAS[k] ? w.replace(new RegExp(k, 'i'), V4N_SIGLAS[k]) : w;
    }).join(' ');
    return { titulo: t.charAt(0).toUpperCase() + t.slice(1) + '.', texto: m[2] };
  }
  var c = /^([^:.]{3,80}):\s+(.+)$/.exec(s);
  if (c && c[1].trim().split(/\s+/).length <= 8) {
    var resto = c[2];
    return { titulo: c[1].trim() + '.', texto: resto.charAt(0).toUpperCase() + resto.slice(1) };
  }
  return { titulo: null, texto: s };
}

// Props: version, items (las lineas de CHANGELOGS[version]) y onClose. Cierran la X, "Entendido", un clic
// en el fondo y la tecla Escape (no hay nada que perder: solo informa).
export function NovedadesModal(props){
  var cerrar = props.onClose, items = props.items || [];
  useEffect(function(){
    function tecla(e){ if (e.key === 'Escape') cerrar(); }
    window.addEventListener('keydown', tecla);
    return function(){ window.removeEventListener('keydown', tecla); };
  }, [cerrar]);
  return h('div', { className: 'v4m-overlay v4n-fondo', onClick: cerrar },
    h('div', { className: 'v4m-sheet v4n', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'v4n-t', onClick: function(e){ e.stopPropagation(); } },
      h('div', { className: 'v4n-cab' },
        h('div', { className: 'v4n-t', id: 'v4n-t' }, 'Novedades de la versión ' + props.version),
        h('div', { className: 'v4n-sub' }, 'Ya está instalada')),
      h('button', { className: 'v4m-x', onClick: cerrar, title: 'Cerrar', 'aria-label': 'Cerrar' }, h(Ico, { name: 'x', size: 15, sw: 2.4 })),
      h('ul', { className: 'v4n-lista' }, items.map(function(item, i){
        var nv = v4nPartir(item);
        return h('li', { key: i, style: { '--i': Math.min(i, 12) } },
          h(Ico, { name: 'check', size: 16, sw: 2 }),
          h('span', null, nv.titulo && h('b', null, nv.titulo), nv.texto));
      })),
      h('div', { className: 'v4n-pie' },
        h('button', { className: 'v4n-ok', onClick: cerrar, autoFocus: true }, 'Entendido'))));
}
