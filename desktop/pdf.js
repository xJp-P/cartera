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

const { BrowserWindow } = require('electron');

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
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    return await win.webContents.printToPDF(OPCIONES_PDF);
  } finally {
    // Tambien si la carga o la impresion fallan: una ventana oculta huerfana no se ve,
    // pero sigue viva hasta cerrar la app.
    if (!win.isDestroyed()) win.destroy();
  }
}

module.exports = { htmlAPdf, OPCIONES_PDF };
