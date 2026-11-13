// desktop/pdf.js — convierte el HTML de un documento en los bytes de un PDF.
//
// Vive aparte de main.js para poder probarlo solo (tests/pdf-nativo.js): main.js no se
// puede cargar en una prueba sin arrancar la app entera, y esta es la unica capa de los
// documentos que toca piezas nativas del sistema operativo.
//
// POR QUE LA VENTANA OCULTA ES NORMAL Y NO "OFFSCREEN" (Bug #69, 3.0.1)
// Hasta 3.0.0 el PDF se dibujaba en una ventana creada con `webPreferences.offscreen`.
// En macOS 27 la app se cerraba al generar cualquier documento, sin llegar a mostrar el
// dialogo de guardar. El reporte del cierre, simbolizado con los simbolos oficiales de
// Electron 29.4.6, lo ubica en el constructor de `OffScreenWebContentsView`: el puntero
// `offScreenView_` no se inicializa (en Electron 44 ya nace en `nullptr`) y al asignarle
// la vista nueva se libera la BASURA que habia en esa memoria. Mientras esa memoria llego
// en cero no paso nada; con macOS 27 ya no llega en cero.
// Para imprimir no hace falta el modo offscreen: `printToPDF` no usa lo que la ventana
// pinta en pantalla, sino su propio render de impresion. Una ventana oculta comun es el
// camino que usa cualquier ventana de la app y deja fuera la pieza defectuosa.

const fs = require('fs');
const path = require('path');
const { BrowserWindow } = require('electron');

// LA LETRA DE LOS DOCUMENTOS (rediseño v4, 2026-11-13): Inter, la de la app, en cuatro pesos
// FIJOS (400, 500, 600 y 700) y en los dos subconjuntos de la app (latino y latino extendido).
// Se incrusta aqui, al convertir, por tres razones medidas:
//   - el documento se carga como data: URL, que no puede pedir /fonts/... al servidor;
//   - la Inter VARIABLE de la app entra al PDF como fuente Type 3 y lo hace de 2,5 a 3,9 veces
//     mas pesado; una FIJA entra como CIDFontType2 (la forma estandar) y el PDF queda mas
//     liviano que con la letra del sistema;
//   - en un solo sitio, el HTML de los generadores no crece y Windows y Mac imprimen igual
//     (hasta aqui un PDF salia con Segoe/Arial en Windows y con otra letra en Mac).
// Las fijas (public/fonts/inter-<subconjunto>-<peso>.woff2) se derivan de la variable que ya
// usa la app con `fontTools.varLib.instancer` (wght fijado; nombres Inter-Regular/Medium/
// SemiBold/Bold). Misma licencia OFL (public/fonts/Inter-OFL.txt), que no reserva el nombre.
// Un documento que no pide 'Inter' no cambia en nada: la @font-face sin uso no se incrusta.
const FUENTES = path.join(__dirname, '..', 'public', 'fonts');
const RANGO_LATIN = 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD';
const RANGO_EXT = 'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF';
const PESOS = [400, 500, 600, 700];

let hojaDeLetra = null;
function leerHojaDeLetra() {
  if (hojaDeLetra !== null) return hojaDeLetra;
  try {
    let css = '';
    for (const w of PESOS) {
      for (const [sub, rango] of [['latin', RANGO_LATIN], ['latin-ext', RANGO_EXT]]) {
        const b64 = fs.readFileSync(path.join(FUENTES, 'inter-' + sub + '-' + w + '.woff2')).toString('base64');
        css += "@font-face{font-family:'Inter';font-style:normal;font-weight:" + w +
               ";src:url(data:font/woff2;base64," + b64 + ") format('woff2');unicode-range:" + rango + '}';
      }
    }
    hojaDeLetra = '<style>' + css + '</style>';
  } catch (e) {
    // Sin las fuentes el documento sale igual, con la letra del sistema: mejor eso que no
    // poder entregar un recibo. tests/pdf-nativo.js exige que la Inter este incrustada.
    console.error('[pdf] no se pudo leer la letra de los documentos:', e && e.message);
    hojaDeLetra = '';
  }
  return hojaDeLetra;
}

// Va justo despues de <head>: las reglas propias del documento vienen despues y mandan.
function conLetra(html) {
  const hoja = leerHojaDeLetra();
  const i = html.indexOf('<head>');
  return i === -1 ? hoja + html : html.slice(0, i + 6) + hoja + html.slice(i + 6);
}

const OPCIONES_PDF = {
  printBackground: true,
  preferCSSPageSize: true,
  // Borde a borde (paperless): sin margenes de pagina del sistema; el inset seguro del
  // contenido lo da el padding del body en @media print.
  margins: { marginType: 'none' }
};

async function htmlAPdf(html) {
  const win = new BrowserWindow({ show: false, width: 800, height: 600 });
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(conLetra(html)));
    return await win.webContents.printToPDF(OPCIONES_PDF);
  } finally {
    // Tambien si la carga o la impresion fallan: una ventana oculta huerfana no se ve,
    // pero sigue viva hasta cerrar la app.
    if (!win.isDestroyed()) win.destroy();
  }
}

module.exports = { htmlAPdf, conLetra, OPCIONES_PDF };
