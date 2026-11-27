// public/js/core/congelar.js — CONGELAR PRESTAMO en el cliente (post-4.1.6, Fases 1 y 2).
//
// ESPEJO de `POST /api/loans/:id/congelar` y `/descongelar` (backend/routes/loans.js) y de las
// cuotas que el motor rehace despues (engine.js, "CONGELAR PRESTAMO": la cuota de cierre, los
// numeros que no se generan, la transitoria al descongelar y la carga de una unificacion). Solo
// alimenta lo que las dos ventanas muestran EN VIVO mientras se elige (cobrar o perdonar los dias,
// la fecha, el primer pago); manda el backend. La paridad -las mismas validaciones, la misma cuota
// de cierre y el mismo cronograma rehecho, fila a fila- la fija la seccion F de `tests/congelar.js`.
//
// Nombres top-level con prefijo `cg`/`CG_`: el arnes de pruebas aplana todos los modulos.

import { congelamientosDe, congeladoAbierto, diasEntre, interesPeriodoParcial, tasaDelPeriodo, computeLiquidacion, pendCuota,
  MODALIDAD_DIARIA, estadoDiario, cortesDe, interesDeTramo } from './dominio.js';
import { esAbono, esCuotaRegular } from './ids.js';
import { pmt, cargaDeCuotaPreview, fechaPagoFrecuencia } from './calculo.js';

// Las modalidades que se congelan: las de cuotas con interes por periodo y (Fase 2) el credito
// abierto, que deja de devengar. Prestamo (0%) y Pago unico no generan interes por periodo.
export var CG_MODALIDADES = ['Intereses', 'Capital + Intereses', MODALIDAD_DIARIA];

var CG_MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
function cgFechaC(iso){ var p = String(iso).split('-'); return (+p[2]) + ' de ' + CG_MESES[+p[1] - 1] + ' de ' + p[0]; }
function cgPesosC(x){ return '$' + Math.round(x).toLocaleString('es-CO'); }
function cgYmd(d){ return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function cgSumarDias(iso, n){ var d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return cgYmd(d); }
export function cgFechaValida(s){
  s = String(s || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  var p = s.split('-').map(Number), f = new Date(p[0], p[1] - 1, p[2]);
  return f.getFullYear() === p[0] && f.getMonth() === p[1] - 1 && f.getDate() === p[2];
}
function cgOrig(l){ return l.moneda === 'USD' ? Math.round(l.montoOrigen * l.trmAcordada) : Math.round(l.montoOrigen); }

// ── Los helpers del motor (engine.js) ─────────────────────────────────────────
export function cgPrimeraCongelada(c){ return c.perdona ? +c.cuotaN : +c.cuotaN + 1; }
function cgCierreDe(loan, n){
  return congelamientosDe(loan).filter(function(c){ return +c.cuotaN === n && !c.perdona && Math.round(+c.interes || 0) > 0 && c.fecha; })[0] || null;
}
export function cgTextoCierre(c){ return 'Cierre por congelamiento: ' + c.dias + ' días de interés'; }
function cgInicioCuenta(loan){ return congelamientosDe(loan).length ? (loan.fechaBaseCronograma || loan.fechaInicio) : loan.fechaInicio; }
// `cuotasHastaHoy` del motor: cuenta con el reloj (como el servidor).
function cgCuotasHastaHoy(fechaInicio, startN, adelante, freq){
  var dias = (new Date() - new Date(fechaInicio + 'T12:00:00')) / 864e5;
  var per = freq === 'Semanal' ? Math.ceil(dias / 7) : freq === 'Quincenal' ? Math.ceil(dias / 14) : Math.ceil(dias / 30.44);
  return Math.max(3, per + adelante - startN + 1);
}
function cgFilaCierre(loan, c, cuotaN, saldo){
  var s = Math.round(saldo), i = Math.round(+c.interes || 0);
  return { id: loan.id + '-' + cuotaN, prestamoId: loan.id, nombreCliente: loan.nombre, cuotaN: cuotaN, fechaPago: c.fecha,
    saldoInicial: s, interesPeriodo: i, abonoCapital: 0, cuotaTotal: i, saldoFinal: s, estadoPago: 'Pendiente', fechaRecaudo: null,
    observaciones: cgTextoCierre(c), montoCOPRecibido: 0, montoUSDRecibido: 0, partialPaid: 0, extraConsolidado: 0, esCierre: true };
}
function cgFila(loan, cuotaN, saldo, interes, capital, cuota, saldoFinal){
  var freq = loan.frecuencia || 'Mensual', base = loan.fechaBaseCronograma || loan.fechaInicio;
  return { id: loan.id + '-' + cuotaN, prestamoId: loan.id, nombreCliente: loan.nombre, cuotaN: cuotaN,
    fechaPago: fechaPagoFrecuencia(base, cuotaN, loan.diaPago, freq), saldoInicial: saldo, interesPeriodo: interes,
    abonoCapital: capital, cuotaTotal: cuota, saldoFinal: saldoFinal, estadoPago: 'Pendiente', fechaRecaudo: null, observaciones: '',
    montoCOPRecibido: 0, montoUSDRecibido: 0, partialPaid: 0, extraConsolidado: 0 };
}
// `aplicarPeriodoIrregular` + `aplicarCargaTrasladada` del motor, despues del filtro del congelamiento.
function cgRemate(loan, rows, termina){
  var abierto = congeladoAbierto(loan);
  var vivas = abierto ? rows.filter(function(p){ return p.cuotaN < cgPrimeraCongelada(abierto); }) : rows;
  var n = +loan.periodoIrregularN || 0;
  if (n && loan.periodoIrregularDesde && !cgCierreDe(loan, n)) {
    var row = vivas.filter(function(p){ return p.cuotaN === n; })[0];
    if (row) {
      var dias = Math.max(1, diasEntre(loan.periodoIrregularDesde, row.fechaPago));
      var mora = Math.max(0, Math.round(+loan.periodoIrregularMora || 0));
      var interes = interesPeriodoParcial(row.saldoInicial, loan.tasaMensual, loan.frecuencia || 'Mensual', dias) + mora;
      var ajuste = interes - row.interesPeriodo;
      row.interesPeriodo = interes; row.cuotaTotal += ajuste; row.extraConsolidado = ajuste; row.diasTransitoria = dias;
    }
  }
  var C = Math.max(0, Math.round(+loan.cargaTrasladada || 0)), K = Math.max(0, Math.round(+loan.cargaCuotas || 0));
  if (C && K && vivas.length) {
    var ultima = vivas[vivas.length - 1], fin = termina && !abierto;
    vivas.forEach(function(r){
      var c = cargaDeCuotaPreview(loan, r.cuotaN);
      if (fin && r === ultima) { for (var j = r.cuotaN + 1; j <= K; j++) c += cargaDeCuotaPreview(loan, j); }
      if (!c) return;
      r.interesPeriodo += c; r.cuotaTotal += c; r.cargaTrasladada = c;
    });
  }
  return vivas;
}
// `buildSchedule` del motor para Intereses y Capital + Intereses.
function cgBuild(loan, startN, saldoIni, total){
  var indef = loan.modalidad === 'Intereses';
  var r = tasaDelPeriodo((+loan.tasaMensual || 0) / 100, loan.frecuencia || 'Mensual');
  var saldo = Math.round(saldoIni), rows = [];
  var cierres = {}, nC = 0;
  for (var k = 0; k < total; k++) { var c = cgCierreDe(loan, startN + k); if (c) { cierres[startN + k] = c; nC++; } }
  var amort = total - nC;
  var nominal = Math.round(nC ? (amort > 0 ? pmt(r, amort, saldoIni) : 0) : pmt(r, total, saldoIni));
  var tol = Math.max((nC ? amort : total) * 2 + 2, Math.ceil(nominal * 0.02));
  var ultima = total - 1;
  while (ultima >= 0 && cierres[startN + ultima]) ultima--;
  for (var i = 0; i < total; i++) {
    var n = startN + i;
    if (cierres[n]) { rows.push(cgFilaCierre(loan, cierres[n], n, saldo)); continue; }
    var interes = Math.round(saldo * r), capital, cuota;
    var isLast = indef ? false : i === ultima;
    if (indef) { capital = 0; cuota = interes; }
    else if (isLast) {
      capital = saldo;
      var natural = interes + capital;
      if (Math.abs(natural - nominal) <= tol && nominal - capital >= 0) { cuota = nominal; interes = cuota - capital; }
      else cuota = natural;
    } else { capital = Math.min(saldo, nominal - interes); cuota = nominal; }
    var sf = Math.max(0, saldo - capital);
    rows.push(cgFila(loan, n, saldo, interes, capital, cuota, sf));
    saldo = sf;
  }
  return cgRemate(loan, rows, !indef);
}
// `buildScheduleFixedPMT` del motor (cuota fija pactada en C+I).
function cgBuildFijo(loan, startN, saldoIni, cuotaFija){
  var r = tasaDelPeriodo((+loan.tasaMensual || 0) / 100, loan.frecuencia || 'Mensual');
  if (cuotaFija <= saldoIni * r) return null;
  var cuotaEnt = Math.round(cuotaFija), saldo = Math.round(saldoIni), n = startN, i = 0, rows = [];
  while (saldo > 0 && i < 1000) {
    var c = cgCierreDe(loan, n);
    if (c) { rows.push(cgFilaCierre(loan, c, n, saldo)); n++; i++; continue; }
    var interes = Math.round(saldo * r), capital, cuota, sf;
    if (saldo + interes <= cuotaEnt) { capital = saldo; cuota = saldo + interes; sf = 0; }
    else { capital = Math.min(saldo, cuotaEnt - interes); cuota = cuotaEnt; sf = Math.max(0, saldo - capital); }
    rows.push(cgFila(loan, n, Math.round(saldo), Math.round(interes), Math.round(capital), Math.round(cuota), Math.round(sf)));
    saldo = sf; n++; i++;
  }
  return cgRemate(loan, rows, true);
}
// `rehacerPendientes` de la ruta: lo pagado y lo vencido quedan; las Pendientes se rehacen con el
// motor y conservan el dinero que traian.
export function cgRehacer(loanN, pays){
  var regs = pays.filter(function(p){ return !esAbono(p); });
  var fijas = regs.filter(function(p){ return p.estadoPago === 'Pagado' || p.estadoPago === 'En Mora'; });
  var pend = regs.filter(function(p){ return p.estadoPago === 'Pendiente'; });
  var consumidas = fijas.length, nextN = consumidas + 1;
  var capAbonos = pays.filter(function(p){ return esAbono(p) && p.estadoPago === 'Pagado'; }).reduce(function(s, p){ return s + p.abonoCapital; }, 0);
  var capCuotas = fijas.reduce(function(s, p){ return s + p.abonoCapital; }, 0);
  var saldo = Math.max(0, cgOrig(loanN) - capAbonos - capCuotas);
  var schedule = [];
  if (saldo > 0) {
    var fija = Math.round(+loanN.cuotaFijaPactada || 0);
    var rem = loanN.modalidad === 'Intereses'
      ? Math.max(0, cgCuotasHastaHoy(cgInicioCuenta(loanN), nextN, 3, loanN.frecuencia || 'Mensual'))
      : Math.max(0, (loanN.plazoMeses || 12) - consumidas);
    if (fija > 0 && loanN.modalidad === 'Capital + Intereses') schedule = cgBuildFijo(loanN, nextN, saldo, fija) || (rem > 0 ? cgBuild(loanN, nextN, saldo, rem) : []);
    else if (rem > 0) schedule = cgBuild(loanN, nextN, saldo, rem);
  }
  var porId = {};
  pend.forEach(function(p){ porId[p.id] = p; });
  schedule.forEach(function(p){ var v = porId[p.id]; if (v && (+v.partialPaid || 0) > 0) { p.partialPaid = v.partialPaid; p.montoCOPRecibido = v.montoCOPRecibido; p.montoUSDRecibido = v.montoUSDRecibido; p.recibos = v.recibos; } });
  return { schedule: schedule, borrar: pend, saldo: saldo, nextN: nextN };
}

// Lo que se puede congelar desde la interfaz: activo, de cuotas con interes, no congelado ya, y con
// una cuota por vencer (sin ella no hay periodo en curso que congelar).
export function cgPuedeCongelar(l, lp, hoy){
  if (!l || l.estado !== 'Activo' || CG_MODALIDADES.indexOf(l.modalidad) === -1 || l.congeladoDesde) return false;
  // Credito abierto: con tasa y capital vivo (sin capital no corre interes que detener).
  if (l.modalidad === MODALIDAD_DIARIA) return (+l.tasaMensual || 0) > 0 && estadoDiario(l, lp || [], hoy || cgHoy()).capitalVivo > 0;
  return (lp || []).some(function(p){ return esCuotaRegular(p) && p.estadoPago === 'Pendiente' && (!hoy || p.fechaPago > hoy); });
}

// ── CONGELAR: lo que haria `POST /congelar` con esta fecha y esta eleccion ───
// Devuelve { error } (el mismo texto del servidor) o el plan: la cuota en curso, sus dias, la cuota
// de cierre (o null si se perdonan), las cuotas que se quitan, lo vencido que queda, el cronograma
// que queda despues y la liquidacion antes y despues.
export function cgPlanCongelar(loan, pays, desde, perdonar, hoy){
  var lp = (pays || []).filter(function(p){ return String(p.prestamoId) === String(loan.id); });
  var err = function(t){ return { ok: false, error: t }; };
  if (loan.estado !== 'Activo') return err('Solo se congela un crédito activo (este está ' + loan.estado + ').');
  if (CG_MODALIDADES.indexOf(loan.modalidad) === -1) return err('Este crédito no se puede congelar.');
  if (loan.congeladoDesde) return err('Este crédito ya está congelado desde el ' + cgFechaC(loan.congeladoDesde) + '.');
  var F = desde ? String(desde) : hoy;
  if (!cgFechaValida(F)) return err('La fecha del congelamiento no es válida.');
  if (F > hoy) return err('No se puede congelar con una fecha futura: congela el día en que empieza.');
  if (loan.modalidad === MODALIDAD_DIARIA) return cgPlanCongelarDiario(loan, lp, F, perdonar, hoy);
  var regs = lp.filter(esCuotaRegular).sort(function(a, b){ return a.cuotaN - b.cuotaN; });
  var curso = regs.filter(function(p){ return p.estadoPago === 'Pendiente' && p.fechaPago > F; })[0];
  if (!curso) return err('Este crédito no tiene cuotas por vencer: no hay intereses que congelar.');
  var prev = regs.filter(function(p){ return p.cuotaN < curso.cuotaN; }).pop();
  var esTrans = +loan.periodoIrregularN === curso.cuotaN && !!loan.periodoIrregularDesde;
  var inicio = esTrans ? loan.periodoIrregularDesde : (prev ? prev.fechaPago : (loan.fechaInicioIntereses || loan.fechaInicio));
  if (F < inicio) return Object.assign(err('Congela desde el ' + cgFechaC(inicio) + ' o después: ese día empezó el período de la cuota en curso (lo anterior ya está facturado).'), { inicio: inicio });
  if (esTrans && (+loan.periodoIrregularMora || 0) > 0) return err('La cuota en curso trae mora consolidada de un cambio de día de pago: cóbrala o liquídala antes de congelar.');
  var futuras = regs.filter(function(p){ return p.estadoPago === 'Pendiente' && p.cuotaN > curso.cuotaN && (+p.partialPaid || 0) > 0; });
  if (futuras.length) return err('La cuota ' + futuras[0].cuotaN + ' ya tiene un abono de ' + cgPesosC(futuras[0].partialPaid) + ': congelar la quitaría. Revierte ese abono antes de congelar.');
  var freq = loan.frecuencia || 'Mensual';
  var dias = Math.max(0, diasEntre(inicio, F));
  var calculado = dias > 0 ? interesPeriodoParcial(curso.saldoInicial, +loan.tasaMensual || 0, freq, dias) : 0;
  var perdona = !!perdonar || calculado <= 0;
  var abonado = Math.round(+curso.partialPaid || 0);
  var carga = cargaDeCuotaPreview(loan, curso.cuotaN);
  var base = { F: F, curso: curso, inicio: inicio, dias: dias, calculado: calculado, carga: carga, abonado: abonado, perdona: perdona,
    sinDias: calculado <= 0 };
  if (perdona && abonado > 0) return Object.assign(base, err('La cuota del ' + cgFechaC(curso.fechaPago) + ' ya tiene un abono de ' + cgPesosC(abonado) + ': no se pueden perdonar sus días. Cóbralos (el abono va a esa cuota).'));
  if (!perdona && abonado > calculado + carga) return Object.assign(base, err('La cuota del ' + cgFechaC(curso.fechaPago) + ' ya tiene un abono de ' + cgPesosC(abonado) + ', más de lo que quedaría por los ' + dias + ' días corridos (' + cgPesosC(calculado + carga) + '). Revierte el abono antes de congelar.'));
  var registro = { desde: F, hasta: null, cuotaN: curso.cuotaN, fecha: curso.fechaPago, inicio: inicio, dias: dias,
    interes: perdona ? 0 : calculado, perdona: perdona, cuotaAntes: Math.round(curso.cuotaTotal) };
  var loanN = Object.assign({}, loan, { congeladoDesde: F, congelamientos: JSON.stringify(congelamientosDe(loan).concat([registro])) });
  var R = cgRehacer(loanN, lp);
  var quitadas = regs.filter(function(p){ return p.estadoPago === 'Pendiente' && p.cuotaN >= cgPrimeraCongelada(registro); });
  var idsBorrar = {}; R.borrar.forEach(function(p){ idsBorrar[p.id] = true; });
  var paysN = lp.filter(function(p){ return !idsBorrar[p.id]; }).concat(R.schedule);
  var vencidas = regs.filter(function(p){ return p.estadoPago !== 'Pagado' && p.cuotaN < curso.cuotaN; });
  var Lantes = computeLiquidacion(loan, lp, {}), Ldesp = computeLiquidacion(loanN, paysN, {});
  var cierreFila = perdona ? null : R.schedule.filter(function(p){ return p.cuotaN === curso.cuotaN; })[0] || null;
  return Object.assign(base, { ok: true, error: null, registro: registro, loanN: loanN, paysN: paysN, schedule: R.schedule,
    quitadas: quitadas, vencidas: vencidas, vencidoMonto: vencidas.reduce(function(s, p){ return s + pendCuota(p); }, 0),
    cierre: cierreFila ? { cuotaN: curso.cuotaN, fecha: curso.fechaPago, dias: dias, interes: calculado, cuota: cierreFila.cuotaTotal, antes: Math.round(curso.cuotaTotal), falta: pendCuota(cierreFila) } : null,
    liqAntes: Lantes.total, liqDespues: Ldesp.total, intCursoAntes: Lantes.intProxMes || 0, intCursoDespues: Ldesp.intProxMes || 0,
    capital: Ldesp.capitalPendiente });
}

// ── DESCONGELAR ───────────────────────────────────────────────────────────────
// El primer dia de pago DESPUES de `desde` (el `siguientePagoTras` de la ruta).
export function cgSiguientePagoTras(loan, desde){
  var freq = loan.frecuencia || 'Mensual';
  if (freq === 'Semanal') return cgSumarDias(desde, 7);
  if (freq === 'Quincenal') return cgSumarDias(desde, 14);
  var dia = +loan.diaPago || +String(loan.fechaInicio).slice(8, 10);
  var d = new Date(desde + 'T12:00:00');
  for (var k = 0; k < 2; k++) {
    var c = new Date(d.getFullYear(), d.getMonth() + k, 1, 12);
    c.setDate(Math.min(dia, new Date(c.getFullYear(), c.getMonth() + 1, 0).getDate()));
    var iso = cgYmd(c);
    if (iso > desde) return iso;
  }
  return cgSumarDias(desde, 30);
}
export function cgPlanDescongelar(loan, pays, desde, primerPago, hoy){
  var lp = (pays || []).filter(function(p){ return String(p.prestamoId) === String(loan.id); });
  var err = function(t){ return { ok: false, error: t }; };
  var abierto = congeladoAbierto(loan);
  if (!abierto) return err('Este crédito no está congelado.');
  if (loan.estado !== 'Activo') return err('Solo se descongela un crédito activo (este está ' + loan.estado + ').');
  var D = desde ? String(desde) : hoy;
  if (!cgFechaValida(D)) return err('La fecha para descongelar no es válida.');
  if (D > hoy) return err('No se puede descongelar con una fecha futura.');
  if (D < abierto.desde) return err('No se puede descongelar antes del ' + cgFechaC(abierto.desde) + ', el día en que se congeló.');
  if (loan.modalidad === MODALIDAD_DIARIA) return cgPlanDescongelarDiario(loan, lp, abierto, D, hoy);
  var sugerido = cgSiguientePagoTras(loan, D);
  var primer = primerPago ? String(primerPago) : sugerido;
  var base0 = { D: D, abierto: abierto, sugerido: sugerido, primer: primer, diasCongelado: diasEntre(abierto.desde, D) };
  if (!cgFechaValida(primer)) return Object.assign(base0, err('La fecha del primer pago no es válida.'));
  if (primer <= D) return Object.assign(base0, err('El primer pago tiene que ser después del ' + cgFechaC(D) + ', el día en que se descongela.'));
  var freq = loan.frecuencia || 'Mensual', N = cgPrimeraCongelada(abierto), base, diaPago = loan.diaPago;
  if (freq === 'Semanal' || freq === 'Quincenal') base = cgSumarDias(primer, -N * (freq === 'Semanal' ? 7 : 14));
  else { var b = new Date(primer + 'T12:00:00'); b.setDate(1); b.setMonth(b.getMonth() - N); base = cgYmd(b); diaPago = +primer.slice(8, 10); }
  var masPlazo = loan.modalidad === 'Capital + Intereses' && !abierto.perdona ? 1 : 0;
  var historial = congelamientosDe(loan).map(function(c, k, a){ return k === a.length - 1 ? Object.assign({}, c, { hasta: D, primerPago: primer }) : c; });
  var loanN = Object.assign({}, loan, { congeladoDesde: null, congelamientos: JSON.stringify(historial), diaPago: diaPago, fechaBaseCronograma: base,
    periodoIrregularN: N, periodoIrregularDesde: D, periodoIrregularMora: 0, plazoMeses: (+loan.plazoMeses || 0) + masPlazo });
  var R = cgRehacer(loanN, lp);
  var primera = R.schedule.filter(function(p){ return p.cuotaN === N; })[0] || null;
  var normal = R.schedule.filter(function(p){ return p.cuotaN > N && !p.esCierre; })[0] || null;
  var idsBorrar = {}; R.borrar.forEach(function(p){ idsBorrar[p.id] = true; });
  var paysN = lp.filter(function(p){ return !idsBorrar[p.id]; }).concat(R.schedule);
  // Lo vencido: lo que ya vencio al descongelar. La cuota de cierre que aun no vence va aparte.
  var vencidas = lp.filter(function(p){ return esCuotaRegular(p) && p.cuotaN < N && (p.estadoPago === 'En Mora' || (p.estadoPago === 'Pendiente' && p.fechaPago <= D)); });
  return Object.assign(base0, { ok: true, error: null, N: N, base: base, diaPago: diaPago, masPlazo: masPlazo, loanN: loanN, paysN: paysN,
    schedule: R.schedule, primera: primera, diasPrimera: primera ? diasEntre(D, primera.fechaPago) : 0, normal: normal,
    restantes: R.schedule.filter(function(p){ return !p.esCierre && p.cuotaN >= N; }).length,
    ultima: R.schedule.length ? R.schedule[R.schedule.length - 1].fechaPago : null,
    vencidas: vencidas, vencidoMonto: vencidas.reduce(function(s, p){ return s + pendCuota(p); }, 0), capital: computeLiquidacion(loanN, paysN, {}).capitalPendiente });
}

// ── EL CREDITO ABIERTO (Fase 2) ───────────────────────────────────────────────
// No hay cuotas: congelar solo guarda la decision y el motor (`devengoDiario`) deja de devengar
// desde ese dia. Lo devengado hasta el congelamiento se sigue debiendo; los dias congelados, no.
function cgHoy(){ return cgYmd(new Date()); }
function cgUltimoCorte(loan, lp){
  var cortes = cortesDe(loan, lp);
  return { cortes: cortes, fecha: cortes.length ? cortes[cortes.length - 1].fechaPago : loan.fechaInicio };
}
function cgPorDia(loan, capital){ return Math.round(interesDeTramo(capital, +loan.tasaMensual || 0, 30) / 30); }
function cgPlanCongelarDiario(loan, lp, F, perdonar, hoy){
  var err = function(t){ return { ok: false, error: t, diario: true }; };
  if (perdonar) return err('En un crédito abierto lo devengado hasta el congelamiento se conserva y se sigue debiendo: para perdonarlo usa «Condonar intereses».');
  var u = cgUltimoCorte(loan, lp);
  if (F < u.fecha) return Object.assign(err('Congela desde el ' + cgFechaC(u.fecha) + ' o después: ' +
    (u.cortes.length ? 'ese día se registró el último corte.' : 'ese día empezó el crédito.')), { inicio: u.fecha });
  var alCongelar = estadoDiario(loan, lp, F);
  if (alCongelar.capitalVivo <= 0) return err('Este crédito ya no tiene capital vivo: no corre interés que congelar.');
  var registro = { desde: F, hasta: null, cuotaN: null, fecha: null, inicio: u.fecha, dias: alCongelar.diasActivosDesdeUltimoCorte,
    interes: 0, devengado: alCongelar.interesPendiente, perdona: false, cuotaAntes: 0 };
  var loanN = Object.assign({}, loan, { congeladoDesde: F, congelamientos: JSON.stringify(congelamientosDe(loan).concat([registro])) });
  // Hoy, sin congelar y congelado desde F: la diferencia son los dias entre F y hoy, que no se cobran.
  var hoySin = estadoDiario(loan, lp, hoy), hoyCon = estadoDiario(loanN, lp, hoy);
  var Lantes = computeLiquidacion(loan, lp, { hasta: hoy }), Ldesp = computeLiquidacion(loanN, lp, { hasta: hoy });
  return { ok: true, error: null, diario: true, F: F, inicio: u.fecha, ultimoCorte: u.cortes.length ? u.fecha : null,
    dias: alCongelar.diasActivosDesdeUltimoCorte, devengado: alCongelar.interesPendiente,
    interesDia: cgPorDia(loan, alCongelar.capitalVivo), capital: alCongelar.capitalVivo,
    diasSinCobrar: Math.max(0, diasEntre(F, hoy)), noSeCobra: Math.max(0, hoySin.interesPendiente - hoyCon.interesPendiente),
    devHoyAntes: hoySin.interesPendiente, devHoyDespues: hoyCon.interesPendiente,
    registro: registro, loanN: loanN, paysN: lp, liqAntes: Lantes.total, liqDespues: Ldesp.total, perdona: false, cierre: null,
    quitadas: [], vencidas: [], vencidoMonto: 0, schedule: [] };
}
function cgPlanDescongelarDiario(loan, lp, abierto, D, hoy){
  var u = cgUltimoCorte(loan, lp);
  var base0 = { D: D, abierto: abierto, diario: true, diasCongelado: diasEntre(abierto.desde, D) };
  if (D < u.fecha) return Object.assign(base0, { ok: false, error: 'No se puede descongelar antes del ' + cgFechaC(u.fecha) + ', el día del último corte.' });
  var historial = congelamientosDe(loan).map(function(c, k, a){ return k === a.length - 1 ? Object.assign({}, c, { hasta: D, primerPago: null }) : c; });
  var loanN = Object.assign({}, loan, { congeladoDesde: null, congelamientos: JSON.stringify(historial) });
  var enD = estadoDiario(loan, lp, D), hoyN = estadoDiario(loanN, lp, hoy);
  return Object.assign(base0, { ok: true, error: null, loanN: loanN, paysN: lp, capital: enD.capitalVivo,
    interesDia: cgPorDia(loan, enD.capitalVivo), devengado: enD.interesPendiente,
    diasCorridos: Math.max(0, diasEntre(D, hoy)), devHoy: hoyN.interesPendiente,
    liqDespues: computeLiquidacion(loanN, lp, { hasta: hoy }).total, schedule: [], vencidas: [], vencidoMonto: 0 });
}
