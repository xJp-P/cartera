// public/js/pdf/condonacion.js — la CONSTANCIA DE CONDONACION (post-4.1.5), con la linea grafica v4
// de los recibos (rbCss, el marco de impresion, la letra y el tema de la app).
//
// El soporte de un acuerdo: "te perdono estos intereses". NO es un recibo y lo dice: no entro
// dinero, los intereses condonados dejan de cobrarse y el capital sigue debiendose. Responde lo
// que el cliente pregunta al recibirla: cuanto se le condono, en que cuotas (enteras o en parte),
// como quedan lo vencido y "Debes hoy", y que el capital no cambio.
//
// SE ARMA CON LO APLICADO, NUNCA CON LO PLANEADO (la leccion del Bug #45): la emite la app DESPUES
// de que el backend confirma, con la respuesta del endpoint (`cond.cuotas`: lo que se condono en
// cada cuota) y el estado YA persistido tras recargar. El "antes" es la foto que la app tomo antes
// de mandar la condonacion (`cond.pre`). Ninguna formula nueva: lo vencido es `pendCuota` de las
// cuotas En Mora y "Debes hoy" es `computeLiquidacion`, la cifra de Liquidar deuda.
//
// Un credito en dolares se imprime SOLO en dolares (decision del PO, 3.7.0): todo pasa por
// `rbMoneda(loan).money`.

import { rbCss, rbPaleta, rbCabecera, rbLarga, rbMedia, rbEsc, rbPlural, rbIniciales, rbMoneda,
  rbTarjeta, rbRejilla, rbEmitir, RB_ICONO_OK, RB_MARCO_ABRE, RB_MARCO_CIERRA } from './recibo-estilo.js';
import { computeLiquidacion, esDiario, estadoDiario, pendCuota } from '../core/dominio.js';
import { esCuotaRegular } from '../core/ids.js';
import { opModalidad } from '../core/operacion.js';
import { nowStr } from '../core/ui.js';
import { nombrePdf, montoArchivo } from './nombres.js';

// Lo vencido de un prestamo: lo que falta de sus cuotas En Mora (la misma regla de "Lo vencido" del
// modal de condonar y de Liquidar deuda).
function cdVencidas(pays){
  return (pays || []).filter(function(p){ return esCuotaRegular(p) && p.estadoPago === 'En Mora'; })
    .sort(function(a, b){ return String(a.fechaPago).localeCompare(String(b.fechaPago)); });
}
function cdSuma(ps){ return ps.reduce(function(s, p){ return s + pendCuota(p); }, 0); }

var CD_CSS = [
  '.cd-aviso{margin-top:8px;padding:7px 14px;border-radius:12px;background:var(--r-soft);font-size:12px;line-height:1.5;color:var(--r-text-2)}',
  '.cd-aviso b{color:var(--r-text)}',
  // La seccion de las cuotas puede seguir en la hoja siguiente (sus filas no se parten) y su total va
  // UNA vez, al final (en un <tfoot> Chromium lo repetiria al pie de cada hoja).
  '.r-sec.cd-cuotas{break-inside:auto}',
  '.r-t tr.r-tot td{border-bottom:0;font-weight:600;padding-top:7px}',
  '.chip.cond{color:var(--r-text-2);background:var(--r-soft-2)}',
  '.chip.parte{color:var(--r-red);background:var(--r-red-bg)}',
  '.cd-motivo{margin-top:8px;font-size:12px;color:var(--r-text-2)}',
  '.cd-motivo b{color:var(--r-text)}'
];

// `loan` / `pays`: el prestamo y SUS cuotas ya persistidos tras condonar.
// `cond`: { fecha, condonado, cuotas: [{ id, cuotaN, condonado, parcial, quedaDebiendo }] (la respuesta
//   del endpoint; vacia en un credito abierto), observaciones, pre: { loan, pays } (antes de condonar) }.
// `opts.dark`: el tema (por defecto, el de la app).
export function htmlConstanciaCondonacion(loan, pays, cond, opts){
  opts = opts || {};
  cond = cond || {};
  var C = rbPaleta(!!opts.dark);
  var M = rbMoneda(loan), m = M.money;
  var fecha = cond.fecha || nowStr();
  var pre = cond.pre || { loan: loan, pays: pays };
  var lp = (pays || []).filter(function(p){ return String(p.prestamoId) === String(loan.id); });
  var lpPre = (pre.pays || []).filter(function(p){ return String(p.prestamoId) === String(loan.id); });
  var diario = esDiario(loan);
  var condonado = Math.round(+cond.condonado || 0);
  var nombre = loan.nombre || '';
  var montoPrest = M.esUSD ? m(Math.round((+loan.montoOrigen || 0) * (+loan.trmAcordada || 0))) : m(loan.montoOrigen);

  // ── La cifra grande: lo que se condono ──
  var hero = '<div class="r-hero"><div class="r-hero-l"><small>Intereses condonados</small>' +
    '<div class="r-monto">' + m(condonado) + '</div>' +
    '<div class="r-quien"><b>' + rbEsc(nombre) + '</b> <span>· préstamo de ' + montoPrest + ' · ' + opModalidad(loan.modalidad) +
    ' · condonados el ' + rbLarga(fecha) + '</span></div></div><div class="r-sello">' + RB_ICONO_OK + '</div></div>';
  var aviso = '<div class="cd-aviso"><b>No es un pago.</b> Estos intereses se perdonan por acuerdo y dejan de cobrarse: no entró dinero. ' +
    'El capital no cambia y se sigue debiendo.</div>';

  // ── Que se condono ──
  var detalle;
  if (diario) {
    var devA = estadoDiario(pre.loan || loan, lpPre, fecha), devD = estadoDiario(loan, lp, fecha);
    detalle = '<div class="r-sec"><div class="r-sec-t">Qué se condonó</div>' + rbRejilla([
      rbTarjeta('', 'Interés devengado', m(devA.interesPendiente), 'al ' + rbLarga(fecha)),
      rbTarjeta('', 'Se condonó', m(condonado)),
      rbTarjeta('', 'Queda por pagar', m(devD.interesPendiente), devD.interesPendiente > 0 ? 'de interés devengado' : 'el interés quedó en cero')
    ]) + '</div>';
  } else {
    var preId = {}; lpPre.forEach(function(p){ preId[String(p.id)] = p; });
    var posId = {}; lp.forEach(function(p){ posId[String(p.id)] = p; });
    var items = (cond.cuotas || []).filter(function(c){ return +c.condonado > 0; }).map(function(c){
      var a = preId[String(c.id)] || {}, d = posId[String(c.id)] || {};
      var queda = !d.id || d.estadoPago === 'Pagado' ? 0 : pendCuota(d);
      return { n: c.cuotaN, fecha: d.fechaPago || a.fechaPago, interes: Math.round(+a.interesPeriodo || 0), cond: Math.round(+c.condonado),
        queda: queda, parcial: !!c.parcial, saldada: d.estadoPago === 'Pagado' };
    }).sort(function(x, y){ return String(x.fecha).localeCompare(String(y.fecha)) || (x.n - y.n); });
    var anio = fecha.slice(0, 4);
    var otroAnio = items.some(function(it){ return String(it.fecha).slice(0, 4) !== anio; });
    var fechaV = function(f){ return f ? (otroAnio ? rbLarga(f) : rbMedia(f)) : '—'; };
    var filas = items.map(function(it){
      var chip = it.parcial ? '<span class="chip parte">En parte</span>'
        : it.saldada ? '<span class="chip cond">Condonada</span>' : '<span class="chip cond">Queda el capital</span>';
      return '<tr><td>' + it.n + '</td><td>' + fechaV(it.fecha) + '</td><td class="n">' + m(it.interes) + '</td>' +
        '<td class="n"><b>' + m(it.cond) + '</b></td><td class="n">' + (it.queda > 0 ? m(it.queda) : '—') + '</td><td>' + chip + '</td></tr>';
    }).join('');
    var tot = '<tr class="r-tot"><td colspan="2">Total</td><td class="n">' + M.fmtUni(M.sumaU(items.map(function(it){ return it.interes; }))) + '</td>' +
      '<td class="n">' + M.fmtUni(M.sumaU(items.map(function(it){ return it.cond; }))) + '</td>' +
      '<td class="n">' + M.fmtUni(M.sumaU(items.map(function(it){ return it.queda; }))) + '</td><td></td></tr>';
    var nComp = items.filter(function(it){ return !it.parcial; }).length, nParte = items.length - nComp;
    detalle = '<div class="r-sec cd-cuotas"><div class="r-sec-t">Qué se condonó · ' +
      (nComp ? rbPlural(nComp, 'cuota completa', 'cuotas completas') : '') + (nComp && nParte ? ' y ' : '') + (nParte ? rbPlural(nParte, 'en parte', 'en parte') : '') + '</div>' +
      '<table class="r-t"><thead><tr><th>Cuota</th><th>Venció</th><th class="n">Interés</th><th class="n">Se condonó</th><th class="n">Queda debiendo</th><th>Estado</th></tr></thead>' +
      '<tbody>' + filas + tot + '</tbody></table></div>';
  }

  // ── Asi queda el credito: lo vencido, "Debes hoy" y el capital, antes y despues ──
  var liqA = computeLiquidacion(pre.loan || loan, lpPre, { hasta: fecha }), liqD = computeLiquidacion(loan, lp, { hasta: fecha });
  var tarjetas;
  if (diario) {
    tarjetas = [
      rbTarjeta('', 'Debes hoy', m(liqD.total), 'antes ' + m(liqA.total)),
      rbTarjeta('', 'Capital', m(liqD.capitalPendiente), 'sin cambios')
    ];
  } else {
    var vA = cdVencidas(lpPre), vD = cdVencidas(lp);
    tarjetas = [
      rbTarjeta('', 'Lo vencido', m(cdSuma(vD)), vD.length ? rbPlural(vD.length, 'cuota', 'cuotas') + ' · antes ' + m(cdSuma(vA)) : 'nada vencido · antes ' + m(cdSuma(vA))),
      rbTarjeta('', 'Debes hoy', m(liqD.total), 'si liquidas todo · antes ' + m(liqA.total)),
      rbTarjeta('', 'Capital', m(liqD.capitalPendiente), 'sin cambios')
    ];
  }
  var queda = '<div class="r-sec"><div class="r-sec-t">Así queda tu crédito</div>' + rbRejilla(tarjetas) +
    (String(cond.observaciones || '').trim() ? '<div class="cd-motivo"><b>Motivo del acuerdo:</b> ' + rbEsc(String(cond.observaciones).trim()) + '</div>' : '') + '</div>';

  var codigo = 'CD-' + rbIniciales(nombre) + '-' + String(loan.id || '').slice(-3) + '-' + fecha.slice(8, 10) + fecha.slice(5, 7);
  var pie = '<div class="r-pie"><div><b>Constancia de condonación</b>Certifica que se condonaron ' + m(condonado) + ' de intereses de este préstamo. ' +
    'No registra ningún pago y no cambia el capital.</div><div class="r-pie-d">' + codigo + '<br>' + rbLarga(fecha) + '</div></div>';

  var html = ['<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>Constancia de condonación</title><style>']
    .concat(rbCss(C)).concat(CD_CSS).concat(['</style></head><body>' + RB_MARCO_ABRE,
      rbCabecera('Constancia de condonación', codigo, fecha), hero, aviso, detalle, queda, pie, RB_MARCO_CIERRA + '</body></html>']).join('');
  return { html: html, fname: nombrePdf('condonacion', nombre, [montoArchivo(M.esUSD ? M.uni(condonado) / 100 : condonado, M.esUSD), fecha]) };
}

// La emite la app al condonar, si la casilla "Generar constancia" esta marcada (por defecto si).
// El documento sigue el tema de la app, salvo que se pida otro.
export function generateConstanciaCondonacion(loan, pays, cond, opts){
  opts = Object.assign({}, opts || {});
  if (opts.dark === undefined) opts.dark = document.documentElement.getAttribute('data-theme') === 'dark';
  var d = htmlConstanciaCondonacion(loan, pays, cond, opts);
  rbEmitir(d.html, d.fname);
  return d;
}
