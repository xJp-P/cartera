// public/js/pdf/recibo-cobro.js — el RECIBO DE PAGO de un cobro en cascada.
//
// Un cobro en cascada son N movimientos contra endpoints distintos (`/partial` por cada cuota
// vencida, `/abono` por el remanente), pero para el cliente fue UNA sola entrega de dinero. Este
// documento es el papel que se le devuelve: cuanto entrego, a que se fue y que le queda.
//
// ── EL DISENO (post-4.1.6, opcion A del PO sobre un prototipo con su cobro real) ─────────────
// Es la GEMELA de la Propuesta de Abono (el papel de ANTES): la misma linea de los recibos y las
// mismas piezas, para que los dos papeles de una operacion se lean igual. El de 3.5.0 explicaba el
// pago en frases y el PO lo encontro "soso". Ahora, en este orden:
//   1. UNA cifra protagonista: lo que entro, de quien y cuando.
//   2. "Como se aplico tu pago": una TABLA (concepto, fecha, intereses, capital), una fila por
//      movimiento, SIN fila de total (el total es la cifra de arriba) y sin columnas que ninguna
//      fila usa. La cuota que quedo a medias dice cuanto falta; la condonada en parte, cuanto se
//      condono.
//   3. "Asi quedo tu credito": tarjetas con el valor de ANTES en letra pequena (capital, tu proxima
//      cuota, lo que te falta por pagar), y notas: verde si el pago lo dejo al dia, ambar con lo
//      que le falta para ponerse al dia, y la del congelamiento.
//   4. "Lo que esta vencido": SOLO las cuotas atrasadas, una por fila, con su total.
//   5. Un cierre que certifica el pago.
//
// ── POR QUE NO ALCANZABAN LOS RECIBOS QUE YA EXISTIAN ────────────────────────
// `generateReciboAbono` describe UN abono y `generateRecibo` el pago de UNA cuota. Y nada en
// el esquema ata los movimientos de un mismo cobro: `payments` no tiene columna de
// correlacion, el id `-ab-` no existe si el cobro fue solo de mora, y agrupar por fecha
// fusionaria dos cobros del mismo dia. Por eso la correlacion se pasa como parametro, desde
// quien acaba de ejecutarla.
//
// ── DE DONDE SALEN LOS DATOS (regla que no se negocia) ───────────────────────
// De `cobro.pasos`, que es `estado.hechos` del orquestador: lo que EFECTIVAMENTE se aplico.
// NUNCA de `plan.pasos`. Si un paso falla, un recibo armado desde el plan declara dinero que no
// se registro (Bug #45). Coherente con eso, `_doCobroCascada` solo llama aqui cuando la cadena
// entera tuvo exito. Lo que queda por pagar sale de las filas PERSISTIDAS y recargadas tras el
// cobro: si un abono regenero el cronograma, esto ya refleja el nuevo. El saldo es `saldoConCaja`,
// nunca el del motor (doctrina v2.3.0: el papel no puede contradecir a la app).

import { fmt, fmtUSD } from '../core/format.js';
import { nowStr } from '../core/ui.js';
import { saldoConCaja, esDiario, pendCuota, condonadoDe, congeladoAbierto, cierreDeCuota } from '../core/dominio.js';
import { esAbono } from '../core/ids.js';
import { nombrePdf, montoArchivo, prestamoArchivo } from './nombres.js';
import { rbCss, rbPaleta, rbCabecera, rbLarga, rbMedia, rbCorta, rbEsc, rbCampoValido, rbPlural, rbPrimerNombre, rbIniciales,
         rbMoneda, rbTarjeta, rbRejilla, rbEmitir, RB_ICONO_OK, RB_ICONO_TIP, RB_MARCO_ABRE, RB_MARCO_CIERRA } from './recibo-estilo.js';

// `cobro` = { fecha, pasos, pre, observaciones }
//   - pasos: los del orquestador ya aplicados. Cada uno trae `obligacionCOP` (deuda
//     extinguida), `cajaCOP` (pesos reales que entraron), `interes` y `capital`; los `partial`
//     ademas `payId`, `cuotaN`, `fechaPago`, `salda` y `restanteCuota`, y en USD el
//     `obligacionUSD` exacto.
//   - pre: snapshot ANTERIOR al cobro (`_snapshotAbono`): `saldoCaja`, `cuota` (la proxima de
//     antes) y `pendPorPagar` (lo que faltaba de cada cuota), para los "antes $X".
// 2 variantes: RECIBO (credito con saldo vivo) y PAZ Y SALVO (el cobro lo salda).
export function generateReciboCobro(loan, allPays, cobro, opts) {
  cobro = cobro || {}; opts = opts || {};
  if (!loan) return;
  // Un credito de interes diario no pasa por la cascada: su comprobante es el del CORTE.
  if (esDiario(loan)) return;
  var pasos = (cobro.pasos || []).filter(Boolean);
  // Sin movimientos aplicados no hay nada que certificar.
  if (!pasos.length) return;

  var C = rbPaleta(document.documentElement.getAttribute('data-theme') === 'dark');
  var mon = rbMoneda(loan), uni = mon.uni, fmtUni = mon.fmtUni, money = mon.money, esUSD = mon.esUSD;
  var pre = cobro.pre || {};
  var esIndef = loan.modalidad === 'Intereses';
  var fechaCobro = cobro.fecha || nowStr();
  var emision = nowStr();
  var anio = String(fechaCobro).slice(0, 4);

  // CAJA: los pesos que entraron de verdad (doctrina CAJA vs OBLIGACION). El orquestador
  // reparte la caja entre los pasos y el ultimo absorbe el residuo: la suma es EXACTAMENTE lo
  // que el usuario declaro haber recibido.
  var cajaCOP = pasos.reduce(function(s, p){ return s + Math.round(p.cajaCOP || 0); }, 0);
  var oblUSD = esUSD ? pasos.reduce(function(s, p){ return s + (+p.obligacionUSD || 0); }, 0) : 0;
  // USD protagonista: el cliente entrego dolares y esa es la cifra que reconoce.
  var recibidoTxt = esUSD ? fmtUSD(oblUSD) : fmt(cajaCOP);

  // ── Estado del credito DESPUES (datos ya persistidos y recargados) ─────────
  var lp = (allPays || []).filter(function(p){ return String(p.prestamoId) === String(loan.id); });
  var regs = lp.filter(function(p){ return !esAbono(p); }).sort(function(a, b){ return a.cuotaN - b.cuotaN; });
  var porId = {}; regs.forEach(function(p){ porId[p.id] = p; });
  var saldoDespues = saldoConCaja(loan, lp);
  var esPazYSalvo = saldoDespues <= 0 || loan.estado === 'Finalizado';
  // Un "PAZ Y SALVO" con saldo > 0 seria un documento que se contradice a si mismo.
  if (esPazYSalvo) saldoDespues = 0;
  var saldoAntes = (pre.saldoCaja != null) ? pre.saldoCaja : ((pre.saldo != null) ? pre.saldo : saldoDespues);
  var pend = regs.filter(function(p){ return p.estadoPago === 'Pendiente'; });
  var vencidas = regs.filter(function(p){ return p.estadoPago === 'En Mora' && pendCuota(p) > 0; })
    .sort(function(a, b){ return String(a.fechaPago).localeCompare(String(b.fechaPago)) || a.cuotaN - b.cuotaN; });
  // Congelado (post-4.1.6): mientras siga congelado no corren intereses ni nacen cuotas, asi que el
  // recibo no puede decir que cada mes se pagan intereses ni sumar las cuotas que quedan como si
  // fueran toda la deuda (en C+I solo queda la de cierre: el capital no vive en ninguna cuota).
  var cong = congeladoAbierto(loan);
  // Una fecha de otro anio lo lleva escrito.
  function fechaV(f){ return f ? (String(f).slice(0, 4) !== anio ? rbLarga(f) : rbMedia(f)) : ''; }

  // ── 2. COMO SE APLICO TU PAGO: una fila por movimiento ─────────────────────
  // Los importes van en la MONEDA VISIBLE y con su clase (`r-i` interes vencido, `r-m` interes del
  // mes, `r-k` capital de una cuota vencida, `r-a` abono): la prueba los suma y exige que el papel
  // cuadre con la obligacion realmente extinguida. El capital de cada fila se ANCLA a su total
  // (capital = obligacion - interes, doctrina v1.18.0): absorbe el residuo de redondeo de las
  // filas legacy (Bug #43) y en USD no se pierde el centavo (Bug #31).
  var filas = pasos.map(function(p){
    var t = uni(p.obligacionCOP);
    if (p.tipo === 'abono') return { c: 'Abono a capital', sub: 'baja tu saldo y los intereses que vienen', cuando: '', i: 0, k: t, ci: '', ck: 'r-a' };
    var fila = p.payId ? porId[p.payId] : null;
    var fecha = p.fechaPago || (fila && fila.fechaPago) || '';
    var n = fila ? fila.cuotaN : p.cuotaN;
    // El interes del PERIODO EN CURSO: la cuota NO vencio, se pago por adelantado (Bug #61: una
    // prueba real declaraba atrasada una cuota del 19 en un cobro del 3).
    if (p.esInteresMes) return { c: 'Interés de la cuota ' + n, sub: '', cuando: fecha ? 'vence el ' + fechaV(fecha) + ' · por adelantado' : 'por adelantado',
      i: t, k: 0, ci: 'r-m', ck: '' };
    var x = Math.min(t, uni(p.interes));
    // Lo que falta sale de la fila persistida, no de `restanteCuota`, que se calcula al PLANEAR:
    // si despues un abono regenera el cronograma esa cifra deja de ser cierta.
    var falta = fila ? pendCuota(fila) : Math.max(0, p.restanteCuota || 0);
    // Una cuota que se salda y que antes se condono en parte vale menos que su cuota: sin decirlo,
    // parece un error (post-4.1.6, primera condonacion con monto en produccion).
    var cond = fila ? condonadoDe(fila) : 0;
    var sub = [(!p.salda && falta > 0) ? 'te faltan ' + money(falta) : '', cond > 0 ? money(cond) + ' de intereses se condonaron' : ''].filter(Boolean).join(' · ');
    return { c: 'Cuota ' + n + (p.salda ? ' · saldada' : ' · en parte'), sub: sub, cuando: fecha ? 'venció el ' + fechaV(fecha) : '',
      i: x, k: Math.max(0, t - x), ci: 'r-i', ck: 'r-k' };
  });
  // Una columna que ninguna fila usa no se imprime (en solo intereses no hay capital).
  var conI = filas.some(function(f){ return f.i > 0; }), conK = filas.some(function(f){ return f.k > 0; });
  var guion = '<span class="muted">—</span>';
  function celda(v, cls){ return '<td class="n">' + (v > 0 ? '<span class="' + cls + '">' + fmtUni(v) + '</span>' : guion) + '</td>'; }
  var aplicacionHTML = '<div class="r-sec"><div class="r-sec-t">Cómo se aplicó tu pago' +
    (pasos.length > 1 && conI && conK ? ' · primero lo vencido, luego el capital' : '') + '</div>' +
    '<table class="r-t"><thead><tr><th>Concepto</th><th></th>' + (conI ? '<th class="n">Intereses</th>' : '') + (conK ? '<th class="n">Capital</th>' : '') + '</tr></thead><tbody>' +
    filas.map(function(f){
      return '<tr><td>' + f.c + (f.sub ? '<span class="rc-sub">' + f.sub + '</span>' : '') + '</td><td class="muted">' + f.cuando + '</td>' +
        (conI ? celda(f.i, f.ci) : '') + (conK ? celda(f.k, f.ck) : '') + '</tr>';
    }).join('') + '</tbody></table></div>';

  // ── PAZ Y SALVO ────────────────────────────────────────────────────────────
  var pazHTML = esPazYSalvo
    ? '<div class="r-paz"><div class="r-paz-t">PAZ Y SALVO</div><div>Con este pago queda <b>cancelada la totalidad</b> de tu crédito. No queda saldo pendiente.</div></div>'
    : '';

  // ── 3-4. ASI QUEDO TU CREDITO y LO QUE ESTA VENCIDO ────────────────────────
  var quedoHTML = '', vencidoHTML = '';
  if (!esPazYSalvo) {
    var prox = pend[0] || null;
    // Lo vencido es la suma de sus filas de "Lo que esta vencido", cada una ya convertida (mon.sumaU).
    var moraU = mon.sumaU(vencidas.map(pendCuota)), proxU = prox ? uni(pendCuota(prox)) : 0;
    // Lo que queda (vencidas y por vencer, desde las filas persistidas). El total es la SUMA de lo que
    // falta de cada cuota ya convertida (4.1.4), igual que la Propuesta (cascada J).
    var porPagar = regs.filter(function(p){ return p.estadoPago !== 'Pagado' && pendCuota(p) > 0; });
    var totalFaltaU = mon.sumaU(porPagar.map(pendCuota));
    // Lo que se debia ANTES, con la misma regla: `pre.pendPorPagar` es la lista de lo que faltaba de
    // cada cuota (app.js, `_snapshotAbono`). Sin ella (un llamador viejo) se convierte el total.
    var antesU = Array.isArray(pre.pendPorPagar) ? mon.sumaU(pre.pendPorPagar) : uni(pre.totalPorPagar || 0);

    var tar = [];
    var capTxt = money(saldoDespues);
    tar.push({ l: 'Capital', v: capTxt, s: saldoAntes > saldoDespues ? 'antes ' + money(saldoAntes)
      : (esIndef && !cong ? 'plazo indefinido: se paga al final' : 'se sigue debiendo') });
    var cardProx = null;
    if (prox) {
      var abProx = Math.round(prox.partialPaid || 0);
      var esCierre = !!(cong && cierreDeCuota(loan, prox.cuotaN));
      // "antes": si un abono de este cobro regenero la cuota, lo que valia antes (`pre.cuota`).
      var antesCuota = (abProx === 0 && pre.cuota && uni(pre.cuota) !== uni(prox.cuotaTotal)) ? 'antes ' + money(pre.cuota) : '';
      cardProx = { l: esCierre ? 'Tu cuota de cierre' : 'Tu próxima cuota', v: fmtUni(proxU),
        s: ['vence el ' + rbCorta(prox.fechaPago, anio), esCierre ? 'los días de interés antes del congelamiento' : '',
            abProx > 0 ? 'ya abonaste ' + money(abProx) + ' de ' + money(prox.cuotaTotal) : '', antesCuota].filter(Boolean).join(' · ') };
    }
    // "Te falta por pagar" no va en `Intereses` (sus cuotas son de puro interes y el capital vence
    // fuera de ellas: la suma anunciaria MENOS deuda de la que hay) ni congelado (solo queda la de
    // cierre).
    var cardTotal = (!esIndef && !cong && totalFaltaU > 0)
      ? { l: 'Te falta por pagar', v: fmtUni(totalFaltaU), s: antesU > totalFaltaU ? 'antes ' + fmtUni(antesU) : 'todas las cuotas que quedan' } : null;
    if (cardProx && cardTotal && cardProx.v === cardTotal.v && vencidas.length === 0) {
      // Una sola cuota y nada vencido: el total y el proximo pago son el MISMO numero, una tarjeta.
      tar.push({ l: 'Te falta un solo pago', v: cardProx.v, s: cardProx.s });
    } else {
      if (cardProx) tar.push(cardProx);
      if (cardTotal) tar.push(cardTotal);
    }
    // Ninguna tarjeta repite una cifra que otra ya muestra (en un `Prestamo` sin interes lo que falta
    // ES el capital; con una sola cuota y su interes cubierto, tambien).
    if (tar.slice(1).some(function(t){ return t.v === capTxt; })) tar.shift();

    var notas = '';
    // El pago saldo todo lo vencido: dicho en verde. "Habia mora" = el cobro aplico dinero a cuotas vencidas.
    var habiaMora = pasos.some(function(p){ return p.tipo === 'partial' && !p.esInteresMes; });
    if (habiaMora && vencidas.length === 0) notas += '<div class="r-tip verde">' + RB_ICONO_OK + '<span><b>Quedaste al día:</b> este pago saldó todo lo vencido.</span></div>';
    if (vencidas.length) notas += '<div class="r-tip ambar">' + RB_ICONO_TIP + '<span>Para ponerte al día te faltan <b>' + fmtUni(moraU) + '</b> (' +
      rbPlural(vencidas.length, 'cuota vencida', 'cuotas vencidas') + ')' +
      (prox ? '. Si pagas <b>' + fmtUni(moraU + proxU) + '</b> a más tardar el ' + rbMedia(prox.fechaPago) + ', quedas completamente al día.' : '.') + '</span></div>';
    if (cong) notas += '<div class="r-tip">' + RB_ICONO_TIP + '<span>Tu crédito está <b>congelado</b> desde el ' + rbLarga(cong.desde) +
      ': no corren intereses ni se generan cuotas hasta que se descongele.' + (vencidas.length ? ' Lo vencido se sigue debiendo.' : '') + '</span></div>';
    quedoHTML = '<div class="r-sec"><div class="r-sec-t">Así quedó tu crédito</div>' +
      rbRejilla(tar.map(function(t){ return rbTarjeta('', t.l, t.v, t.s); })) + notas + '</div>';

    // Tabla "Lo que esta vencido" (post-4.1.6, decision del PO): SOLO las cuotas atrasadas, una
    // por fila. Si no cabe, sigue en la hoja siguiente con los titulos repetidos (`r-venc`).
    if (vencidas.length) {
      // UN formato de fecha en toda la tabla: si alguna fila es de otro anio, todas lo llevan.
      var conAnio = vencidas.some(function(p){ return String(p.fechaPago).slice(0, 4) !== anio; });
      vencidoHTML = '<div class="r-sec r-venc"><div class="r-sec-t">Lo que está vencido</div><table class="r-t"><thead><tr><th>Cuota</th><th>Venció</th><th class="n">Te falta</th></tr></thead><tbody>' +
        vencidas.map(function(p){
          var ab = Math.round(p.partialPaid || 0);
          return '<tr><td>' + p.cuotaN + '</td><td>' + (conAnio ? rbLarga(p.fechaPago) : rbMedia(p.fechaPago)) + '</td><td class="n">' +
            (condonadoDe(p) > 0 ? '<span class="sub">se condonó ' + money(condonadoDe(p)) + '</span>' : '') +
            (ab > 0 ? '<span class="sub">ya abonaste ' + money(ab) + ' de ' + money(p.cuotaTotal) + '</span>' : '') + '<b>' + money(pendCuota(p)) + '</b></td></tr>';
        }).join('') +
        '<tr class="r-tot"><td colspan="2">Total vencido</td><td class="n">' + fmtUni(moraU) + '</td></tr></tbody></table></div>';
    }
  }

  var obsHTML = rbCampoValido(cobro.observaciones) ? '<div class="r-obs"><b>Observaciones:</b> ' + rbEsc(String(cobro.observaciones).trim()) + '</div>' : '';

  var codigo = 'RC-' + rbIniciales(loan.nombre) + '-' + String(loan.id || '').slice(-3) + '-' + String(fechaCobro).slice(8, 10) + String(fechaCobro).slice(5, 7);
  var contacto = [rbCampoValido(loan.cedula) ? 'C.C. ' + rbEsc(String(loan.cedula).trim()) : '',
                  rbCampoValido(loan.telefono) ? 'Tel. ' + rbEsc(String(loan.telefono).trim()) : ''].filter(Boolean);
  var titulo = esPazYSalvo ? 'Paz y salvo' : 'Recibo de pago';
  var nombre1 = rbEsc(rbPrimerNombre(loan.nombre));

  var html = [
    '<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>' + titulo + '</title><style>'
  ].concat(rbCss(C)).concat([
    '.r-t tr.r-tot td{border-bottom:0;font-weight:600;padding-top:7px}',
    '.r-t .muted{color:var(--r-muted)}',
    '.r-t .rc-sub{display:block;font-size:11.5px;color:var(--r-muted);font-weight:400}',
    '.r-sec.r-venc{break-inside:auto}',
    '.r-tip.verde{background:var(--r-green-bg);color:var(--r-green)}',
    '.r-tip.verde svg{color:var(--r-green)}',
    '.r-tip.ambar{background:var(--r-amber-bg);color:var(--r-amber)}',
    '.r-tip.ambar svg{color:var(--r-amber)}',
    '.r-tip.verde b,.r-tip.ambar b{color:inherit}',
    '.r-paz{margin-top:12px;padding:12px 18px;border-radius:14px;border:1px solid var(--r-green-bd);background:var(--r-green-bg);font-size:13.5px}',
    '.r-paz-t{font-size:15px;font-weight:700;letter-spacing:.08em;color:var(--r-green);margin-bottom:3px}',
    '.r-obs{margin-top:8px;font-size:12px;color:var(--r-muted)}',
    '</style></head><body>' + RB_MARCO_ABRE,
    rbCabecera(esPazYSalvo ? 'Paz y salvo' : 'Recibo de pago', codigo, emision),
    '<div class="r-hero"><div class="r-hero-l"><small>Recibimos tu pago</small><div class="r-monto">' + recibidoTxt + '</div>',
    // 3.7.0 (decision del PO): un credito en dolares se imprime SOLO en dolares: el hero no lleva
    // "Equivalen a $X · TRM del dia". La caja en pesos sigue registrada en la app (doctrina CAJA vs OBLIGACION).
    '<div class="r-quien"><b>' + rbEsc(loan.nombre) + '</b> <span>· ' + contacto.concat([rbLarga(fechaCobro)]).join(' · ') + '</span></div></div>',
    '<div class="r-sello">' + RB_ICONO_OK + '</div></div>',
    pazHTML, aplicacionHTML, quedoHTML, vencidoHTML, obsHTML,
    '<div class="r-pie"><div>' + (esPazYSalvo
        ? '<b>¡Felicidades, ' + nombre1 + '!</b>Este documento certifica que recibimos ' + recibidoTxt + ' el ' + rbLarga(fechaCobro) + ' y que tu crédito quedó cancelado en su totalidad.'
        : '<b>Gracias por tu pago, ' + nombre1 + '.</b>Este recibo certifica que recibimos ' + recibidoTxt + ' el ' + rbLarga(fechaCobro) + ' y cómo se aplicó a tu crédito.') +
      '</div><div class="r-pie-d">' + codigo + '<br>Generado por Cartera</div></div>',
    RB_MARCO_CIERRA + '</body></html>'
  ]).join('\n');

  // Punto 5 (post-4.0.0): `nombrePdf` arma el nombre (monto y fecha del cobro; el Paz y salvo, el prestamo).
  rbEmitir(html, esPazYSalvo ? nombrePdf('pazYSalvo', loan.nombre, [prestamoArchivo(loan), fechaCobro])
                             : nombrePdf('reciboCobro', loan.nombre, [montoArchivo(esUSD ? oblUSD : cajaCOP, esUSD), fechaCobro]));
}
