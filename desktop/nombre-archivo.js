// desktop/nombre-archivo.js — la ULTIMA defensa del nombre de un PDF antes de armar la ruta.
//
// ESPEJO de `limpiarNombreArchivo` (public/js/pdf/nombres.js): los generadores ya mandan el nombre
// limpio, pero `print-pdf` lo vuelve a limpiar para que ningun documento (ni uno futuro) pueda
// meter un "/" que se vuelva carpeta o un caracter que Windows o Mac no aceptan. `pdf-render`
// exige que las dos limpiezas den lo mismo sobre una lista de nombres tramposos.

const NOMBRE_MAX_LIMPIO = 150;

function limpiarNombreArchivo(s) {
  let t = String(s == null ? '' : s);
  try { t = t.normalize('NFC'); } catch (_) {}
  t = t.replace(/[\u0000-\u001f\u007f]/g, ' ')
       .replace(/[\\/:*?"<>|]/g, '-')
       .replace(/[\s  -​  　﻿]+/g, ' ')
       .replace(/-{2,}/g, '-')
       .trim();
  if (t.length > NOMBRE_MAX_LIMPIO) t = t.slice(0, NOMBRE_MAX_LIMPIO);
  t = t.replace(/[. ]+$/, '');
  if (!t) t = 'documento';
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(t)) t = '_' + t;
  return t;
}

module.exports = { limpiarNombreArchivo };
