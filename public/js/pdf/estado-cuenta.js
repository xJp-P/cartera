// public/js/pdf/estado-cuenta.js — Estado de Cuenta de un credito de INTERES DIARIO.
//
// Es el sustituto del Cronograma para esta modalidad: un credito abierto no tiene
// cuotas que listar, tiene un interes que se genero dia a dia. Este documento
// responde la unica pregunta que el deudor hace de verdad — "¿por que debo esto?"—
// mostrando la secuencia completa de tramos y, INTERCALADOS en azul, los cortes que
// los interrumpieron. Asi se lee como una linea de tiempo (se devengo, se cobro, se
// devengo) y se ve por que el capital base baja tras un abono, en vez de obligar a
// cruzar dos tablas separadas.
//
// La tabla va SIEMPRE COMPLETA (decision de negocio): en un PDF la paginacion no es
// un problema y la trazabilidad del calculo es lo que evita disputas.
//
// DOCTRINA: el devengo NO se recalcula aqui. Sale de `estadoDiario`, el mismo espejo
// del motor que usa la pantalla y que la suite verifica contra el backend. El papel y
// la app no pueden contradecirse (Bug #45).

import { fmt, fmtD, copToUsd } from '../core/format.js';
import { nowStr } from '../core/ui.js';
import { estadoDiario } from '../core/dominio.js';
import { rbPaleta, rbTokens, rbImpresionPapel, rbIniciales, RB_LETRA, RB_LOGO, RB_MARCO_ABRE, RB_MARCO_CIERRA } from './recibo-estilo.js';

// Descarta ""/null/undefined/"0" — sin esto salia "C.C. 0" en los documentos.
function campoValido(v){
  if (v === null || v === undefined) return false;
  var s = String(v).trim();
  return s !== '' && s !== '0';
}
function esc(s){
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

export function generateEstadoCuentaDiario(loan, allPays, opts) {
  opts = opts || {};
  if (!loan) return;
  var hasta = opts.hasta || nowStr();
  var dark = document.documentElement.getAttribute('data-theme') === 'dark';
  var esUSD = loan.moneda === 'USD';
  var trm = loan.trmAcordada || 1;
  // USD protagonista: una linea por rubro, no COP+USD (doctrina v1.16.0).
  function money(cop){ return esUSD ? copToUsd(cop, trm) : fmt(cop); }

  var dev = estadoDiario(loan, allPays, hasta);
  var cortes = (allPays || [])
    .filter(function(p){ return String(p.prestamoId) === String(loan.id) && String(p.id).indexOf('-ct-') !== -1; })
    .sort(function(a,b){
      var c = String(a.fechaPago).localeCompare(String(b.fechaPago));
      return c !== 0 ? c : (a.cuotaN - b.cuotaN);
    });

  var fechaEmision = new Date().toLocaleDateString('es-CO', {day:'2-digit', month:'long', year:'numeric'});
  // Iniciales con la lista blanca comun (con dieresis): antes un apellido con "ü" perdia esa letra.
  var ecCode = 'EC-' + rbIniciales(loan.nombre) + '-' + String(loan.id).slice(-3) + '-' + String(hasta).slice(8,10) + String(hasta).slice(5,7);
  var interesDia = Math.round(dev.capitalVivo * (+loan.tasaMensual || 0) / 100 / 30);
  var tasaDia = Math.round((+loan.tasaMensual || 0) / 30 * 1000) / 1000;

  // Rediseño v4: la paleta del papel de recibo-estilo.js, en el tema de la app (claro, u oscuro v4).
  var C = rbPaleta(dark);

  function row(l, v, color){
    return '<div class="ec-row"><span class="ec-lab">' + l + '</span>' +
           '<span class="ec-val"' + (color ? ' style="color:' + color + '"' : '') + '>' + v + '</span></div>';
  }

  // ── Linea de tiempo: tramos con los cortes intercalados ────────────────────
  // Los tramos de 0 dias (dos cortes el mismo dia) se omiten: no aportan interes y
  // solo anadirian una fila vacia que el deudor leeria como un error del documento.
  var filas = [];
  dev.tramos.forEach(function(t, i){
    if (t.dias > 0 || i === dev.tramos.length - 1) {
      filas.push('<tr><td>' + fmtD(t.desde) + '</td><td>' + fmtD(t.hasta) + '</td>' +
        '<td class="n">' + t.dias + '</td><td class="n">' + money(t.base) + '</td>' +
        '<td class="n">' + money(t.interes) + '</td></tr>');
    }
    // Tras cada tramo (salvo el abierto) viene el corte que lo cerro.
    var c = cortes[i];
    if (c) {
      var det = [];
      if (Math.round(+c.interesPeriodo || 0) > 0) det.push('pago de intereses');
      if (Math.round(+c.abonoCapital || 0) > 0) det.push('abono a capital ' + money(Math.round(+c.abonoCapital)));
      filas.push('<tr class="ev"><td colspan="4">Corte #' + c.cuotaN + ' &nbsp;&middot;&nbsp; ' +
        fmtD(c.fechaPago) + ' &nbsp;&middot;&nbsp; ' + (det.join(' + ') || 'sin movimiento') + '</td>' +
        '<td class="n">&minus;' + money(Math.round(+c.interesPeriodo || 0)) + '</td></tr>');
    }
  });
  filas.push('<tr class="tot"><td colspan="3">Total devengado</td><td class="n">' + dev.diasTotales + ' días</td>' +
             '<td class="n">' + money(dev.interesDevengado) + '</td></tr>');
  filas.push('<tr class="tot"><td colspan="4">Total cobrado</td><td class="n">&minus;' + money(dev.interesCobrado) + '</td></tr>');

  var deudorMeta = [
    campoValido(loan.cedula) ? 'C.C. ' + esc(loan.cedula) : '',
    campoValido(loan.telefono) ? 'Tel. ' + esc(loan.telefono) : ''
  ].filter(Boolean).join(' &nbsp;&middot;&nbsp; ');

  var html = [
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Estado de Cuenta - ' + esc(loan.nombre) + '</title><style>',
    '*{box-sizing:border-box}',
    rbTokens(C),
    'body{font-family:' + RB_LETRA + ';margin:0;padding:26px 30px;background:var(--r-bg);color:var(--r-text);font-size:12px;line-height:1.45;max-width:700px;font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}',
    '.ec-head{display:flex;justify-content:space-between;align-items:center;gap:16px;padding-bottom:11px;border-bottom:1px solid var(--r-bd);margin-bottom:14px}',
    '.ec-brand{display:flex;align-items:center;gap:10px}',
    '.ec-logo{width:32px;height:32px;border-radius:10px;background:var(--r-text);color:var(--r-bg);display:flex;align-items:center;justify-content:center;flex-shrink:0}',
    '.ec-wm{font-size:16px;font-weight:600;letter-spacing:-.02em}',
    '.ec-sub{font-size:10.5px;color:var(--r-muted);margin-top:1px}',
    '.ec-meta{text-align:right}',
    '.ec-type{font-size:11px;font-weight:500;color:var(--r-muted)}',
    '.ec-num{font-size:12.5px;font-weight:600;color:var(--r-text);margin-top:1px}',
    '.ec-date{font-size:10.5px;color:var(--r-muted);margin-top:1px}',
    '.ec-st{font-size:11px;color:var(--r-muted)}',
    '.ec-name{font-size:16px;font-weight:600;letter-spacing:-.01em;margin:1px 0}',
    '.ec-cc{font-size:10.5px;color:var(--r-muted)}',
    '.ec-sec{font-size:12px;font-weight:600;color:var(--r-text);margin:16px 0 6px}',
    '.ec-row{display:flex;justify-content:space-between;gap:12px;padding:5px 0;border-bottom:1px solid var(--r-bd);font-size:11.5px}',
    '.ec-lab{color:var(--r-muted)}',
    '.ec-val{font-weight:600;white-space:nowrap}',
    '.ec-sm{font-size:9.5px;color:var(--r-muted)}',
    'table{width:100%;border-collapse:collapse;font-size:10.5px}',
    'th{text-align:left;color:var(--r-muted);font-size:9.5px;font-weight:500;padding:4px 5px 5px;border-bottom:1px solid var(--r-bd-2);white-space:nowrap}',
    'td{padding:5px;border-bottom:1px solid var(--r-bd);white-space:nowrap}',
    'td.n,th.n{text-align:right}',
    'tr.ev td{background:var(--r-blue-bg);color:var(--r-blue);font-weight:600;font-size:10px}',
    'tr.tot td{font-weight:600;border-top:1px solid var(--r-bd-2);border-bottom:none}',
    '.ec-caja{margin-top:11px;padding:11px 14px;border-radius:14px;display:flex;justify-content:space-between;align-items:center;gap:12px;background:var(--r-blue-bg);border:1px solid ' + C.blueBd + '}',
    '.ec-caja .q{font-size:12px;font-weight:600;color:var(--r-blue)}',
    '.ec-caja .v{font-size:22px;font-weight:600;letter-spacing:-.02em;color:var(--r-blue);white-space:nowrap}',
    '.ec-nota{margin-top:11px;padding:9px 13px;background:var(--r-soft);border-radius:12px;font-size:10.5px;line-height:1.5;color:var(--r-text-2)}',
    '.ec-nota b{color:var(--r-text)}',
    '.ec-foot{margin-top:17px;padding-top:9px;border-top:1px solid var(--r-bd);text-align:center;color:var(--r-muted);font-size:9.5px;line-height:1.55}',
    '.ec-foot b{color:var(--r-text);font-weight:600}',
    rbImpresionPapel(dark),
    '</style></head><body>' + RB_MARCO_ABRE,
    '<div class="ec-head"><div class="ec-brand">',
    '<div class="ec-logo">' + RB_LOGO + '</div>',
    '<div><div class="ec-wm">Cartera</div><div class="ec-sub">Gestión de cartera de crédito</div></div></div>',
    '<div class="ec-meta"><div class="ec-type">Estado de Cuenta</div><div class="ec-num">' + ecCode + '</div>',
    '<div class="ec-date">Emisión: ' + fechaEmision + '</div></div></div>',
    '<div class="ec-st">Crédito abierto de</div>',
    '<div class="ec-name">' + esc(loan.nombre) + '</div>',
    (deudorMeta ? '<div class="ec-cc">' + deudorMeta + '</div>' : ''),

    '<div class="ec-sec">Condiciones</div>',
    row('Capital prestado', money(dev.origCOP)),
    row('Desde', fmtD(loan.fechaInicio)),
    row('Tasa', (+loan.tasaMensual || 0) + '% mensual &nbsp;&middot;&nbsp; ' + tasaDia + '% diario'),

    '<div class="ec-sec">Cómo se generó el interés</div>',
    '<table><thead><tr><th>Desde</th><th>Hasta</th><th class="n">Días</th><th class="n">Capital base</th><th class="n">Interés</th></tr></thead><tbody>',
    filas.join(''),
    '</tbody></table>',
    '<div class="ec-sm" style="margin-top:5px">Cada tramo va desde su fecha inicial inclusive hasta la siguiente sin incluir, de modo que ningún día se cobra dos veces. Un abono a capital reduce la base ese mismo día.</div>',

    '<div class="ec-sec">Situación al ' + fmtD(hasta) + '</div>',
    row('Capital prestado', money(dev.origCOP)),
    row('Capital devuelto', '&minus;' + money(dev.capitalAbonado), C.green),
    row('Capital vivo', money(dev.capitalVivo)),
    row('Interés devengado por cobrar<div class="ec-sm">' + dev.diasDesdeUltimoCorte + ' día(s) x ' + money(interesDia) +
        '/día desde ' + (dev.fechaUltimoCorte ? ('el último corte (' + fmtD(dev.fechaUltimoCorte) + ')') : ('el inicio (' + fmtD(loan.fechaInicio) + ')')) + '</div>',
        money(dev.interesPendiente), C.blue),

    '<div class="ec-caja"><span class="q">Valor para liquidar al ' + fmtD(hasta) + '</span>',
    '<span class="v">' + money(dev.capitalVivo + dev.interesPendiente) + '</span></div>',
    (dev.capitalVivo > 0
      ? '<div class="ec-nota">Mientras quede capital vivo, el crédito genera <b>' + money(interesDia) + '</b> cada día. Puedes pagar solo los intereses o abonar a capital en cualquier momento: cada abono baja el interés diario desde ese mismo día.</div>'
      : '<div class="ec-nota">El capital fue devuelto en su totalidad; el crédito ya no genera interés.</div>'),

    '<div class="ec-foot">Este documento detalla cómo se generó el interés de tu crédito abierto y su situación a la fecha de emisión.',
    '<br>Generado por <b>Cartera</b> &nbsp;&middot;&nbsp; ' + ecCode + ' &nbsp;&middot;&nbsp; ' + fechaEmision + '</div>',
    RB_MARCO_CIERRA + '</body></html>'
  ].join('\n');

  var fname = 'Estado de cuenta ' + loan.nombre + ' - ' + hasta;
  if (window.electronAPI && window.electronAPI.printPDF) {
    window.electronAPI.printPDF(html, fname);
  } else {
    var w = window.open('', '_blank', 'width=750,height=800');
    w.document.write(html); w.document.close();
    w.onload = function(){ w.print(); };
  }
}
