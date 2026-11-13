// public/js/pdf/recibo-corte.js — Comprobante de un CORTE de interes diario.
//
// Es el equivalente del Recibo de Pago para esta modalidad: se entrega al deudor
// justo despues de registrar un corte, y certifica que ese dinero entro.
//
// Responde tres cosas, en este orden: cuanto entrego, DE DONDE SALE esa cifra
// (dias x interes diario, no un numero caido del cielo), y como le queda el credito
// — incluido cuanto va a generar desde manana, que es lo que un credito abierto
// tiene de particular y lo que el deudor necesita saber para decidir su proximo pago.
//
// El estado PREVIO no se pide por parametro: se deriva excluyendo este corte del
// ledger, con el mismo `estadoDiario` que usa la pantalla. Asi el recibo no puede
// contradecir a la app aunque el llamador pase datos incompletos.

import { fmt, fmtD, copToUsd } from '../core/format.js';
import { estadoDiario } from '../core/dominio.js';
import { rbPaleta, rbTokens, rbImpresionPapel, rbIniciales, RB_LETRA, RB_LOGO, RB_MARCO_ABRE, RB_MARCO_CIERRA } from './recibo-estilo.js';

function campoValido(v){
  if (v === null || v === undefined) return false;
  var s = String(v).trim();
  return s !== '' && s !== '0';
}
function esc(s){
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

export function generateReciboCorte(loan, allPays, corte, opts) {
  opts = opts || {};
  if (!loan || !corte) return;
  var dark = document.documentElement.getAttribute('data-theme') === 'dark';
  var esUSD = loan.moneda === 'USD';
  var trm = loan.trmAcordada || 1;
  function money(cop){ return esUSD ? copToUsd(cop, trm) : fmt(cop); }

  var fechaCorte = corte.fechaPago;
  var intCobrado = Math.round(+corte.interesPeriodo || 0);
  var abonoCap   = Math.round(+corte.abonoCapital  || 0);
  var total      = intCobrado + abonoCap;

  // Estado DESPUES (el ledger ya trae este corte) y ANTES (excluyendolo).
  var mios = (allPays || []).filter(function(p){ return String(p.prestamoId) === String(loan.id); });
  var devPost = estadoDiario(loan, mios, fechaCorte);
  var devPre  = estadoDiario(loan, mios.filter(function(p){ return String(p.id) !== String(corte.id); }), fechaCorte);

  var interesDiaAntes  = Math.round(devPre.capitalVivo  * (+loan.tasaMensual || 0) / 100 / 30);
  var interesDiaDespues= Math.round(devPost.capitalVivo * (+loan.tasaMensual || 0) / 100 / 30);
  var saldado = devPost.capitalVivo === 0 && devPost.interesPendiente === 0;

  var fechaEmision = new Date().toLocaleDateString('es-CO', {day:'2-digit', month:'long', year:'numeric'});
  // Iniciales con la lista blanca comun (con dieresis): antes un apellido con "ü" perdia esa letra.
  var rcCode = 'RC-' + rbIniciales(loan.nombre) + '-' + String(loan.id).slice(-3) + '-' + String(corte.cuotaN).padStart(2,'0');

  // Rediseño v4: la paleta del papel de recibo-estilo.js, en el tema de la app (claro, u oscuro v4).
  var C = rbPaleta(dark);

  function row(l, v, color){
    return '<div class="rc-row"><span class="rc-lab">' + l + '</span>' +
           '<span class="rc-val"' + (color ? ' style="color:' + color + '"' : '') + '>' + v + '</span></div>';
  }

  var deudorMeta = [
    campoValido(loan.cedula) ? 'C.C. ' + esc(loan.cedula) : '',
    campoValido(loan.telefono) ? 'Tel. ' + esc(loan.telefono) : ''
  ].filter(Boolean).join(' &nbsp;&middot;&nbsp; ');

  var html = [
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Recibo de Corte - ' + esc(loan.nombre) + '</title><style>',
    '*{box-sizing:border-box}',
    rbTokens(C),
    'body{font-family:' + RB_LETRA + ';margin:0;padding:26px 30px;background:var(--r-bg);color:var(--r-text);font-size:12px;line-height:1.45;max-width:580px;font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}',
    '.rc-head{display:flex;justify-content:space-between;align-items:center;gap:16px;padding-bottom:11px;border-bottom:1px solid var(--r-bd);margin-bottom:14px}',
    '.rc-brand{display:flex;align-items:center;gap:10px}',
    '.rc-logo{width:32px;height:32px;border-radius:10px;background:var(--r-text);color:var(--r-bg);display:flex;align-items:center;justify-content:center;flex-shrink:0}',
    '.rc-wm{font-size:16px;font-weight:600;letter-spacing:-.02em}',
    '.rc-sub{font-size:10.5px;color:var(--r-muted);margin-top:1px}',
    '.rc-meta{text-align:right}',
    '.rc-type{font-size:11px;font-weight:500;color:var(--r-muted)}',
    '.rc-num{font-size:12.5px;font-weight:600;color:var(--r-text);margin-top:1px}',
    '.rc-date{font-size:10.5px;color:var(--r-muted);margin-top:1px}',
    '.rc-st{font-size:11px;color:var(--r-muted)}',
    '.rc-name{font-size:16px;font-weight:600;letter-spacing:-.01em;margin:1px 0}',
    '.rc-cc{font-size:10.5px;color:var(--r-muted)}',
    '.rc-sec{font-size:12px;font-weight:600;color:var(--r-text);margin:16px 0 6px}',
    '.rc-row{display:flex;justify-content:space-between;gap:12px;padding:5px 0;border-bottom:1px solid var(--r-bd);font-size:11.5px}',
    '.rc-lab{color:var(--r-muted)}',
    '.rc-val{font-weight:600;white-space:nowrap}',
    '.rc-sm{font-size:9.5px;color:var(--r-muted)}',
    // Lo recibido: la cifra en tinta sobre una tarjeta neutra; el verde va en el rotulo y la fecha.
    '.rc-hero{margin:14px 0 2px;padding:14px;text-align:center;background:var(--r-card);border:1px solid var(--r-bd);border-radius:18px}',
    '.rc-hero .l{font-size:12px;font-weight:600;color:var(--r-green)}',
    '.rc-hero .a{font-size:29px;font-weight:600;letter-spacing:-.03em;color:var(--r-text);margin-top:2px}',
    '.rc-chip{display:inline-block;margin-top:6px;padding:2px 10px;border-radius:99px;background:var(--r-green-bg);color:var(--r-green);font-size:10.5px;font-weight:500}',
    '.rc-caja{margin-top:11px;padding:11px 14px;border-radius:14px;display:flex;justify-content:space-between;align-items:center;gap:12px;background:var(--r-blue-bg);border:1px solid ' + C.blueBd + '}',
    '.rc-caja .q{font-size:12px;font-weight:600;color:var(--r-blue)}',
    '.rc-caja .v{font-size:18px;font-weight:600;letter-spacing:-.02em;color:var(--r-blue);white-space:nowrap}',
    '.rc-paz{margin:12px 0 4px;padding:13px;text-align:center;background:var(--r-green-bg);border:1px solid var(--r-green-bd);border-radius:16px}',
    '.rc-paz-t{font-size:17px;font-weight:700;letter-spacing:.08em;color:var(--r-green)}',
    '.rc-paz-s{font-size:12px;color:var(--r-text);margin-top:4px}',
    '.rc-foot{margin-top:17px;padding-top:9px;border-top:1px solid var(--r-bd);text-align:center;color:var(--r-muted);font-size:9.5px;line-height:1.55}',
    '.rc-foot b{color:var(--r-text);font-weight:600}',
    rbImpresionPapel(dark),
    '</style></head><body>' + RB_MARCO_ABRE,
    '<div class="rc-head"><div class="rc-brand">',
    '<div class="rc-logo">' + RB_LOGO + '</div>',
    '<div><div class="rc-wm">Cartera</div><div class="rc-sub">Gestión de cartera de crédito</div></div></div>',
    '<div class="rc-meta"><div class="rc-type">Recibo de Corte</div><div class="rc-num">' + rcCode + '</div>',
    '<div class="rc-date">Emisión: ' + fechaEmision + '</div></div></div>',
    '<div class="rc-st">Recibido de</div>',
    '<div class="rc-name">' + esc(loan.nombre) + '</div>',
    (deudorMeta ? '<div class="rc-cc">' + deudorMeta + '</div>' : ''),

    '<div class="rc-hero"><div class="l">Total recibido</div><div class="a">' + money(total) + '</div>',
    '<div><span class="rc-chip">Registrado el ' + fmtD(fechaCorte) + '</span></div></div>',

    '<div class="rc-sec">Detalle</div>',
    (intCobrado > 0
      ? row('Intereses<div class="rc-sm">' + devPre.diasDesdeUltimoCorte + ' día(s) x ' + money(interesDiaAntes) + '/día desde ' +
            (devPre.fechaUltimoCorte ? fmtD(devPre.fechaUltimoCorte) : fmtD(loan.fechaInicio)) + '</div>', money(intCobrado), C.green)
      : row('Intereses', money(0))),
    row('Abono a capital', money(abonoCap), abonoCap > 0 ? C.blue : undefined),
    (corte.observaciones ? row('Observaciones', esc(corte.observaciones)) : ''),

    (saldado
      ? '<div class="rc-paz"><div class="rc-paz-t">PAZ Y SALVO</div><div class="rc-paz-s">Este crédito quedó cancelado en su totalidad.</div></div>'
      : [
          '<div class="rc-sec">Cómo queda tu crédito</div>',
          row('Capital vivo' + (abonoCap === 0 ? '<div class="rc-sm">Sin cambio: este corte no incluyo abono</div>' : ''), money(devPost.capitalVivo)),
          row('Interés por cobrar', money(devPost.interesPendiente), devPost.interesPendiente > 0 ? C.blue : undefined),
          row('Desde mañana genera' + (abonoCap > 0 ? '<div class="rc-sm">Antes generaba ' + money(interesDiaAntes) + '/día</div>' : ''),
              money(interesDiaDespues) + ' / día'),
          '<div class="rc-caja"><span class="q">Si liquidas hoy</span><span class="v">' +
            money(devPost.capitalVivo + devPost.interesPendiente) + '</span></div>'
        ].join('\n')),

    '<div class="rc-foot">' + (saldado
        ? 'Este documento certifica que el crédito fue cancelado en su totalidad.'
        : 'Este documento certifica el dinero recibido y cómo queda tu crédito a la fecha.') +
      '<br>Generado por <b>Cartera</b> &nbsp;&middot;&nbsp; ' + rcCode + ' &nbsp;&middot;&nbsp; ' + fechaEmision + '</div>',
    RB_MARCO_CIERRA + '</body></html>'
  ].join('\n');

  // El monto se formatea aparte: fmt() mete un espacio duro (U+00A0) tras el '$'
  // que ensuciaria el nombre del archivo (misma razon que en el Recibo de Abono).
  var montoFname = esUSD ? copToUsd(total, trm) : ('$' + total.toLocaleString('es-CO'));
  var fname = saldado ? ('Paz y Salvo ' + loan.nombre) : ('RC ' + loan.nombre + ' - ' + montoFname);
  if (window.electronAPI && window.electronAPI.printPDF) {
    window.electronAPI.printPDF(html, fname);
  } else {
    var w = window.open('', '_blank', 'width=600,height=800');
    w.document.write(html); w.document.close();
    w.onload = function(){ w.print(); };
  }
}
