// public/js/pdf/recibo-general.js — el RECIBO DE COBRO GENERAL de un deudor (3.5.0).
//
// Un solo papel con TODA la deuda vencida del deudor y el estado general de sus creditos, para
// mandarselo cuando hay que ponerse al dia. Es un AVISO DE COBRO, no un comprobante: no
// certifica ningun pago y lo dice en el pie (misma doctrina que la Propuesta de Abono: un papel
// con el membrete de la app y cifras exactas se lee como comprobante si no lo aclara).
//
// ── EL DISENO (aprobado por el PO sobre un prototipo con un credito del fixture) ────────────
//   1. UNA cifra arriba: lo que debe para ponerse al dia, con cuantas cuotas y desde cuando, en
//      ambar (es un llamado a pagar, no una alarma). Al dia, el mismo bloque pasa a verde con
//      su proxima cuota.
//   2. "Lo que esta vencido": cuota por cuota, cuando vencio, los dias de mora y cuanto falta
//      (descontando lo ya abonado). Al pie, el total y cuanto de eso son intereses.
//   3. "Tus opciones de pago": ponerse al dia (lo minimo), al dia + la proxima cuota, o liquidar
//      el credito con su validez; debajo, en que orden se aplica cualquier pago.
//   4. "Asi va tu credito": la barra de cuotas, lo que falta y cuanto de eso es capital.
//   5. "Como pagar", con los datos de `config.datos_pago`.
//   6. El aviso de que no es un comprobante, con la fecha de corte.
// VARIOS CREDITOS (decision del PO): el total CONSOLIDADO arriba (cifra, tabla de lo vencido con
// la columna del credito y las opciones sumadas) y el desglose POR CREDITO debajo.
//
// ── DE DONDE SALEN LAS CIFRAS ────────────────────────────────────────────────
// Ninguna formula nueva: `pendCuota` (lo que falta de cada cuota), `pendienteDeCuota` (su
// interes), `computeLiquidacion` (el valor de liquidar, el mismo de Liquidar deuda y del Estado
// de Liquidacion), `proximoVencimiento` (hasta cuando vale) y `saldoConCaja` (el capital que
// muestra la app). `hasta` es un PARAMETRO, como en el Estado de Liquidacion: el documento
// depende del dia, y sin eso no seria reproducible ni probable con el reloj congelado.
// Una cuota Pendiente cuya fecha ya paso se trata como vencida: es lo que hace la auto-mora del
// backend al arrancar, y la bandeja de Cobros la cuenta igual (`bandejaCobro`).
//
// FUERA: los creditos de Interes Diario. No tienen cuotas ni vencen; su papel es el Estado de
// Cuenta. Si el deudor tiene uno, el documento lo dice en vez de omitirlo en silencio.

import { fmt, fmtUSD } from '../core/format.js';
import { nowStr } from '../core/ui.js';
import { computeLiquidacion, diasEntre, esDiario, pendCuota, pendienteDeCuota, proximoVencimiento, saldoConCaja } from '../core/dominio.js';
import { esAbono, esCuotaRegular } from '../core/ids.js';
import { opModalidad } from '../core/operacion.js';
import { rbCss, rbPaleta, rbCabecera, rbLarga, rbMedia, rbCorta, rbEsc, rbPlural, rbPrimerNombre, rbIniciales, rbMoneda, rbMixto,
         rbTarjeta, rbRejilla, rbBarraCuotas, rbLeyenda, rbEmitir, RB_ICONO_OK, RB_ICONO_RELOJ, RB_ICONO_ORDEN, RB_MARCO_ABRE, RB_MARCO_CIERRA } from './recibo-estilo.js';

// El boton solo se ofrece cuando hay algo que imprimir: un credito activo con cuotas.
export function puedeReciboGeneral(loans){
  return (loans || []).some(function(l){ return l && l.estado === 'Activo' && !esDiario(l); });
}

// `loansDeudor`: los prestamos del deudor (cualquier estado; se toman los activos con cuotas).
// `opts.hasta`: fecha de corte (por defecto hoy).
export function generateReciboGeneral(loansDeudor, allPays, datosPago, opts) {
  opts = opts || {};
  var hasta = opts.hasta || nowStr();
  var activos = (loansDeudor || []).filter(function(l){ return l && l.estado === 'Activo' && !esDiario(l); })
    .sort(function(a, b){ return String(a.fechaInicio).localeCompare(String(b.fechaInicio)) || String(a.id).localeCompare(String(b.id)); });
  if (!activos.length) return;
  var diarios = (loansDeudor || []).filter(function(l){ return l && l.estado === 'Activo' && esDiario(l); });
  var C = rbPaleta(document.documentElement.getAttribute('data-theme') === 'dark');
  var anio = hasta.slice(0, 4);
  var varios = activos.length > 1;

  // ── El modelo de cada credito, en su moneda visible ────────────────────────
  var mods = activos.map(function(l, i){
    var mon = rbMoneda(l);
    var lp = (allPays || []).filter(function(p){ return String(p.prestamoId) === String(l.id); }).map(function(p){
      return (esCuotaRegular(p) && p.estadoPago === 'Pendiente' && String(p.fechaPago) < hasta) ? Object.assign({}, p, { estadoPago: 'En Mora' }) : p;
    });
    var regs = lp.filter(esCuotaRegular).sort(function(a, b){ return a.cuotaN - b.cuotaN; });
    var venc = regs.filter(function(p){ return p.estadoPago === 'En Mora' && pendCuota(p) > 0; })
      .sort(function(a, b){ return String(a.fechaPago).localeCompare(String(b.fechaPago)) || a.cuotaN - b.cuotaN; });
    var pend = regs.filter(function(p){ return p.estadoPago === 'Pendiente' && pendCuota(p) > 0; });
    var L = computeLiquidacion(l, lp, { hasta: hasta });
    var esIndef = l.modalidad === 'Intereses';
    return {
      l: l, i: i, mon: mon, lp: lp, regs: regs, venc: venc, pend: pend, prox: pend[0] || null, sig: pend[1] || null, esIndef: esIndef,
      deN: esIndef ? '' : ' de ' + regs.length,
      vencU: mon.uni(venc.reduce(function(s, p){ return s + pendCuota(p); }, 0)),
      intVencU: mon.uni(venc.reduce(function(s, p){ return s + pendienteDeCuota(p).interes; }, 0)),
      proxU: pend[0] ? mon.uni(pendCuota(pend[0])) : 0,
      // El desglose de liquidar en la moneda visible: capital + intereses vencidos (y la mora que
      // un cambio de dia consolido) - lo ya abonado a cuotas sin saldar = `L.total`, exacto. El
      // capital absorbe el residuo del redondeo, como en las columnas del cronograma (Bug #31).
      liq: L, liqU: mon.uni(L.total), liqIntU: mon.uni(L.intMora + (L.moraConsolidada || 0)), liqParcU: mon.uni(L.partialPend),
      validoHasta: proximoVencimiento(l, lp, hasta),
      faltaU: mon.uni(regs.filter(function(p){ return p.estadoPago !== 'Pagado'; }).reduce(function(s, p){ return s + pendCuota(p); }, 0)),
      capU: mon.uni(saldoConCaja(l, lp)),
      abonos: lp.filter(function(p){ return esAbono(p) && p.estadoPago === 'Pagado'; })
    };
  });

  // Totales por moneda: un credito en pesos y uno en dolares no se suman entre si.
  function suma(campo, filtro){
    var t = { cop: 0, usd: 0 };
    mods.forEach(function(m){ if (filtro && !filtro(m)) return; t[m.mon.esUSD ? 'usd' : 'cop'] += m[campo]; });
    return t;
  }
  function sumaT(a, b){ return { cop: a.cop + b.cop, usd: a.usd + b.usd }; }
  mods.forEach(function(m){ m.liqCapU = m.liqU - m.liqIntU + m.liqParcU; });
  var vencT = suma('vencU'), intVencT = suma('intVencU'), proxT = suma('proxU'), liqT = suma('liqU'), liqCapT = suma('liqCapU'), liqIntT = suma('liqIntU'), liqParcT = suma('liqParcU');
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
  // 3.7.0 (decision del PO): un credito en dolares se imprime SOLO en dolares: un deudor sin
  // creditos en pesos nunca ve un "$ 0" (rbMixto imprime los pesos cuando no hay dolares que sumar).
  var soloUSD = mods.every(function(m){ return m.mon.esUSD; });
  function monto(t){ return soloUSD ? fmtUSD((t.usd || 0) / 100) : rbMixto(t); }
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
    // Activo, sin vencidas ni cuotas por venir: solo queda el valor de liquidarlo.
    hero = '<div class="r-hero"><div class="r-hero-l"><small>Estás al día</small><div class="r-monto' + (liqT.cop && liqT.usd ? ' mixto' : '') + '">' + monto(liqT) + '</div>' +
      '<div class="r-quien"><b>' + rbEsc(nombre) + '</b> <span>· lo que falta para cerrar ' + (varios ? 'tus créditos' : 'tu crédito') + '</span></div></div>' +
      '<div class="r-sello">' + RB_ICONO_OK + '</div></div>';
  }

  // ── 2. LO QUE ESTA VENCIDO ─────────────────────────────────────────────────
  // Una fila por cuota vencida. Con muchas, las mas viejas de cada credito se resumen en UNA
  // fila (con su total, nunca omitidas): el documento tiene que caber en una hoja carta.
  function chip(cls, t){ return '<span class="chip ' + cls + '">' + t + '</span>'; }
  var tablaVenc = '';
  if (hayVenc) {
    // Tope de filas: 5 con un credito, 5 repartidas con varios (minimo 2 por credito: la mas
    // reciente y el resumen de las anteriores).
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
    var intTxt = (intVencT.cop || intVencT.usd) ? ' <span class="sub">· de eso, intereses ' + monto(intVencT) + '</span>' : '';
    tablaVenc = '<div class="r-sec"><div class="r-sec-t">Lo que está vencido</div><table class="r-t"><thead><tr>' + (varios ? '<th>Crédito</th>' : '') +
      '<th>Cuota</th><th>Venció</th><th>Mora</th><th class="n">Te falta</th></tr></thead><tbody>' + filas + '</tbody>' +
      '<tfoot><tr><td colspan="' + (varios ? 4 : 3) + '">Total vencido' + intTxt + '</td><td class="n">' + monto(vencT) + '</td></tr></tfoot></table></div>';
  }

  // ── 3. TUS OPCIONES DE PAGO ────────────────────────────────────────────────
  var tarjetas = [];
  var proxN = mods.filter(function(m){ return m.prox; }).length;
  if (hayVenc) {
    tarjetas.push(rbTarjeta('ambar', 'Ponerte al día', monto(vencT),
      'paga ' + (nVenc > 1 ? 'las ' + nVenc + ' cuotas vencidas' : 'la cuota vencida') + (conVenc.length > 1 ? ' de tus ' + conVenc.length + ' créditos' : ''), 'LO MÍNIMO'));
    if (proxN) {
      tarjetas.push(rbTarjeta('', 'Al día + la próxima cuota', monto(sumaT(vencT, proxT)),
        (proxN > 1 ? 'incluye la próxima cuota de cada crédito' : 'incluye la del ' + rbCorta(proxima.p.fechaPago, anio)) +
        (siguientes[0] ? '; lo siguiente vence el ' + rbCorta(siguientes[0], anio) : '')));
    }
  } else if (proxN) {
    tarjetas.push(rbTarjeta('', proxN > 1 ? 'Tus próximas cuotas' : 'Tu próxima cuota', monto(proxT),
      (proxN > 1 ? 'una por crédito; la primera vence el ' : 'vence el ') + rbCorta(proxima.p.fechaPago, anio) +
      (proxN === 1 && siguientes[0] ? '; la siguiente, el ' + rbCorta(siguientes[0], anio) : '')));
  }
  tarjetas.push(rbTarjeta('', varios ? 'Liquidar tus créditos' : 'Liquidar el crédito', monto(liqT),
    'capital ' + monto(liqCapT) + ((liqIntT.cop || liqIntT.usd) ? ' + intereses vencidos ' + monto(liqIntT) : '') +
    ((liqParcT.cop || liqParcT.usd) ? ' − lo ya abonado ' + monto(liqParcT) : '') +
    (vigencias[0] ? ' · válido hasta el ' + rbCorta(vigencias[0], anio) : '')));
  var opciones = '<div class="r-sec"><div class="r-sec-t">Tus opciones de pago</div>' + rbRejilla(tarjetas) +
    '<div class="r-tip">' + RB_ICONO_ORDEN + (hayVenc
      ? '<span>Puedes pagar cualquier valor: se aplica primero a los intereses vencidos, después al capital vencido, y lo que sobre abona a tu crédito.</span>'
      : '<span>Puedes adelantar cualquier valor: lo que pagues de más abona a tu crédito y baja los intereses que vienen.</span>') + '</div></div>';

  // ── 4. ASI VA TU CREDITO (uno por credito con varios) ──────────────────────
  function bloqueCredito(m){
    var nPag = m.regs.filter(function(p){ return p.estadoPago === 'Pagado'; }).length;
    var porVenir = m.pend.length - (m.prox ? 1 : 0);
    var abonos = m.abonos.slice(0, 2).map(function(a){ return m.mon.money(a.abonoCapital) + ' el ' + rbCorta(a.fechaRecaudo || a.fechaPago, anio); }).join(', ') +
      (m.abonos.length > 2 ? ' y ' + (m.abonos.length - 2) + ' más' : '');
    var ley = '<div class="r-av-ley">' + rbLeyenda('green-2', rbPlural(nPag, 'pagada', 'pagadas')) +
      (m.venc.length ? rbLeyenda('red', rbPlural(m.venc.length, 'vencida', 'vencidas')) : '') +
      (m.esIndef ? '<span>plazo indefinido</span>' : (m.prox ? rbLeyenda('blue', 'la próxima') : '') + rbLeyenda('track', porVenir + ' por venir')) +
      (abonos ? '<span>· abono a capital: ' + abonos + '</span>' : '') + '</div>';
    // Ninguna cifra repetida: en un `Prestamo` sin interes lo que falta ES el capital. Y en
    // `Intereses` no hay "lo que falta": el capital vence fuera de las cuotas, que son de puro
    // interes, y la suma anunciaria MENOS deuda de la que hay.
    var faltaTxt = m.mon.fmtUni(m.faltaU), capTxt = m.mon.fmtUni(m.capU);
    var saldos;
    if (varios) {
      // Con varios creditos cada uno va en un bloque CORTO (la cifra grande y las opciones ya
      // estan arriba, consolidadas): sus saldos en una sola linea.
      saldos = '<span class="r-linea">' + (m.esIndef
          ? 'Saldo de capital <b class="r-cap">' + capTxt + '</b>'
          : 'Te falta por pagar <b class="r-tot">' + faltaTxt + '</b>' + (faltaTxt === capTxt ? '' : ' · de eso, capital <b class="r-cap">' + capTxt + '</b>')) +
        ' · liquidarlo hoy <b>' + m.mon.fmtUni(m.liqU) + '</b></span>';
    } else {
      saldos = '<div class="r-saldos">' + (m.esIndef
        ? '<div>Saldo de capital<b class="r-cap">' + capTxt + '</b><span class="viejo">se paga al final; cada mes pagas los intereses</span></div>'
        : faltaTxt === capTxt
          ? '<div>Te falta por pagar<b class="r-cap">' + capTxt + '</b><span class="viejo">todo lo que queda del crédito</span></div>'
          : '<div>Te falta por pagar<b class="r-tot">' + faltaTxt + '</b><span class="viejo">todas las cuotas que quedan</span></div>' +
            '<div>De eso, capital<b class="r-cap">' + capTxt + '</b><span class="viejo">el resto son los intereses de esas cuotas</span></div>') + '</div>';
    }
    var titulo = varios
      ? rotulo(m) + ' · ' + montoPrestamo(m) + ' · ' + opModalidad(m.l.modalidad) + ' · desde el ' + rbLarga(m.l.fechaInicio) +
        (m.venc.length ? ' · <span class="r-rojo">vencido ' + m.mon.fmtUni(m.vencU) + '</span>' : '')
      : 'Así va tu crédito · ' + montoPrestamo(m) + ' desde el ' + rbLarga(m.l.fechaInicio);
    // Con varios creditos la leyenda y los saldos comparten renglon.
    if (varios) ley = ley.replace(/<\/div>$/, saldos + '</div>');
    return '<div class="r-sec r-credito"><div class="r-sec-t">' + titulo + '</div>' +
      (m.esIndef ? '' : rbBarraCuotas(m.regs, m.prox ? m.prox.cuotaN : null)) + ley + (varios ? '' : saldos) + '</div>';
  }
  var creditos = mods.map(bloqueCredito).join('') + (diarios.length
    ? '<div class="r-aparte">' + (diarios.length > 1 ? 'Tus ' + diarios.length + ' créditos abiertos' : 'Tu crédito abierto') +
      ' de interés diario no ' + (diarios.length > 1 ? 'están' : 'está') + ' en este documento: ' + (diarios.length > 1 ? 'tienen' : 'tiene') + ' su propio estado de cuenta.</div>'
    : '');

  // ── 5. COMO PAGAR ──────────────────────────────────────────────────────────
  var pagar = String(datosPago || '').trim()
    ? '<div class="r-sec"><div class="r-sec-t">Cómo pagar</div><div class="r-pagar">' + rbEsc(String(datosPago).trim()) + '</div></div>' : '';

  var codigo = 'CG-' + rbIniciales(nombre) + '-' + (varios ? activos.length + 'C' : String(activos[0].id || '').slice(-3)) + '-' + hasta.slice(8, 10) + hasta.slice(5, 7);
  var html = [
    '<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>Recibo de cobro general</title><style>'
  ].concat(rbCss(C)).concat([
    '.r-t .sub{white-space:normal}',
    '.r-linea{margin-left:auto;font-size:12.5px;color:var(--r-muted)}',
    '.r-linea b{color:var(--r-text)}',
    '.r-rojo{color:var(--r-red)}',
    '.r-aparte{margin-top:10px;font-size:12px;color:var(--r-muted)}',
    '.r-pagar{padding:7px 14px;border:1px dashed var(--r-bd);border-radius:12px;font-size:13px;white-space:pre-wrap}',
    '.r-credito{break-inside:avoid}',
    '</style></head><body>' + RB_MARCO_ABRE,
    rbCabecera('Recibo de cobro general', codigo, hasta),
    hero, tablaVenc, opciones,
    creditos,
    pagar,
    '<div class="r-pie"><div><b>' + (hayVenc ? nombre1 + ', ponerte al día es lo más importante.' : 'Gracias por estar al día, ' + nombre1 + '.') + '</b>' +
      'Este documento es un aviso de cobro: no certifica ningún pago. Cifras calculadas al ' + rbLarga(hasta) + '.</div>' +
      '<div class="r-pie-d">' + codigo + '<br>Generado por Cartera</div></div>',
    RB_MARCO_CIERRA + '</body></html>'
  ]).join('\n');

  rbEmitir(html, 'CG ' + nombre + ' - ' + hasta);
}
