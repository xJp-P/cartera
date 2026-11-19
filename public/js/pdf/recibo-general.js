// public/js/pdf/recibo-general.js — el RECIBO DE COBRO GENERAL de un deudor (3.5.0; «Tu deuda hoy» y el interés en curso, post-4.0.0).
//
// Un solo papel con TODA la deuda del deudor y el estado general de sus creditos, para mandarselo
// cuando hay que ponerse al dia. Es un AVISO DE COBRO, no un comprobante: no certifica ningun pago
// y lo dice en el pie (misma doctrina que la Propuesta de Abono).
//
// ── EL DISENO ────────────────────────────────────────────────────────────────
//   1. UNA cifra arriba: lo que debe para ponerse al dia (ambar), o, al dia, su proxima cuota.
//   2. "Tu deuda hoy" (punto 4 del PO, post-4.0.0): TRES cifras con nombre propio, para que no
//      quede duda de cuanto debe en total:
//        - Vencido: lo que necesita para ponerse al dia;
//        - Debes hoy: lo que pagaria si liquida TODO hoy (capital + intereses vencidos - lo ya
//          abonado, y el interes del periodo en curso si se eligio cobrarlo en el modal previo);
//        - Si sigues con tus cuotas: todas las cuotas que le quedan (lo vencido mas lo que viene,
//          con sus intereses).
//      Con varios creditos, una fila por credito y el total; con uno, tres tarjetas. Debajo, una
//      frase que explica la diferencia (cuanto se ahorraria liquidando hoy).
//   3. "Lo que esta vencido": cuota por cuota, cuando vencio, los dias de mora y cuanto falta.
//   4. ("Tus opciones de pago" se integro en "Tu deuda hoy": lo minimo es la cifra grande,
//      liquidar es "Debes hoy"; quedar al dia + la proxima cuota y el orden de imputacion van
//      en sus renglones.)
//   5. "Asi va tu credito": la barra de cuotas y su leyenda (sus cifras ya estan arriba).
//   6. "Como pagar" y el aviso de que no es un comprobante, con la fecha de corte.
//
// ── DE DONDE SALEN LAS CIFRAS ────────────────────────────────────────────────
// Ninguna formula nueva: `pendCuota`, `pendienteDeCuota`, `computeLiquidacion` (el valor de
// liquidar, el mismo de Liquidar deuda, con la MISMA casilla del interes del periodo en curso),
// `proximoVencimiento` y `saldoConCaja`. El modelo vive en `modeloReciboGeneral`, que usan el
// generador Y el modal previo: la cifra que el modal anuncia es la que se imprime, por construccion.
// `hasta` es un PARAMETRO: el documento depende del dia.
// Una cuota Pendiente cuya fecha ya paso se trata como vencida (la auto-mora del backend).
//
// FUERA: los creditos de Interes Diario (su papel es el Estado de Cuenta); el documento lo dice.

import { fmt, fmtUSD } from '../core/format.js';
import { nowStr } from '../core/ui.js';
import { computeLiquidacion, diasEntre, esDiario, pendCuota, pendienteDeCuota, proximoVencimiento, saldoConCaja } from '../core/dominio.js';
import { esAbono, esCuotaRegular } from '../core/ids.js';
import { opModalidad } from '../core/operacion.js';
import { rbCss, rbPaleta, rbCabecera, rbLarga, rbMedia, rbCorta, rbEsc, rbPlural, rbPrimerNombre, rbIniciales, rbMoneda, rbMixto,
         rbTarjeta, rbRejilla, rbBarraCuotas, rbLeyenda, rbEmitir, RB_ICONO_OK, RB_ICONO_RELOJ, RB_MARCO_ABRE, RB_MARCO_CIERRA } from './recibo-estilo.js';

// El boton solo se ofrece cuando hay algo que imprimir: un credito activo con cuotas.
export function puedeReciboGeneral(loans){
  return (loans || []).some(function(l){ return l && l.estado === 'Activo' && !esDiario(l); });
}

// ── EL MODELO (lo usan el generador y el modal previo) ───────────────────────
// `opts.hasta`: fecha de corte (hoy por defecto). `opts.interesMes`: true (todos) o {loanId: true}
// — los creditos en los que se cobra el interes del periodo en curso al liquidar (la casilla de
// Liquidar deuda, credito por credito).
export function modeloReciboGeneral(loansDeudor, allPays, opts) {
  opts = opts || {};
  var hasta = opts.hasta || nowStr();
  var activos = (loansDeudor || []).filter(function(l){ return l && l.estado === 'Activo' && !esDiario(l); })
    .sort(function(a, b){ return String(a.fechaInicio).localeCompare(String(b.fechaInicio)) || String(a.id).localeCompare(String(b.id)); });
  var diarios = (loansDeudor || []).filter(function(l){ return l && l.estado === 'Activo' && esDiario(l); });
  var incluye = function(l){ return opts.interesMes === true || !!(opts.interesMes && opts.interesMes[l.id]); };
  var mods = activos.map(function(l, i){
    var mon = rbMoneda(l);
    var lp = (allPays || []).filter(function(p){ return String(p.prestamoId) === String(l.id); }).map(function(p){
      return (esCuotaRegular(p) && p.estadoPago === 'Pendiente' && String(p.fechaPago) < hasta) ? Object.assign({}, p, { estadoPago: 'En Mora' }) : p;
    });
    var regs = lp.filter(esCuotaRegular).sort(function(a, b){ return a.cuotaN - b.cuotaN; });
    var venc = regs.filter(function(p){ return p.estadoPago === 'En Mora' && pendCuota(p) > 0; })
      .sort(function(a, b){ return String(a.fechaPago).localeCompare(String(b.fechaPago)) || a.cuotaN - b.cuotaN; });
    var pend = regs.filter(function(p){ return p.estadoPago === 'Pendiente' && pendCuota(p) > 0; });
    var L = computeLiquidacion(l, lp, { hasta: hasta, incluyeProxMes: incluye(l) });
    var L0 = L.incluyeProxMes ? computeLiquidacion(l, lp, { hasta: hasta }) : L;
    var esIndef = l.modalidad === 'Intereses';
    var m = {
      l: l, i: i, mon: mon, lp: lp, regs: regs, venc: venc, pend: pend, prox: pend[0] || null, sig: pend[1] || null, esIndef: esIndef,
      deN: esIndef ? '' : ' de ' + regs.length,
      vencU: mon.uni(venc.reduce(function(s, p){ return s + pendCuota(p); }, 0)),
      intVencU: mon.uni(venc.reduce(function(s, p){ return s + pendienteDeCuota(p).interes; }, 0)),
      proxU: pend[0] ? mon.uni(pendCuota(pend[0])) : 0,
      // Liquidar, en la moneda visible: capital + intereses vencidos (+ mora consolidada + carga de
      // una unificacion) + el interes del periodo en curso si se eligio - lo ya abonado = `L.total`,
      // exacto. El capital absorbe el residuo del redondeo (Bug #31).
      liq: L, liqU: mon.uni(L.total), liqIntU: mon.uni(L.intMora + (L.moraConsolidada || 0) + (L.cargaPendiente || 0)),
      liqParcU: mon.uni(L.partialPend), liqMesU: mon.uni(L.intExtra || 0), inclMes: !!L.incluyeProxMes,
      // Lo que se podria cobrar del periodo en curso (para el modal), con o sin la casilla.
      mesPosible: L0.aplicaInteres && !L0.enGracia && L0.capitalPendiente > 0 ? L.intProxMes : 0, L0: L0,
      validoHasta: L.incluyeProxMes && L.periodoIrregular ? L.validoHasta : proximoVencimiento(l, lp, hasta),
      // "Si sigues con tus cuotas": todas las que quedan, sin saldar. En `Intereses` no aplica: sus
      // cuotas son de puro interes y el capital va aparte (la suma anunciaria MENOS deuda).
      faltaU: esIndef ? null : mon.uni(regs.filter(function(p){ return p.estadoPago !== 'Pagado'; }).reduce(function(s, p){ return s + pendCuota(p); }, 0)),
      capU: mon.uni(saldoConCaja(l, lp)),
      abonos: lp.filter(function(p){ return esAbono(p) && p.estadoPago === 'Pagado'; })
    };
    m.liqCapU = m.liqU - m.liqIntU - m.liqMesU + m.liqParcU;
    return m;
  });
  function suma(campo, filtro){
    var t = { cop: 0, usd: 0 };
    mods.forEach(function(m){ if (filtro && !filtro(m)) return; if (m[campo] == null) return; t[m.mon.esUSD ? 'usd' : 'cop'] += m[campo]; });
    return t;
  }
  var soloUSD = mods.length > 0 && mods.every(function(m){ return m.mon.esUSD; });
  return {
    hasta: hasta, activos: activos, diarios: diarios, mods: mods, varios: activos.length > 1, soloUSD: soloUSD,
    vencT: suma('vencU'), intVencT: suma('intVencU'), proxT: suma('proxU'), liqT: suma('liqU'), liqCapT: suma('liqCapU'),
    liqIntT: suma('liqIntU'), liqParcT: suma('liqParcU'), liqMesT: suma('liqMesU'), faltaT: suma('faltaU'),
    hayIndef: mods.some(function(m){ return m.esIndef; }), capIndefT: suma('capU', function(m){ return m.esIndef; }),
    // Para el modal: los creditos donde la pregunta del interes en curso tiene respuesta.
    conMes: mods.filter(function(m){ return m.mesPosible > 0; }),
    monto: function(t){ return soloUSD ? fmtUSD((t.usd || 0) / 100) : rbMixto(t); }
  };
}

// `loansDeudor`: los prestamos del deudor (cualquier estado; se toman los activos con cuotas).
// `opts.hasta`: fecha de corte (por defecto hoy). `opts.interesMes`: ver `modeloReciboGeneral`.
export function generateReciboGeneral(loansDeudor, allPays, datosPago, opts) {
  opts = opts || {};
  var Mo = modeloReciboGeneral(loansDeudor, allPays, opts);
  var hasta = Mo.hasta, activos = Mo.activos, diarios = Mo.diarios, mods = Mo.mods, varios = Mo.varios, monto = Mo.monto;
  if (!activos.length) return;
  var C = rbPaleta(document.documentElement.getAttribute('data-theme') === 'dark');
  var anio = hasta.slice(0, 4);
  function sumaT(a, b){ return { cop: a.cop + b.cop, usd: a.usd + b.usd }; }
  function hay(t){ return !!(t.cop || t.usd); }
  var vencT = Mo.vencT, intVencT = Mo.intVencT, proxT = Mo.proxT, liqT = Mo.liqT, liqCapT = Mo.liqCapT, liqIntT = Mo.liqIntT,
      liqParcT = Mo.liqParcT, liqMesT = Mo.liqMesT, faltaT = Mo.faltaT;
  var nVenc = mods.reduce(function(s, m){ return s + m.venc.length; }, 0);
  var conVenc = mods.filter(function(m){ return m.venc.length; });
  var hayVenc = nVenc > 0;
  var masVieja = null;
  mods.forEach(function(m){ if (m.venc[0] && (!masVieja || m.venc[0].fechaPago < masVieja.fechaPago)) masVieja = m.venc[0]; });
  var proxima = null;
  mods.forEach(function(m){ if (m.prox && (!proxima || m.prox.fechaPago < proxima.p.fechaPago)) proxima = { p: m.prox, m: m }; });
  var siguientes = mods.map(function(m){ return m.sig && m.sig.fechaPago; }).filter(Boolean).sort();
  var vigencias = mods.map(function(m){ return m.validoHasta; }).filter(Boolean).sort();
  var nombre = activos[0].nombre;
  var nombre1 = rbEsc(rbPrimerNombre(nombre));
  function rotulo(m){ return 'Crédito ' + (m.i + 1); }
  function montoPrestamo(m){ return m.mon.esUSD ? fmtUSD(+m.l.montoOrigen || 0) : fmt(m.l.montoOrigen); }
  var mixto = vencT.cop && vencT.usd;

  // ── 1. HERO ────────────────────────────────────────────────────────────────
  var hero;
  if (hayVenc) {
    var dias = diasEntre(masVieja.fechaPago, hasta);
    hero = '<div class="r-hero ambar"><div class="r-hero-l"><small>Para ponerte al día</small><div class="r-monto' + (mixto ? ' mixto' : '') + '">' + monto(vencT) + '</div>' +
      '<div class="r-quien"><b>' + rbEsc(nombre) + '</b> <span>· ' + rbPlural(nVenc, 'cuota vencida', 'cuotas vencidas') +
      (conVenc.length > 1 ? ' en ' + conVenc.length + ' créditos' : '') + (nVenc > 1 ? ', la más antigua del ' : ', del ') +
      rbMedia(masVieja.fechaPago) + ' (' + rbPlural(dias, 'día', 'días') + ')</span></div></div><div class="r-sello">' + RB_ICONO_RELOJ + '</div></div>';
  } else if (proxima) {
    var pm = proxima.m;
    hero = '<div class="r-hero"><div class="r-hero-l"><small>Estás al día · tu próxima cuota</small><div class="r-monto">' + pm.mon.fmtUni(pm.proxU) + '</div>' +
      '<div class="r-quien"><b>' + rbEsc(nombre) + '</b> <span>· vence el ' + rbLarga(proxima.p.fechaPago) + ' (cuota ' + proxima.p.cuotaN + pm.deN + (varios ? ', ' + rotulo(pm).toLowerCase() : '') + ')</span></div></div>' +
      '<div class="r-sello">' + RB_ICONO_OK + '</div></div>';
  } else {
    hero = '<div class="r-hero"><div class="r-hero-l"><small>Estás al día</small><div class="r-monto' + (liqT.cop && liqT.usd ? ' mixto' : '') + '">' + monto(liqT) + '</div>' +
      '<div class="r-quien"><b>' + rbEsc(nombre) + '</b> <span>· lo que falta para cerrar ' + (varios ? 'tus créditos' : 'tu crédito') + '</span></div></div>' +
      '<div class="r-sello">' + RB_ICONO_OK + '</div></div>';
  }

  // ── 2. TU DEUDA HOY (punto 4 del PO) ────────────────────────────────────────
  // Tres cifras con nombre propio. "Debes hoy" es la respuesta a "¿cuanto debo en total?".
  var detLiq = 'capital ' + monto(liqCapT) + (hay(liqIntT) ? ' + intereses vencidos ' + monto(liqIntT) : '') +
    (hay(liqMesT) ? ' + interés del periodo en curso ' + monto(liqMesT) : '') + (hay(liqParcT) ? ' − lo ya abonado ' + monto(liqParcT) : '');
  var vigTxt = vigencias[0] ? 'válido hasta el ' + rbCorta(vigencias[0], anio) : 'calculado al ' + rbCorta(hasta, anio);
  var plazoMods = mods.filter(function(m){ return !m.esIndef; });
  var deuda;
  if (varios) {
    var filasD = mods.map(function(m){
      return '<tr><td>' + rotulo(m) + '<span class="sub"> · ' + montoPrestamo(m) + ' · ' + opModalidad(m.l.modalidad, true) + '</span></td>' +
        '<td class="n">' + (m.vencU ? '<span class="r-rojo">' + m.mon.fmtUni(m.vencU) + '</span>' : '—') + '</td>' +
        '<td class="n"><b>' + m.mon.fmtUni(m.liqU) + '</b>' + (m.inclMes ? '<span class="sub r-blk">con el interés en curso</span>' : '') + '</td>' +
        '<td class="n">' + (m.faltaU == null ? '<span class="sub">sin plazo fijo</span>' : m.mon.fmtUni(m.faltaU)) + '</td></tr>';
    }).join('');
    deuda = '<table class="r-t r-deuda"><thead><tr><th>Crédito</th><th class="n">Vencido</th><th class="n">Debes hoy</th><th class="n">Si sigues con tus cuotas</th></tr></thead>' +
      '<tbody>' + filasD + '</tbody><tfoot><tr><td>Total</td><td class="n">' + (hay(vencT) ? monto(vencT) : '—') + '</td><td class="n">' + monto(liqT) + '</td>' +
      '<td class="n">' + (plazoMods.length ? monto(faltaT) : '—') + '</td></tr></tfoot></table>';
  } else {
    var m1 = mods[0];
    deuda = rbRejilla([
      rbTarjeta(hayVenc ? 'ambar' : '', 'Vencido', hayVenc ? monto(vencT) : monto({ cop: 0, usd: 0 }), hayVenc ? 'lo que necesitas para ponerte al día' : 'no tienes cuotas vencidas'),
      rbTarjeta('r-fuerte', 'Debes hoy', monto(liqT), 'si liquidas todo hoy'),
      m1.esIndef
        ? rbTarjeta('', 'Si sigues con tus cuotas', 'Sin plazo fijo', 'cada mes pagas los intereses; el capital (' + m1.mon.fmtUni(m1.capU) + ') cuando quieras')
        : rbTarjeta('', 'Si sigues con tus cuotas', monto(faltaT), 'todas las cuotas que te quedan, con sus intereses')
    ]);
  }
  // Lo que la tabla no dice, en renglones cortos (sin repetir sus cifras): de que esta hecho
  // "Debes hoy" y hasta cuando vale, cuanto se ahorra liquidando, y lo que cuesta quedar al dia
  // cubriendo tambien la proxima cuota. Reemplaza a "Tus opciones de pago" (punto 4 del PO): lo
  // minimo ya es la cifra grande y liquidar ya es "Debes hoy".
  var ahorro = plazoMods.length && !Mo.hayIndef ? sumaT(faltaT, { cop: -liqT.cop, usd: -liqT.usd }) : null;
  var proxN = mods.filter(function(m){ return m.prox; }).length;
  var notas = ['<div><b>Debes hoy</b> = ' + detLiq + ' · ' + vigTxt + (hay(liqMesT) ? ' (incluye el interés del periodo en curso)' : '') + '.</div>'];
  if (Mo.hayIndef && plazoMods.length) notas.push('<div>"Si sigues con tus cuotas" no incluye el capital de tu crédito de solo intereses (' + monto(Mo.capIndefT) + '), que pagas cuando quieras.</div>');
  if (ahorro && (ahorro.cop > 0 || ahorro.usd > 0)) notas.push('<div>Liquidando hoy te ahorrarías <b>' + monto(ahorro) + '</b> de los intereses que traen tus cuotas.</div>');
  if (hayVenc && proxN) notas.push('<div>Para quedar al día y pagar también ' + (proxN > 1 ? 'la próxima cuota de cada crédito' : 'la próxima cuota') + ': <b>' +
    monto(sumaT(vencT, proxT)) + '</b>' + (siguientes[0] ? ' (lo siguiente vence el ' + rbCorta(siguientes[0], anio) + ')' : '') + '.</div>');
  else if (!hayVenc && proxN) notas.push('<div>' + (proxN > 1 ? 'Tus próximas cuotas: <b>' : 'Tu próxima cuota: <b>') + monto(proxT) + '</b>, ' +
    (proxN > 1 ? 'la primera vence el ' : 'vence el ') + rbCorta(proxima.p.fechaPago, anio) + '.</div>');
  notas.push('<div class="r-orden">' + (hayVenc
    ? 'Puedes pagar cualquier valor: se aplica primero a los intereses vencidos, después al capital vencido, y lo que sobre abona a tu crédito.'
    : 'Puedes adelantar cualquier valor: lo que pagues de más abona a tu crédito y baja los intereses que vienen.') + '</div>');
  var tuDeuda = '<div class="r-sec"><div class="r-sec-t">Tu deuda hoy</div>' + deuda + '<div class="r-notas">' + notas.join('') + '</div></div>';

  // ── 3. LO QUE ESTA VENCIDO ─────────────────────────────────────────────────
  function chip(cls, t){ return '<span class="chip ' + cls + '">' + t + '</span>'; }
  var tablaVenc = '';
  if (hayVenc) {
    var tope = Math.max(2, Math.floor(5 / conVenc.length));
    var filas = '';
    conVenc.forEach(function(m){
      var col = varios ? '<td>' + rotulo(m) + '</td>' : '';
      var viejas = m.venc.length > tope ? m.venc.slice(0, m.venc.length - (tope - 1)) : [];
      if (viejas.length) {
        var a = viejas[0], z = viejas[viejas.length - 1];
        filas += '<tr>' + col + '<td>' + a.cuotaN + ' a ' + z.cuotaN + m.deN + '</td><td>' + rbCorta(a.fechaPago, anio) + ' a ' + rbCorta(z.fechaPago, anio) + '</td>' +
          '<td>' + chip('venc', 'hasta ' + rbPlural(diasEntre(a.fechaPago, hasta), 'día', 'días')) + '</td>' +
          '<td class="n"><span class="sub">' + viejas.length + ' cuotas</span><b>' + m.mon.money(viejas.reduce(function(s, p){ return s + pendCuota(p); }, 0)) + '</b></td></tr>';
      }
      m.venc.slice(viejas.length).forEach(function(p){
        var d = diasEntre(p.fechaPago, hasta), ab = Math.round(p.partialPaid || 0);
        filas += '<tr>' + col + '<td>' + p.cuotaN + m.deN + '</td><td>' + rbMedia(p.fechaPago) + '</td><td>' + chip('venc', rbPlural(d, 'día', 'días')) + '</td>' +
          '<td class="n">' + (ab > 0 ? '<span class="sub">ya abonaste ' + m.mon.money(ab) + ' de ' + m.mon.money(p.cuotaTotal) + '</span>' : '') + '<b>' + m.mon.money(pendCuota(p)) + '</b></td></tr>';
      });
    });
    var intTxt = hay(intVencT) ? ' <span class="sub">· de eso, intereses ' + monto(intVencT) + '</span>' : '';
    tablaVenc = '<div class="r-sec"><div class="r-sec-t">Lo que está vencido</div><table class="r-t"><thead><tr>' + (varios ? '<th>Crédito</th>' : '') +
      '<th>Cuota</th><th>Venció</th><th>Mora</th><th class="n">Te falta</th></tr></thead><tbody>' + filas + '</tbody>' +
      '<tfoot><tr><td colspan="' + (varios ? 4 : 3) + '">Total vencido' + intTxt + '</td><td class="n">' + monto(vencT) + '</td></tr></tfoot></table></div>';
  }

  // ── 5. ASI VA TU CREDITO: la barra y su leyenda (las cifras ya estan en "Tu deuda hoy") ──
  function bloqueCredito(m){
    var nPag = m.regs.filter(function(p){ return p.estadoPago === 'Pagado'; }).length;
    var porVenir = m.pend.length - (m.prox ? 1 : 0);
    var abonos = m.abonos.slice(0, 2).map(function(a){ return m.mon.money(a.abonoCapital) + ' el ' + rbCorta(a.fechaRecaudo || a.fechaPago, anio); }).join(', ') +
      (m.abonos.length > 2 ? ' y ' + (m.abonos.length - 2) + ' más' : '');
    var ley = '<div class="r-av-ley">' + rbLeyenda('green-2', rbPlural(nPag, 'pagada', 'pagadas')) +
      (m.venc.length ? rbLeyenda('red', rbPlural(m.venc.length, 'vencida', 'vencidas')) : '') +
      (m.esIndef ? '<span>plazo indefinido</span>' : (m.prox ? rbLeyenda('blue', 'la próxima') : '') + rbLeyenda('track', porVenir + ' por venir')) +
      (abonos ? '<span>· abono a capital: ' + abonos + '</span>' : '') +
      '<span class="r-linea">de eso, capital <b>' + m.mon.fmtUni(m.capU) + '</b></span></div>';
    var titulo = varios
      ? rotulo(m) + ' · ' + montoPrestamo(m) + ' · ' + opModalidad(m.l.modalidad) + ' · desde el ' + rbLarga(m.l.fechaInicio)
      : 'Así va tu crédito · ' + montoPrestamo(m) + ' desde el ' + rbLarga(m.l.fechaInicio);
    return '<div class="r-sec r-credito"><div class="r-sec-t">' + titulo + '</div>' +
      (m.esIndef ? '' : rbBarraCuotas(m.regs, m.prox ? m.prox.cuotaN : null)) + ley + '</div>';
  }
  var creditos = mods.map(bloqueCredito).join('') + (diarios.length
    ? '<div class="r-aparte">' + (diarios.length > 1 ? 'Tus ' + diarios.length + ' créditos abiertos' : 'Tu crédito abierto') +
      ' de interés diario no ' + (diarios.length > 1 ? 'están' : 'está') + ' en este documento: ' + (diarios.length > 1 ? 'tienen' : 'tiene') + ' su propio estado de cuenta.</div>'
    : '');

  // ── 6. COMO PAGAR ──────────────────────────────────────────────────────────
  var pagar = String(datosPago || '').trim()
    ? '<div class="r-sec"><div class="r-sec-t">Cómo pagar</div><div class="r-pagar">' + rbEsc(String(datosPago).trim()) + '</div></div>' : '';

  var codigo = 'CG-' + rbIniciales(nombre) + '-' + (varios ? activos.length + 'C' : String(activos[0].id || '').slice(-3)) + '-' + hasta.slice(8, 10) + hasta.slice(5, 7);
  var html = [
    '<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>Recibo de cobro general</title><style>'
  ].concat(rbCss(C)).concat([
    '.r-t .sub{white-space:normal}',
    '.r-linea{margin-left:auto;font-size:12.5px;color:var(--r-muted)}',
    '.r-linea b{color:var(--r-text);font-weight:600}',
    '.r-rojo{color:var(--r-red)}',
    '.r-aparte{margin-top:10px;font-size:12px;color:var(--r-muted)}',
    '.r-pagar{padding:7px 14px;border-radius:12px;background:var(--r-soft);font-size:12.5px;line-height:1.42;white-space:pre-wrap}',
    '.r-credito{break-inside:avoid}',
    // "Tu deuda hoy": la columna "Debes hoy" es la respuesta a "cuanto debo": va mas marcada.
    '.r-deuda td:nth-child(3),.r-deuda th:nth-child(3){background:var(--r-soft)}',
    '.r-deuda tfoot td{font-size:14px}',
    '.r-blk{display:block;margin-right:0!important}',
    '.r-tar.r-fuerte{border-color:var(--r-text)}',
    '.r-notas{margin-top:7px;padding:7px 14px;border-radius:12px;background:var(--r-soft);font-size:12px;line-height:1.5;color:var(--r-text-2)}',
    '.r-notas b{color:var(--r-text)}',
    '.r-notas .r-orden{color:var(--r-muted)}',
    '</style></head><body>' + RB_MARCO_ABRE,
    rbCabecera('Recibo de cobro general', codigo, hasta),
    hero, tuDeuda, tablaVenc,
    creditos,
    pagar,
    '<div class="r-pie"><div><b>' + (hayVenc ? nombre1 + ', ponerte al día es lo más importante.' : 'Gracias por estar al día, ' + nombre1 + '.') + '</b>' +
      'Este documento es un aviso de cobro: no certifica ningún pago. Cifras calculadas al ' + rbLarga(hasta) + '.</div>' +
      '<div class="r-pie-d">' + codigo + '<br>Generado por Cartera</div></div>',
    RB_MARCO_CIERRA + '</body></html>'
  ]).join('\n');

  rbEmitir(html, 'CG ' + nombre + ' - ' + hasta);
}
