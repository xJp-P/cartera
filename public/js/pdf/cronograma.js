// public/js/pdf/cronograma.js — Cronograma de pagos que se entrega al deudor.
//
// Extraido de `app.js` en la Etapa 3 (B6) del refactor. Codigo VERBATIM.
//
// Los 5 generadores emiten por `window.electronAPI.printPDF(html, nombre)` con
// respaldo a `window.open` + `print`. No hay libreria de PDF: se arma HTML y lo
// imprime Electron (printToPDF con margins:none, que es lo que consigue el borde
// a borde real; el `@page{margin:0}` del CSS por si solo no basta).
//
// DOCTRINA (v2.3.0): los PDF NO son una excepcion a lo que muestra la app. Usan
// `saldoConCaja` e `imputarCobros`, igual que la pantalla desde la que se generan.
// Hasta v2.3.0 usaban la formula vieja mientras la UI ya mostraba la nueva: el
// papel y la app se contradecian justo cuando el cliente pregunta (Bug #45).
// UNICA excepcion deliberada: el *Valor de liquidacion* sale de
// `computeLiquidacion`, que resta el parcial APARTE; migrarlo lo restaria dos veces.

import { fmt, fmtUSD, fmtD, copToUsd } from '../core/format.js';
import { imputarCobros, computeLiquidacion, proximoVencimiento, periodoEnCursoDe } from '../core/dominio.js';
import { nowStr } from '../core/ui.js';
import { esAbono } from '../core/ids.js';
import { opModalidad } from '../core/operacion.js';
import { rbPaleta, rbTokens, rbImpresionPapel, RB_LETRA, RB_LOGO, RB_MARCO_ABRE, RB_MARCO_CIERRA } from './recibo-estilo.js';

// `opts.incluyeProxMes` (3.1.0): si el valor de liquidacion del pie incluye el interes del
// mes en curso. Es la MISMA decision que la casilla de Liquidar deuda y la toma quien
// imprime, en `CronogramaPdfModal`. Sin `opts` el documento sale byte a byte como antes.
export function generateCronogramaPDF(loan, payments, darkMode, opts) {
  opts = opts || {};
  var esUSD = loan && loan.moneda === 'USD';
  var trm = loan.trmAcordada || 1;
  var fv = esUSD ? function(cop) { return copToUsd(cop, trm); } : fmt;
  // Variante compacta SOLO para las celdas de la tabla del cronograma: en USD omite el
  // prefijo "USD " (la tabla es monomoneda, el prefijo es redundante y roba ~28px por
  // celda). Con 7 columnas en ~640px utiles ese ahorro es lo que evita el desborde.
  var fvT = function(cop) { return fmtDisp(toDisp(cop)); };
  // toDisp/fmtDisp separan el REDONDEO del FORMATO para poder reconciliar el capital en la
  // MONEDA VISIBLE. Redondear cada rubro por separado en USD descuadra la identidad por 1
  // centavo (363.25 + 96.74 = 459.99 != 460.00); reconciliando sobre valores ya redondeados
  // cuadra por construccion. Misma doctrina que moneyCapital en generateFacturaCobro (v1.16.0).
  function toDisp(cop) { return esUSD ? (trm > 0 ? Math.round((cop||0)/trm*100)/100 : 0) : Math.round(cop||0); }
  function fmtDisp(v) { return esUSD ? '$' + new Intl.NumberFormat('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}).format(v||0) : fmt(v); }
  var fechaEmision = new Date().toLocaleDateString('es-CO', {day:'2-digit', month:'long', year:'numeric'});
  var dark = !!darkMode;
  // Rediseño v4: la paleta del papel de recibo-estilo.js, en el tema que pide quien imprime.
  var C = rbPaleta(dark);
  // Todas las cuotas del préstamo
  var allCuotas = payments.filter(function(p) {
    return p.prestamoId === loan.id;
  }).sort(function(a, b) { return a.cuotaN - b.cuotaN; });
  var cuotasAll = allCuotas.filter(function(p) { return !esAbono(p); });
  var abonos = allCuotas.filter(function(p) { return esAbono(p); });
  // Para Intereses: excluir cuotas pendientes (evitar confusión con plazo indefinido)
  var cuotas = loan.modalidad === 'Intereses' ? cuotasAll.filter(function(p) { return p.estadoPago !== 'Pendiente'; }) : cuotasAll;
  var totalPagar = cuotas.reduce(function(s, p) { return s + p.cuotaTotal; }, 0);
  var totalInteres = cuotas.reduce(function(s, p) { return s + p.interesPeriodo; }, 0);
  var totalAbonos = abonos.reduce(function(s, p) { return s + p.abonoCapital; }, 0);
  // Combinar cuotas y abonos (filtrados), ordenar por fecha y luego cuotaN
  var filasBase = cuotas.concat(abonos);
  var filas = filasBase.slice().sort(function(a, b) {
    var cmp = a.fechaPago.localeCompare(b.fechaPago);
    return cmp !== 0 ? cmp : a.cuotaN - b.cuotaN;
  });
  // Pago Unico: la "frecuencia" base (Mensual) confunde -> se fuerza a "Pago Unico"
  var freqLabel = loan.modalidad === 'Pago Unico' ? 'Pago único' : (loan.frecuencia === 'Semanal' ? 'Semanal' : loan.frecuencia === 'Quincenal' ? 'Quincenal' : 'Mensual');
  // Fecha de finalizacion = fecha programada de la ultima cuota (Indefinido para modalidad Intereses)
  var fechaFinPrestamo = loan.modalidad === 'Intereses' ? null : (cuotasAll.length ? cuotasAll.reduce(function(mx, p){ return p.fechaPago > mx ? p.fechaPago : mx; }, '') : null);
  // Tasa: Pago Unico imprime la ganancia pactada como % del capital; el resto, su tasa mensual
  var capCOPpdf = esUSD ? Math.round(loan.montoOrigen * trm) : Math.round(loan.montoOrigen);
  var tasaPdfRow;
  if (loan.modalidad === 'Pago Unico') {
    var puPct = (loan.gananciaFija > 0 && capCOPpdf > 0) ? (Math.round(loan.gananciaFija / capCOPpdf * 1000) / 10) : (loan.tasaMensual || 0);
    tasaPdfRow = '<div class="row"><span class="label">Tasa</span><span class="value">' + puPct + '% (ganancia pactada)</span></div>';
  } else {
    tasaPdfRow = loan.tasaMensual > 0 ? '<div class="row"><span class="label">Tasa</span><span class="value">' + loan.tasaMensual + '% mensual</span></div>' : '';
  }
  var html = [
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Cronograma de Pagos</title>',
    '<style>',
    '*{margin:0;padding:0;box-sizing:border-box}',
    rbTokens(C),
    'body{font-family:' + RB_LETRA + ';padding:30px;max-width:700px;margin:0 auto;color:var(--r-text);background:var(--r-bg);font-size:12px;line-height:1.3;font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}',
    // Encabezado con el logo de la app (el maletin en un cuadro inverso); el titulo sigue siendo el h1.
    '.header{display:flex;align-items:center;gap:12px;border-bottom:1px solid var(--r-bd);padding-bottom:12px;margin-bottom:14px}',
    '.cr-logo{width:34px;height:34px;border-radius:11px;background:var(--r-text);color:var(--r-bg);display:flex;align-items:center;justify-content:center;flex-shrink:0}',
    '.header h1{font-size:19px;font-weight:600;letter-spacing:-.02em;line-height:1.2;margin-bottom:1px}',
    '.header p{font-size:11px;color:var(--r-muted)}',
    '.section{margin-bottom:12px}',
    '.section-title{font-size:12.5px;font-weight:600;color:var(--r-text);margin-bottom:3px}',
    '.row{display:flex;justify-content:space-between;gap:12px;padding:3px 0;font-size:13px;border-bottom:1px solid var(--r-bd)}',
    '.row .label{color:var(--r-muted)}',
    '.row .value{font-weight:500;text-align:right}',
    'table{width:100%;border-collapse:collapse;margin-top:6px}',
    // Cronograma de 7 columnas en ~640px utiles: el padding lateral se queda en 4px y las
    // cabeceras largas ("Abono a capital", "Valor cuota") siguen pudiendo envolver a dos
    // lineas (sin nowrap en th) para no ensanchar su columna.
    'th{padding:5px 4px;text-align:right;font-size:9px;font-weight:500;color:var(--r-muted);border-bottom:1px solid var(--r-bd-2);line-height:1.2}',
    'th:first-child,td:first-child{text-align:center}',
    // nowrap en los importes: sin el, el espacio duro de fmt() ("$ 3.445.494") parte el
    // simbolo del numero en dos lineas al apretarse la columna.
    'td{border-bottom:1px solid var(--r-bd);padding:4px 4px;text-align:right;font-size:10px;line-height:1.2;white-space:nowrap}',
    // Los estados tiñen las CELDAS, no la fila: asi no pelean con la regla del marco
    // (`.r-marco>tbody>tr{background:none}`) y no hace falta ningun `!important`.
    'tr.pagado td{background:var(--r-green-bg);color:var(--r-green)}',
    'tr.mora td{background:var(--r-red-bg);color:var(--r-red);font-weight:600}',
    'tr.pendiente td{color:var(--r-text)}',
    // Las insignias llevan borde: dentro de una fila teñida del mismo tono, sin el se funden.
    '.badge{display:inline-block;padding:0 7px;border-radius:99px;font-size:9px;font-weight:600;line-height:1.2;border:1px solid transparent}',
    '.badge-pagado{background:var(--r-green-bg);color:var(--r-green);border-color:var(--r-green-bd)}',
    '.badge-mora{background:var(--r-red-bg);color:var(--r-red);border-color:' + C.redBd + '}',
    '.badge-pendiente{background:var(--r-soft-2);color:var(--r-text-2);border-color:var(--r-bd-2)}',
    '.badge-abono{background:var(--r-blue-bg);color:var(--r-blue);border-color:' + C.blueBd + '}',
    '.badge-parcial{background:var(--r-amber-bg);color:var(--r-amber);border-color:var(--r-amber-bd)}',
    'tr.abono td{background:var(--r-blue-bg);color:var(--r-blue);font-weight:600}',
    'tr.total-row td{background:var(--r-green-bg);color:var(--r-green);font-weight:600}',
    'tr.total-row.abonos td{background:var(--r-blue-bg);color:var(--r-blue)}',
    '.footer{text-align:center;margin-top:20px;padding-top:12px;border-top:1px solid var(--r-bd);font-size:10px;color:var(--r-muted)}',
    '.nota{margin-top:12px;padding:10px 14px;background:var(--r-amber-bg);border:1px solid var(--r-amber-bd);border-radius:12px;font-size:11px;color:var(--r-amber)}',
    rbImpresionPapel(dark, '', 'font-size:11px;'),
    '</style></head><body>' + RB_MARCO_ABRE,
    '<div class="header"><div class="cr-logo">' + RB_LOGO + '</div><div>',
    '<h1>Cronograma de Pagos</h1>',
    '<p>Fecha de emisión: ' + fechaEmision + '</p>',
    '</div></div>',
    '<div class="section">',
    '<div class="section-title">Deudor</div>',
    '<div class="row"><span class="label">Nombre</span><span class="value">' + loan.nombre + '</span></div>',
    loan.cedula && loan.cedula !== '0' ? '<div class="row"><span class="label">Cédula / ID</span><span class="value">' + loan.cedula + '</span></div>' : '',
    loan.telefono && loan.telefono !== '0' ? '<div class="row"><span class="label">Teléfono</span><span class="value">' + loan.telefono + '</span></div>' : '',
    '</div>',
    '<div class="section">',
    '<div class="section-title">Préstamo</div>',
    '<div class="row"><span class="label">Monto prestado</span><span class="value">' + (esUSD ? fmtUSD(loan.montoOrigen) : fmt(loan.montoOrigen)) + '</span></div>',
    '<div class="row"><span class="label">Modalidad</span><span class="value">' + opModalidad(loan.modalidad) + '</span></div>',
    '<div class="row"><span class="label">Frecuencia</span><span class="value">' + freqLabel + '</span></div>',
    tasaPdfRow,
    '<div class="row"><span class="label">Fecha inicio</span><span class="value">' + fmtD(loan.fechaInicio) + '</span></div>',
    '<div class="row"><span class="label">Fecha de finalización</span><span class="value">' + (loan.modalidad === 'Intereses' ? 'Indefinido' : (fechaFinPrestamo ? fmtD(fechaFinPrestamo) : '—')) + '</span></div>',
    loan.modalidad !== 'Intereses' ? '<div class="row"><span class="label">Cuotas</span><span class="value">' + cuotas.length + '</span></div>' : '',
    '</div>',
    '<div class="section">',
    '<div class="section-title">Cronograma</div>',
    // La fila de titulos va en <thead>: si la tabla sigue en otra hoja, se repite arriba.
    '<table>',
    '<thead><tr><th>#</th><th>Vence</th><th>Interés</th><th>Abono a capital</th><th>Valor cuota</th><th>Saldo</th><th>Estado</th></tr></thead><tbody>',
    filas.map(function(p) {
      var filaEsAbono = esAbono(p);
      var isParcial = !filaEsAbono && (p.partialPaid||0) > 0 && p.estadoPago !== 'Pagado';
      var cls = filaEsAbono ? ' class="abono"' : isParcial ? ' class="mora"' : p.estadoPago === 'Pagado' ? ' class="pagado"' : p.estadoPago === 'En Mora' ? ' class="mora"' : ' class="pendiente"';
      var badge = filaEsAbono ? '<span class="badge badge-abono">Abono</span>' : isParcial ? '<span class="badge badge-mora">'+(p.estadoPago==='En Mora'?'En Mora':'Pendiente')+'</span> <span class="badge badge-parcial">Parcial</span>' : p.estadoPago === 'Pagado' ? '<span class="badge badge-pagado">Pagado</span>' : p.estadoPago === 'En Mora' ? '<span class="badge badge-mora">En Mora</span>' : '<span class="badge badge-pendiente">Pendiente</span>';
      if (filaEsAbono) {
        // Un abono no devenga interes: la columna INTERES va en guion (no "$0", que se
        // confundiria con un interes calculado en cero).
        return '<tr' + cls + '><td>-</td><td style="text-align:left">' + fmtD(p.fechaPago) + '</td><td>&mdash;</td>' +
          '<td><strong>' + fvT(p.abonoCapital) + '</strong></td><td><strong>' + fvT(p.cuotaTotal) + '</strong></td>' +
          '<td>' + fvT(p.saldoFinal) + '</td><td style="text-align:center">' + badge + '</td></tr>';
      }
      // Capital RECONCILIADO (= Valor cuota - Interes), NO p.abonoCapital crudo: en modalidad
      // Prestamo el backend persiste abonoCapital=0 (Bug #2 historico), lo que imprimiria
      // "0 + 0 = 2.300.000" y afirmaria que no se amortizo capital pese a que el saldo cae a
      // cero. Anclado a cuotaTotal, la identidad Interes + Capital = Valor cuota cuadra en las
      // 4 modalidades. La resta va sobre valores YA redondeados a la moneda visible para que
      // en USD tampoco descuadre el centavo (ver nota en toDisp/fmtDisp).
      var intD = toDisp(p.interesPeriodo);
      var cuoD = toDisp(p.cuotaTotal);
      var capD = Math.max(0, Math.round((cuoD - intD) * 100) / 100);
      // VALOR CUOTA es siempre cuotaTotal (el valor pactado de la cuota). En un parcial, lo ya
      // abonado va como sub-linea: si la celda mostrara el remanente, romperia la identidad
      // con las columnas de Interes y Capital, que si suman la cuota completa.
      var cuotaCell = '<strong>' + fmtDisp(cuoD) + '</strong>' +
        (isParcial ? '<br><span style="font-size:9px;opacity:0.75">Abonado ' + fvT(p.partialPaid||0) + '</span>' : '');
      return '<tr' + cls + '><td>' + p.cuotaN + '</td><td style="text-align:left">' + fmtD(p.fechaPago) + '</td>' +
        '<td>' + fmtDisp(intD) + '</td><td>' + fmtDisp(capD) + '</td><td>' + cuotaCell + '</td>' +
        '<td>' + fvT(p.saldoFinal) + '</td><td style="text-align:center">' + badge + '</td></tr>';
    }).join(''),
    // Filas de totales: 7 celdas (antes 6) y cada total alineado BAJO SU columna —
    // los intereses en INTERES (3a) y el capital en ABONO A CAPITAL (4a). Antes todos
    // caian en la 4a celda, que en el layout viejo era la de "Cuota".
    loan.modalidad === 'Intereses' ? function(){var intPagados=cuotas.reduce(function(s,p){return s+imputarCobros(p).totales.interes;},0);return intPagados>0?'<tr class="total-row"><td></td><td style="text-align:left">INTERESES PAGADOS</td><td><strong>'+fvT(intPagados)+'</strong></td><td></td><td></td><td></td><td></td></tr>':'';}() : loan.modalidad === 'Capital + Intereses' ? function(){var capPagado=cuotas.reduce(function(s,p){return s+imputarCobros(p).totales.capital;},0);return capPagado>0?'<tr class="total-row"><td></td><td style="text-align:left">CAPITAL PAGADO</td><td></td><td><strong>'+fvT(capPagado)+'</strong></td><td></td><td></td><td></td></tr>':'';}() : '',
    totalAbonos > 0 ? '<tr class="total-row abonos"><td></td><td style="text-align:left">ABONOS</td><td></td><td><strong>' + fvT(totalAbonos) + '</strong></td><td></td><td></td><td></td></tr>' : '',
    '</tbody></table>',
    loan.modalidad === 'Intereses' ? '<div class="nota"><strong>Nota:</strong> Este préstamo es de plazo indefinido. Solo se muestran las cuotas generadas hasta la fecha. Los pagos de intereses continuarán hasta que el capital sea devuelto en su totalidad, ya sea al final del acuerdo o mediante abonos a capital.</div>' : '',
    function(){
      // v1.19.0 — valor de liquidacion desde el helper centralizado (misma cifra que el modal).
      // 3.1.0 — con la opcion del interes del mes, la misma que ve `LiquidarModal`: para una
      // misma decision, el cronograma y el Estado de Liquidacion imprimen el mismo total.
      // 3.2.0 — con un periodo irregular en curso, los dias que eligio el administrador.
      var L = computeLiquidacion(loan, payments, { incluyeProxMes: !!opts.incluyeProxMes, diasProxMes: opts.diasProxMes, hasta: nowStr() });
      if(L.capitalPendiente <= 0) return '';
      var mesTxt = fv(L.moraValorMes) + '/mes' + (L.moraUniforme ? '' : ' prom.');
      // El total se explica en su propia linea: si incluye el interes del mes, lo dice
      // (un total que su desglose no explica fue el Bug #49).
      var detalle = 'Capital ' + fv(L.capitalPendiente) +
        (L.intMora > 0 ? ' + mora ' + fv(L.intMora) + ' (' + L.moraCount + ' cuota' + (L.moraCount>1?'s':'') + ' a ' + mesTxt + ')' : '') +
        (L.moraConsolidada > 0 ? ' + mora consolidada ' + fv(L.moraConsolidada) : '') +
        (L.partialPend > 0 ? ' &minus; parciales ' + fv(L.partialPend) : '') +
        (L.intExtra > 0 ? (L.periodoIrregular ? ' + interés de ' + L.diasCobrados + ' días del periodo en curso ' : ' + interés ' + periodoEnCursoDe(L.frecuencia) + ' ') + fv(L.intExtra) : '');
      var bg = C.amberBg, bd = C.amberBd, cl = C.amber;
      // Vigencia SOLO cuando la cifra incluye el interes del mes: el deudor queda cubierto
      // hasta la proxima cuota, y sin la fecha podria pagar semanas despues creyendose al
      // dia. La fecha sale del mismo helper que usa el Estado de Liquidacion. Sin la opcion
      // no se emite nada, y los cronogramas de siempre quedan byte a byte como estaban.
      var vig = '';
      if (L.incluyeProxMes) {
        var hoy = nowStr();
        // 3.2.0 — en un periodo irregular, hasta donde cubren los dias cobrados.
        var pv = L.periodoIrregular ? L.validoHasta : proximoVencimiento(loan, payments, hoy);
        vig = '<div style="font-size:10px;color:'+cl+';margin-top:4px"><b>' +
          (pv && L.periodoIrregular ? 'Válido hasta el ' + fmtD(pv) + '.</b> Incluye ' + L.diasCobrados + ' días de interés de este periodo; si el pago se hace después, se generan nuevos intereses.'
          : pv ? 'Válido hasta el ' + fmtD(pv) + '.</b> Incluye el interés de este periodo; si el pago se hace después, se generan nuevos intereses.'
              : 'Valor calculado al ' + fmtD(hoy) + '.</b> Si el pago se hace más adelante, solicita un valor actualizado.') +
          '</div>';
      }
      return '<div style="margin-top:14px;padding:12px 16px;background:'+bg+';border:1px solid '+bd+';border-radius:12px;display:flex;justify-content:space-between;align-items:center;gap:12px">' +
        '<div><div style="font-size:10.5px;font-weight:600;color:'+cl+'">Valor de liquidación</div>' +
        '<div style="font-size:10px;color:'+cl+';margin-top:2px">' + detalle + '</div>' + vig + '</div>' +
        '<div style="font-size:20px;font-weight:600;letter-spacing:-.02em;color:'+cl+';white-space:nowrap">' + fv(L.total) + '</div></div>';
    }(),
    '</div>',
    '<div class="footer">',
    '<p>Este cronograma es informativo y puede variar por abonos a capital</p>',
    '<p style="margin-top:4px">Cartera</p>',
    '</div>',
    RB_MARCO_CIERRA + '</body></html>'
  ].join('\n');
  if (window.electronAPI && window.electronAPI.printPDF) {
    // 3.7.0 (decision del PO): un credito en dolares se imprime SOLO en dolares, tambien en el nombre
    // del archivo (antes salia el monto en dolares con formato de pesos: 'Cronograma $ 1.600').
    var fname = 'Cronograma ' + (esUSD ? fmtUSD(loan.montoOrigen) : fmt(loan.montoOrigen)) + ' - ' + loan.nombre;
    window.electronAPI.printPDF(html, fname);
  } else {
    var w = window.open('', '_blank', 'width=750,height=700');
    w.document.write(html);
    w.document.close();
    w.onload = function() { w.print(); };
  }
}
