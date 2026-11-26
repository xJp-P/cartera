// public/js/pdf/nombres.js — EL NOMBRE DE ARCHIVO de cada PDF (punto 5 del PO, post-4.0.0).
//
// Hasta aqui cada generador armaba su nombre a mano y se mezclaban codigos (FC, AB, RC, CG) con
// palabras; "RC" era a la vez el recibo del cobro y el del corte, tres generadores emitian
// "Paz y Salvo [Cliente]" sin fecha ni prestamo, el cronograma en pesos llevaba el espacio duro
// que mete `fmt()` tras el "$", y el nombre del cliente pasaba tal cual: un "/" se volvia una
// carpeta y ": * ? \" < > |" no son validos en Windows.
//
// LA REGLA (aprobada por el PO): `Documento - Cliente - detalle - fecha`.
//   - Documento: en palabras, el mismo titulo que el papel lleva por dentro (se lo mandas al
//     cliente: tiene que entenderse sin explicacion). Los codigos impresos (FC-, RC-...) no van en
//     el nombre: siguen dentro del documento.
//   - detalle: lo que lo distingue de otro papel del mismo cliente (la cuota, el monto o el
//     prestamo), y la fecha en formato ano-mes-dia, que se ordena sola en una carpeta.
// Asi solo "chocan" dos archivos cuando son el mismo documento reimpreso el mismo dia (y entonces
// esta bien que la ventana de guardar pregunte si lo reemplaza).
//
// La limpieza tiene un ESPEJO en la capa nativa (`desktop/nombre-archivo.js`), que la vuelve a
// aplicar antes de armar la ruta: asi ni un documento futuro puede romperla. `pdf-render` exige que
// las dos den lo mismo.

export var PDF_DOCUMENTOS = {
  cronograma: 'Cronograma',
  reciboCuota: 'Recibo de pago',          // boton "Pagó": una cuota
  reciboCobro: 'Recibo de pago',          // boton "Cobrar": el cobro en cascada
  factura: 'Factura de cobro',
  reciboAbono: 'Recibo de abono',
  reciboCorte: 'Recibo de corte',
  pazYSalvo: 'Paz y salvo',
  cobroGeneral: 'Recibo de cobro general',
  liquidacion: 'Estado de liquidación',
  estadoCuenta: 'Estado de cuenta',
  propuestaAbono: 'Propuesta de abono',
  propuestaUnificacion: 'Propuesta de unificación',
  constanciaUnificacion: 'Constancia de unificación',
  condonacion: 'Constancia de condonación',
  reporte: 'Reporte de préstamos activos'
};

// Tope del nombre (sin ".pdf"). La limpieza recorta a NOMBRE_MAX_LIMPIO como ultima defensa;
// `nombrePdf` recorta antes, y solo el nombre del cliente, a NOMBRE_MAX.
var NOMBRE_MAX = 120, NOMBRE_MAX_LIMPIO = 150;

// Deja un texto listo para nombre de archivo en Windows y Mac: sin caracteres de control ni
// \ / : * ? " < > | (pasan a "-"), el espacio duro y los espacios repetidos a un espacio, sin
// punto ni espacio al final, sin nombres reservados de Windows y con un tope de largo. Las tildes y
// la ñ se conservan (las dos plataformas las aceptan). ESPEJO: desktop/nombre-archivo.js.
export function limpiarNombreArchivo(s){
  var t = String(s == null ? '' : s);
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

// Un monto como va en el nombre: "$400.000" en pesos (sin el espacio duro de `fmt`) y
// "USD $1,600.00" en dolares (el formato del dolar, nunca el del peso).
export function montoArchivo(valor, esUSD){
  var v = +valor || 0;
  return esUSD
    ? 'USD $' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '$' + Math.round(v).toLocaleString('es-CO');
}

// "préstamo $400.000": el prestamo al que se refiere un documento de un credito, por su monto.
export function prestamoArchivo(loan){
  loan = loan || {};
  return 'préstamo ' + montoArchivo(loan.montoOrigen, loan.moneda === 'USD');
}

// El nombre de un documento: `Documento - Cliente - detalle... - fecha`. `partes` son los detalles
// en orden (las vacias se omiten). Si el nombre sale largo, se recorta SOLO el del cliente.
export function nombrePdf(tipo, cliente, partes){
  var doc = PDF_DOCUMENTOS[tipo];
  if (!doc) throw new Error('nombrePdf: tipo de documento desconocido "' + tipo + '"');
  var extra = (partes || []).filter(function(p){ return p !== null && p !== undefined && String(p).trim() !== ''; })
    .map(function(p){ return limpiarNombreArchivo(p); });
  var cli = cliente ? limpiarNombreArchivo(cliente) : '';
  var armar = function(c){ return [doc].concat(c ? [c] : []).concat(extra).join(' - '); };
  var t = armar(cli);
  if (t.length > NOMBRE_MAX && cli) {
    cli = cli.slice(0, Math.max(8, cli.length - (t.length - NOMBRE_MAX))).trim();
    t = armar(cli);
  }
  return limpiarNombreArchivo(t);
}
