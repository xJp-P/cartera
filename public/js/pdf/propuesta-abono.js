// public/js/pdf/propuesta-abono.js — "Si abonas X, asi quedaria tu credito".
//
// El papel que se le manda a un cliente que pregunta ANTES de pagar. No registra
// nada: se genera desde el modal de cobro, con el plan y el preview que el usuario
// ya tiene en pantalla, sin tocar el backend.
//
// ── POR QUE ES UN GENERADOR APARTE Y NO UN MODO DEL RECIBO ───────────────────
// Porque los dos documentos afirman cosas opuestas. `generateReciboCobro` dice
// "Recibimos tu pago" y "certifica que recibimos"; este dice "Si abonas" y "no
// registra ningun pago". Un flag compartido deja a una sola funcion emitiendo las
// dos cosas, y un error de flag produciria el peor documento posible: un comprobante
// de dinero que nunca entro. Con dos generadores ese fallo es estructuralmente
// imposible. Es la misma leccion del Bug #45, donde el recibo se emitia ANTES de que
// la escritura ocurriera.
//
// ── DE DONDE SALEN LOS DATOS ────────────────────────────────────────────────
// Aqui SI se usa `plan.pasos` —y no `estado.hechos` como el recibo— porque no hay
// nada aplicado que consultar: el documento describe, por definicion, lo que
// PASARIA. Y el estado final NO puede salir de las filas persistidas: sale de la
// proyeccion que el modal dibujo con `previewRecalculo` + `filasPreview`, que son
// el espejo verificado del motor (seccion F de `cascada-cobro`).
//
// ── EL DISEÑO (post-4.1.6, opcion A del PO sobre un prototipo con un abono real) ──
// La linea grafica de los recibos (rbCss, como la constancia de condonacion). La version
// anterior repetia la cifra del abono cuatro veces (el titular, la tarjeta del paso, el
// panel de rubros y su total) y tachaba el capital de antes. Ahora:
//   - el monto del abono va UNA vez, arriba ("Si abonas");
//   - "Como se aplicaria" es una frase si todo va a capital, o una tabla corta (concepto,
//     intereses, capital) SIN fila de total: el total es la cifra de arriba, y las filas
//     suman exactamente esa cifra en la moneda visible;
//   - "Asi quedaria tu credito" son tarjetas con el valor de ANTES en letra pequeña
//     ("antes $X"), como la constancia, nunca tachado.

import { fmt, fmtUSD } from '../core/format.js';
import { nowStr } from '../core/ui.js';
import { esDiario, congeladoAbierto, cierreDeCuota, tasaDelPeriodo, periodoEnCursoDe } from '../core/dominio.js';
import { esAbono } from '../core/ids.js';
import { opModalidad } from '../core/operacion.js';
import { rbCss, rbPaleta, rbCabecera, rbLarga, rbMedia, rbCorta, rbEsc, rbPlural, rbIniciales, rbMoneda,
  rbTarjeta, rbRejilla, rbEmitir, RB_ICONO_TIP, RB_MARCO_ABRE, RB_MARCO_CIERRA } from './recibo-estilo.js';
import { nombrePdf, montoArchivo } from './nombres.js';

// El sello del titular: una flecha hacia abajo (lo que BAJARIA). Azul, porque es una proyeccion.
var PA_ICONO = '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M19 12l-7 7-7-7"/></svg>';

function paCss(C, conAbonado){
  return [
    '.r-hero.azul small{color:var(--r-blue)}',
    '.r-hero.azul .r-sello{background:var(--r-blue-bg);border-color:' + C.blueBd + ';color:var(--r-blue)}',
    '.pa-aviso{margin-top:8px;padding:7px 14px;border-radius:12px;background:var(--r-soft);font-size:12px;line-height:1.5;color:var(--r-text-2)}',
    '.pa-aviso b{color:var(--r-text)}',
    '.pa-frase{font-size:13.5px;line-height:1.45}',
    '.r-t .muted{color:var(--r-muted)}',
    '.r-t .pa-sub{display:block;font-size:11.5px;color:var(--r-muted)}',
    // La sub-linea de la fila que ya trae dinero adentro: SOLO si el documento la lleva.
    conAbonado ? '.r-t tr.pa-ab td{border-bottom:1px solid var(--r-bd);padding:0 8px 5px}' +
      '.pa-ab span{display:inline-block;background:var(--r-blue-bg);color:var(--r-blue);border-radius:99px;padding:1px 9px;font-size:11.5px}' : ''
  ].filter(Boolean);
}

// `propuesta` = { fecha, plan, cajaCOP, proyeccion }
//   - plan       : resultado de `planCascada` (pasos + totales). NO aplicado.
//   - cajaCOP    : los pesos que el cliente entregaria. Desde 3.7.0 NO se imprime: un credito en
//                  dolares se imprime solo en dolares (decision del PO).
//   - proyeccion : { filas, n, saldado, totalAntes, totalDespues, pendAntes, pendDespues,
//                  abonadoProxima, moraTras, capitalAntes, capitalDespues, cuotaAntes }.
//                  `filas` puede venir vacia (modalidades sin cronograma amortizable o un
//                  credito congelado): el documento se emite igual, sin tabla ni total.
//
// "Te faltaria por pagar" sale DIRECTO de la proyeccion (lo que falta de cada cuota, ya convertido
// a la moneda visible): es exactamente lo que el recibo declara despues en "Te falta por pagar"
// (seccion J de cascada-cobro). El capital sale de `capitalTrasCobro` (la misma cifra que el recibo
// imprime en "De eso, capital"). Ninguna formula nueva.
export function generatePropuestaAbono(loan, allPays, propuesta, opts) {
  opts = opts || {};
  // Un credito de interes diario no pasa por la cascada: su puerta es el CORTE.
  if (esDiario(loan)) return;

  var plan = (propuesta && propuesta.plan) || null;
  if (!plan || !plan.pasos || !plan.pasos.length) return;

  var proy  = (propuesta && propuesta.proyeccion) || {};
  var pasos = plan.pasos;
  var M = rbMoneda(loan), esUSD = M.esUSD, uni = M.uni, fmtUni = M.fmtUni, money = M.money;
  var fechaProp = (propuesta && propuesta.fecha) || nowStr();
  var emision   = nowStr();
  var anio      = String(fechaProp).slice(0, 4);
  var nombre    = loan.nombre || '';
  var esCI      = loan.modalidad === 'Capital + Intereses';
  var esIndef   = loan.modalidad === 'Intereses';
  var cong      = congeladoAbierto(loan);

  var lp = (allPays || []).filter(function(p){ return String(p.prestamoId) === String(loan.id); });
  var pendHoy = lp.filter(function(p){ return !esAbono(p) && p.estadoPago === 'Pendiente'; })
                  .sort(function(a, b){ return (a.cuotaN || 0) - (b.cuotaN || 0); });
  // ¿Queda alguna cuota por vencer? En un credito congelado sin cuotas, «si vence una cuota antes de
  // que abones» seria falso (post-4.1.6). Sin `allPays`, como antes.
  var quedanPorVencer = !allPays || pendHoy.length > 0;

  // ── Lo que se abonaria, en la unidad de la MONEDA VISIBLE ──
  // En dolares, cada paso vale los dolares que el cliente entrega (`obligacionUSD`): asi la tabla de
  // abajo suma EXACTAMENTE la cifra del titular. En pesos, la obligacion de cada paso.
  function totDe(p){ return esUSD ? Math.round((+p.obligacionUSD || 0) * 100) : Math.round(+p.obligacionCOP || 0); }
  var totalU = pasos.reduce(function(s, p){ return s + Math.round(+p.obligacionCOP || 0); }, 0);
  var oblUSD = esUSD ? pasos.reduce(function(s, p){ return s + (+p.obligacionUSD || 0); }, 0) : 0;
  var heroTxt = esUSD ? fmtUSD(oblUSD) : fmt(totalU);

  var codigo = 'PA-' + rbIniciales(nombre) + '-' + String(loan.id || '').slice(-3) + '-' +
               String(fechaProp).slice(8, 10) + String(fechaProp).slice(5, 7);
  var prest = money(esUSD ? Math.round((+loan.montoOrigen || 0) * (+loan.trmAcordada || 0)) : (+loan.montoOrigen || 0));

  var hero = '<div class="r-hero azul"><div class="r-hero-l"><small>Si abonas</small><div class="r-monto">' + heroTxt + '</div>' +
    '<div class="r-quien"><b>' + rbEsc(nombre) + '</b> <span>· préstamo de ' + prest + ' · ' + opModalidad(loan.modalidad) +
    '</span></div></div><div class="r-sello">' + PA_ICONO + '</div></div>';
  // El aviso es la razon de ser del documento: sin el, un papel con el membrete de la app y cifras
  // exactas se puede leer como comprobante de algo ya pagado.
  var aviso = '<div class="pa-aviso"><b>Es una propuesta, no un comprobante.</b> No se ha registrado ningún pago: ' +
    'tu crédito sigue como está hasta que abones. Los valores corresponden al ' + rbLarga(fechaProp) +
    (quedanPorVencer ? '; si vence una cuota antes de que abones, el reparto cambia.' : '.') + '</div>';

  // ── Como se aplicaria: primero lo vencido, luego el capital (art. 1653) ──
  var moraTras = Math.max(0, Math.round(+proy.moraTras || 0));
  var soloAbono = pasos.length === 1 && pasos[0].tipo === 'abono';
  var aplicacion;
  if (soloAbono) {
    // El monto ya esta arriba: aqui no se repite.
    aplicacion = '<div class="r-sec"><div class="r-sec-t">Cómo se aplicaría</div><div class="pa-frase">Todo iría a <b>abono de capital</b>' +
      (moraTras > 0 ? '. Tus cuotas vencidas no se tocarían: se siguen debiendo.' : ': no tienes cuotas vencidas.') + '</div></div>';
  } else {
    var fechaV = function(f){ return f ? (String(f).slice(0, 4) !== anio ? rbLarga(f) : rbMedia(f)) : ''; };
    var guion = '<span class="muted">—</span>';
    var filasA = pasos.map(function(p){
      var tot = totDe(p), concepto, cuando = '', intU, capU;
      if (p.tipo === 'abono') {
        concepto = 'Abono a capital'; intU = 0; capU = tot;
      } else if (p.esInteresMes) {
        // Todo el paso es interes: la cuota aun no vence, se adelanta (Bug #61: nunca "vencida").
        concepto = cierreDeCuota(loan, p.cuotaN) ? 'Interés de la cuota de cierre' : 'Interés ' + periodoEnCursoDe(loan.frecuencia || 'Mensual');
        cuando = p.fechaPago ? 'vence el ' + fechaV(p.fechaPago) + ' · por adelantado' : 'por adelantado';
        intU = tot; capU = 0;
      } else {
        // Capital reconciliado en la moneda visible (Bug #31): capital = lo del paso - su interes.
        concepto = 'Cuota ' + p.cuotaN + (p.salda ? ' · se salda' : ' · en parte');
        if (!p.salda && (+p.restanteCuota || 0) > 0) concepto += '<span class="pa-sub">seguiría debiendo ' + money(p.restanteCuota) + '</span>';
        cuando = p.fechaPago ? 'venció el ' + fechaV(p.fechaPago) : '';
        intU = Math.min(tot, uni(p.interes)); capU = Math.max(0, tot - intU);
      }
      return '<tr><td>' + concepto + '</td><td class="muted">' + cuando + '</td>' +
        '<td class="n">' + (intU > 0 ? fmtUni(intU) : guion) + '</td><td class="n">' + (capU > 0 ? fmtUni(capU) : guion) + '</td></tr>';
    }).join('');
    aplicacion = '<div class="r-sec"><div class="r-sec-t">Cómo se aplicaría · primero lo vencido, luego el capital</div>' +
      '<table class="r-t"><thead><tr><th>Concepto</th><th></th><th class="n">Intereses</th><th class="n">Capital</th></tr></thead>' +
      '<tbody>' + filasA + '</tbody></table></div>';
  }

  // ── Asi quedaria tu credito ──
  // El cronograma proyectado solo existe en Capital + Intereses (el modal solo lo arma ahi): en las
  // demas modalidades unas filas amortizadas describirian un credito que no existe.
  var filas = esCI ? (proy.filas || []) : [];
  var totalDespues = (proy.totalDespues === null || proy.totalDespues === undefined) ? null : Math.max(0, Math.round(proy.totalDespues));
  var tar = [];
  var tieneCap = proy.capitalAntes != null && proy.capitalDespues != null;
  var capA = tieneCap ? Math.max(0, Math.round(proy.capitalAntes)) : 0;
  var capD = tieneCap ? Math.max(0, Math.round(proy.capitalDespues)) : 0;
  // `proy.saldado` (del preview) solo dice que no queda capital por amortizar en cuotas FUTURAS: con una
  // cuota vencida a medias el credito no queda pagado. Se exige ademas capital 0 y nada vencido.
  var saldado = (!!proy.saldado || totalDespues === 0) && (!tieneCap || capD === 0) && moraTras === 0;
  var baja = tieneCap && uni(capD) < uni(capA);
  var abonadoProx = Math.max(0, Math.round(proy.abonadoProxima || 0));
  var aPagarProx = filas.length ? Math.max(0, Math.round(filas[0].cuota) - abonadoProx) : 0;
  var aPagarTxt = money(aPagarProx);

  if (!saldado && esIndef && baja && capD > 0) {
    // En `Intereses` las cuotas son de puro interes: lo que cambia es el interes de cada periodo.
    var r = tasaDelPeriodo((+loan.tasaMensual || 0) / 100, loan.frecuencia || 'Mensual');
    var cada = loan.frecuencia === 'Semanal' ? 'semana' : loan.frecuencia === 'Quincenal' ? 'quincena' : 'mes';
    if (r > 0) tar.push(rbTarjeta('', 'Interés de cada ' + cada, money(Math.round(capD * r)),
      (cong ? 'cuando se descongele · ' : '') + 'antes ' + money(Math.round(capA * r))));
  }
  if (!saldado && esCI && filas.length) {
    // Lo que habria que girar en la proxima cuota (si ya trae dinero encima, el neto), y lo que
    // hoy habria que girar en esa misma cuota.
    var proxHoy = pendHoy[0] ? Math.max(0, Math.round(pendHoy[0].cuotaTotal || 0) - Math.round(pendHoy[0].partialPaid || 0))
                             : Math.round(proy.cuotaAntes || 0);
    var fechaProx = filas[0].fecha || null;
    var antesProx = proxHoy > 0 && uni(proxHoy) !== uni(aPagarProx) ? 'antes ' + money(proxHoy) : '';
    var subProx = [fechaProx ? 'el ' + rbCorta(fechaProx, anio) : '', antesProx].filter(Boolean).join(' · ');
    // El total es la SUMA de lo que falta de cada cuota, ya convertida (4.1.4), igual que el recibo.
    var totD = Array.isArray(proy.pendDespues) ? M.sumaU(proy.pendDespues) : (totalDespues !== null ? uni(totalDespues) : null);
    var totA = Array.isArray(proy.pendAntes) ? M.sumaU(proy.pendAntes) : uni(proy.totalAntes || 0);
    var nD = Array.isArray(proy.pendDespues) ? proy.pendDespues.length : filas.length;
    if (aPagarProx > 0 && totD !== null && fmtUni(totD) === aPagarTxt && moraTras === 0) {
      // Con una sola cuota y nada vencido, el total y el proximo pago son el MISMO numero: una tarjeta.
      tar.push(rbTarjeta('', 'Quedaría un solo pago', aPagarTxt,
        [fechaProx ? 'el ' + rbCorta(fechaProx, anio) : '', totA !== totD ? 'antes ' + fmtUni(totA) : ''].filter(Boolean).join(' · ')));
    } else {
      // Si un pago anterior ya cubre la proxima cuota entera, no hay nada que girar en ella: la tarjeta
      // se omite, pero lo que falta del credito se sigue diciendo.
      if (aPagarProx > 0) tar.push(rbTarjeta('', 'Tu próxima cuota', aPagarTxt, subProx));
      if (totD !== null) tar.push(rbTarjeta('', 'Te faltaría por pagar', fmtUni(totD),
        'en ' + rbPlural(nD, 'cuota', 'cuotas') + (totA !== totD ? ' · antes ' + fmtUni(totA) : '')));
    }
  }
  if (tieneCap) {
    // Ninguna tarjeta repite una cifra que otra ya muestra: con una sola cuota y su interes
    // adelantado, el pago unico ES el capital.
    var capTxt = money(capD);
    var repetida = tar.some(function(t){ return t.indexOf('<div class="r-tar-v">' + capTxt + '</div>') !== -1; });
    if (!repetida) tar.unshift(rbTarjeta('', 'Capital', capTxt, baja ? 'antes ' + money(capA) : 'sin cambios'));
  }
  var notas = '';
  if (saldado) notas += '<div class="r-tip">' + RB_ICONO_TIP + '<span>Con este abono tu crédito quedaría <b>totalmente pagado</b>.</span></div>';
  else if (moraTras > 0) notas += '<div class="r-tip">' + RB_ICONO_TIP + '<span>Seguirían vencidos <b>' + money(moraTras) +
    '</b>' + (pendHoy.length ? ': se cobran antes que tu próxima cuota.' : ': se siguen debiendo.') + '</span></div>';
  if (cong) notas += '<div class="r-tip">' + RB_ICONO_TIP + '<span>Tu crédito está <b>congelado</b> desde el ' + rbLarga(cong.desde) +
    ': mientras siga así no corren intereses.</span></div>';
  var queda = (tar.length || notas) ? '<div class="r-sec"><div class="r-sec-t">Así quedaría tu crédito</div>' +
    (tar.length ? rbRejilla(tar) : '') + notas + '</div>' : '';

  // ── Asi quedarian tus cuotas: el cronograma PROYECTADO ──
  // Las columnas de siempre, con el capital reconciliado en la moneda visible (Bug #31).
  var crono = '';
  if (filas.length) {
    var conAnio = filas.some(function(f){ return f.fecha && String(f.fecha).slice(0, 4) !== anio; });
    var fechaFila = function(f){ return f ? (conAnio ? rbLarga(f) : rbMedia(f)) : '—'; };
    crono = '<div class="r-sec"><div class="r-sec-t">Así quedarían tus cuotas</div><table class="r-t"><thead><tr>' +
      '<th>Cuota</th><th>Vence</th><th class="n">Interés</th><th class="n">Capital</th><th class="n">Valor cuota</th><th class="n">Saldo</th></tr></thead><tbody>' +
      filas.map(function(f, ix){
        var q = uni(f.cuota), i2 = uni(f.interes), c2 = Math.max(0, q - i2);
        var tr = '<tr><td>' + (f.cuotaN || '') + '</td><td>' + fechaFila(f.fecha) + '</td><td class="n">' + fmtUni(i2) + '</td>' +
          '<td class="n">' + fmtUni(c2) + '</td><td class="n"><b>' + fmtUni(q) + '</b></td><td class="n">' + money(f.saldo) + '</td></tr>';
        // ── LA FILA QUE YA TRAE DINERO ADENTRO LO DICE (v2.9.7) ──
        // `Valor cuota` es la obligacion contractual y sigue siendo la cuota entera (sostiene
        // Interes + Capital = Valor cuota). Sin esta linea, la tarjeta de la proxima cuota y esta
        // fila darian dos cifras para la misma fecha sin nada que las una. Solo la PRIMERA fila
        // puede llevarla: `abonadoProxima` se refiere a la proxima cuota.
        if (ix !== 0 || abonadoProx <= 0) return tr;
        return tr + '<tr class="pa-ab"><td colspan="6"><span>esta cuota quedaría con ' + money(abonadoProx) +
          ' abonado &rarr; a pagar <b>' + aPagarTxt + '</b></span></td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  var pie = '<div class="r-pie"><div><b>Propuesta de abono</b>Documento informativo preparado a solicitud del cliente. No registra ningún pago.</div>' +
    '<div class="r-pie-d">' + codigo + '<br>' + rbLarga(emision) + '</div></div>';

  // El tema: el de `opts.dark` o el de la app (como siempre).
  var dark = opts.dark !== undefined ? opts.dark
           : (typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') !== 'light');
  var C = rbPaleta(dark);
  var html = ['<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>Propuesta de abono</title><style>']
    .concat(rbCss(C)).concat(paCss(C, filas.length > 0 && abonadoProx > 0)).concat(['</style></head><body>' + RB_MARCO_ABRE,
      rbCabecera('Propuesta de abono', codigo, emision), hero, aviso, aplicacion, queda, crono, pie,
      RB_MARCO_CIERRA + '</body></html>']).join('');

  // `fmt()` mete un espacio duro despues del $ que ensuciaria el nombre del archivo: `montoArchivo`.
  var fname = nombrePdf('propuestaAbono', nombre, [montoArchivo(esUSD ? oblUSD : totalU, esUSD), nowStr()]);
  rbEmitir(html, fname);
}
