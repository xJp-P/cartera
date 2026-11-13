// public/js/pdf/recibo-estilo.js — la linea grafica de los recibos de 3.5.0.
//
// La comparten el Recibo de pago (`recibo-cobro.js`, el comprobante de un cobro) y el Recibo
// de cobro general (`recibo-general.js`, el aviso con toda la deuda de un deudor). Los dos
// salen de prototipos que el PO aprobo tal cual: una cifra protagonista arriba, tarjetas con
// lo que el cliente tiene que hacer, la barra de cuotas del credito y una tabla corta. Vivir
// en un solo modulo es lo que garantiza que sigan pareciendo de la misma familia.
//
// Ortografia completa con tildes (decision del PO en 3.4.0 para la UI; aqui por la misma
// razon): el informe de exploracion del 5-ago-2026 comprobo que la codificacion funciona en
// toda la cadena hasta el PDF, y que lo que se veia mal eran rotulos escritos sin tildes.
//
// Nombres top-level con prefijo `rb`/`RB_`: el arnes de pruebas aplana todos los modulos en un
// mismo ambito.

import { fmt, fmtUSD } from '../core/format.js';
import { properCase } from '../core/ui.js';

var RB_MES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
var RB_MES3 = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];

// Fechas ancladas a mediodia, como `fmtD`: a medianoche el huso horario puede correr el dia.
function rbFecha(iso){ return new Date(String(iso).slice(0, 10) + 'T12:00:00'); }
export function rbLarga(iso){ var d = rbFecha(iso); return d.getDate() + ' de ' + RB_MES[d.getMonth()] + ' de ' + d.getFullYear(); }
export function rbMedia(iso){ var d = rbFecha(iso); return d.getDate() + ' de ' + RB_MES[d.getMonth()]; }
// `anioRef`: el anio que se sobreentiende. Una fecha de otro anio lo lleva escrito.
export function rbCorta(iso, anioRef){
  var d = rbFecha(iso);
  return d.getDate() + ' ' + RB_MES3[d.getMonth()] + (anioRef && d.getFullYear() !== +anioRef ? ' ' + d.getFullYear() : '');
}

export function rbEsc(s){ return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
export function rbCampoValido(v){ v = String(v == null ? '' : v).trim(); return v !== '' && v !== '0'; }
export function rbPlural(n, uno, varios){ return n + ' ' + (n === 1 ? uno : varios); }
export function rbPrimerNombre(nombre){ return properCase(nombre || '').split(' ')[0] || ''; }
// Lista blanca CON dieresis y enye (la de estado-liquidacion): un apellido con enye conserva
// sus iniciales en vez de saltarse letras.
export function rbIniciales(nombre){
  return properCase(nombre || '').replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/g, '').slice(0, 2) || 'XX';
}

// ── Dinero en la MONEDA VISIBLE ──────────────────────────────────────────────
// Centavos de dolar en un credito USD, pesos en uno COP. Todo lo que deba sumar se suma sobre
// valores YA convertidos a lo que se imprime (Bug #31: redondear cada rubro por su cuenta y
// sumar despues descuadra un centavo).
export function rbMoneda(loan){
  var esUSD = loan.moneda === 'USD', trm = +loan.trmAcordada || 1;
  function uni(cop){ return esUSD ? Math.round((cop || 0) / trm * 100) : Math.round(cop || 0); }
  function fmtUni(u){ return esUSD ? fmtUSD((u || 0) / 100) : fmt(u || 0); }
  return { esUSD: esUSD, trm: trm, uni: uni, fmtUni: fmtUni, money: function(cop){ return fmtUni(uni(cop)); } };
}
// Un deudor con creditos en pesos Y en dolares: los totales no se pueden sumar entre si, asi
// que se imprimen juntos ("$ 1.200.000 + USD $400.00"). `t` = { cop: pesos, usd: centavos }.
export function rbMixto(t){
  var partes = [];
  if (t.cop || !t.usd) partes.push(fmt(t.cop || 0));
  if (t.usd) partes.push(fmtUSD(t.usd / 100));
  return partes.join(' + ');
}

// ── Paleta del PAPEL (rediseño v4) ──────────────────────────────────────────
// Las paletas de Control TC v7 que usa la app, llevadas al papel. El documento SIGUE EL TEMA de
// la app, como siempre (decision del PO, 2026-11-13: probo "siempre en claro" en la galeria y
// lo revirtio).
//   CLARO: fondo blanco puro (el perla de la pantalla, #f6f6f3, queda para los bloques suaves);
//   OSCURO: el negro real de la app de fondo y sus superficies (#0a0a0a las tarjetas, #111 y
//     #191919 los bloques suaves), la tinta perla y los tonos de estado del tema oscuro.
//   En los dos: tinta en tres niveles y lineas SOLIDAS (las de la app son translucidas, casi no
//   se imprimen y en un PDF abren grupos de transparencia); el color solo donde informa: verde =
//   pagado o recibido, ambar = aviso, rojo = vencido, azul = la proxima cuota. Los tonos suaves
//   son los `*-soft` de la app ya mezclados sobre el fondo (colores solidos).
export function rbPaleta(dark){
  return dark
    ? { oscuro: true, bg: '#000000', card: '#0a0a0a', text: '#f5f5f4', text2: '#a3a3a0', muted: '#858580', soft: '#111111', soft2: '#1b1b1b',
        bd: '#1f1f1f', bd2: '#2e2e2e',
        green: '#3fb37f', greenBg: '#0b1d12', greenBd: '#1c4029', green2: '#3fb37f',
        amber: '#f2b33d', amberBg: '#1f1709', amberBd: '#4a3712',
        red: '#f06b6b', redBg: '#240f0f', redBd: '#4b1a1a', red2: '#d03b3b',
        blue: '#5b9bf0', blueBg: '#0c1828', blueBd: '#1f3a5f', track: '#2a2a2a' }
    : { oscuro: false, bg: '#ffffff', card: '#ffffff', text: '#0a0a0a', text2: '#4b4b47', muted: '#6b6b66', soft: '#f6f6f3', soft2: '#ecece8',
        bd: '#e6e6e1', bd2: '#d6d6d0',
        green: '#17804f', greenBg: '#eaf6ea', greenBd: '#c4e5c4', green2: '#17804f',
        amber: '#a86400', amberBg: '#fef5de', amberBd: '#f5dfa8',
        red: '#c62f35', redBg: '#fbeded', redBd: '#f3caca', red2: '#d03b3b',
        blue: '#2a6fd1', blueBg: '#ecf2fb', blueBd: '#cddcf3', track: '#ecece8' };
}

// ── EL MARCO Y LA IMPRESION DE TODOS LOS DOCUMENTOS (3.5.0 los recibos; 3.6.0 los 12) ──
// Carta (816 px) con 1,3 cm de margen y `@page{margin:0}`, para que el fondo llegue a sangre en
// tema oscuro (doctrina v1.12.3).
//
// EL MARGEN DE ARRIBA Y DE ABAJO NO LO DA EL `body`: lo dan el thead y el tfoot de una tabla que
// envuelve el documento (`RB_MARCO_*`), y Chromium los REPITE en cada hoja impresa. Con el
// padding del body, una segunda hoja arrancaba pegada al filo del papel (medido en Electron: el
// texto de la hoja 2 empezaba a 0,2 pt del borde); con `@page{margin}` el fondo oscuro dejaba
// margenes blancos (medido). Con el marco, la hoja 2 arranca a 38,5 pt y el fondo sigue a sangre.
// Tiene que ser una <table> real: con DIVs `display:table-header-group` no se repite (medido).
export var RB_MARCO_ABRE = '<table class="r-marco"><thead><tr><td class="r-esp"></td></tr></thead><tfoot><tr><td class="r-esp"></td></tr></tfoot><tbody><tr><td class="r-hoja">';
export var RB_MARCO_CIERRA = '</td></tr></tbody></table>';
// Cada documento trae sus propias reglas GENERICAS de tabla (`td{white-space:nowrap;
// text-align:right}`, `table{font-size:10px}`, `tr:nth-child(even){background}`...). El marco
// es una tabla, asi que sin esto se las heredaria y se las pasaria a TODO el documento (texto
// en una sola linea, alineado a la derecha, con fondo de fila). Las CELDAS se dejan neutras con
// `all:unset`; la tabla y las filas, con reseteos explicitos. OJO: `all:unset` en thead, tbody o
// tr hace que Chromium deje de REPETIR el thead/tfoot en cada hoja (medido en Electron: la hoja 2
// del cronograma volvia a arrancar a 9,7 pt del filo), asi que no se extiende a ellos.
var RB_CSS_MARCO = 'table.r-marco{width:100%;border-collapse:collapse;margin:0;border:0;background:none;font-size:inherit}' +
  '.r-marco>thead>tr,.r-marco>tfoot>tr,.r-marco>tbody>tr{background:none}' +
  '.r-marco>thead>tr>td,.r-marco>tfoot>tr>td,.r-marco>tbody>tr>td{all:unset;display:table-cell;vertical-align:top}';
var RB_PCA = '-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important';
// El bloque de impresion, UNO solo para los 12 generadores: el mismo margen, el mismo papel y el
// mismo fondo a sangre en todos. Va AL FINAL de cada <style>, para ganar los empates de
// especificidad. `cuerpo` agrega declaraciones al body impreso (p. ej. `font-size:11px;`) y
// `extra`, reglas propias de un documento dentro del @media print.
// `colores` ({bg, tx}): los del papel v4 (rbImpresionPapel). Sin ellos, los de los documentos aun no
// migrados, que salen byte a byte como antes.
export function rbImpresion(dark, cuerpo, extra, colores){
  var bg = colores ? colores.bg : (dark ? '#0d1117' : '#ffffff'), tx = colores ? colores.tx : (dark ? '#e6edf3' : '#1f2328');
  return RB_CSS_MARCO + '@media print{html,body{' + RB_PCA + '}*{' + RB_PCA + '}@page{size:letter;margin:0}' +
    'html{background:' + bg + '!important}body{max-width:none;padding:0 1.3cm;' + (cuerpo || '') +
    'background:' + bg + '!important;color:' + tx + '!important;min-height:100vh}' +
    '.r-marco>thead>tr>td,.r-marco>tfoot>tr>td{height:1.3cm}' + (extra || '') + '}';
}

// LA LETRA: Inter, como la app. No viaja en este HTML: la incrusta la capa nativa
// (desktop/pdf.js) al convertir, en cuatro pesos FIJOS (400, 500, 600 y 700); por eso aqui
// solo se usan esos cuatro. Fuera de Electron cae a la letra del sistema.
// LAS CIFRAS siguen siendo texto corrido ("$ 1.234.567" en un solo nodo): partir la moneda en su
// propio <span>, como hace V4Dinero en la app, rompe la lectura de importes de las pruebas.
// ── Las piezas comunes del papel v4 ─────────────────────────────────────────
// Las usan rbCss (los recibos de 3.5.0) y cada documento que se migra con su propia hoja de
// estilo (factura, recibo de una cuota, recibo de abono, propuesta...): asi todos comparten la
// misma paleta, la misma letra, el mismo logo y el mismo bloque de impresion.
export var RB_LETRA = "'Inter','Segoe UI',-apple-system,Roboto,Arial,sans-serif";
export function rbTokens(C){
  return ':root{--r-bg:' + C.bg + ';--r-card:' + C.card + ';--r-text:' + C.text + ';--r-text-2:' + C.text2 + ';--r-muted:' + C.muted + ';--r-soft:' + C.soft + ';--r-soft-2:' + C.soft2 +
    ';--r-bd:' + C.bd + ';--r-bd-2:' + C.bd2 +
    ';--r-green:' + C.green + ';--r-green-bg:' + C.greenBg + ';--r-green-bd:' + C.greenBd + ';--r-green-2:' + C.green2 + ';--r-amber:' + C.amber + ';--r-amber-bg:' + C.amberBg +
    ';--r-amber-bd:' + C.amberBd + ';--r-red:' + C.red + ';--r-red-bg:' + C.redBg + ';--r-red-2:' + C.red2 + ';--r-blue:' + C.blue + ';--r-blue-bg:' + C.blueBg + ';--r-track:' + C.track + '}';
}
// El mismo bloque de impresion de siempre (el marco, la carta, el fondo a sangre), con el fondo y el
// texto impresos del papel v4 del tema: sin el #0d1117 ni el #1f2328 de los documentos viejos.
// `extra`: reglas propias de un documento dentro del @media print y `cuerpo`, declaraciones del
// body impreso (el `font-size:11px;` del cronograma y el reporte), como en rbImpresion.
export function rbImpresionPapel(dark, extra, cuerpo){
  return rbImpresion(!!dark, cuerpo || '', extra || '', { bg: 'var(--r-bg)', tx: 'var(--r-text)' });
}

export function rbCss(C){
  return [
    rbTokens(C),
    '*{margin:0;padding:0;box-sizing:border-box}',
    'html{background:var(--r-bg)}',
    "body{max-width:816px;margin:0 auto;padding:1.3cm;font-family:'Inter','Segoe UI',-apple-system,Roboto,Arial,sans-serif;font-size:13px;font-variant-numeric:tabular-nums;" +
      'background:var(--r-bg);color:var(--r-text);line-height:1.35;-webkit-font-smoothing:antialiased}',
    'b{font-weight:600}',
    // Cabecera: el logo de la app (el maletin en un cuadro inverso) y el codigo del documento.
    '.r-cab{display:flex;justify-content:space-between;align-items:center;padding-bottom:11px;border-bottom:1px solid var(--r-bd)}',
    '.r-marca{display:flex;align-items:center;gap:11px}',
    '.r-logo{width:34px;height:34px;border-radius:11px;background:var(--r-text);color:var(--r-bg);display:flex;align-items:center;justify-content:center}',
    '.r-marca b{font-size:17px;font-weight:600;letter-spacing:-.02em;display:block;line-height:1.15}',
    '.r-marca span{font-size:12px;color:var(--r-muted)}',
    '.r-doc{text-align:right;font-size:12px;color:var(--r-muted)}',
    '.r-doc b{display:block;font-size:13.5px;font-weight:600;color:var(--r-text);letter-spacing:-.01em}',
    // La cifra protagonista: en tinta, sobre una tarjeta neutra. El color lo pone el SELLO (y el
    // rotulo): verde = recibido o al dia, ambar = hay algo vencido.
    '.r-hero{display:flex;justify-content:space-between;align-items:center;gap:20px;margin-top:12px;padding:11px 22px;border-radius:18px;border:1px solid var(--r-bd);background:var(--r-card)}',
    '.r-hero-l{min-width:0}',
    '.r-hero-l small{font-size:13px;color:var(--r-green);font-weight:600}',
    '.r-monto{font-size:40px;font-weight:600;letter-spacing:-.035em;color:var(--r-text);line-height:1.05;margin:1px 0 5px}',
    '.r-monto.mixto{font-size:32px;letter-spacing:-.03em}',
    '.r-equiv{font-size:12.5px;color:var(--r-muted);margin:-2px 0 6px}',
    '.r-quien{font-size:13px;color:var(--r-text)}',
    '.r-quien span{color:var(--r-muted)}',
    '.r-sello{flex-shrink:0;width:58px;height:58px;border-radius:99px;background:var(--r-green-bg);border:1px solid var(--r-green-bd);color:var(--r-green);display:flex;align-items:center;justify-content:center}',
    '.r-sello svg{width:28px;height:28px}',
    '.r-hero.ambar small{color:var(--r-amber)}',
    '.r-hero.ambar .r-sello{background:var(--r-amber-bg);border-color:var(--r-amber-bd);color:var(--r-amber)}',
    '.r-sec{margin-top:11px;break-inside:avoid}',
    '.r-sec-t{font-size:13px;font-weight:600;letter-spacing:-.01em;color:var(--r-text);margin-bottom:6px}',
    '.r-dos{display:grid;grid-template-columns:1fr 1fr;gap:10px}',
    '.r-tres{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}',
    '.r-uno{display:grid;grid-template-columns:1fr;gap:10px}',
    '.r-tar{border-radius:14px;padding:9px 14px;border:1px solid var(--r-bd);background:var(--r-card);position:relative}',
    '.r-tar.ambar{background:var(--r-amber-bg);border-color:var(--r-amber-bd)}',
    '.r-tar-l{font-size:12.5px;font-weight:500;color:var(--r-text-2)}',
    '.r-tar.ambar .r-tar-l{color:var(--r-amber)}',
    '.r-tar-v{font-size:21px;font-weight:600;letter-spacing:-.025em;margin:1px 0}',
    '.r-tar-s{font-size:11.5px;color:var(--r-muted);line-height:1.42}',
    '.r-tar-tag{position:absolute;top:-9px;right:10px;font-size:10px;font-weight:600;letter-spacing:.04em;padding:2px 8px;border-radius:99px;background:var(--r-amber-bg);border:1px solid var(--r-amber-bd);color:var(--r-amber)}',
    '.r-tip{margin-top:8px;display:flex;gap:10px;align-items:center;font-size:12px;color:var(--r-text-2);padding:7px 14px;border-radius:12px;background:var(--r-soft)}',
    '.r-tip svg{flex-shrink:0;width:16px;height:16px;color:var(--r-muted)}',
    // La barra de cuotas: los mismos significados de la app (verde pagada, rojo vencida, azul la
    // proxima, gris por venir).
    '.r-av{display:flex;gap:3px;margin:4px 0 8px}',
    '.r-av.denso{gap:2px}',
    '.r-av div{flex:1;height:12px;border-radius:3px;background:var(--r-track);position:relative;overflow:hidden}',
    '.r-av .pagada{background:var(--r-green-2)}',
    '.r-av .vencida{background:var(--r-red-2)}',
    '.r-av .proxima{background:var(--r-blue)}',
    '.r-av .abonada:after{content:"";position:absolute;left:0;top:0;bottom:0;width:var(--p);background:var(--r-green-2)}',
    '.r-av-ley{display:flex;gap:16px;font-size:12px;color:var(--r-muted);flex-wrap:wrap}',
    '.r-av-ley i{display:inline-block;width:8px;height:8px;border-radius:99px;margin-right:6px;vertical-align:1px}',
    '.r-saldos{display:flex;gap:30px;margin-top:8px;font-size:12.5px;color:var(--r-text-2)}',
    '.r-saldos b{display:block;font-size:18px;font-weight:600;letter-spacing:-.02em;color:var(--r-text);margin-top:1px}',
    '.r-saldos .viejo{color:var(--r-muted);font-size:12px;font-weight:400}',
    // Las tablas: lineas finas, cabecera en tinta suave, cifras alineadas.
    'table.r-t{width:100%;border-collapse:collapse;font-size:13px}',
    '.r-t th{text-align:left;font-size:12px;font-weight:500;color:var(--r-muted);padding:0 8px 5px;border-bottom:1px solid var(--r-bd-2)}',
    '.r-t td{padding:3px 8px;border-bottom:1px solid var(--r-bd)}',
    '.r-t .n{text-align:right;white-space:nowrap}',
    '.r-t tr{break-inside:avoid}',
    '.r-t tfoot td{border-bottom:0;font-weight:600;padding-top:7px}',
    '.r-t .sub{font-size:11.5px;color:var(--r-muted);font-weight:400;margin-right:8px}',
    '.chip{display:inline-block;font-size:11.5px;font-weight:500;padding:1px 9px;border-radius:99px;white-space:nowrap}',
    '.chip.venc{color:var(--r-red);background:var(--r-red-bg)}',
    '.chip.prox{color:var(--r-blue);background:var(--r-blue-bg)}',
    '.chip.pend{color:var(--r-text-2);background:var(--r-soft-2)}',
    '.r-pie{margin-top:13px;padding-top:11px;break-inside:avoid;border-top:1px solid var(--r-bd);display:flex;justify-content:space-between;gap:16px;font-size:11.5px;line-height:1.42;color:var(--r-muted)}',
    '.r-pie b{color:var(--r-text);font-size:13px;font-weight:600;display:block;margin-bottom:2px}',
    '.r-pie-d{text-align:right;white-space:nowrap}',
    rbImpresionPapel(C.oscuro)
  ];
}

export var RB_ICONO_OK = '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
export var RB_ICONO_RELOJ = '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
export var RB_ICONO_TIP = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5l3 2"/></svg>';
export var RB_ICONO_ORDEN = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18M5 10l7-7 7 7"/></svg>';

// El logo de la app: el maletin (`briefcase` de iconos.js) en un cuadro inverso. Decision del PO
// (2026-11-13): reemplaza a la "C" de los documentos viejos, y es el UNICO texto que cambia.
export var RB_LOGO = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M20 7H4a2 2 0 00-2 2v10a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2z"/><path d="M16 7V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v2"/></svg>';

export function rbCabecera(tipo, codigo, emision){
  return '<div class="r-cab"><div class="r-marca"><div class="r-logo">' + RB_LOGO + '</div><div><b>Cartera</b><span>' + tipo + '</span></div></div>' +
    '<div class="r-doc"><b>' + codigo + '</b>Emitido el ' + rbLarga(emision) + '</div></div>';
}

export function rbTarjeta(clase, etiqueta, valor, sub, tag){
  return '<div class="r-tar' + (clase ? ' ' + clase : '') + '">' + (tag ? '<span class="r-tar-tag">' + tag + '</span>' : '') +
    '<div class="r-tar-l">' + etiqueta + '</div><div class="r-tar-v">' + valor + '</div>' +
    (sub ? '<div class="r-tar-s">' + sub + '</div>' : '') + '</div>';
}
export function rbRejilla(tarjetas){
  return '<div class="' + (tarjetas.length >= 3 ? 'r-tres' : tarjetas.length === 2 ? 'r-dos' : 'r-uno') + '">' + tarjetas.join('') + '</div>';
}

// ── La barra de cuotas del credito ──────────────────────────────────────────
// Un segmento por cuota del cronograma, en orden: pagada (verde), vencida (rojo), la proxima
// (azul, solo si se pide) y por venir (gris). Lo ya abonado a una cuota sin saldar se pinta
// en verde dentro de su segmento.
export function rbBarraCuotas(regs, proximaN){
  var segs = regs.map(function(p){
    var cls = p.estadoPago === 'Pagado' ? 'pagada' : p.estadoPago === 'En Mora' ? 'vencida' : (proximaN != null && p.cuotaN === proximaN) ? 'proxima' : '';
    var ab = p.estadoPago !== 'Pagado' && (p.partialPaid || 0) > 0 && (p.cuotaTotal || 0) > 0
      ? Math.max(1, Math.min(99, Math.round(p.partialPaid / p.cuotaTotal * 100))) : 0;
    return '<div class="' + (cls + (ab ? ' abonada' : '')).trim() + '"' + (ab ? ' style="--p:' + ab + '%"' : '') + '></div>';
  }).join('');
  return '<div class="r-av' + (regs.length > 36 ? ' denso' : '') + '">' + segs + '</div>';
}
export function rbLeyenda(color, texto){ return '<span><i style="background:var(--r-' + color + ')"></i>' + texto + '</span>'; }

// La misma salida de siempre: el dialogo nativo de Electron o, fuera de la app, imprimir.
export function rbEmitir(html, fname){
  if (window.electronAPI && window.electronAPI.printPDF) {
    window.electronAPI.printPDF(html, fname);
  } else {
    var w = window.open('', '_blank', 'width=860,height=900');
    w.document.write(html); w.document.close();
    w.onload = function() { w.print(); };
  }
}
