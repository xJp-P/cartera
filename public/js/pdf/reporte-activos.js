// public/js/pdf/reporte-activos.js — Mapa de riesgo interno: capital en la calle, mora y vencimientos.
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
import { saldoConCaja, esDiario, estadoDiario } from '../core/dominio.js';
import { nowStr } from '../core/ui.js';
import { esAbono } from '../core/ids.js';
import { opModalidad } from '../core/operacion.js';
import { rbPaleta, rbTokens, rbImpresionPapel, rbMixto, RB_LETRA, RB_LOGO, RB_MARCO_ABRE, RB_MARCO_CIERRA } from './recibo-estilo.js';

// ── Reporte de Prestamos Activos (PDF) ────────────────────────────────────
// Reusa el pipeline printToPDF (electronAPI.printPDF) con fallback a window.print,
// igual que generateCronogramaPDF/generateRecibo -> cero dependencias nuevas.
// Un bloque por prestamo activo; las cuotas En Mora se anidan debajo del prestamo.
// 3.7.0 (decision del PO): la fila de un prestamo en DOLARES lleva solo dolares (valor de la cuota,
// saldo, cuotas en mora y transitoria), como todo documento de un credito en dolares. Y los TOTALES
// separan las dos monedas sin convertirlas ("$ X + USD $Y"): ver el bloque de los totales.
// Totalizador del "capital total en la calle" al final. Tema-aware (claro/oscuro).
export function generateReportePrestamosPDF(loans, pays, darkMode) {
  var dark = !!darkMode;
  // Rediseño v4: la paleta del papel de recibo-estilo.js, en el tema que pide quien imprime.
  var C = rbPaleta(dark);
  var fechaEmision = new Date().toLocaleDateString('es-CO', {day:'2-digit', month:'long', year:'numeric'});
  var hoy = new Date(); hoy.setHours(12, 0, 0, 0);
  function diasAtraso(iso) { if (!iso) return 0; var d = new Date(iso + 'T12:00:00'); return Math.max(0, Math.round((hoy - d) / 86400000)); }
  // v2.1.2 — SALDO REAL de una cuota en mora: lo que FALTA por cobrar, no el valor original.
  // Un pago parcial (POST /payments/:id/partial que no completa la cuota) deja la cuota En Mora
  // con partialPaid > 0; imprimir cuotaTotal afirmaba que se debe el 100% cuando ya entro parte
  // del dinero. Se usa en las 4 superficies del reporte (sub-fila, orden del mapa de riesgo,
  // total vencido y su equivalente USD) para que no puedan divergir entre si.
  function saldoMora(p) { return Math.max(0, (p.cuotaTotal || 0) - (p.partialPaid || 0)); }
  // USD: el cliente paga DOLARES, asi que lo pendiente se mide contra los dolares YA entregados
  // (montoUSDRecibido), no reconvirtiendo los COP abonados a TRM pactada — eso exige de mas cuando
  // la TRM del dia fue menor (doctrina del Bug #23). Misma formula que `pendUSD` en la Factura de
  // Cobro. Sin USD registrado (parcial pagado en pesos) se cae al equivalente COP, correcto ahi.
  function saldoMoraUSD(p, trm) {
    if (!(trm > 0)) return 0;
    var usdRec = +p.montoUSDRecibido || 0;
    return usdRec > 0 ? Math.max(0, (p.cuotaTotal || 0) / trm - usdRec) : saldoMora(p) / trm;
  }

  // Saldo (formula canonica: originalCOP - capital pagado) + cuotas en mora, por prestamo activo
  var rows = (loans || []).filter(function(l) { return l.estado === 'Activo'; }).map(function(l) {
    var esUSD = l.moneda === 'USD';
    var trm = l.trmAcordada || 1;
    var money = esUSD ? function(cop) { return copToUsd(cop, trm); } : fmt;
    var lp = (pays || []).filter(function(p) { return p.prestamoId === l.id; });
    var originalCOP = esUSD ? Math.round(l.montoOrigen * trm) : Math.round(l.montoOrigen);
    // Fase 3: saldo CON CAJA APLICADA. Antes la columna SALDO y el totalizador "capital total en
    // la calle" eran ciegos al capital ya cubierto por un parcial en curso, mientras las sub-filas
    // de mora SI lo descontaban (helper saldoMora, v2.1.2) -> el documento se contradecia solo.
    var saldo = saldoConCaja(l, lp);
    var moras = lp.filter(function(p) { return !esAbono(p) && p.estadoPago === 'En Mora'; })
                  .sort(function(a, b) { return a.cuotaN - b.cuotaN; });
    var vencido = moras.reduce(function(s, p) { return s + saldoMora(p); }, 0);
    // Fila principal = proxima cuota PENDIENTE (el ciclo regular activo). Las En Mora NO van aqui:
    // se detallan en sub-filas rojas. Si no queda ninguna Pendiente (cronograma terminado) -> '—'.
    var pendientes = lp.filter(function(p) { return !esAbono(p) && p.estadoPago === 'Pendiente'; })
                       .sort(function(a, b) { return a.cuotaN - b.cuotaN; });
    var mainCuota = pendientes.length ? pendientes[0] : null;
    // Cuota transitoria (cambio de fecha): extraConsolidado != 0. La fila principal muestra su valor
    // REGULAR (cuotaTotal - extraConsolidado) como referencia; el prorrateo real va en sub-fila ambar.
    var esTransitoria = !!(mainCuota && mainCuota.extraConsolidado && mainCuota.extraConsolidado !== 0);
    var transValor = esTransitoria ? mainCuota.cuotaTotal : 0;
    var transFechaLabel = esTransitoria ? fmtD(mainCuota.fechaPago) : '';   // fecha REAL de la transitoria (sub-fila ambar)
    var vencLabel, proxLabel, proxValor, proxValorLabel;
    if (mainCuota) {
      proxValor = esTransitoria ? (mainCuota.cuotaTotal - mainCuota.extraConsolidado) : mainCuota.cuotaTotal;
      proxValorLabel = money(proxValor);
      if (esTransitoria) {
        // Vencimiento de la fila principal = fecha del PROXIMO ciclo regular (la cuota siguiente a la
        // transitoria): el mes en que retoma la normalidad. La fecha de la transitoria va en la sub-fila.
        var nextReg = pendientes.length > 1 ? pendientes[1] : null;
        vencLabel = fmtD(nextReg ? nextReg.fechaPago : mainCuota.fechaPago);
      } else {
        vencLabel = fmtD(mainCuota.fechaPago);
      }
      if (l.modalidad === 'Intereses') proxLabel = '#' + mainCuota.cuotaN;              // plazo indefinido
      else if (l.modalidad === 'Prestamo' || l.modalidad === 'Pago Unico') proxLabel = '1/1';
      else proxLabel = mainCuota.cuotaN + '/' + (l.plazoMeses || '?');                   // N/M
    } else { vencLabel = '—'; proxLabel = '—'; proxValor = 0; proxValorLabel = '—'; }
    // ── INTERES DIARIO ────────────────────────────────────────────────────────
    // Un credito abierto no tiene cuota que proyectar, asi que las tres columnas
    // salian en '—' y el reporte no decia NADA util de el. Se reinterpretan con lo
    // que si tiene: desde cuando devenga, cuantos dias lleva y cuanto genera al dia.
    // El saldo pasa a incluir el interes devengado: es lo que habria que cobrar hoy,
    // y ese es el sentido de un "capital en la calle".
    var devD = null;
    if (esDiario(l)) {
      devD = estadoDiario(l, lp, nowStr());
      vencLabel = devD.fechaUltimoCorte ? fmtD(devD.fechaUltimoCorte) : fmtD(l.fechaInicio);
      proxLabel = devD.diasDesdeUltimoCorte + ' días';
      proxValor = Math.round(devD.capitalVivo * (+l.tasaMensual || 0) / 100 / 30);
      proxValorLabel = money(proxValor) + '/día';
      saldo = devD.capitalVivo + devD.interesPendiente;
    }
    var tasaStr;
    if (l.modalidad === 'Pago Unico') {
      var pct = (l.gananciaFija > 0 && originalCOP > 0) ? (Math.round(l.gananciaFija / originalCOP * 1000) / 10) : 0;
      tasaStr = pct + '% ganancia';
    } else if (l.modalidad === 'Prestamo') {
      tasaStr = '0%';
    } else {
      tasaStr = (l.tasaMensual || 0) + '% mensual';
    }
    // El rotulo corto de la app (el valor interno se guarda sin tildes); el credito abierto, entero.
    var modLabel = opModalidad(l.modalidad, l.modalidad !== 'Interes Diario');
    return { l: l, esUSD: esUSD, trm: trm, money: money, saldo: saldo, moras: moras, vencido: vencido, tasaStr: tasaStr, modLabel: modLabel,
             vencLabel: vencLabel, proxLabel: proxLabel, proxValor: proxValor, proxValorLabel: proxValorLabel, esTransitoria: esTransitoria, transValor: transValor, transFechaLabel: transFechaLabel };
  });

  // Orden (mapa de riesgo): En Mora primero por TOTAL VENCIDO desc; luego Al dia por SALDO desc
  rows.sort(function(a, b) {
    var am = a.moras.length > 0, bm = b.moras.length > 0;
    if (am !== bm) return am ? -1 : 1;      // En Mora arriba
    if (am) return b.vencido - a.vencido;   // ambos en mora: quien deba mas plata vencida primero
    return b.saldo - a.saldo;               // ambos al dia: mayor capital prestado primero
  });

  // TOTALES (3.7.0, decision del PO sobre un prototipo con las dos versiones): pesos y dolares POR
  // SEPARADO, sin convertir ni sumar entre si ("$ X + USD $Y", el formato de `rbMixto`, el mismo del
  // recibo general de un deudor con creditos en las dos monedas). Cada cifra es la suma EXACTA de las
  // filas impresas: los pesos de los prestamos en pesos y los dolares de los prestamos en dolares, estos
  // en centavos ya redondeados como en su fila. Hasta aqui el total iba en pesos con los dolares
  // convertidos a la TRM PACTADA y un "(Incluye USD $X)": con las filas en dolares mostrando solo
  // dolares, sumar las filas ya no daba ese total. Una cartera sin prestamos en dolares sale igual que antes.
  var totalSaldo = { cop: 0, usd: 0 }, totalVencido = { cop: 0, usd: 0 };
  rows.forEach(function(r) {
    if (r.esUSD) {
      totalSaldo.usd += Math.round(r.saldo / r.trm * 100);
      totalVencido.usd += r.moras.reduce(function(a, p) { return a + Math.round(saldoMoraUSD(p, r.trm) * 100); }, 0);
    } else {
      totalSaldo.cop += Math.round(r.saldo);
      totalVencido.cop += r.moras.reduce(function(a, p) { return a + Math.round(saldoMora(p)); }, 0);
    }
  });
  // Una cartera SOLO en dolares no lee nunca un "$ 0" (rbMixto imprime los pesos cuando no hay dolares).
  var soloUSD = rows.length > 0 && rows.every(function(r) { return r.esUSD; });
  function totalTxt(t) { return soloUSD ? fmtUSD(t.usd / 100) : rbMixto(t); }
  var dosMonedas = totalSaldo.cop > 0 && totalSaldo.usd > 0;
  var countMora = rows.filter(function(r) { return r.moras.length > 0; }).length;

  var filasHTML = rows.map(function(r) {
    var l = r.l, esMora = r.moras.length > 0;
    // Estado del renglon: la fila principal representa la proxima cuota Pendiente (futura). Si el
    // prestamo tiene mora pero esa cuota aun no vence -> "Pendiente" (neutral gris); las sub-filas
    // rojas ya alertan la mora. Sin ninguna Pendiente (cronograma vencido completo) -> "En Mora".
    var estadoBadge = !esMora
      ? '<span class="badge badge-pagado">Al día</span>'
      : (r.proxLabel !== '—' ? '<span class="badge badge-pend">Pendiente</span>' : '<span class="badge badge-mora">En Mora</span>');
    var loanTr = '<tr class="loan-row' + (esMora ? ' mora' : '') + '">' +
      '<td>' + r.vencLabel + '</td>' +
      '<td><strong>' + l.nombre + '</strong></td>' +
      '<td>' + r.modLabel + '</td>' +
      '<td>' + r.tasaStr + '</td>' +
      '<td style="text-align:center">' + r.proxLabel + '</td>' +
      '<td style="text-align:right">' + r.proxValorLabel + '</td>' +
      '<td style="text-align:right"><strong>' + r.money(r.saldo) + '</strong></td>' +
      '<td style="text-align:center">' + estadoBadge + '</td></tr>';
    // Sub-filas rojas: cuotas En Mora. En un prestamo en dolares, solo dolares (3.7.0).
    var moraTrs = r.moras.map(function(p) {
      var dias = diasAtraso(p.fechaPago);
      // v2.1.2 — se imprime el SALDO PENDIENTE de la cuota, no su valor nominal: si ya entro un
      // pago parcial, cobrar el 100% seria cobrar dos veces lo abonado.
      var pend = saldoMora(p);
      var abonado = Math.max(0, (p.cuotaTotal || 0) - pend);
      // Si hubo abono parcial se aclara, para que el deudor entienda por que la cifra es menor
      // que el valor de la cuota (de lo contrario el documento parece tener un error).
      // En dolares la cifra es la de `saldoMoraUSD` (dolares contra dolares, Bug #23) y lo abonado es
      // la cuota menos eso, en centavos, para que "abonado X de Y" cuadre con lo que se imprime.
      var pendTxt = fmt(pend), notaParcial = abonado > 0 ? ' &middot; abonado ' + fmt(abonado) + ' de ' + fmt(p.cuotaTotal) : '';
      if (r.esUSD) {
        var cuotaC = Math.round((p.cuotaTotal || 0) / r.trm * 100), pendC = Math.round(saldoMoraUSD(p, r.trm) * 100);
        pendTxt = fmtUSD(pendC / 100);
        notaParcial = cuotaC - pendC > 0 ? ' &middot; abonado ' + fmtUSD((cuotaC - pendC) / 100) + ' de ' + fmtUSD(cuotaC / 100) : '';
      }
      return '<tr class="mora-sub"><td colspan="8"><div class="mora-detalle">' +
        '<span><span class="gl">&#8627;</span> Cuota #' + p.cuotaN + ' &middot; venció el ' + fmtD(p.fechaPago) + ' &middot; ' + dias + (dias === 1 ? ' día' : ' días') + ' de atraso' + notaParcial + '</span>' +
        '<span><strong>' + pendTxt + '</strong></span></div></td></tr>';
    }).join('');
    // Sub-fila ambar: cuota transitoria (interes prorrateado por cambio de fecha)
    var transTr = r.esTransitoria ? ('<tr class="tran-sub"><td colspan="8"><div class="tran-detalle">' +
      '<span><span class="gl">&#8627;</span> Cuota transitoria &middot; vence ' + r.transFechaLabel + ' &middot; interés prorrateado</span>' +
      '<span><strong>' + r.money(r.transValor) + '</strong></span></div></td></tr>') : '';
    return loanTr + moraTrs + transTr;
  }).join('');

  var html = [
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Reporte de Préstamos Activos</title>',
    '<style>',
    '*{margin:0;padding:0;box-sizing:border-box}',
    rbTokens(C),
    'body{font-family:' + RB_LETRA + ';padding:30px;max-width:780px;margin:0 auto;color:var(--r-text);background:var(--r-bg);font-size:12px;line-height:1.3;font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}',
    // Encabezado con el logo de la app (el maletin en un cuadro inverso); el titulo sigue siendo el h1.
    '.header{display:flex;align-items:center;gap:12px;border-bottom:1px solid var(--r-bd);padding-bottom:13px;margin-bottom:12px}',
    '.ra-logo{width:34px;height:34px;border-radius:11px;background:var(--r-text);color:var(--r-bg);display:flex;align-items:center;justify-content:center;flex-shrink:0}',
    '.header h1{font-size:19px;font-weight:600;letter-spacing:-.02em;line-height:1.2;margin-bottom:1px}',
    '.header p{font-size:11px;color:var(--r-muted)}',
    '.summary{display:flex;gap:20px;margin-bottom:14px;font-size:11px;color:var(--r-muted)}',
    '.summary strong{color:var(--r-text);font-weight:600}',
    'table{width:100%;border-collapse:collapse}',
    // La rejilla v4 es de lineas horizontales: cada prestamo abre con el borde superior de su
    // fila y las sub-filas (mora, transitoria) se le pegan debajo sin linea propia.
    'th{padding:6px 9px;text-align:left;font-size:10px;font-weight:500;color:var(--r-muted);border-bottom:1px solid var(--r-bd-2)}',
    'td{padding:7px 9px;font-size:11px;vertical-align:top}',
    'tr.loan-row td{border-top:1px solid var(--r-bd)}',
    'tr.loan-row.mora td{background:var(--r-red-bg)}',
    'tr.mora-sub td{padding:3px 9px}',
    '.mora-detalle{display:flex;justify-content:space-between;gap:12px;padding-left:16px;font-size:10px;color:var(--r-red)}',
    'tr.tran-sub td{padding:4px 9px;background:var(--r-amber-bg)}',
    '.tran-detalle{display:flex;justify-content:space-between;gap:12px;padding-left:16px;font-size:10px;font-weight:600;color:var(--r-amber)}',
    // Las insignias llevan borde: dentro de una fila teñida del mismo tono, sin el se funden.
    '.badge{display:inline-block;padding:2px 8px;border-radius:99px;font-size:9px;font-weight:600;line-height:1.2;border:1px solid transparent}',
    '.badge-pagado{background:var(--r-green-bg);color:var(--r-green);border-color:var(--r-green-bd)}',
    '.badge-mora{background:var(--r-red-bg);color:var(--r-red);border-color:' + C.redBd + '}',
    '.badge-pend{background:var(--r-soft-2);color:var(--r-text-2);border-color:var(--r-bd-2)}',
    // Los glifos &#8627; y &#9632; no estan en los subconjuntos de Inter: sin una letra del
    // sistema que SI los tenga como TrueType, Chromium los saca de CambriaMath en Type3.
    '.gl{font-family:"Segoe UI Symbol","Segoe UI",Arial,sans-serif}',
    '.footer{text-align:center;margin-top:22px;padding-top:12px;border-top:1px solid var(--r-bd);font-size:10px;color:var(--r-muted)}',
    rbImpresionPapel(dark, '', 'font-size:11px;'),
    '</style></head><body>' + RB_MARCO_ABRE,
    '<div class="header"><div class="ra-logo">' + RB_LOGO + '</div><div><h1>Reporte de Préstamos Activos</h1><p>Fecha de emisión: ' + fechaEmision + '</p></div></div>',
    '<div class="summary"><span><strong>' + rows.length + '</strong> préstamo' + (rows.length === 1 ? '' : 's') + ' activo' + (rows.length === 1 ? '' : 's') + '</span>' +
      '<span><strong>' + countMora + '</strong> en mora</span>' +
      '<span>Total vencido: <strong>' + totalTxt(totalVencido) + '</strong></span></div>',
    rows.length === 0 ?
      '<div style="text-align:center;padding:36px 0;font-size:12px;color:' + C.muted + '">No hay préstamos activos.</div>' :
      '<table><thead><tr><th>Vencimiento</th><th>Deudor</th><th>Modalidad</th><th>Tasa</th><th style="text-align:center">Cuota</th><th style="text-align:right">Valor cuota</th><th style="text-align:right">Saldo Pendiente</th><th style="text-align:center">Estado</th></tr></thead><tbody>' + filasHTML + '</tbody></table>',
    '<div style="margin-top:18px;padding:14px 18px;background:' + C.greenBg + ';border:1px solid ' + C.greenBd + ';border-radius:16px;display:flex;justify-content:space-between;align-items:center">' +
      '<div><div style="font-size:11px;font-weight:600;color:' + C.green + '">Capital total en la calle</div>' +
      '<div style="font-size:10px;color:' + C.green + ';margin-top:2px">' + rows.length + ' préstamo' + (rows.length === 1 ? '' : 's') + ' activo' + (rows.length === 1 ? '' : 's') + (countMora > 0 ? ' &middot; ' + countMora + ' en mora' : '') + '</div></div>' +
      '<div style="text-align:right"><div style="font-size:24px;font-weight:600;letter-spacing:-.02em;color:' + C.green + '">' + totalTxt(totalSaldo) + '</div>' + (dosMonedas ? '<div style="font-size:11px;color:' + C.green + ';margin-top:2px">pesos y dólares por separado: no se suman entre sí</div>' : '') + '</div></div>',
    rows.length > 0 ? function() {
      var borde = C.bd, txt = C.muted, rojo = C.red, ambar = C.amber;
      function item(chip, desc) {
        return '<div style="display:flex;gap:9px;align-items:baseline;margin-bottom:4px">' +
          '<span style="flex-shrink:0;width:72px">' + chip + '</span><span>' + desc + '</span></div>';
      }
      var cuad = function(c) { return '<span class="gl" style="color:' + c + ';font-size:11px">&#9632;</span>'; };
      return '<div style="margin-top:14px;border-top:1px solid ' + borde + ';padding-top:10px;font-size:9px;color:' + txt + '">' +
        '<div style="font-size:9px;font-weight:600;color:' + txt + ';letter-spacing:.3px;margin-bottom:7px">Referencia de estados</div>' +
        item('<span class="badge badge-pagado">Al día</span>', 'Sin cuotas vencidas.') +
        item('<span class="badge badge-pend">Pendiente</span>', 'El préstamo tiene mora, pero la fila principal proyecta la próxima cuota (aún no vence); lo vencido se detalla en las sub-filas rojas.') +
        item('<span class="badge badge-mora">En Mora</span>', 'Cronograma vencido por completo (sin ninguna cuota futura pendiente).') +
        item(cuad(rojo), 'Sub-fila roja: cuota vencida, con sus días de atraso.') +
        // 3.2.0: la transitoria ya no sale solo de un cambio de fecha; tambien de un primer
        // pago elegido al crear que no cae un mes despues del inicio.
        item(cuad(ambar), 'Sub-fila ámbar: cuota transitoria (interés prorrateado por días: primer periodo irregular o cambio de fecha), con su fecha real a cobrar.') +
        '</div>';
    }() : '',
    '<div class="footer"><p>Reporte informativo del estado actual de la cartera</p><p style="margin-top:4px">Cartera</p></div>',
    RB_MARCO_CIERRA + '</body></html>'
  ].join('\n');

  if (window.electronAPI && window.electronAPI.printPDF) {
    var d2 = new Date();
    var fname = 'Reporte Préstamos Activos ' + d2.getFullYear() + '-' + ('0' + (d2.getMonth() + 1)).slice(-2) + '-' + ('0' + d2.getDate()).slice(-2);
    window.electronAPI.printPDF(html, fname);
  } else {
    var w = window.open('', '_blank', 'width=820,height=720');
    w.document.write(html);
    w.document.close();
    w.onload = function() { w.print(); };
  }
}
