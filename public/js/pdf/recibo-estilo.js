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

// ── Paleta ──────────────────────────────────────────────────────────────────
// La de los prototipos aprobados, como variables CSS: el resto de la hoja es identica en los
// dos temas.
export function rbPaleta(dark){
  return dark
    ? { bg: '#0d1117', text: '#e6edf3', muted: '#8b949e', soft: '#161b22', bd: '#30363d', green: '#3fb950', greenBg: '#12261a', green2: '#2ea043',
        amber: '#e3b341', amberBg: '#2a2210', amberBd: '#5c4a1a', red: '#f85149', redBg: '#2d1416', blue: '#58a6ff', blueBg: '#0f2236', track: '#21262d' }
    : { bg: '#ffffff', text: '#1f2328', muted: '#656d76', soft: '#f6f8fa', bd: '#d8dee4', green: '#1a7f37', greenBg: '#e8f6ec', green2: '#2da44e',
        amber: '#9a6700', amberBg: '#fff6dc', amberBd: '#eed58a', red: '#cf222e', redBg: '#ffebe9', blue: '#0969da', blueBg: '#ddf4ff', track: '#e6eaef' };
}

// La hoja: 816 px de ancho (carta) con 1,3 cm de margen, en pantalla y al imprimir, que es
// exactamente la hoja sobre la que se midieron los prototipos. `@page` fija el tamano carta y
// el margen en cero para que el fondo llegue a sangre en tema oscuro (doctrina v1.12.3).
//
// EL MARGEN DE ARRIBA Y DE ABAJO NO LO DA EL `body`: lo dan el thead y el tfoot de una tabla que
// envuelve el documento (`RB_MARCO_*`), y Chromium los REPITE en cada hoja impresa. Con el
// padding del body, una segunda hoja arrancaba pegada al filo del papel (el defecto anotado en el
// backlog para los 10 generadores viejos: medido en Electron, el texto de la hoja 2 empezaba a
// 0,2 pt del borde); con `@page{margin}` el fondo oscuro dejaba de llegar a sangre (margen
// blanco, medido). Con el marco, la hoja 2 arranca a 38,5 pt y el fondo sigue a sangre. Lo
// normal es que estos recibos quepan en una hoja; el marco es lo que hace bien el caso que no.
export var RB_MARCO_ABRE = '<table class="r-marco"><thead><tr><td class="r-esp"></td></tr></thead><tfoot><tr><td class="r-esp"></td></tr></tfoot><tbody><tr><td class="r-hoja">';
export var RB_MARCO_CIERRA = '</td></tr></tbody></table>';
export function rbCss(C){
  return [
    ':root{--r-bg:' + C.bg + ';--r-text:' + C.text + ';--r-muted:' + C.muted + ';--r-soft:' + C.soft + ';--r-bd:' + C.bd +
      ';--r-green:' + C.green + ';--r-green-bg:' + C.greenBg + ';--r-green-2:' + C.green2 + ';--r-amber:' + C.amber + ';--r-amber-bg:' + C.amberBg +
      ';--r-amber-bd:' + C.amberBd + ';--r-red:' + C.red + ';--r-red-bg:' + C.redBg + ';--r-blue:' + C.blue + ';--r-blue-bg:' + C.blueBg + ';--r-track:' + C.track + '}',
    '*{margin:0;padding:0;box-sizing:border-box}',
    'html{background:var(--r-bg)}',
    "body{max-width:816px;margin:0 auto;padding:0 1.3cm;font-family:'Segoe UI',-apple-system,Roboto,Arial,sans-serif;font-size:13px;font-variant-numeric:tabular-nums;" +
      'background:var(--r-bg);color:var(--r-text);line-height:1.35}',
    'table.r-marco{width:100%;border-collapse:collapse}',
    '.r-marco>thead>tr>td,.r-marco>tfoot>tr>td{height:1.3cm;padding:0}',
    '.r-hoja{padding:0;vertical-align:top}',
    '.r-cab{display:flex;justify-content:space-between;align-items:center;padding-bottom:11px;border-bottom:1px solid var(--r-bd)}',
    '.r-marca{display:flex;align-items:center;gap:10px}',
    '.r-logo{width:34px;height:34px;border-radius:9px;background:var(--r-green-2);color:#fff;font-weight:800;font-size:19px;display:flex;align-items:center;justify-content:center}',
    '.r-marca b{font-size:17px;display:block;line-height:1.1}',
    '.r-marca span{font-size:11.5px;color:var(--r-muted)}',
    '.r-doc{text-align:right;font-size:11.5px;color:var(--r-muted)}',
    '.r-doc b{display:block;font-size:13.5px;color:var(--r-text)}',
    '.r-hero{display:flex;justify-content:space-between;align-items:center;gap:20px;margin-top:13px;padding:12px 22px;border-radius:16px;background:var(--r-green-bg)}',
    '.r-hero-l{min-width:0}',
    '.r-hero-l small{font-size:14px;color:var(--r-green);font-weight:600}',
    '.r-monto{font-size:40px;font-weight:800;letter-spacing:-1.5px;color:var(--r-green);line-height:1.05;margin:1px 0 5px}',
    '.r-monto.mixto{font-size:32px;letter-spacing:-1px}',
    '.r-equiv{font-size:12.5px;color:var(--r-muted);margin:-2px 0 6px}',
    '.r-quien{font-size:14px;color:var(--r-text)}',
    '.r-quien span{color:var(--r-muted)}',
    '.r-sello{flex-shrink:0;width:62px;height:62px;border-radius:99px;border:3px solid var(--r-green);color:var(--r-green);display:flex;align-items:center;justify-content:center}',
    '.r-hero.ambar{background:var(--r-amber-bg);border:1px solid var(--r-amber-bd)}',
    '.r-hero.ambar small,.r-hero.ambar .r-monto{color:var(--r-amber)}',
    '.r-hero.ambar .r-sello{border-color:var(--r-amber);color:var(--r-amber)}',
    '.r-sec{margin-top:11px;break-inside:avoid}',
    '.r-sec-t{font-size:12px;font-weight:700;color:var(--r-muted);margin-bottom:6px}',
    '.r-dos{display:grid;grid-template-columns:1fr 1fr;gap:12px}',
    '.r-tres{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}',
    '.r-uno{display:grid;grid-template-columns:1fr;gap:10px}',
    '.r-tar{border-radius:14px;padding:9px 14px;border:1px solid var(--r-bd);position:relative}',
    '.r-tar.ambar{background:var(--r-amber-bg);border-color:var(--r-amber-bd)}',
    '.r-tar-l{font-size:12px;font-weight:700}',
    '.r-tar.ambar .r-tar-l,.r-tar.ambar .r-tar-v{color:var(--r-amber)}',
    '.r-tar-v{font-size:22px;font-weight:800;letter-spacing:-.5px;margin:1px 0}',
    '.r-tar-s{font-size:12px;color:var(--r-muted);line-height:1.45}',
    '.r-tar-tag{position:absolute;top:-8px;right:10px;font-size:10px;font-weight:700;letter-spacing:.3px;padding:2px 8px;border-radius:99px;background:var(--r-amber);color:var(--r-bg)}',
    '.r-tip{margin-top:8px;display:flex;gap:9px;align-items:center;font-size:13px;padding:7px 14px;border-radius:12px;background:var(--r-soft)}',
    '.r-tip svg{flex-shrink:0;opacity:.7}',
    '.r-av{display:flex;gap:4px;margin:4px 0 8px}',
    '.r-av.denso{gap:2px}',
    '.r-av div{flex:1;height:14px;border-radius:4px;background:var(--r-track);position:relative;overflow:hidden}',
    '.r-av .pagada{background:var(--r-green-2)}',
    '.r-av .vencida{background:var(--r-red)}',
    '.r-av .proxima{background:var(--r-blue)}',
    '.r-av .abonada:after{content:"";position:absolute;left:0;top:0;bottom:0;width:var(--p);background:var(--r-green-2)}',
    '.r-av-ley{display:flex;gap:16px;font-size:12px;color:var(--r-muted);flex-wrap:wrap}',
    '.r-av-ley i{display:inline-block;width:9px;height:9px;border-radius:3px;margin-right:5px;vertical-align:0}',
    '.r-saldos{display:flex;gap:28px;margin-top:8px;font-size:13px}',
    '.r-saldos b{display:block;font-size:18px;margin-top:1px}',
    '.r-saldos .viejo{color:var(--r-muted);font-size:12px;font-weight:500}',
    'table.r-t{width:100%;border-collapse:collapse;font-size:13px}',
    '.r-t th{text-align:left;font-size:11.5px;font-weight:700;color:var(--r-muted);padding:0 8px 6px;border-bottom:1px solid var(--r-bd)}',
    '.r-t td{padding:3px 8px;border-bottom:1px solid var(--r-bd)}',
    '.r-t .n{text-align:right;white-space:nowrap}',
    '.r-t tr{break-inside:avoid}',
    '.r-t tfoot td{border-bottom:0;font-weight:700;padding-top:7px}',
    '.r-t .sub{font-size:11.5px;color:var(--r-muted);font-weight:400;margin-right:8px}',
    '.chip{display:inline-block;font-size:11.5px;font-weight:600;padding:1px 8px;border-radius:99px;white-space:nowrap}',
    '.chip.venc{color:var(--r-red);background:var(--r-red-bg)}',
    '.chip.prox{color:var(--r-blue);background:var(--r-blue-bg)}',
    '.chip.pend{color:var(--r-muted);background:var(--r-soft)}',
    '.r-pie{margin-top:13px;padding-top:11px;break-inside:avoid;border-top:1px solid var(--r-bd);display:flex;justify-content:space-between;gap:16px;font-size:12px;color:var(--r-muted)}',
    '.r-pie b{color:var(--r-text);font-size:13.5px;display:block;margin-bottom:2px}',
    '.r-pie-d{text-align:right;white-space:nowrap}',
    '@media print{html,body,*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important}' +
      '@page{size:letter;margin:0}html{background:' + C.bg + '!important}body{max-width:none;background:' + C.bg + '!important;color:' + C.text + '!important;min-height:100vh}}'
  ];
}

export var RB_ICONO_OK = '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
export var RB_ICONO_RELOJ = '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
export var RB_ICONO_TIP = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5l3 2"/></svg>';
export var RB_ICONO_ORDEN = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18M5 10l7-7 7 7"/></svg>';

export function rbCabecera(tipo, codigo, emision){
  return '<div class="r-cab"><div class="r-marca"><div class="r-logo">C</div><div><b>Cartera</b><span>' + tipo + '</span></div></div>' +
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
