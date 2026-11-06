// public/js/pdf/recibo-cobro.js — el RECIBO DE PAGO de un cobro en cascada.
//
// Un cobro en cascada son N movimientos contra endpoints distintos (`/partial` por cada cuota
// vencida, `/abono` por el remanente), pero para el cliente fue UNA sola entrega de dinero. Este
// documento es el papel que se le devuelve: cuanto entrego, a que se fue y que le queda.
//
// ── EL DISENO (3.5.0, aprobado por el PO sobre un prototipo con un cobro real) ──────────────
// El recibo anterior confundia al cliente: los intereses cobrados salian en ROJO como si fueran
// deuda, "cuotas pendientes" no contaba las vencidas que la tabla si listaba, el "total por
// pagar" aparecia junto a una cifra tachada sin decir cual valia, la misma cifra salia tres
// veces (total recibido, el paso y "Total aplicado") y no decia lo primero que pregunta el
// cliente: cuanto le falta para ponerse al dia. Ahora, en este orden:
//   1. UNA cifra protagonista: lo que entro, de quien y cuando.
//   2. "Como se aplico tu pago": una FRASE por movimiento (las cuotas saldadas seguidas, en una
//      sola) y la barra de la cuota que quedo a medias (cuanto cubrio y cuanto le falta).
//   3. "Lo que sigue": cuanto le falta para ponerse al dia, su proxima cuota y la suma exacta
//      que lo deja al dia.
//   4. "Asi va tu credito": la barra de cuotas y dos saldos con nombre propio.
//   5. "Tus cuotas": 4 columnas, el estado en palabras; las cuotas lejanas en UNA fila.
//   6. Un cierre que certifica el pago.
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
// se registro (Bug #45). Los totales tambien se DERIVAN de los pasos. Coherente con eso,
// `_doCobroCascada` solo llama aqui cuando la cadena entera tuvo exito.
// Lo que queda por pagar sale de las filas PERSISTIDAS y recargadas tras el cobro: si un abono
// regenero el cronograma, esto ya refleja el nuevo. El saldo es `saldoConCaja`, nunca el del
// motor (doctrina v2.3.0: el papel no puede contradecir a la app).

import { fmt, fmtUSD } from '../core/format.js';
import { nowStr } from '../core/ui.js';
import { saldoConCaja, esDiario, pendCuota } from '../core/dominio.js';
import { esAbono } from '../core/ids.js';
import { rbCss, rbPaleta, rbCabecera, rbLarga, rbMedia, rbCorta, rbEsc, rbCampoValido, rbPlural, rbPrimerNombre, rbIniciales,
         rbMoneda, rbTarjeta, rbRejilla, rbBarraCuotas, rbLeyenda, rbEmitir, RB_ICONO_OK, RB_ICONO_TIP, RB_MARCO_ABRE, RB_MARCO_CIERRA } from './recibo-estilo.js';

// `cobro` = { fecha, pasos, pre, observaciones }
//   - pasos: los del orquestador ya aplicados. Cada uno trae `obligacionCOP` (deuda
//     extinguida), `cajaCOP` (pesos reales que entraron), `interes` y `capital`; los `partial`
//     ademas `payId`, `cuotaN`, `fechaPago`, `salda` y `restanteCuota`, y en USD el
//     `obligacionUSD` exacto.
//   - pre: snapshot ANTERIOR al cobro (`_snapshotAbono`), para el "antes de este pago".
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
  var anio = emision.slice(0, 4);

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
  var moraViva = vencidas.reduce(function(s, p){ return s + pendCuota(p); }, 0);
  // "cuota 3 de 10". En `Intereses` el plazo es indefinido y no hay "de".
  var deN = esIndef ? '' : ' de ' + regs.length;
  function cuotaDe(p){ return 'cuota ' + p.cuotaN + deN; }

  // ── 2. COMO SE APLICO TU PAGO ──────────────────────────────────────────────
  // Una FRASE por movimiento, y las cuotas vencidas que se saldaron seguidas van en UNA sola
  // ("Saldamos tus cuotas del 7 de marzo y 7 de abril..."): un cobro de cinco cuotas no puede
  // costar cinco renglones. Los importes van en la MONEDA VISIBLE y con su clase (`r-i` interes
  // vencido, `r-m` interes del mes, `r-k` capital, `r-a` abono): la prueba los suma y exige que
  // el papel cuadre con la obligacion realmente extinguida. El capital de cada paso se ANCLA a su
  // total (capital = obligacion - interes, doctrina v1.18.0): absorbe el residuo de redondeo de
  // las filas legacy (Bug #43) y en USD no se pierde el centavo (Bug #31).
  function cualDe(p){
    var fila = p.payId ? porId[p.payId] : null;
    return { fila: fila, fecha: p.fechaPago || (fila && fila.fechaPago) || fechaCobro, n: fila ? fila.cuotaN : p.cuotaN };
  }
  function partesDe(ps){
    var iU = 0, kU = 0;
    ps.forEach(function(p){ var t = uni(p.obligacionCOP), x = Math.min(t, uni(p.interes)); iU += x; kU += Math.max(0, t - x); });
    var partes = [];
    // El interes del PERIODO EN CURSO lleva su propia clase: no es interes vencido (una prueba
    // real declaraba atrasada una cuota del 19 en un cobro del 3).
    if (iU > 0) partes.push('<b class="' + (ps[0].esInteresMes ? 'r-m' : 'r-i') + '">' + fmtUni(iU) + '</b> de intereses');
    if (kU > 0) partes.push('<b class="r-k">' + fmtUni(kU) + '</b> de capital');
    return partes.join(' y ');
  }
  function enLista(xs){ return xs.length > 1 ? xs.slice(0, -1).join(', ') + ' y ' + xs[xs.length - 1] : String(xs[0]); }
  function cualesDe(ps){
    var ns = ps.map(function(p){ return cualDe(p).n; });
    var seguidas = ns.every(function(n, k){ return k === 0 || n === ns[k - 1] + 1; });
    return ps.length === 1
      ? 'tu <b>cuota del ' + rbMedia(cualDe(ps[0]).fecha) + '</b> (cuota ' + ns[0] + deN + ')'
      : 'tus <b>cuotas del ' + enLista(ps.map(function(p){ return rbMedia(cualDe(p).fecha); })) + '</b> (cuotas ' +
        (seguidas && ns.length > 2 ? ns[0] + ' a ' + ns[ns.length - 1] : enLista(ns)) + deN + ')';
  }
  var grupos = [];
  pasos.forEach(function(p){
    var saldaMora = p.tipo === 'partial' && p.salda && !p.esInteresMes;
    var ult = grupos[grupos.length - 1];
    if (saldaMora && ult && ult.saldaMora) ult.pasos.push(p); else grupos.push({ saldaMora: saldaMora, pasos: [p] });
  });
  var frases = grupos.map(function(g){
    var p = g.pasos[0];
    if (p.tipo === 'abono') return 'Abonamos <b class="r-a">' + fmtUni(uni(p.obligacionCOP)) + '</b> a tu capital: baja tu saldo y los intereses que vienen.';
    // El tiempo verbal importa: la cuota del interes del mes NO vencio, se pago por adelantado.
    if (p.esInteresMes) return 'Adelantamos el interés de ' + cualesDe(g.pasos) + ', que aún no vence: ' + partesDe(g.pasos) + '.';
    if (p.salda) return 'Saldamos ' + cualesDe(g.pasos) + ': ' + partesDe(g.pasos) + '.';
    // Lo que falta sale de la fila persistida, no de `restanteCuota`, que se calcula al PLANEAR:
    // si despues un abono regenera el cronograma esa cifra deja de ser cierta.
    var c = cualDe(p);
    var falta = c.fila ? pendCuota(c.fila) : Math.max(0, p.restanteCuota || 0);
    return 'Lo abonamos a ' + cualesDe(g.pasos) + ': cubrió ' + partesDe(g.pasos) + '.' + (falta > 0 ? ' De esa cuota te faltan <b>' + money(falta) + '</b>.' : '');
  });
  var pasosHTML = frases.map(function(f, k){
    return '<div class="r-paso">' + (frases.length > 1 ? '<span class="r-n">' + (k + 1) + '</span>' : '') + '<div class="r-frase">' + f + '</div></div>';
  }).join('');
  // La cuota que quedo a medias se dibuja con su barra: cuanto lleva y cuanto le falta.
  var cuotaBarra = null;
  pasos.forEach(function(p){
    var c = cualDe(p);
    if (p.tipo === 'partial' && c.fila && c.fila.estadoPago !== 'Pagado' && pendCuota(c.fila) > 0 && (c.fila.partialPaid || 0) > 0) cuotaBarra = { fila: c.fila, hoyU: uni(p.obligacionCOP) };
  });

  var barraCuotaHTML = '';
  if (cuotaBarra) {
    var f = cuotaBarra.fila;
    // Las mismas cifras que la fila de esa cuota en "Tus cuotas" (una sola conversion cada una).
    var abU = uni(f.partialPaid), pct = f.cuotaTotal > 0 ? Math.max(1, Math.min(99, Math.round(f.partialPaid / f.cuotaTotal * 100))) : 0;
    barraCuotaHTML = '<div class="r-cuota"><div class="r-barra"><div class="pag" style="width:' + pct + '%"></div></div>' +
      '<div class="r-ley"><span class="ok">' + (abU === cuotaBarra.hoyU ? 'Pagado hoy ' + fmtUni(abU) : 'Abonado ' + fmtUni(abU) + ' · hoy ' + fmtUni(cuotaBarra.hoyU)) + '</span>' +
      '<span class="falta">Falta ' + money(pendCuota(f)) + ' · valor de la cuota ' + money(f.cuotaTotal) + '</span></div></div>';
  }

  // Sin panel de rubros con "Total aplicado": las frases ya dicen a donde fue cada peso, y el
  // panel repetia por tercera vez la cifra del titular (uno de los defectos del recibo anterior).

  // ── PAZ Y SALVO ────────────────────────────────────────────────────────────
  var pazHTML = esPazYSalvo
    ? '<div class="r-paz"><div class="r-paz-t">PAZ Y SALVO</div><div>Con este pago queda <b>cancelada la totalidad</b> de tu crédito. No queda saldo pendiente.</div></div>'
    : '';

  // ── 3-5. LO QUE SIGUE, ASI VA TU CREDITO, TUS CUOTAS ──────────────────────
  var sigueHTML = '', creditoHTML = '', cuotasHTML = '';
  if (!esPazYSalvo) {
    var prox = pend[0] || null;
    var moraU = uni(moraViva), proxU = prox ? uni(pendCuota(prox)) : 0;
    var tarjetas = [];
    if (moraViva > 0) {
      tarjetas.push(rbTarjeta('ambar', 'Para ponerte al día', fmtUni(moraU),
        rbPlural(vencidas.length, 'cuota vencida', 'cuotas vencidas') + ': ' +
        vencidas.slice(0, 4).map(function(p){ return rbCorta(p.fechaPago, anio); }).join(', ') + (vencidas.length > 4 ? '…' : '')));
    }
    if (prox) {
      var abProx = Math.round(prox.partialPaid || 0);
      tarjetas.push(rbTarjeta('', 'Tu próxima cuota', fmtUni(proxU),
        'vence el ' + rbLarga(prox.fechaPago) + ' (' + cuotaDe(prox) + ')' +
        (abProx > 0 ? ' · ya abonaste ' + money(abProx) + ' de ' + money(prox.cuotaTotal) : '')));
    }
    sigueHTML = tarjetas.length ? '<div class="r-sec"><div class="r-sec-t">Lo que sigue</div>' + rbRejilla(tarjetas) +
      ((moraViva > 0 && prox) ? '<div class="r-tip">' + RB_ICONO_TIP + '<span>Si pagas <b>' + fmtUni(moraU + proxU) + '</b> a más tardar el ' +
        rbMedia(prox.fechaPago) + ', quedas completamente al día.</span></div>' : '') + '</div>' : '';

    // Lo que queda: vencidas y por vencer, desde las filas persistidas.
    var porPagar = regs.filter(function(p){ return p.estadoPago !== 'Pagado' && pendCuota(p) > 0; });
    var totalFalta = porPagar.reduce(function(s, p){ return s + pendCuota(p); }, 0);
    var totalTxt = money(totalFalta), saldoTxt = money(saldoDespues);

    // La barra no aplica en `Intereses`: el plazo es indefinido y el capital vence fuera del
    // cronograma, asi que "por venir" contaria solo las 3 cuotas que el sistema tiene generadas.
    var nPag = regs.filter(function(p){ return p.estadoPago === 'Pagado'; }).length;
    var nVen = regs.filter(function(p){ return p.estadoPago === 'En Mora'; }).length;
    var barra = esIndef ? '' : rbBarraCuotas(regs, null);
    var ley = '<div class="r-av-ley">' + rbLeyenda('green-2', rbPlural(nPag, 'pagada', 'pagadas')) +
      (nVen ? rbLeyenda('red', rbPlural(nVen, 'vencida', 'vencidas')) : '') +
      (esIndef ? '<span>plazo indefinido</span>' : rbLeyenda('track', (regs.length - nPag - nVen) + ' por venir')) + '</div>';
    // Dos saldos con nombre propio, y ninguno repite una cifra que el otro ya muestra (en un
    // `Prestamo` sin interes lo que falta ES el capital). En `Intereses` no hay "total por
    // pagar": sus cuotas son de puro interes y el capital vence fuera de ellas, asi que la suma
    // anunciaria MENOS deuda de la que hay (medido: 2.700.000 bajo un capital de 3.000.000).
    var saldos;
    if (esIndef) {
      saldos = '<div>Saldo de capital<b class="r-cap">' + saldoTxt + '</b><span class="viejo">' +
        (saldoAntes > saldoDespues ? 'antes de este pago: ' + money(saldoAntes) : 'se paga al final; cada mes pagas los intereses') + '</span></div>';
    } else {
      var antesTot = (pre.totalPorPagar > totalFalta) ? 'antes de este pago: ' + money(pre.totalPorPagar) : 'todas las cuotas que quedan';
      saldos = totalTxt === saldoTxt
        ? '<div>Te falta por pagar<b class="r-cap">' + totalTxt + '</b><span class="viejo">' + antesTot + '</span></div>'
        : '<div>Te falta por pagar<b class="r-tot">' + totalTxt + '</b><span class="viejo">' + antesTot + '</span></div>' +
          '<div>De eso, capital<b class="r-cap">' + saldoTxt + '</b><span class="viejo">el resto son los intereses de las cuotas que faltan</span></div>';
    }
    creditoHTML = '<div class="r-sec"><div class="r-sec-t">Así va tu crédito</div>' + barra + ley + '<div class="r-saldos">' + saldos + '</div></div>';

    // Tabla: lo vencido y la proxima, fila por fila; lo que viene despues, en UNA fila (el
    // cliente necesita el detalle de lo que debe ya, no de dentro de un anio). Con muchas
    // vencidas, las mas viejas tambien se resumen: el recibo tiene que caber en una hoja.
    function chip(cls, t){ return '<span class="chip ' + cls + '">' + t + '</span>'; }
    function celdaFalta(p){
      var ab = Math.round(p.partialPaid || 0);
      return '<td class="n">' + (ab > 0 ? '<span class="sub">ya abonaste ' + money(ab) + ' de ' + money(p.cuotaTotal) + '</span>' : '') + '<b>' + money(pendCuota(p)) + '</b></td>';
    }
    function filaResumen(grupo, estadoHTML){
      var a = grupo[0], z = grupo[grupo.length - 1];
      var iguales = grupo.every(function(p){ return Math.round(pendCuota(p)) === Math.round(pendCuota(a)); });
      return '<tr><td>' + a.cuotaN + ' a ' + z.cuotaN + '</td><td>' + rbCorta(a.fechaPago, anio) + ' a ' + rbCorta(z.fechaPago, anio) + '</td><td>' + estadoHTML + '</td>' +
        '<td class="n">' + (iguales ? '<span class="sub">' + grupo.length + ' × ' + money(pendCuota(a)) + '</span>' : '') +
        '<b>' + money(grupo.reduce(function(s, p){ return s + pendCuota(p); }, 0)) + '</b></td></tr>';
    }
    var filas = '';
    var viejas = vencidas.length > 4 ? vencidas.slice(0, vencidas.length - 3) : [];
    if (viejas.length) filas += filaResumen(viejas, chip('venc', 'Vencidas'));
    vencidas.slice(viejas.length).forEach(function(p){
      filas += '<tr><td>' + p.cuotaN + deN + '</td><td>' + rbMedia(p.fechaPago) + '</td><td>' + chip('venc', 'Vencida') + '</td>' + celdaFalta(p) + '</tr>';
    });
    var futuras = pend.filter(function(p){ return pendCuota(p) > 0; });
    if (futuras[0]) filas += '<tr><td>' + futuras[0].cuotaN + deN + '</td><td>' + rbMedia(futuras[0].fechaPago) + '</td><td>' + chip('prox', 'Próxima') + '</td>' + celdaFalta(futuras[0]) + '</tr>';
    var resto = futuras.slice(1);
    if (resto.length === 1) filas += '<tr><td>' + resto[0].cuotaN + deN + '</td><td>' + rbMedia(resto[0].fechaPago) + '</td><td>' + chip('pend', 'Por vencer') + '</td>' + celdaFalta(resto[0]) + '</tr>';
    else if (resto.length > 1) filas += filaResumen(resto, chip('pend', 'Por vencer'));
    if (filas) {
      cuotasHTML = '<div class="r-sec"><div class="r-sec-t">Tus cuotas</div><table class="r-t"><thead><tr><th>Cuota</th><th>Vence</th><th>Estado</th><th class="n">Te falta</th></tr></thead>' +
        '<tbody>' + filas + '</tbody><tfoot><tr><td colspan="3">' + (esIndef ? 'Total de estas cuotas' : 'Total por pagar') + '</td><td class="n">' + totalTxt + '</td></tr></tfoot></table></div>';
    }
  }

  // La nota explica POR QUE el dinero fue a donde fue: una entrega repartida entre varias
  // obligaciones parece arbitraria sin ella.
  var notaHTML = pasos.length > 1
    ? '<div class="r-nota"><b>Cómo se imputa el pago:</b> primero a los intereses vencidos, luego al capital de las cuotas vencidas y, si sobra, ' +
      'como abono a capital (artículo 1653 del Código Civil).</div>'
    : '';
  var obsHTML = rbCampoValido(cobro.observaciones) ? '<div class="r-obs"><b>Observaciones:</b> ' + rbEsc(String(cobro.observaciones).trim()) + '</div>' : '';

  var codigo = 'RC-' + rbIniciales(loan.nombre) + '-' + String(loan.id || '').slice(-3) + '-' + String(fechaCobro).slice(8, 10) + String(fechaCobro).slice(5, 7);
  var contacto = [rbCampoValido(loan.cedula) ? 'C.C. ' + rbEsc(String(loan.cedula).trim()) : '',
                  rbCampoValido(loan.telefono) ? 'Tel. ' + rbEsc(String(loan.telefono).trim()) : ''].filter(Boolean);
  var titulo = esPazYSalvo ? 'Paz y salvo' : 'Recibo de pago';
  var nombre1 = rbEsc(rbPrimerNombre(loan.nombre));

  var html = [
    '<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>' + titulo + '</title><style>'
  ].concat(rbCss(C)).concat([
    '.r-paso{display:flex;gap:9px;align-items:flex-start}',
    '.r-paso+.r-paso{margin-top:6px}',
    '.r-n{flex-shrink:0;width:19px;height:19px;margin-top:1px;border-radius:99px;background:var(--r-green-bg);color:var(--r-green);font-size:11px;font-weight:700;line-height:19px;text-align:center}',
    '.r-frase{font-size:14px;line-height:1.42}',
    '.r-cuota{margin-top:8px;padding:10px 14px;border:1px solid var(--r-bd);border-radius:12px}',
    '.r-barra{display:flex;height:12px;border-radius:99px;overflow:hidden;background:var(--r-track)}',
    '.r-barra .pag{background:var(--r-green-2)}',
    '.r-ley{display:flex;justify-content:space-between;gap:12px;margin-top:7px;font-size:12px}',
    '.r-ley .ok{color:var(--r-green);font-weight:600}',
    '.r-ley .falta{color:var(--r-muted)}',
    '.r-paz{margin-top:12px;padding:12px 18px;border-radius:14px;border:2px solid var(--r-green-2);font-size:14px}',
    '.r-paz-t{font-size:18px;font-weight:800;letter-spacing:2px;color:var(--r-green);margin-bottom:2px}',
    '.r-nota{margin-top:10px;padding:7px 14px;border-radius:12px;background:var(--r-soft);font-size:12px;color:var(--r-muted);line-height:1.45}',
    '.r-nota b{color:var(--r-text)}',
    '.r-obs{margin-top:8px;font-size:12px;color:var(--r-muted)}',
    '</style></head><body>' + RB_MARCO_ABRE,
    rbCabecera(esPazYSalvo ? 'Paz y salvo' : 'Recibo de pago', codigo, emision),
    '<div class="r-hero"><div class="r-hero-l"><small>Recibimos tu pago</small><div class="r-monto">' + recibidoTxt + '</div>',
    // 3.7.0 (decision del PO): un credito en dolares se imprime SOLO en dolares: el hero ya no lleva
    // "Equivalen a $X · TRM del dia". La caja en pesos sigue registrada en la app (doctrina CAJA vs OBLIGACION).
    '',   // (el elemento vacio conserva el separador: los documentos en pesos quedan identicos byte a byte)
    '<div class="r-quien"><b>' + rbEsc(loan.nombre) + '</b> <span>· ' + contacto.concat([rbLarga(fechaCobro)]).join(' · ') + '</span></div></div>',
    '<div class="r-sello">' + RB_ICONO_OK + '</div></div>',
    pazHTML,
    '<div class="r-sec"><div class="r-sec-t">Cómo se aplicó tu pago</div>' + pasosHTML + barraCuotaHTML + '</div>',
    sigueHTML, creditoHTML, cuotasHTML, notaHTML, obsHTML,
    '<div class="r-pie"><div>' + (esPazYSalvo
        ? '<b>¡Felicidades, ' + nombre1 + '!</b>Este documento certifica que recibimos ' + recibidoTxt + ' el ' + rbLarga(fechaCobro) + ' y que tu crédito quedó cancelado en su totalidad.'
        : '<b>Gracias por tu pago, ' + nombre1 + '.</b>Este recibo certifica que recibimos ' + recibidoTxt + ' el ' + rbLarga(fechaCobro) + ' y cómo se aplicó a tu crédito.') +
      '</div><div class="r-pie-d">' + codigo + '<br>Generado por Cartera</div></div>',
    RB_MARCO_CIERRA + '</body></html>'
  ]).join('\n');

  // El monto se formatea aparte: fmt() mete un espacio duro (U+00A0) que ensuciaria el nombre.
  var montoFname = esUSD ? fmtUSD(oblUSD) : ('$' + Math.round(cajaCOP).toLocaleString('es-CO'));
  rbEmitir(html, esPazYSalvo ? ('Paz y Salvo ' + loan.nombre) : ('RC ' + loan.nombre + ' - ' + montoFname));
}
