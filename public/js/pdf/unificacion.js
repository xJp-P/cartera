// public/js/pdf/unificacion.js — los documentos de la UNIFICACION de prestamos (post-4.0.0), con la
// linea grafica v4 de los recibos (rbCss). Aprobados por el PO sobre una muestra con un caso real.
//
// DOS generadores, no un modo (la leccion del Bug #45 y de la Propuesta de Abono): la PROPUESTA se
// manda ANTES ("si unificamos..."), no cambia nada y lo dice; la CONSTANCIA se entrega DESPUES
// ("unificamos tus prestamos") y es el papel del prestamo nuevo. Comparten el cuerpo, pero el tipo
// de documento lo decide QUE funcion se llama, nunca un parametro.
//
// Lo que el cliente necesita, y nada mas: cuanto va a pagar (la cifra grande), que se unio y por
// cuanto (cuadra con lo que debia hoy en cada prestamo), las condiciones del nuevo, su cronograma
// y que paso con lo que ya pago. NO lleva la ganancia del acreedor.

import { rbCss, rbPaleta, rbCabecera, rbLarga, rbMedia, rbCorta, rbEsc, rbPlural, rbIniciales, rbMoneda,
  rbTarjeta, rbEmitir, RB_ICONO_OK, RB_ICONO_RELOJ, RB_MARCO_ABRE, RB_MARCO_CIERRA } from './recibo-estilo.js';
import { opModalidad } from '../core/operacion.js';
import { nombrePdf } from './nombres.js';

function unPct(t){ return (+t).toLocaleString('es-CO', { maximumFractionDigits: 3 }) + '%'; }
var UN_FREQ = { Mensual: 'mensuales', Quincenal: 'quincenales', Semanal: 'semanales' };
var UN_FREQ1 = { Mensual: 'mensual', Quincenal: 'quincenal', Semanal: 'semanal' };

function unCuerpo(plan, deudor, opts, propuesta){
  opts = opts || {};
  var M = rbMoneda(plan.traslados[0].loan), m = M.money;
  var N = plan.nuevo, hoy = plan.hoy, fecha = plan.fecha || hoy, anio = fecha.slice(0, 4);
  var nPrest = plan.traslados.length;
  var diario = N.modalidad === 'Interes Diario', soloInt = N.modalidad === 'Intereses';
  var cuotasPl = soloInt ? Math.min(N.plazo, N.filas.length) : N.filas.length;

  // ── La cifra grande ──
  var heroT, heroSub;
  if (diario) {
    heroT = m(N.monto);
    heroSub = 'en un crédito abierto al ' + unPct(N.tasaMensual) + ' mensual: el interés corre por días y pagas cuando quieras';
  } else {
    var distinta = N.primeraCuota !== N.cuota;
    heroT = soloInt ? m(N.cuota) : (distinta ? m(N.cuota) : rbPlural(cuotasPl, 'cuota', 'cuotas') + ' de ' + m(N.cuota));
    heroSub = soloInt ? 'de interés ' + UN_FREQ1[N.frecuencia] + ', desde el ' + rbLarga(N.primerPago) + '. El capital (' + m(N.monto) + ') se devuelve cuando quieras'
      : (distinta ? 'la cuota ' + UN_FREQ1[N.frecuencia] + ' (' + rbPlural(cuotasPl, 'cuota', 'cuotas') + '); la primera, del ' + rbMedia(N.primerPago) + ', es de ' + m(N.primeraCuota)
        : UN_FREQ[N.frecuencia] + ', desde el ' + rbLarga(N.primerPago) + ' hasta el ' + rbLarga(N.ultima));
  }
  // Antes y ahora, en una linea bajo la cifra: lo que pagaba por mes en cuotas separadas.
  var antesTxt = diario ? '' : (propuesta ? 'Hoy pagas ' : 'Antes pagabas ') + rbPlural(nPrest, 'cuota', 'cuotas') + ' que ' + (propuesta ? 'suman ' : 'sumaban ') +
    m(plan.actual.porMes) + ' al mes' + (plan.actual.vencido > 0 ? (propuesta ? ' y tienes ' : ', y tenías ') + m(plan.actual.vencido) + ' vencidos' : '') + '.';
  var hero = '<div class="r-hero' + (propuesta ? ' ambar' : '') + '"><div class="r-hero-l"><small>' +
    (propuesta ? 'Si unificamos tus ' + nPrest + ' préstamos, pagarías' : 'Unificamos tus ' + nPrest + ' préstamos: ahora pagas') + '</small>' +
    '<div class="r-monto">' + heroT + '</div><div class="r-quien">' + heroSub + '</div>' +
    (antesTxt ? '<div class="un-antes">' + antesTxt + '</div>' : '') + '</div>' +
    '<div class="r-sello">' + (propuesta ? RB_ICONO_RELOJ : RB_ICONO_OK) + '</div></div>';

  // ── Lo que se une: capital pendiente + intereses - ya abonado = lo que debia hoy ──
  var conAbono = plan.traslados.some(function(t){ return t.abonado > 0; });
  var filas = plan.traslados.map(function(t){
    var l = t.loan, interes = t.interes + t.aInteres;
    return '<tr><td>Préstamo de ' + m(M.esUSD ? l.montoOrigen * l.trmAcordada : l.montoOrigen) + '<span class="sub"> · ' + unPct(+l.tasaMensual) + ' · desde el ' + rbCorta(l.fechaInicio, anio) + '</span></td>' +
      '<td class="n">' + m(t.liq.capitalPendiente) + '</td><td class="n">' + (interes > 0 ? m(interes) : '—') + '</td>' +
      (conAbono ? '<td class="n">' + (t.abonado > 0 ? '− ' + m(t.abonado) : '—') + '</td>' : '') +
      '<td class="n"><b>' + m(t.total) + '</b></td></tr>';
  }).join('');
  var sumCap = plan.traslados.reduce(function(s, t){ return s + t.liq.capitalPendiente; }, 0);
  var sumInt = plan.traslados.reduce(function(s, t){ return s + t.interes + t.aInteres; }, 0);
  var sumAb = plan.traslados.reduce(function(s, t){ return s + t.abonado; }, 0);
  var detalleInt = [];
  if (plan.traslados.some(function(t){ return t.intVencido > 0; })) detalleInt.push('cuotas vencidas');
  if (plan.traslados.some(function(t){ return t.corrido.monto > 0; }) && plan.corridoCobrado > 0) detalleInt.push('días ya corridos');
  if (plan.traslados.some(function(t){ return t.conPU; })) detalleInt.push('ganancia pactada');
  var une = '<div class="r-sec"><div class="r-sec-t">' + (propuesta ? 'Lo que se uniría' : 'Lo que se unió') + ' (lo que debías ' + (fecha === hoy ? 'hoy, ' : 'el ') + rbLarga(fecha) + ')</div>' +
    '<table class="r-t"><thead><tr><th>Préstamo</th><th class="n">Capital</th><th class="n">Intereses</th>' + (conAbono ? '<th class="n">Ya abonado</th>' : '') +
    '<th class="n">Total</th></tr></thead><tbody>' + filas + '</tbody><tfoot><tr><td>Total</td><td class="n">' + m(sumCap) + '</td><td class="n">' + (sumInt > 0 ? m(sumInt) : '—') + '</td>' +
    (conAbono ? '<td class="n">' + (sumAb > 0 ? '− ' + m(sumAb) : '—') + '</td>' : '') + '<td class="n">' + m(plan.total) + '</td></tr></tfoot></table>' +
    (detalleInt.length ? '<div class="un-nota-t">Intereses: ' + detalleInt.join(', ').replace(/, ([^,]*)$/, ' y $1') + '.' +
      (conAbono ? ' Lo ya abonado se descuenta primero de ellos.' : '') + '</div>' : '') + '</div>';

  // ── El prestamo nuevo ──
  var I = plan.interes, txtInt;
  if (I <= 0) txtInt = null;
  else if (plan.destino === 'repartir') txtInt = 'Los intereses (' + m(I) + ') se reparten en ' + (soloInt ? 'las primeras ' : 'las ') + rbPlural(N.filas.filter(function(f){ return f.carga > 0; }).length, 'cuota', 'cuotas') + ', sin intereses encima';
  else if (plan.destino === 'primera') txtInt = diario ? 'Los intereses (' + m(I) + ') quedan pendientes para el próximo pago' : 'Los intereses (' + m(I) + ') van en la primera cuota, sin intereses encima';
  else if (plan.destino === 'capital') txtInt = 'Incluye ' + m(I) + ' de intereses que pasan a capital';
  else txtInt = 'Los intereses (' + m(I) + ') se ' + (propuesta ? 'condonarían' : 'condonaron');
  // Cuatro datos en una fila (sin sub-lineas: el documento tiene que caber en una hoja) y, debajo,
  // que se hizo con los intereses.
  var tars = [
    rbTarjeta('', 'Capital', m(N.monto)),
    rbTarjeta('', 'Tasa mensual', unPct(N.tasaMensual)),
    diario ? rbTarjeta('', 'Modalidad', 'Crédito abierto')
      : rbTarjeta('', soloInt ? 'Cuota de interés' : 'Cuotas', soloInt ? UN_FREQ1[N.frecuencia] : cuotasPl + ' ' + UN_FREQ[N.frecuencia]),
    diario ? rbTarjeta('', 'Interés por mes', m(Math.round(N.monto * N.tasaMensual / 100)))
      : rbTarjeta('', soloInt ? 'Primera cuota' : 'Último pago', soloInt ? rbCorta(N.primerPago, anio) : rbCorta(N.ultima, anio))
  ];
  var nuevo = '<div class="r-sec"><div class="r-sec-t">' + (propuesta ? 'Tu préstamo nuevo sería' : 'Tu préstamo nuevo') + ' · ' + opModalidad(N.modalidad) + '</div>' +
    '<div class="un-cuatro">' + tars.join('') + '</div>' + (txtInt ? '<div class="un-nota-t">' + txtInt + '.</div>' : '') + '</div>';

  // ── El cronograma ──
  var crono = '';
  if (!diario) {
    var vis = soloInt ? N.filas.slice(0, Math.max(cuotasPl, N.filas.filter(function(f){ return f.carga > 0; }).length)) : N.filas;
    var conCarga = vis.some(function(f){ return f.carga > 0; });
    crono = '<div class="r-sec"><div class="r-sec-t">' + (propuesta ? 'Así quedaría tu cronograma' : 'Tu cronograma') + '</div>' +
      '<table class="r-t un-crono"><thead><tr><th>#</th><th>Vence</th><th class="n">Interés</th><th class="n">Abono a capital</th><th class="n">Valor cuota</th><th class="n">Saldo</th></tr></thead><tbody>' +
      vis.map(function(f){
        return '<tr><td>' + f.n + '</td><td>' + rbCorta(f.fecha, anio) + '</td><td class="n">' + m(f.interes) + '</td><td class="n">' + m(f.capital) + '</td>' +
          '<td class="n"><b>' + m(f.cuota) + '</b></td><td class="n">' + m(f.saldo) + '</td></tr>';
      }).join('') + '</tbody>' +
      '<tfoot><tr><td></td><td>Total</td><td class="n">' + m(vis.reduce(function(s, f){ return s + f.interes; }, 0)) + '</td><td class="n">' + m(vis.reduce(function(s, f){ return s + f.capital; }, 0)) + '</td>' +
      '<td class="n">' + m(vis.reduce(function(s, f){ return s + f.cuota; }, 0)) + '</td><td></td></tr></tfoot></table>' +
      (conCarga ? '<div class="un-nota-t">' + (plan.destino === 'primera' ? 'La primera cuota incluye los ' + m(I)
          : (vis.filter(function(f){ return f.carga > 0; }).length === vis.length ? 'Cada cuota' : 'Cada una de las primeras ' + vis.filter(function(f){ return f.carga > 0; }).length + ' cuotas') +
            ' incluye ' + m(vis[0].carga) + ' de los ' + m(I)) +
        ' de intereses de tus préstamos anteriores, sin intereses encima.' + (soloInt ? ' El capital (' + m(N.monto) + ') no está en estas cuotas: se devuelve aparte.' : '') + '</div>'
        : (soloInt ? '<div class="un-nota-t">El capital (' + m(N.monto) + ') no está en estas cuotas: se devuelve aparte, cuando quieras.</div>' : '')) + '</div>';
  }

  // ── Como pagar (solo la constancia: la propuesta todavia no es un prestamo) y el pie ──
  var pagado = plan.traslados.reduce(function(s, t){ return s + t.abonado; }, 0);
  var pie = '<div class="r-pie"><div><b>' + (propuesta ? 'Esto es una propuesta' : 'Constancia de unificación') + '</b>' +
    (propuesta ? 'No cambia tus préstamos hasta que se confirme. Las cifras están calculadas al ' + rbLarga(fecha) + '.'
      : 'Tus ' + nPrest + ' préstamos anteriores quedaron cerrados y unificados en este. Lo que ya pagaste sigue registrado' + (pagado > 0 ? ' (también los ' + m(pagado) + ' abonados a cuotas sin saldar)' : '') + '.') +
    (!propuesta && opts.datosPago ? '<span class="un-pagar"><b>Cómo pagar</b>' + rbEsc(opts.datosPago) + '</span>' : '') +
    '</div><div class="r-pie-d">' + rbEsc(deudor) + '<br>' + (fecha === hoy ? '' : 'Unificación del ') + rbLarga(fecha) + '</div></div>';
  return hero + une + nuevo + crono + pie;
}

var UN_CSS_EXTRA = [
  '.un-nota-t{font-size:11.5px;color:var(--r-muted);margin-top:5px;line-height:1.45}',
  '.un-antes{font-size:12px;color:var(--r-muted);margin-top:3px}',
  '.r-sec{margin-top:9px}',
  '.r-hero{padding:9px 22px}',
  '.r-monto{font-size:36px}',
  '.un-cuatro{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}',
  '.un-cuatro .r-tar-v{font-size:18px}',
  'table.un-crono td{padding:2px 8px;font-size:12.5px}',
  '.un-pagar{display:block;margin-top:6px}',
  '.un-pagar b{display:inline!important;font-size:11.5px!important;margin-right:6px}'
];

function unHtml(titulo, codigo, plan, deudor, opts, propuesta){
  var C = rbPaleta(!!opts.dark);
  return ['<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>' + titulo + '</title><style>']
    .concat(rbCss(C)).concat(UN_CSS_EXTRA).concat(['</style></head><body>' + RB_MARCO_ABRE,
      rbCabecera(titulo, codigo, plan.hoy), unCuerpo(plan, deudor, opts, propuesta), RB_MARCO_CIERRA + '</body></html>']).join('');
}
function unDDMM(iso){ return iso.slice(8, 10) + iso.slice(5, 7); }

// El documento sigue el tema de la app (decision del PO, rediseño v4), salvo que se pida otro.
function unOpts(opts){
  opts = Object.assign({}, opts || {});
  if (opts.dark === undefined) opts.dark = document.documentElement.getAttribute('data-theme') === 'dark';
  return opts;
}

// La PROPUESTA: lo que se manda ANTES de unificar. No cambia nada y lo dice.
export function generatePropuestaUnificacion(plan, deudor, opts){
  var d = htmlPropuestaUnificacion(plan, deudor, unOpts(opts));
  rbEmitir(d.html, d.fname);
  return d;
}
// La CONSTANCIA: lo que se entrega DESPUES. `opts.nuevoId` = el id del prestamo nuevo (su codigo).
export function generateConstanciaUnificacion(plan, deudor, opts){
  var d = htmlConstanciaUnificacion(plan, deudor, unOpts(opts));
  rbEmitir(d.html, d.fname);
  return d;
}

export function htmlPropuestaUnificacion(plan, deudor, opts){
  opts = opts || {};
  return { html: unHtml('Propuesta de unificación', 'PU-' + rbIniciales(deudor) + '-' + unDDMM(plan.fecha || plan.hoy), plan, deudor, opts, true),
    fname: nombrePdf('propuestaUnificacion', deudor, [plan.fecha || plan.hoy]) };
}
export function htmlConstanciaUnificacion(plan, deudor, opts){
  opts = opts || {};
  var id = String(opts.nuevoId || 'NC');
  return { html: unHtml('Constancia de unificación', 'UN-' + rbIniciales(deudor) + '-' + id.slice(-3) + '-' + unDDMM(plan.fecha || plan.hoy), plan, deudor, opts, false),
    fname: nombrePdf('constanciaUnificacion', deudor, [plan.fecha || plan.hoy]) };
}
