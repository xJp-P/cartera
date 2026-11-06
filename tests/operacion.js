// tests/operacion.js — Cobros, Cartera y el panel del deudor (3.5.0) contra el fixture y el server real.
//
// 3.5.0 reemplazo tres pestanas (Cartera, Deudores y Pagos) por dos (Cobros y Cartera) y el modal
// del perfil del deudor por un panel lateral. Ninguna formula nueva de dinero: las cifras salen de
// los helpers del dominio, agregadas en `core/operacion.js`. Lo que SI es nuevo es la forma de
// agruparlas —por tramo de urgencia, por deudor, por evento de caja— y el cableado de las acciones.
// Esta suite fija:
//
//   A. EL MODELO: la bandeja de cobro particiona exactamente las cuotas por cobrar (cada una en UN
//      tramo, sin abonos ni cortes), y sus totales cuadran con los del Resumen; cada prestamo del
//      panel muestra el MISMO saldo, valor de liquidacion y ganancia que los helpers del dominio.
//   B. COBROS renderizado: tramos con sus cifras, lo vencido agrupado por credito con "Cobrar" (el
//      cobro en cascada), "Pago" por cuota, "Mas adelante" plegado, y la caja del mes en "Cobrado".
//   C. CARTERA renderizada: lo urgente primero, los filtros con sus conteos y el foco que llega
//      desde el Resumen o la busqueda.
//   D. EL PANEL DEL DEUDOR: acciones gateadas por modalidad y cableadas al prestamo correcto,
//      cronograma de 7 columnas y la cifra "Liquidar hoy".
//   E. CAMBIAR DIA DE PAGO, el modal extraido del perfil: su preview contra lo que el backend
//      REAL registra, pulsando el boton real del componente.
//   F. GUARDAS ESTATICAS del reemplazo: las vistas viejas no dejan restos.
//   G. LA MEMORIA DE CARTERA (3.6.0): al volver a la pestana se conservan el filtro, el orden, el
//      deudor abierto y el prestamo elegido. "Volver" es montar la vista otra vez con la MISMA
//      memoria, que es exactamente lo que hace App (la vista se desmonta al cambiar de pestana).
//      3.7.0: la memoria sobrevive al CIERRE de la app (localStorage). "Reiniciar" es leerla de
//      nuevo con `ctLeerMemoria` en un objeto nuevo, que es lo que hace App al arrancar.
//   H. EL BUSCADOR IGNORA TILDES (3.7.0) y los codigos FC: los de las cuotas NO cambian (se comparan
//      contra la regla de 3.6.0 copiada aqui), los de los creditos abiertos dejan de perder letras y
//      los papeles viejos se siguen encontrando.
//   I. ORTOGRAFIA (3.7.0): los modales y vistas viejos, renderizados de verdad, no muestran palabras
//      sin su tilde (el guardian D9 de `resumen`, extendido al resto de la interfaz).
//
// Se ejecuta:
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron tests/operacion.js

const fs   = require('fs');
const path = require('path');
const { Reporter }          = require('./lib/report');
const { copiaDeProduccion } = require('./lib/db');
const { REPO }              = require('./lib/paths');

const R = new Reporter('operacion');

// ── RELOJ: calendario CONGELADO, reloj de ids INTACTO ────────────────────────
// Mismo instante y misma razon que `resumen`, `pdf-render` y `e2e-api`: 31-jul-2026, la fecha de
// referencia del fixture. Los tramos de Cobros dependen del dia: sin esto caducarian solos.
const RelojReal = Date;
const INSTANTE_FIJO = new RelojReal(2026, 6, 31, 12, 0, 0);
global.Date = class extends RelojReal {
  constructor(...args) { if (args.length === 0) super(INSTANTE_FIJO.getTime()); else super(...args); }
  static now() { return RelojReal.now(); }
};
const HOY = '2026-07-31';

const createApp = require('../backend/server');

function arrancar(dbPath) {
  return new Promise((resolve, reject) => {
    let app;
    try { app = createApp(dbPath); } catch (e) { return reject(e); }
    const srv = app.listen(0, '127.0.0.1', () => resolve({ srv, base: 'http://127.0.0.1:' + srv.address().port }));
    srv.on('error', reject);
  });
}
const cerrar = S => new Promise(r => S.srv.close(() => r()));
async function traer(S, ruta) {
  const r = await fetch(S.base + ruta);
  if (r.status !== 200) throw new Error('GET ' + ruta + ' ' + r.status);
  return r.json();
}

// ── Arnes de render (el de `periodo-irregular` J: estado sembrado y setters registrados) ──
const pintar = n => {
  if (n === null || n === undefined || typeof n === 'boolean') return null;
  if (typeof n === 'string' || typeof n === 'number') return String(n);
  if (Array.isArray(n)) return n.map(pintar).filter(x => x !== null);
  if (typeof n.type === 'function') return pintar(n.type(Object.assign({}, n.props, { children: n.children })));
  return { tag: n.type, props: n.props, kids: (n.children || []).map(pintar).filter(x => x !== null) };
};
const textos = (n, out) => {
  out = out || [];
  if (typeof n === 'string') { out.push(n); return out; }
  if (Array.isArray(n)) { n.forEach(x => textos(x, out)); return out; }
  if (n && n.kids) n.kids.forEach(x => textos(x, out));
  return out;
};
const nodos = (n, pred, out) => {
  out = out || [];
  if (Array.isArray(n)) { n.forEach(x => nodos(x, pred, out)); return out; }
  if (n && n.kids) { if (pred(n)) out.push(n); n.kids.forEach(x => nodos(x, pred, out)); }
  return out;
};
// Nodos que llevan TODAS las clases pedidas ('dp-crono-f foco'), comparadas como palabras enteras:
// `cb-tramo` no debe confundirse con `cb-tramo-l`.
const conClase = (arbol, req) => nodos(arbol, n => {
  if (!n.props || typeof n.props.className !== 'string') return false;
  const cl = n.props.className.split(/\s+/);
  return req.split(' ').every(c => cl.indexOf(c) !== -1);
});
const botones = (arbol, re) => nodos(arbol, n => n.tag === 'button' && re.test(textos(n).join('')));
const suma = (arr, f) => arr.reduce((s, x) => s + f(x), 0);

// ═════════════════════════════════════════════════════════════════════════════
(async () => {
  const dbPath = copiaDeProduccion('operacion');
  const S = await arrancar(dbPath);
  let loans, pays, historial, journal, historial100;
  try {
    // GET /api/payments corre la auto-mora a la fecha congelada: es el estado que ve la app.
    loans = await traer(S, '/api/loans');
    pays  = await traer(S, '/api/payments');
    // El historial COMPLETO, como lo pide App desde 3.7.0 (seccion K), y el de siempre para comparar.
    historial = await traer(S, '/api/activity?todo=1');
    historial100 = await traer(S, '/api/activity');
    journal = await traer(S, '/api/undo');
  } catch (e) { await cerrar(S); throw e; }

  // El frontend real, con `fetch` apuntando al server de esta suite: el modal de Cambiar dia
  // publica de verdad contra el backend (seccion E).
  const { cargarFrontend } = require('./lib/load-frontend');
  const FE = cargarFrontend({ silenciarConsola: true, fetch: (url, opts) => fetch(S.base + url, opts) });
  const X = FE.sandbox;
  X.Date = Date;
  const useStateOrig = X.useState;
  const montar = (Comp, props, estado) => {
    const llamadas = [];
    let i = 0;
    X.useState = init => {
      const k = i++;
      const v = (estado && k < estado.length && estado[k] !== undefined) ? estado[k] : (typeof init === 'function' ? init() : init);
      return [v, nuevo => llamadas.push({ k, nuevo })];
    };
    try {
      const arbol = pintar({ type: Comp, props, children: [] });
      return { arbol, t: textos(arbol), todo: textos(arbol).join(' '), llamadas };
    } finally { X.useState = useStateOrig; }
  };

  R.seccion('0 — el arnes ve el dia congelado y los simbolos nuevos');
  R.eq('0 nowStr() dentro del frontend = 31-jul-2026', X.nowStr(), HOY);
  R.check('0 la operacion expone su modelo, sus dos vistas, el panel y el modal',
    ['bandejaCobro', 'modeloDeudor', 'modeloPrestamo', 'opPuedeCambiarDia', 'CobrosView', 'CarteraView', 'DeudorPanel', 'CambiarDiaModal']
      .every(k => typeof X[k] === 'function'));

  // Los deudores, armados como los arma App (agrupados por nombre).
  const deudores = [];
  loans.forEach(l => { if (!deudores.some(d => d.nombre === l.nombre)) deudores.push({ nombre: l.nombre, cedula: l.cedula, telefono: l.telefono }); });
  const lpDe = id => pays.filter(p => p.prestamoId === id);
  const loanMap = {}; loans.forEach(l => { loanMap[l.id] = l; });
  const activos = loans.filter(l => l.estado === 'Activo');

  // ── A — EL MODELO ─────────────────────────────────────────────────────────
  R.seccion('A — la bandeja de cobro y el modelo del deudor, contra el dominio');
  const B = X.bandejaCobro(loans, pays, HOY);
  // Lo que FALTA cobrar, calculado aparte: cuotas del cronograma, no pagadas, de prestamos activos.
  const porCobrar = pays.filter(p => loanMap[p.prestamoId] && loanMap[p.prestamoId].estado === 'Activo' &&
    X.esCuotaRegular(p) && p.estadoPago !== 'Pagado');
  R.eq('A1 cada cuota por cobrar aparece UNA vez en la bandeja', B.map(f => f.p.id).sort(), porCobrar.map(p => p.id).sort());
  R.check('A1 sin abonos ni cortes (ya entraron: no se cobran)', B.every(f => !X.esAbono(f.p) && !X.esCorte(f.p)));
  // Abonos y cortes nacen Pagados, asi que en el fixture el filtro por estado ya los deja fuera y
  // el filtro por TIPO no se ejercita. Se construye la fila que lo exige: un corte y un abono que
  // (por un dato raro) no figuran Pagados siguen sin ser cuotas que cobrar.
  const corte0 = pays.filter(p => X.esCorte(p))[0], abono0 = pays.filter(p => X.esAbono(p) && loanMap[p.prestamoId].estado === 'Activo')[0];
  const raros = [corte0, abono0].filter(Boolean).map(p => Object.assign({}, p, { id: p.id + '9', estadoPago: 'Pendiente', fechaPago: HOY }));
  R.check('A1 un corte o un abono sin marcar Pagado tampoco entra a la bandeja (filtro por tipo)',
    raros.length === 2 && X.bandejaCobro(loans, pays.concat(raros), HOY).length === B.length, raros.length);
  const tramo = t => B.filter(f => f.tramo === t);
  const totTramo = t => suma(tramo(t), f => f.pend);
  R.eq('A2 los cinco tramos particionan la bandeja', ['vencido', 'hoy', 'semana', 'mes', 'despues'].reduce((s, t) => s + tramo(t).length, 0), B.length);
  const moraReg = pays.filter(p => p.estadoPago === 'En Mora' && X.esCuotaRegular(p));
  R.eq('A3 vencido = lo que falta de cada cuota En Mora (el "En mora" del Resumen)', totTramo('vencido'), suma(moraReg, p => X.pendCuota(p)));
  R.eq('A3 cifra del fixture: 3.012.407 en 7 cuotas', [totTramo('vencido'), tramo('vencido').length], [3012407, 7]);
  R.eq('A4 hoy = cuotas Pendientes que vencen el 31-jul (640.000)', totTramo('hoy'),
    suma(porCobrar.filter(p => p.estadoPago === 'Pendiente' && p.fechaPago === HOY), p => X.pendCuota(p)));
  R.eq('A4 cifras del fixture: hoy 640.000 y proximos 7 dias 1.114.250', [totTramo('hoy'), totTramo('semana')], [640000, 1114250]);
  R.check('A5 cada fila guarda lo que FALTA (pendCuota), no el valor de la cuota', B.every(f => f.pend === X.pendCuota(f.p)));

  // Cada prestamo del panel muestra lo mismo que los helpers del dominio.
  const mods = loans.map(l => X.modeloPrestamo(l, lpDe(l.id), HOY));
  R.check('A6 saldo mostrado = saldoConCaja, en los ' + loans.length + ' prestamos',
    mods.every(m => m.saldo === X.saldoConCaja(m.loan, m.lp)), mods.filter(m => m.saldo !== X.saldoConCaja(m.loan, m.lp)).map(m => m.loan.id));
  R.check('A6 "Liquidar hoy" = computeLiquidacion en los ' + activos.length + ' activos',
    mods.filter(m => m.activo).every(m => m.liq.total === X.computeLiquidacion(m.loan, m.lp, {}).total));
  R.check('A6 ganancia = gananciaDePrestamo y lo recibido = toda la caja de cobrosDe',
    mods.every(m => m.gp.cop === X.gananciaDePrestamo(m.loan, m.lp).cop &&
      m.recTotal === Math.round(suma(m.lp, p => suma(X.cobrosDe(p), e => e.cop)))));
  // El fixture no trae pagos parciales en vuelo, y sin ellos el saldo con caja coincide con el del
  // motor: la igualdad de arriba pasaria igual mostrando el saldo equivocado. Se construye uno:
  // un parcial que cubre el interes de la cuota y 100.000 de capital.
  const mCI = mods.filter(m => m.activo && m.loan.modalidad === 'Capital + Intereses' && m.pendientes.length)[0];
  const cuotaP = mCI.pendientes[0];
  const parcial = cuotaP.interesPeriodo + 100000;
  const lpP = mCI.lp.map(p => p.id !== cuotaP.id ? p : Object.assign({}, p, { partialPaid: parcial, montoCOPRecibido: parcial,
    recibos: JSON.stringify([{ fecha: HOY, cop: parcial }]) }));
  const mP = X.modeloPrestamo(mCI.loan, lpP, HOY);
  R.check('A6 con un parcial en vuelo, el saldo mostrado baja por el capital que cubrio (saldoConCaja), no el del motor',
    mP.saldo === X.saldoConCaja(mCI.loan, lpP) && mP.saldo === mCI.saldo - 100000 && mP.saldoMotor === mCI.saldoMotor,
    { saldo: mP.saldo, antes: mCI.saldo, motor: mP.saldoMotor });
  const MD = deudores.map(d => X.modeloDeudor(d, loans, pays, HOY));
  const MR = X.modeloResumen(loans, pays, HOY);
  R.eq('A7 "En la calle" de Cartera = capital en la calle del Resumen (36.153.366)', suma(MD, x => x.saldo), MR.vivo);
  R.eq('A7 "Prestado" de Cartera = prestado del Resumen (41.586.369)', suma(MD, x => x.prestado), MR.prestado);
  R.eq('A7 lo vencido por deudor suma lo vencido de la bandeja', suma(MD, x => x.mora), totTramo('vencido'));
  R.eq('A7 deudores en mora: 3', MD.filter(x => x.moraN > 0).length, 3);
  R.check('A8 un deudor con mora se marca "mora" y su prestamo con mora va primero en sus pestanas',
    MD.filter(x => x.moraN > 0).every(x => x.estado === 'mora' && x.activos[0].enMora.length > 0));
  // "Cambiar dia de pago" solo donde el backend lo acepta (whitelist de /cambiar-dia-pago).
  const elegibles = activos.filter(l => X.opPuedeCambiarDia(l));
  R.check('A9 Cambiar dia: solo Intereses o C+I, mensuales y activos',
    loans.every(l => X.opPuedeCambiarDia(l) === (l.estado === 'Activo' && ['Intereses', 'Capital + Intereses'].indexOf(l.modalidad) !== -1 && (l.frecuencia || 'Mensual') === 'Mensual')));
  R.check('A9 ANTI-VACIO: hay prestamos que si y que no', elegibles.length >= 2 && activos.some(l => !X.opPuedeCambiarDia(l)));

  // ── B — COBROS ────────────────────────────────────────────────────────────
  R.seccion('B — la vista Cobros renderizada');
  const llamadasAcc = [];
  const acciones = {};
  ['onCobro', 'onCorte', 'onLiquidar', 'onReestructurar', 'onCambiarDia', 'onCondonar', 'onEdit', 'onDelete', 'onForceClose', 'onNewLoan']
    .forEach(k => { acciones[k] = arg => llamadasAcc.push({ k, arg }); });
  const pagos = [];
  const propsCobros = { loans, pays, deudores, hoy: HOY, acciones, onPay: p => pagos.push(p), datosPago: '', showToast: () => {} };
  let cb = null, error = null;
  try { cb = montar(X.CobrosView, propsCobros, []); } catch (e) { error = e; }
  R.check('B1 la vista se renderiza sin excepciones', !!cb, error && (error.stack || String(error)));
  if (cb) {
    const tarjetas = conClase(cb.arbol, 'cb-tramo');
    R.eq('B1 cinco tarjetas de tramo', tarjetas.length, 5);
    const valorTramo = t => { const n = tarjetas.filter(x => x.props.className.split(/\s+/).indexOf('t-' + t) !== -1)[0]; return n ? textos(n).join('|') : ''; };
    R.check('B1 cada tarjeta muestra el total de su tramo',
      ['vencido', 'hoy', 'semana', 'mes', 'despues'].every(t => valorTramo(t).indexOf(X.fmt(totTramo(t))) !== -1),
      ['vencido', 'hoy', 'semana'].map(valorTramo));
    // Lo vencido se agrupa por credito: un grupo por prestamo con 2+ cuotas vencidas.
    const porLoan = {};
    tramo('vencido').forEach(f => { porLoan[f.l.id] = (porLoan[f.l.id] || 0) + 1; });
    const conVarias = Object.keys(porLoan).filter(id => porLoan[id] > 1);
    const grupos = conClase(cb.arbol, 'cb-grupo');
    R.eq('B2 un grupo por credito con varias cuotas vencidas', grupos.length, conVarias.length);
    R.check('B2 ANTI-VACIO: el fixture tiene al menos un credito con varias cuotas vencidas', conVarias.length >= 1);
    llamadasAcc.length = 0;
    botones(grupos[0], /^Cobrar$/)[0].props.onClick();
    R.check('B2 "Cobrar" del grupo abre el cobro en cascada de ESE prestamo',
      llamadasAcc.length === 1 && llamadasAcc[0].k === 'onCobro' && conVarias.indexOf(llamadasAcc[0].arg.id) !== -1, llamadasAcc);
    R.check('B2 el total del grupo es lo que falta de sus cuotas',
      textos(grupos[0]).indexOf(X.fmt(suma(tramo('vencido').filter(f => f.l.id === llamadasAcc[0].arg.id), f => f.pend))) !== -1);
    // ACORDEON (decision del PO): un credito con 2+ cuotas vencidas nace plegado y su fila dice solo
    // cuantas cuotas, cuanto suman y cuantos dias tiene la mas vieja.
    const enGrupos = conVarias.reduce((s, id) => s + porLoan[id], 0);
    const idG = conVarias[0], fsG = tramo('vencido').filter(f => f.l.id === idG);
    const grupoG = grupos.filter(g => textos(g).join(' ').indexOf(X.properCase(loanMap[idG].nombre)) !== -1)[0];
    const cabG = conClase(grupoG, 'cb-grupo-h')[0];
    R.check('B2 acordeon plegado por defecto: el grupo no muestra sus cuotas',
      conClase(grupoG, 'cb-grupo-cuotas').length === 0 && cabG.props['aria-expanded'] === false && !/\babierto\b/.test(grupoG.props.className));
    const txtG = textos(cabG).join(' ');
    R.check('B2 su fila: cuantas cuotas, cuanto suman y los dias de la mas vieja',
      txtG.indexOf(fsG.length + ' cuotas vencidas') !== -1 && txtG.indexOf(X.fmt(suma(fsG, f => f.pend))) !== -1 &&
      txtG.indexOf((-fsG[0].dias) + ' días de mora') !== -1, txtG);
    const r0 = montar(X.CobrosView, propsCobros, []);
    const cab0 = conClase(conClase(r0.arbol, 'cb-grupo').filter(g => textos(g).join(' ').indexOf(X.properCase(loanMap[idG].nombre)) !== -1)[0], 'cb-grupo-h')[0];
    cab0.props.onClick();
    R.check('B2 un clic en la fila lo abre (y muestra al deudor en el panel)',
      r0.llamadas.some(x => x.k === 7 && x.nuevo[idG] === true) && r0.llamadas.some(x => x.k === 3 && x.nuevo.loanId === idG), r0.llamadas);
    const abiertoG = {}; abiertoG[idG] = true;
    const cbG = montar(X.CobrosView, propsCobros, [undefined, undefined, undefined, undefined, undefined, undefined, undefined, abiertoG]);
    R.eq('B2 abierto, muestra sus ' + fsG.length + ' cuotas una por una', conClase(cbG.arbol, 'cb-fila en-grupo').length, fsG.length);
    // "Mas adelante" (> 30 dias) tambien nace plegado.
    const nDespues = tramo('despues').length;
    const pago = botones(cb.arbol, /^Pagó$/);
    R.eq('B3 un "Pagó" por cuota visible: todas menos las de "Más adelante" y las de los grupos plegados', pago.length, B.length - nDespues - enGrupos);
    R.check('B3 "Más adelante" ofrece desplegarse con su conteo',
      botones(cb.arbol, new RegExp('^Mostrar las ' + nDespues + ' cuotas que vencen después de 30 días$')).length === 1 && nDespues > 0, nDespues);
    // La primera cuota con su propio boton: la mas vieja que no esta dentro de un grupo plegado.
    const primera = B.filter(f => conVarias.indexOf(f.l.id) === -1 && f.tramo !== 'despues')[0];
    pago[0].props.onClick();
    R.check('B3 "Pagó" abre el pago de ESA cuota (la primera visible, la mas vieja)',
      pagos.length === 1 && pagos[0].id === primera.p.id, pagos.map(p => p.id));
    const factura = nodos(cb.arbol, n => n.tag === 'button' && n.props && /Factura de cobro/.test(n.props.title || ''));
    FE.captura.pdfs.length = 0;
    factura[0].props.onClick();
    R.check('B3 el boton de factura emite la Factura de Cobro de esa cuota', FE.captura.pdfs.length === 1 &&
      FE.captura.pdfs[0].html.indexOf(X.facturaCode(primera.p)) !== -1, FE.captura.pdfs.length);
    // B6 — el Recibo de cobro general en la fila agrupada (decision del PO). Es del DEUDOR, no del
    // credito: lleva toda su mora, de todos sus creditos activos.
    const rg = nodos(cabG, n => n.tag === 'button' && n.props && /Recibo de cobro general/.test(n.props.title || ''));
    R.eq('B6 la fila agrupada ofrece el Recibo de cobro general', rg.length, 1);
    if (rg.length === 1) {
      const nomG = loanMap[idG].nombre;
      const nDeudor = tramo('vencido').filter(f => f.l.nombre === nomG).length;
      // Que reciba los prestamos del DEUDOR y no solo el de la fila. El unico deudor con la fila
      // agrupada tiene, a la fecha del fixture, un solo credito, y ahi "el de la fila" y "todos
      // los suyos" son lo mismo (verificado: la regresion pasaba en verde). Se le agrega un
      // segundo credito en memoria y se mira el argumento mismo.
      const otro = loans.filter(x => x.estado === 'Activo' && x.nombre !== nomG && !X.esDiario(x))[0];
      const loansB6 = loans.concat([Object.assign({}, otro, { id: 'b6-segundo-credito', nombre: nomG })]);
      const cbB6 = montar(X.CobrosView, Object.assign({}, propsCobros, { loans: loansB6 }), []);
      const grupoB6 = conClase(cbB6.arbol, 'cb-grupo').filter(g => textos(g).join(' ').indexOf(X.properCase(nomG)) !== -1)[0];
      const rgB6 = nodos(grupoB6, n => n.tag === 'button' && n.props && /Recibo de cobro general/.test(n.props.title || ''))[0];
      const genReal = X.generateReciboGeneral, argsG = [];
      X.generateReciboGeneral = function(){ argsG.push([].slice.call(arguments)); return genReal.apply(this, arguments); };
      try { rgB6.props.onClick(); } finally { X.generateReciboGeneral = genReal; }
      R.eq('B6 recibe TODOS los prestamos del deudor (no solo el de la fila), con hoy como corte',
        argsG.length === 1 ? [argsG[0][0].map(x => x.id).sort(), argsG[0][3] && argsG[0][3].hasta] : null,
        [loansB6.filter(x => x.nombre === nomG).map(x => x.id).sort(), HOY]);
      FE.captura.pdfs.length = 0;
      rg[0].props.onClick();
      const docG = FE.captura.pdfs[0];
      R.check('B6 emite el recibo general de ese deudor con TODA su mora (' + nDeudor + ' cuotas)',
        FE.captura.pdfs.length === 1 && docG.html.indexOf('Recibo de cobro general') !== -1 &&
        docG.html.indexOf(nDeudor + ' cuotas vencidas') !== -1 && docG.fname === 'CG ' + nomG + ' - ' + HOY,
        docG && docG.fname);
    }
    // Desplegado (verDespues = true, el 7o useState), aparecen.
    const cbAbierto = montar(X.CobrosView, propsCobros, [undefined, undefined, undefined, undefined, undefined, undefined, true]);
    R.eq('B4 desplegado, "Más adelante" muestra sus cuotas', botones(cbAbierto.arbol, /^Pagó$/).length, B.length - enGrupos);
    // El tramo que llega por props (las insignias del encabezado) abre la bandeja filtrada.
    const cbVenc = montar(X.CobrosView, Object.assign({}, propsCobros, { tramo: 'vencido' }), []);
    R.check('B5 tramo "vencido": solo la seccion Vencido', conClase(cbVenc.arbol, 'cb-sec').length === 1 &&
      cbVenc.t.indexOf('Hoy') === cbVenc.t.lastIndexOf('Hoy'), conClase(cbVenc.arbol, 'cb-sec').length);
    // Busqueda por codigo de factura.
    const cod = X.facturaCode(B[0].p);
    const cbQ = montar(X.CobrosView, propsCobros, [undefined, undefined, cod]);
    R.eq('B6 la busqueda reconoce el codigo de factura (' + cod + ')', botones(cbQ.arbol, /^Pagó$/).length,
      B.filter(f => X.payMatchesQuery(f.p, cod) && f.tramo !== 'despues').length);
    // Cobrado: toda la caja del mes, repartida por imputarCobros.
    const cobr = montar(X.CobrosView, propsCobros, ['cobrado']);
    const ev = []; pays.forEach(p => { if (loanMap[p.prestamoId]) X.imputarCobros(p).eventos.forEach(e => { if (e.fecha.slice(0, 7) === '2026-07') ev.push(e); }); });
    const caja = suma(ev, e => e.cop);
    R.eq('B7 "Cobrado" de julio = Cobros del Mes del Resumen (8.411.353)', caja, 8411353);
    R.check('B7 la vista lo muestra en "Entró en caja"', cobr.t.indexOf('Entró en caja') !== -1 && cobr.t.indexOf(X.fmt(caja)) !== -1);
    R.check('B7 interes + capital + efecto TRM = caja, evento por evento', ev.every(e => Math.abs(e.interes + e.capital + (e.ajuste || 0) - e.cop) < 1e-6));
    R.check('B7 y muestra los intereses del mes', cobr.t.indexOf(X.fmt(suma(ev, e => e.interes))) !== -1);
    // Con una cuota elegida, el panel del deudor aparece al lado con ese prestamo.
    const f0 = tramo('vencido')[0];
    const cbSel = montar(X.CobrosView, propsCobros, [undefined, undefined, undefined, { nombre: f0.l.nombre, loanId: f0.l.id, payId: f0.p.id }]);
    const panel = conClase(cbSel.arbol, 'dp');
    R.check('B8 elegir una cuota abre el panel de su deudor, con la cuota resaltada en el cronograma',
      panel.length === 1 && conClase(panel[0], 'dp-crono-f foco').length === 1);
  }

  // ── C — CARTERA ───────────────────────────────────────────────────────────
  R.seccion('C — la vista Cartera renderizada');
  const propsCartera = { loans, pays, deudores, hoy: HOY, acciones, onPay: () => {}, onNuevo: () => {}, datosPago: '', showToast: () => {}, foco: null };
  let ct = null; error = null;
  try { ct = montar(X.CarteraView, propsCartera, []); } catch (e) { error = e; }
  R.check('C1 la vista se renderiza sin excepciones', !!ct, error && (error.stack || String(error)));
  if (ct) {
    const filas = conClase(ct.arbol, 'ct-fila');
    const conActivos = MD.filter(x => x.activos.length > 0);
    R.eq('C1 por defecto lista los deudores con prestamos activos', filas.length, conActivos.length);
    const nombres = filas.map(f => textos(f)[1]);
    const enMora = MD.filter(x => x.moraN > 0).map(x => X.properCase(x.nombre));
    R.check('C2 lo urgente primero: los deudores en mora encabezan la lista',
      nombres.slice(0, enMora.length).sort().join('|') === enMora.sort().join('|'), nombres.slice(0, 5));
    // El contrato completo del orden: en mora, cobra hoy, cobra esta semana, al dia, credito abierto.
    const pesos = nombres.map(n => X.opPesoEstado(MD.filter(x => X.properCase(x.nombre) === n)[0].estado));
    R.check('C2 y despues, por urgencia: el peso del estado nunca baja en la lista',
      pesos.every((w, i) => i === 0 || w >= pesos[i - 1]) && new Set(pesos).size >= 3, pesos);
    R.check('C2 en escritorio el primero de la lista ya esta abierto en el panel',
      conClase(ct.arbol, 'dp').length === 1 && ct.t.indexOf(X.properCase(filas.length ? nombres[0] : '')) !== -1);
    const chips = conClase(ct.arbol, 'op-filtro').map(n => textos(n).join(' '));
    R.check('C3 el filtro "En mora" cuenta 3', chips.some(c => /^En mora 3$/.test(c)), chips);
    R.check('C3 el filtro "Activos" cuenta los deudores con prestamos activos', chips.some(c => c === 'Activos ' + conActivos.length), chips);
    R.check('C4 el resumen dice lo mismo que el Resumen: en la calle y prestado',
      ct.t.indexOf(X.fmt(MR.vivo)) !== -1 && ct.t.indexOf(X.fmt(MR.prestado)) !== -1);
    // El foco (desde el Resumen o la busqueda): un deudor sin mora y uno de sus prestamos.
    const otro = MD.filter(x => x.activos.length > 0 && x.moraN === 0)[0];
    const lf = otro.activos[otro.activos.length - 1].loan;
    const ctF = montar(X.CarteraView, Object.assign({}, propsCartera, { foco: { nombre: otro.nombre, loanId: lf.id, t: 1 } }), []);
    const pestOn = conClase(ctF.arbol, 'dp-tab on');
    R.check('C5 el foco abre ESE deudor con ESE prestamo seleccionado',
      conClase(ctF.arbol, 'ct-fila on').length === 1 && textos(conClase(ctF.arbol, 'ct-fila on')[0])[1] === X.properCase(otro.nombre) &&
      pestOn.length === 1 && textos(pestOn[0]).join(' ').indexOf(X.fmt(X.modeloPrestamo(lf, lpDe(lf.id), HOY).saldo)) !== -1);
    const ctInact = montar(X.CarteraView, propsCartera, [undefined, 'inactivos']);
    R.eq('C6 el filtro "Sin préstamos activos" lista los demas', conClase(ctInact.arbol, 'ct-fila').length, MD.length - conActivos.length);
  }

  // ── D — EL PANEL DEL DEUDOR ───────────────────────────────────────────────
  R.seccion('D — el panel del deudor: acciones, cronograma y cifras');
  const mMora = mods.filter(m => m.activo && m.enMora.length > 0 && m.loan.modalidad === 'Capital + Intereses' && X.opPuedeCambiarDia(m.loan))[0];
  R.check('D0 ANTI-VACIO: el fixture tiene un C+I mensual con mora', !!mMora);
  const deudorDe = l => deudores.filter(d => d.nombre === l.nombre)[0];
  const propsPanel = (l, extra) => Object.assign({ deudor: deudorDe(l), loans, pays, hoy: HOY, focoLoan: l.id, datosPago: '', showToast: () => {}, onPay: p => pagos.push(p) }, acciones, extra || {});
  if (mMora) {
    const l = mMora.loan;
    const dp = montar(X.DeudorPanel, propsPanel(l), []);
    R.check('D1 acciones a la vista: Registrar cobro, Liquidar, Cronograma PDF y Más',
      ['Registrar cobro', 'Liquidar', 'Cronograma PDF', 'Más'].every(t => botones(dp.arbol, new RegExp('^' + t + '$')).length === 1));
    llamadasAcc.length = 0;
    botones(dp.arbol, /^Registrar cobro$/)[0].props.onClick();
    botones(dp.arbol, /^Liquidar$/)[0].props.onClick();
    R.check('D1 cobrar y liquidar abren su modal con ESE prestamo',
      llamadasAcc.map(x => x.k + ':' + x.arg.id).join('|') === 'onCobro:' + l.id + '|onLiquidar:' + l.id, llamadasAcc);
    // El menu "Más" abierto (3er useState).
    const dpMenu = montar(X.DeudorPanel, propsPanel(l), [undefined, undefined, true]);
    const menu = conClase(dpMenu.arbol, 'dp-menu')[0];
    const opciones = menu ? nodos(menu, n => n.tag === 'button').map(b => textos(b).join('')) : [];
    R.eq('D2 el menu "Más" de un C+I mensual con mora',
      opciones, ['Reestructurar cuotas', 'Cambiar día de pago', 'Condonar intereses', 'Editar datos', 'Cerrar préstamo (forzar)', 'Eliminar préstamo']);
    llamadasAcc.length = 0;
    nodos(menu, n => n.tag === 'button').forEach(b => b.props.onClick());
    R.eq('D2 cada opcion llama a su accion con ese prestamo (Eliminar, con su id)',
      llamadasAcc.map(x => x.k + ':' + (typeof x.arg === 'string' ? x.arg : x.arg.id)),
      ['onReestructurar', 'onCambiarDia', 'onCondonar', 'onEdit', 'onForceClose'].map(k => k + ':' + l.id).concat(['onDelete:' + l.id]));
    // Cronograma: las 7 columnas universales.
    const cab = conClase(dp.arbol, 'dp-crono-h')[0];
    R.eq('D3 el cronograma lleva las 7 columnas universales', cab ? textos(cab) : [], ['#', 'Vence', 'Interés', 'Abono a capital', 'Valor cuota', 'Saldo', 'Estado']);
    const moraBtn = nodos(conClase(dp.arbol, 'dp-crono-f mora')[0], n => n.tag === 'button')[0];
    pagos.length = 0;
    moraBtn.props.onClick();
    R.check('D3 el estado de una cuota sin pagar es un boton que abre su pago', pagos.length === 1 && pagos[0].id === mMora.enMora[0].id);
    R.check('D4 "Liquidar hoy" = computeLiquidacion y "En mora" = lo que falta de sus cuotas vencidas',
      dp.t.indexOf(X.fmt(X.computeLiquidacion(l, mMora.lp, {}).total)) !== -1 && dp.t.indexOf(X.fmt(mMora.moraMonto)) !== -1);
    // D8 — el Recibo de cobro general va en la CABECERA del panel: es del deudor, no del prestamo
    // que este abierto en las pestanas.
    const rgP = botones(dp.arbol, /^Recibo general$/);
    R.check('D8 la cabecera del panel ofrece "Recibo general"', rgP.length === 1 &&
      nodos(conClase(dp.arbol, 'dp-head-acc')[0], n => n.tag === 'button' && /^Recibo general$/.test(textos(n).join(''))).length === 1);
    if (rgP.length === 1) {
      FE.captura.pdfs.length = 0;
      rgP[0].props.onClick();
      R.check('D8 emite el recibo general de ese deudor', FE.captura.pdfs.length === 1 &&
        FE.captura.pdfs[0].html.indexOf('Recibo de cobro general') !== -1 && FE.captura.pdfs[0].fname === 'CG ' + l.nombre + ' - ' + HOY,
        FE.captura.pdfs.length && FE.captura.pdfs[0].fname);
    }
    // Gate por frecuencia: un semanal no ofrece "Cambiar dia" (el backend lo rechaza).
    const sem = Object.assign({}, l, { frecuencia: 'Semanal' });
    const loansSem = loans.map(x => x.id === l.id ? sem : x);
    const dpSem = montar(X.DeudorPanel, Object.assign(propsPanel(l), { loans: loansSem }), [undefined, undefined, true]);
    const opSem = nodos(conClase(dpSem.arbol, 'dp-menu')[0], n => n.tag === 'button').map(b => textos(b).join(''));
    R.check('D5 en un semanal el menu NO ofrece "Cambiar día de pago"', opSem.indexOf('Cambiar día de pago') === -1 && opSem.indexOf('Editar datos') !== -1, opSem);
  }
  // D9 — con VARIOS creditos activos el recibo general los consolida (decision del PO): el total
  // arriba y un bloque por credito.
  const activosCon = d => loans.filter(l => l.nombre === d.nombre && l.estado === 'Activo' && !X.esDiario(l));
  const dMulti = deudores.filter(d => activosCon(d).length >= 2)[0];
  R.check('D9 ANTI-VACIO: el fixture tiene un deudor con varios creditos activos', !!dMulti);
  if (dMulti) {
    const nM = activosCon(dMulti).length;
    const dpM = montar(X.DeudorPanel, propsPanel(activosCon(dMulti)[0]), []);
    FE.captura.pdfs.length = 0;
    botones(dpM.arbol, /^Recibo general$/)[0].props.onClick();
    const hM = FE.captura.pdfs.length === 1 ? FE.captura.pdfs[0].html : '';
    R.check('D9 el recibo de ' + nM + ' creditos trae un bloque por credito y su codigo lo dice',
      hM.indexOf('Crédito ' + nM + ' ·') !== -1 && hM.indexOf('Crédito ' + (nM + 1) + ' ·') === -1 && hM.indexOf('-' + nM + 'C-') !== -1);
  }
  const mDiario = mods.filter(m => m.activo && X.esDiario(m.loan))[0];
  if (mDiario) {
    const dpD = montar(X.DeudorPanel, propsPanel(mDiario.loan), [undefined, undefined, true]);
    // Un deudor sin creditos de cuotas activos no tiene nada que poner en el recibo general.
    const dDiario = deudorDe(mDiario.loan);
    R.check('D9 sin creditos de cuotas activos no se ofrece el recibo general',
      botones(dpD.arbol, /^Recibo general$/).length === (X.puedeReciboGeneral(activosCon(dDiario)) ? 1 : 0) &&
      !X.puedeReciboGeneral(activosCon(dDiario)));
    const opD = nodos(conClase(dpD.arbol, 'dp-menu')[0], n => n.tag === 'button').map(b => textos(b).join(''));
    R.check('D6 credito abierto: "Registrar corte" y su Estado de cuenta, sin "Cambiar día de pago"',
      botones(dpD.arbol, /^Registrar corte$/).length === 1 && botones(dpD.arbol, /^Estado de cuenta$/).length === 1 &&
      opD.indexOf('Cambiar día de pago') === -1, opD);
  } else R.check('D6 ANTI-VACIO: el fixture tiene un credito abierto activo', false);
  // Un prestamo cerrado se abre desde "Historial" con su resumen.
  const mCerr = mods.filter(m => !m.activo && m.recTotal > 0)[0];
  if (mCerr) {
    const dpC = montar(X.DeudorPanel, propsPanel(mCerr.loan), []);
    R.check('D7 un prestamo cerrado enfocado abre el Historial y muestra lo recibido',
      conClase(dpC.arbol, 'dp-tab hist abierto').length === 1 && dpC.t.indexOf('Total recibido') !== -1 &&
      dpC.t.indexOf(X.fmt(mCerr.recTotal)) !== -1 && botones(dpC.arbol, /^Registrar cobro$/).length === 0);
  } else R.check('D7 ANTI-VACIO: el fixture tiene un prestamo cerrado con cobros', false);

  // ── E — CAMBIAR DIA DE PAGO, CONTRA EL BACKEND REAL ───────────────────────
  R.seccion('E — Cambiar día de pago: el preview del modal contra lo que registra el backend');
  // Dos casos: alargar el ciclo (un dia posterior) y acortarlo (uno anterior, que por la regla
  // "nunca adelantar" se proyecta al mes siguiente). Uno de ellos, con mora consolidada.
  // Las dos modalidades: el C+I con mora (donde el modal calcula tambien el capital de la cuota) y
  // un Intereses sin mora.
  const tieneMora = l => lpDe(l.id).some(p => p.estadoPago === 'En Mora');
  const conMora = elegibles.filter(l => tieneMora(l) && l.modalidad === 'Capital + Intereses')[0];
  const sinMora = elegibles.filter(l => !tieneMora(l) && l.modalidad === 'Intereses')[0];
  R.check('E0 ANTI-VACIO: un elegible con mora y otro sin ella', !!conMora && !!sinMora);
  const casos = [];
  if (conMora) casos.push({ l: conMora, dia: conMora.diaPago >= 25 ? conMora.diaPago - 10 : conMora.diaPago + 3, nombre: 'con mora' });
  if (sinMora) casos.push({ l: sinMora, dia: sinMora.diaPago > 6 ? sinMora.diaPago - 5 : sinMora.diaPago + 20, nombre: 'sin mora' });
  // Bug #79: un C+I con un abono a capital. El fixture no trae ninguno elegible, asi que se crea
  // contra el server: prestamo de 6.000.000 y abono de 2.000.000 (el preview tiene que partir de
  // los 4.000.000 que quedan, como el backend).
  const postJ = async (ruta, cuerpo) => (await fetch(S.base + ruta, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) })).json();
  const nuevoAb = await postJ('/api/loans', { nombre: 'Prueba abono', cedula: '1', telefono: '1', moneda: 'COP', trmAcordada: 0, estado: 'Activo', notas: '',
    frecuencia: 'Mensual', comprasUSD: '', fechaDevolucion: '', gananciaFija: 0, montoOrigen: 6000000, montoCOP: 6000000, tasaMensual: 5, plazoMeses: 6,
    modalidad: 'Capital + Intereses', fechaInicio: '2026-07-10', diaPago: 10 });
  await postJ('/api/loans/' + nuevoAb.id + '/abono', { monto: 2000000, fecha: HOY, observaciones: '', recalcMode: 'mantener' });
  const paysAb = await traer(S, '/api/payments');
  casos.push({ l: (await traer(S, '/api/loans')).filter(x => x.id === nuevoAb.id)[0], dia: 20, nombre: 'con abono', pays: paysAb });
  for (const c of casos) {
    const l = c.l;
    const P = c.pays || pays, lpC = P.filter(p => p.prestamoId === l.id);
    const ctx = X.contextoCambioDia(l, P);
    const pv = X.previewCambioDia(l, ctx, c.dia);
    if (c.nombre === 'con abono') R.eq('E1 [con abono] el preview parte del saldo que dejo el abono (4.000.000)', ctx.saldo, 4000000);
    const md = montar(X.CambiarDiaModal, { loan: l, pays: P, onReload: () => {}, onClose: () => {} }, [String(c.dia)]);
    R.check('E1 [' + c.nombre + '] el modal muestra el preview: total ' + X.fmt(pv.primeraCuotaTotal) + ' el ' + pv.primera,
      pv.valido && md.t.indexOf(X.fmt(pv.primeraCuotaTotal)) !== -1 && md.todo.indexOf('PRIMERA CUOTA (') !== -1);
    if (c.nombre === 'con mora') R.check('E1 [con mora] y avisa que las cuotas vencidas NO cambian (3.5.0, Bug #78)',
      ctx.moraCount > 0 && md.todo.indexOf('No cambian: siguen vencidas') !== -1 && md.todo.indexOf('consolid') === -1);
    const recargas = [];
    const md2 = montar(X.CambiarDiaModal, { loan: l, pays: P, onReload: () => recargas.push(1), onClose: () => {} }, [String(c.dia)]);
    botones(md2.arbol, /^Confirmar cambio$/)[0].props.onClick();
    // El boton real: _submitGuard -> API.post (fetch del sandbox -> server de esta suite) -> setResultado.
    let r = null;
    for (let k = 0; k < 50 && !r; k++) { await new Promise(res => setTimeout(res, 20)); const x = md2.llamadas.filter(y => y.k === 1)[0]; if (x) r = x.nuevo; }
    R.check('E2 [' + c.nombre + '] el boton real publica en el backend y recarga', !!r && !r.error && recargas.length === 1, r);
    if (!r) continue;
    R.eq('E3 [' + c.nombre + '] la primera cuota que registro el backend es la del preview (fecha y total)',
      [r.primeraCuota && r.primeraCuota.fechaPago, r.primeraCuota && r.primeraCuota.cuotaTotal], [pv.primera, pv.primeraCuotaTotal]);
    R.eq('E3 [' + c.nombre + '] mismos dias e interes prorrateado', [r.diasReales, r.prorrateo], [pv.diasReales, pv.intProrrateado]);
    // La regla de 3.5.0, contra lo que quedo en la BD: el prorrateo corre desde la ultima cuota ya
    // FACTURADA (pagada o en mora), las vencidas no se tocan y el valor de liquidacion no se mueve.
    const consumidas = lpC.filter(p => !X.esAbono(p) && (p.estadoPago === 'Pagado' || p.estadoPago === 'En Mora'));
    R.eq('E3 [' + c.nombre + '] el interes corre desde la ultima cuota ya facturada', r.desde,
      consumidas.length ? consumidas.map(p => p.fechaPago).sort().pop() : (l.fechaInicioIntereses || l.fechaInicio));
    if (c.nombre === 'con mora') {
      const pDesp = (await traer(S, '/api/payments')).filter(p => p.prestamoId === l.id);
      const lDesp = (await traer(S, '/api/loans')).filter(x => x.id === l.id)[0];
      const moraAntes = lpDe(l.id).filter(p => p.estadoPago === 'En Mora');
      R.check('E3 [con mora] las cuotas vencidas siguen ahi, intactas (antes se borraban y su interes se cobraba dos veces)',
        moraAntes.length > 0 && moraAntes.every(m => { const d = pDesp.filter(x => x.id === m.id)[0];
          return d && d.estadoPago === 'En Mora' && d.cuotaTotal === m.cuotaTotal && d.interesPeriodo === m.interesPeriodo; }), moraAntes.length);
      R.eq('E3 [con mora] el valor de liquidacion no se mueve con el cambio de dia',
        X.computeLiquidacion(lDesp, pDesp, {}).total, X.computeLiquidacion(l, lpDe(l.id), {}).total);
    }
    const fin = montar(X.CambiarDiaModal, { loan: l, pays: P, onReload: () => {}, onClose: () => {} }, [String(c.dia), r]);
    R.check('E4 [' + c.nombre + '] el comprobante muestra lo registrado', fin.todo.indexOf('Día de pago actualizado') !== -1 &&
      fin.t.indexOf(X.fmt(r.primeraCuota.cuotaTotal)) !== -1);
  }
  // El caso que acorta el ciclo tiene que haber ejercido la regla "nunca adelantar": su primera
  // cuota cae DESPUES de la fecha ingenua (mismo mes, dia nuevo), y E3 ya fijo que el backend
  // registro esa misma fecha.
  const corto = casos.filter(c => c.dia < c.l.diaPago)[0];
  const ctxC = corto ? X.contextoCambioDia(corto.l, pays) : null;
  const ingenua = corto ? X.cdPayDate(corto.l.fechaBaseCronograma || corto.l.fechaInicio, ctxC.regularConsumed + 1, corto.dia) : '';
  const pvC = corto ? X.previewCambioDia(corto.l, ctxC, corto.dia) : null;
  R.check('E5 ANTI-VACIO: un caso acorta el ciclo y se proyecta al mes siguiente ("nunca adelantar")',
    !!corto && pvC.primera > ingenua, { ingenua, primera: pvC && pvC.primera });
  console.log('   casos: ' + casos.map(c => c.nombre + ' · ' + c.l.modalidad + ' · dia ' + c.l.diaPago + ' -> ' + c.dia).join(' | '));
  await cerrar(S);

  // ── F — GUARDAS ESTATICAS ─────────────────────────────────────────────────
  R.seccion('F — las vistas viejas no dejan restos');
  const leer = p => fs.readFileSync(path.join(REPO, p), 'utf8');
  R.check('F1 Deudores, Pagos y el modal del perfil ya no existen',
    ['public/js/vistas/DeudoresView.js', 'public/js/vistas/PagosView.js', 'public/js/modales/DebtorModal.js'].every(p => !fs.existsSync(path.join(REPO, p))));
  const app = leer('public/js/app.js');
  R.check('F2 el menu: Cobros y Cartera, sin Deudores ni Pagos',
    /\['cobros','check2','Cobros'\],\s*\['cartera','users','Cartera'\]/.test(app) && !/\['(deudores|pagos)',/.test(app));
  R.check('F2 App renderiza las vistas nuevas con las acciones del panel',
    /view==='cobros'\s*&& h\(CobrosView,\{[^}]*acciones:accionesOp/.test(app) && /view==='cartera'\s*&& h\(CarteraView,\{[^}]*acciones:accionesOp/.test(app));
  R.check('F2 "Cambiar dia de pago" abre su propio modal',
    /onCambiarDia:function\(l\)\{setCambioDiaModal\(\{loan:l\}\);\}/.test(app) && /cambioDiaModal&&h\(CambiarDiaModal,/.test(app));
  R.check('F2 sin rastro del perfil viejo (DebtorModal / fromDeudor en codigo)',
    !/DebtorModal|setDebtorModal/.test(app) && !/\.fromDeudor|fromDeudor:/.test(app));
  R.check('F2 abrir un deudor por nombre lleva a Cartera con el foco',
    /function openDebtorByName\(nombre,loanId,payId\)\{\s*navTo\('cartera',\{nombre:nombre/.test(app));
  // Hallado al verificar en la app real: el foco quedaba guardado y, al volver a Cartera desde el
  // menu, reabria al ultimo deudor buscado (en ventana angosta, tapando la lista).
  R.check('F2 navegar sin destino limpia el foco y el tramo (un foco viejo no reabre a nadie)',
    /if\(id==='cartera'\) setFoco\(destino\?Object\.assign\(\{t:Date\.now\(\)\},destino\):null\);/.test(app) &&
    /if\(id==='cobros'\) setTramoCobros\(destino\?\{tramo:destino,t:Date\.now\(\)\}:null\);/.test(app));
  const dash = leer('public/js/vistas/DashView.js');
  R.check('F3 el Resumen navega a las pestanas nuevas', !/onNav\('(pagos|deudores)'/.test(dash) && /onNav\('cobros', 'vencido'\)/.test(dash));
  const reglas = leer('public/css/styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
  R.check('F4 styles.css trae el maestro-detalle y el panel superpuesto en ventana angosta',
    /\.op\{display:grid/.test(reglas) && /\.dp\{/.test(reglas) && /\.cb-tramos\{/.test(reglas) && /\.ct-fila\{/.test(reglas) &&
    /@media \(max-width:1099px\)\{(?:\s*[^{}]+\{[^}]*\})*?\s*\.op-lado\.superpuesto\{position:fixed/.test(reglas));

  // ── G — LA MEMORIA DE CARTERA ─────────────────────────────────────────────
  R.seccion('G — Cartera recuerda el filtro, el orden y el deudor entre visitas');
  const filasDe  = a => conClase(a.arbol, 'ct-fila').map(f => textos(f)[1]);
  const filaOn   = a => conClase(a.arbol, 'ct-fila on').map(f => textos(f)[1]);
  const filtroOn = a => conClase(a.arbol, 'op-filtro on').map(n => textos(n)[0]);
  const ordenDe  = a => nodos(a.arbol, n => n.tag === 'select')[0].props.value;
  const tabOn    = a => conClase(a.arbol, 'dp-tab').findIndex(n => n.props.className.split(/\s+/).indexOf('on') !== -1);
  const visita   = (memoria, extra, estado) => montar(X.CarteraView, Object.assign({}, propsCartera, { memoria }, extra || {}), estado || []);
  const PC = X.properCase;
  // El deudor que se elige: en dolares, con 2 prestamos activos (la pestana del prestamo importa).
  const elegido = MD.filter(x => x.activos.length >= 2 && x.activos.every(m => m.esUSD))[0];
  const enPesos = MD.filter(x => x.activos.length > 0 && !x.activos.some(m => m.esUSD) && x.moraN === 0)[0];
  R.check('G0 ANTI-VACIO: el fixture tiene un deudor en dolares con 2 prestamos activos y uno en pesos al dia',
    !!elegido && !!enPesos, elegido && elegido.nombre);

  if (elegido && enPesos) {
    const act = elegido.activos.map(m => m.loan.id);
    // G1 — primera visita: como siempre, y lo que quedo a la vista entra en la memoria.
    const mem = {};
    const v1 = visita(mem);
    const primero = filasDe(v1)[0];
    R.check('G1 primera visita: "Activos", lo urgente primero y el primero de la lista abierto',
      filtroOn(v1).join() === 'Activos' && ordenDe(v1) === 'prioridad' && filaOn(v1).join() === primero, [filtroOn(v1), ordenDe(v1), filaOn(v1)]);
    R.check('G1 ...y la memoria guarda ese perfil: es el que el usuario tenia a la vista',
      PC(mem.sel) === primero && mem.loan === null && mem.filtro === 'activos', mem);
    R.check('G1 ANTI-TRIVIAL: el elegido NO es el primero de la lista', PC(elegido.nombre) !== primero);

    // G2 — el usuario elige: "En dolares", "Mayor saldo" y el 2o prestamo del elegido (su chip).
    const bDol = conClase(v1.arbol, 'op-filtro').filter(n => textos(n)[0] === 'En dólares')[0];
    bDol.props.onClick();
    nodos(v1.arbol, n => n.tag === 'select')[0].props.onChange({ target: { value: 'saldo' } });
    const filaEl = conClase(v1.arbol, 'ct-fila').filter(f => textos(f)[1] === PC(elegido.nombre))[0];
    const chipsEl = filaEl ? conClase(filaEl, 'ct-chip').filter(n => n.props.className.indexOf('cerrado') === -1) : [];
    if (chipsEl[1]) chipsEl[1].props.onClick({ stopPropagation: () => {} });
    R.check('G2 cada clic queda en la memoria: filtro, orden, deudor y prestamo',
      mem.filtro === 'usd' && mem.orden === 'saldo' && mem.sel === elegido.nombre && mem.loan === act[1], mem);
    R.check('G2 ...y tambien cambia lo que se ve (los setters de siempre)',
      v1.llamadas.some(c => c.k === 1 && c.nuevo === 'usd') && v1.llamadas.some(c => c.k === 2 && c.nuevo === 'saldo') &&
      v1.llamadas.some(c => c.k === 4 && c.nuevo === elegido.nombre), v1.llamadas);

    // G3 — volver a la pestana: todo como se dejo.
    const v2 = visita(mem);
    const usd = MD.filter(x => x.activos.some(m => m.esUSD)).sort((a, b) => b.saldo - a.saldo).map(x => PC(x.nombre));
    R.check('G3 al volver: "En dólares" y "Mayor saldo" siguen elegidos', filtroOn(v2).join() === 'En dólares' && ordenDe(v2) === 'saldo', [filtroOn(v2), ordenDe(v2)]);
    R.eq('G3 la lista: los deudores en dolares, de mayor a menor saldo', filasDe(v2).join('|'), usd.join('|'));
    R.check('G3 el deudor que estaba abierto sigue abierto, con su prestamo', filaOn(v2).join() === PC(elegido.nombre) && tabOn(v2) === 1, [filaOn(v2), tabOn(v2)]);

    // G4 — la pestana del prestamo, elegida dentro del panel, tambien se recuerda.
    conClase(v2.arbol, 'dp-tab')[0].props.onClick();
    R.eq('G4 elegir otro prestamo en el panel lo deja en la memoria', mem.loan, act[0]);
    const v3 = visita(mem);
    R.check('G4 ...y al volver es ese el que esta abierto', filaOn(v3).join() === PC(elegido.nombre) && tabOn(v3) === 0, [filaOn(v3), tabOn(v3)]);

    // G5 — cerrar el panel tambien se respeta: al volver no se abre nadie solo.
    const bCerrar = nodos(v3.arbol, n => n.tag === 'button' && n.props.title === 'Cerrar panel')[0];
    bCerrar.props.onClick();
    R.check('G5 cerrar el panel deja la memoria sin deudor', mem.sel === null && mem.loan === null, mem);
    const v4 = visita(mem);
    R.check('G5 al volver no se abre nadie solo', filaOn(v4).length === 0 && conClase(v4.arbol, 'dp').length === 0 &&
      v4.todo.indexOf('Elige un deudor de la lista.') !== -1);
    // Elegir una fila: deudor nuevo y SIN prestamo recordado (abre el primero de los suyos).
    conClase(v4.arbol, 'ct-fila').filter(f => textos(f)[1] === PC(elegido.nombre))[0].props.onClick();
    R.check('G5 elegir una fila recuerda al deudor y olvida el prestamo del anterior', mem.sel === elegido.nombre && mem.loan === null, mem);

    // G6 — el recordado ya no existe (p. ej. se eliminaron sus prestamos): se abre el primero.
    const memNadie = { filtro: 'activos', sel: 'NADIE CON ESTE NOMBRE', loan: 'zzz' };
    const v5 = visita(memNadie);
    R.check('G6 si el deudor recordado ya no existe, se abre el primero de la lista y la memoria se corrige',
      filaOn(v5).join() === primero && PC(memNadie.sel) === primero && memNadie.loan === null, [filaOn(v5), memNadie]);

    // G7 — el filtro recordado se quedo sin nadie (se cobro la ultima mora): cae a "Activos".
    const sinMora = deudores.filter(d => MD.filter(x => x.nombre === d.nombre)[0].moraN === 0);
    const memMora = { filtro: 'mora' };
    const v6 = visita(memMora, { deudores: sinMora });
    const actSinMora = MD.filter(x => x.moraN === 0 && x.activos.length > 0).length;
    R.check('G7 un filtro recordado que quedo vacio cae a "Activos" (su boton ya no existe)',
      filtroOn(v6).join() === 'Activos' && filasDe(v6).length === actSinMora && !conClase(v6.arbol, 'op-filtro').some(n => textos(n)[0] === 'En mora'),
      [filtroOn(v6), filasDe(v6).length, actSinMora]);
    R.check('G7 ANTI-VACIO: sin esos deudores nadie queda en mora y la lista no esta vacia', actSinMora > 0 && sinMora.length < deudores.length);

    // G8 — un foco (Resumen o busqueda) manda sobre la memoria, y la memoria lo aprende.
    const lPesos = enPesos.activos[enPesos.activos.length - 1].loan;
    const memF = { filtro: 'usd', orden: 'saldo', sel: elegido.nombre, loan: act[1] };
    const v7 = visita(memF, { foco: { nombre: enPesos.nombre, loanId: lPesos.id, t: 2 } });
    R.check('G8 con foco se abre ESE deudor, aunque la memoria tenga otro', filaOn(v7).join() === PC(enPesos.nombre), filaOn(v7));
    R.check('G8 si el deudor del foco no pasa el filtro recordado, se abre uno donde si aparece',
      filtroOn(v7).join() === 'Activos' && filasDe(v7).indexOf(PC(enPesos.nombre)) !== -1, filtroOn(v7));
    R.check('G8 la memoria queda con lo que se ve: ese deudor, ese prestamo y ese filtro (al volver por el menu no se esconde)',
      memF.sel === enPesos.nombre && memF.loan === lPesos.id && memF.filtro === 'activos' && memF.orden === 'saldo', memF);
    const memF2 = { filtro: 'usd' };
    const v8 = visita(memF2, { foco: { nombre: elegido.nombre, t: 3 } });
    R.check('G8 si el deudor del foco SI pasa el filtro recordado, el filtro se conserva', filtroOn(v8).join() === 'En dólares' && memF2.filtro === 'usd', filtroOn(v8));
  }

  // G10 — 3.7.0: la memoria SOBREVIVE AL CIERRE de la app. Se escribe a disco en cada clic
  // (`onMemoria`, que en App es `ctGuardarMemoria`) y al arrancar se lee de nuevo.
  const LS = X.localStorage, CLAVE = 'carteraMemoria';
  LS.removeItem(CLAVE);
  if (elegido && enPesos) {
    const act = elegido.activos.map(m => m.loan.id);
    const persistente = memoria => visita(memoria, { onMemoria: X.ctGuardarMemoria });
    const memA = X.ctLeerMemoria();
    R.eq('G10 sin nada guardado, la memoria arranca vacia (Cartera abre como siempre)', JSON.stringify(memA), '{}');
    const va = persistente(memA);
    conClase(va.arbol, 'op-filtro').filter(n => textos(n)[0] === 'En dólares')[0].props.onClick();
    nodos(va.arbol, n => n.tag === 'select')[0].props.onChange({ target: { value: 'saldo' } });
    const filaE = conClase(va.arbol, 'ct-fila').filter(f => textos(f)[1] === PC(elegido.nombre))[0];
    conClase(filaE, 'ct-chip').filter(n => n.props.className.indexOf('cerrado') === -1)[1].props.onClick({ stopPropagation: () => {} });
    let disco = null; try { disco = JSON.parse(LS.getItem(CLAVE)); } catch (_) {}
    R.check('G10 cada clic queda en disco: filtro, orden, deudor y prestamo',
      !!disco && disco.filtro === 'usd' && disco.orden === 'saldo' && disco.sel === elegido.nombre && disco.loan === act[1], disco);
    // EL REINICIO: un objeto NUEVO leido de disco, como al abrir la app.
    const memB = X.ctLeerMemoria();
    R.check('G10 al reiniciar, la memoria se lee de disco: objeto nuevo, mismos datos',
      memB !== memA && JSON.stringify(memB) === JSON.stringify({ filtro: 'usd', orden: 'saldo', sel: elegido.nombre, loan: act[1] }), memB);
    const vb = persistente(memB);
    R.check('G10 tras reiniciar, Cartera abre donde se dejo: "En dólares", "Mayor saldo", el deudor y su prestamo',
      filtroOn(vb).join() === 'En dólares' && ordenDe(vb) === 'saldo' && filaOn(vb).join() === PC(elegido.nombre) && tabOn(vb) === 1,
      [filtroOn(vb), ordenDe(vb), filaOn(vb), tabOn(vb)]);
    nodos(vb.arbol, n => n.tag === 'button' && n.props.title === 'Cerrar panel')[0].props.onClick();
    const vc = persistente(X.ctLeerMemoria());
    R.check('G10 el panel cerrado tambien sobrevive al reinicio', filaOn(vc).length === 0 && vc.todo.indexOf('Elige un deudor de la lista.') !== -1 &&
      filtroOn(vc).join() === 'En dólares', [filaOn(vc), filtroOn(vc)]);
  }
  // G11 — lo que se lee de disco se VALIDA: un dato viejo o corrupto nunca rompe la vista.
  LS.setItem(CLAVE, '{esto no es json');
  R.eq('G11 memoria corrupta: se ignora', JSON.stringify(X.ctLeerMemoria()), '{}');
  LS.setItem(CLAVE, JSON.stringify({ filtro: 'inexistente', orden: 'raro', sel: 42, loan: 7 }));
  R.eq('G11 valores que no existen o no son del tipo esperado: se descartan', JSON.stringify(X.ctLeerMemoria()), '{}');
  LS.setItem(CLAVE, JSON.stringify({ filtro: 'mora', orden: 'nombre', sel: 'NADIE CON ESTE NOMBRE', loan: { x: 1 } }));
  const memD = X.ctLeerMemoria();
  R.check('G11 un prestamo guardado invalido cae a null; el resto se conserva',
    memD.filtro === 'mora' && memD.orden === 'nombre' && memD.sel === 'NADIE CON ESTE NOMBRE' && memD.loan === null, memD);
  const vd = visita(memD, { onMemoria: X.ctGuardarMemoria });
  let discoD = null; try { discoD = JSON.parse(LS.getItem(CLAVE)); } catch (_) {}
  R.check('G11 si el deudor guardado ya no esta en la cartera, se abre el primero de la lista y eso queda en disco',
    filtroOn(vd).join() === 'En mora' && filaOn(vd).length === 1 && filaOn(vd)[0] === filasDe(vd)[0] && !!discoD && PC(discoD.sel) === filasDe(vd)[0],
    [filtroOn(vd), filaOn(vd), discoD]);
  LS.removeItem(CLAVE);

  // G9 — el cableado en App: la memoria vive por encima de la vista y por encima del return del
  // spinner (Bug #40: ningun hook por debajo de un return condicional).
  const iMem = app.indexOf('var memCartera=React.useRef(null);'), iLoad = app.indexOf('if(loading) return');
  const iLee = app.indexOf('if(memCartera.current===null) memCartera.current=ctLeerMemoria();');
  R.check('G9 App guarda la memoria de Cartera en un useRef, ANTES del return del spinner', iMem !== -1 && iLoad !== -1 && iMem < iLoad, { iMem, iLoad });
  R.check('G9 ...la lee de disco UNA vez, en el primer render y tambien antes del spinner (3.7.0)', iLee > iMem && iLee < iLoad, { iLee });
  R.check('G9 ...y se la pasa a la vista con el guardado a disco', /h\(CarteraView,\{[^}]*memoria:memCartera\.current,onMemoria:ctGuardarMemoria/.test(app));
  R.check('G9 el panel avisa del prestamo elegido (onLoan) y Cartera lo recuerda',
    /if \(props\.onLoan\) props\.onLoan\(x\.loan\.id\)/.test(leer('public/js/componentes/DeudorPanel.js')) &&
    /onLoan: function\(id\)\{ mem\.loan = id; guardar\(\); \}/.test(leer('public/js/vistas/CarteraView.js')));

  // ── H — EL BUSCADOR IGNORA TILDES Y LOS CODIGOS FC ─────────────────────────
  R.seccion('H — el buscador ignora tildes: "jose" = "José" (3.7.0)');
  R.eq('H1 plegar: sin tildes, sin dieresis, la enie como n y en minusculas',
    [X.plegar('José'), X.plegar('MUÑOZ'), X.plegar('Güiza'), X.plegar('ÁÉÍÓÚ'), X.plegar(null)].join('|'), 'jose|munoz|guiza|aeiou|');
  R.check('H1 "jose", "José", "JOSÉ" y "josé" encuentran a José Muñoz; "munoz" tambien',
    ['jose', 'José', 'JOSÉ', 'josé', '  jose '].every(q => X.contiene('José Muñoz', q)) && X.contiene('José Muñoz', 'munoz'));
  R.check('H1 y al reves: "José" encuentra a un "Jose" guardado sin tilde', X.contiene('Jose Munoz', 'José') && X.contiene('Jose Munoz', 'MUÑOZ'));
  R.check('H1 ANTI-TRIVIAL: no encuentra lo que no esta', !X.contiene('José Muñoz', 'maria') && !X.contiene('Ana Restrepo', 'jose'));
  // Dos deudores del fixture renombrados EN MEMORIA con tildes (el fixture es ASCII a proposito).
  const renom = { [elegido ? elegido.nombre : '']: 'José Muñoz', [enPesos ? enPesos.nombre : '']: 'Ángela Ruiz' };
  const loansT = loans.map(l => renom[l.nombre] ? Object.assign({}, l, { nombre: renom[l.nombre] }) : l);
  const paysT = pays.map(p => renom[p.nombreCliente] ? Object.assign({}, p, { nombreCliente: renom[p.nombreCliente] }) : p);
  const deudoresT = deudores.map(d => renom[d.nombre] ? Object.assign({}, d, { nombre: renom[d.nombre] }) : d);
  const propsT = Object.assign({}, propsCartera, { loans: loansT, pays: paysT, deudores: deudoresT });
  const enCartera = q => filasDe(montar(X.CarteraView, propsT, [q]));
  const busq = ['jose', 'José', 'JOSÉ', 'josé', 'munoz'].map(q => enCartera(q).join('|'));
  R.check('H2 Cartera: las cinco busquedas dan EXACTAMENTE el mismo perfil, José Muñoz',
    busq.every(b => b === 'José Muñoz'), busq);
  R.check('H2 Cartera: "angela" encuentra a Ángela Ruiz', enCartera('angela').join('|') === 'Ángela Ruiz', enCartera('angela'));
  const cuotasDe = q => paysT.filter(p => X.payMatchesQuery(p, q)).map(p => p.id).sort().join('|');
  const deJose = paysT.filter(p => p.nombreCliente === 'José Muñoz').map(p => p.id).sort().join('|');
  R.check('H3 Cobros: "jose" y "JOSÉ" filtran las mismas cuotas, todas de José Muñoz',
    deJose.length > 0 && cuotasDe('jose') === deJose && cuotasDe('JOSÉ') === deJose, [cuotasDe('jose').split('|').length, deJose.split('|').length]);
  const global = q => X.opBuscarGlobal(q, deudoresT.map(d => Object.assign({ loans: loansT.filter(l => l.nombre === d.nombre), totalSaldo: 0 }, d)), loansT, paysT)
    .map(r => r.type + ':' + r.label).join('|');
  const gs = ['jose', 'José', 'JOSÉ', 'josé'].map(global);
  R.check('H4 busqueda global: las cuatro formas devuelven lo mismo, y empieza por el deudor José Muñoz',
    gs.every(g => g === gs[0]) && gs[0].indexOf('deudor:José Muñoz') === 0, gs[0].slice(0, 120));
  R.check('H4 busqueda global: la modalidad tambien, con o sin tilde ("prestamo sin interes")',
    global('préstamo sin interés') === global('prestamo sin interes') && global('prestamo sin interes').indexOf('Préstamo sin interés') !== -1);
  R.check('H4 los autocompletados (cliente del prestamo, acreedor de la deuda) usan el mismo `contiene`',
    /clientes\.filter\(function\(c\)\{return contiene\(c\.nombre,cliQ\);\}\)/.test(leer('public/js/modales/LoanModal.js')) &&
    /existingAcreedores\.filter\(function\(n\)\{return contiene\(n,acrQ\);\}\)/.test(leer('public/js/modales/DebtModal.js')));

  R.seccion('H — codigos FC: los emitidos no cambian, los nuevos no pierden letras');
  // La regla de las cuotas COPIADA de 3.6.0. Si alguien la cambia, un papel ya entregado dejaria de
  // coincidir con lo que imprime la app.
  const fc36 = p => 'FC-' + X.properCase(String(p.nombreCliente || '')).replace(/\s+/g, '').slice(0, 2) + '-' +
    String(p.prestamoId || '').slice(-3) + '-' + String(p.cuotaN || 0).padStart(2, '0');
  const regulares = paysT.filter(p => X.esCuotaRegular(p));
  R.check('H5 el codigo de TODAS las cuotas (' + regulares.length + ') es identico al de 3.6.0, tambien con tildes',
    regulares.length > 100 && regulares.every(p => X.facturaCode(p) === fc36(p)), regulares.filter(p => X.facturaCode(p) !== fc36(p)).slice(0, 2));
  const pA = paysT.filter(p => p.nombreCliente === 'Ángela Ruiz' && X.esCuotaRegular(p))[0];
  const idA = pA ? String(pA.prestamoId).slice(-3) : '';
  R.check('H5 la cuota de Ángela conserva su tilde en el codigo: FC-Án-…', !!pA && X.facturaCode(pA).indexOf('FC-Án-' + idA) === 0, pA && X.facturaCode(pA));
  R.check('H5 y se encuentra escribiendola como sea: "fc-an-", "FC-ÁN-" o "fc-án"',
    !!pA && ['fc-an-' + idA, 'FC-ÁN-' + idA, 'fc-án'].every(q => X.payMatchesQuery(pA, q)));
  R.check('H5 ANTI-TRIVIAL: otro codigo no la encuentra', !!pA && !X.payMatchesQuery(pA, 'fc-ng-' + idA) && !X.payMatchesQuery(pA, 'fc-an-zzz'));
  const pagada = paysT.filter(p => X.esCuotaRegular(p) && p.estadoPago === 'Pagado')[0];
  const rPag = X.opBuscarGlobal(fc36(pagada), [], loansT, paysT);
  R.check('H5 la busqueda global encuentra por codigo una cuota YA PAGADA (rastrear un papel viejo)',
    rPag.some(r => r.type === 'factura' && r.data.id === pagada.id), rPag.map(r => r.label));
  // Credito abierto: el codigo lleva la fecha de emision; sus iniciales salian sin tilde.
  const ld = loansT.filter(l => X.esDiario(l))[0];
  const ldA = Object.assign({}, ld, { nombre: 'Ángela Ruiz' }), idD = String(ld.id).slice(-3), H = '2026-11-06';
  const diario36 = (l, hasta) => 'FC-' + (String(l.nombre || '').trim().replace(/[^A-Za-z]/g, '').slice(0, 2) || 'XX') + '-' +
    String(l.id).slice(-3) + '-' + hasta.slice(8, 10) + hasta.slice(5, 7);
  R.eq('H6 credito abierto: el codigo NUEVO conserva la tilde', X.fcCodigoDiario(ldA, H), 'FC-Án-' + idD + '-0611');
  R.eq('H6 ...el de 3.6.0 la perdia (es el que esta en los papeles viejos)', diario36(ldA, H), 'FC-ng-' + idD + '-0611');
  R.check('H6 los dos se encuentran: el papel viejo, el nuevo, y escrito sin tilde o sin fecha',
    [diario36(ldA, H), X.fcCodigoDiario(ldA, H), 'fc-an-' + idD, 'FC-ÁN-' + idD + '-06', 'fc-ng-' + idD].every(q => X.fcCoincideDiario(ldA, q)));
  R.check('H6 ANTI-TRIVIAL: no coincide con otro credito ni con una fecha mal formada',
    !X.fcCoincideDiario(ldA, 'fc-an-zzz') && !X.fcCoincideDiario(ldA, 'fc-an-' + idD + '-061199') && !X.fcCoincideDiario(ldA, 'jose'));
  R.eq('H6 sin tildes en el nombre, el codigo del credito abierto no cambia', X.fcCodigoDiario(ld, H), diario36(ld, H));
  FE.captura.pdfs.length = 0;
  X.generateFacturaCobroDiario(ldA, paysT, '', { hasta: H });
  const htmlD = FE.captura.pdfs[0] ? FE.captura.pdfs[0].html : '';
  R.check('H6 la factura del credito abierto imprime el codigo nuevo', htmlD.indexOf('FC-Án-' + idD + '-0611') !== -1 && htmlD.indexOf('FC-ng-') === -1, htmlD.length);
  const rD = X.opBuscarGlobal(diario36(ldA, H), [], [ldA], []);
  R.check('H6 la busqueda global lleva del papel viejo al credito', rD.length === 1 && rD[0].type === 'prestamo' && rD[0].data.id === ld.id, rD.map(r => r.label));

  // ── I — ORTOGRAFIA EN EL RESTO DE LA INTERFAZ ──────────────────────────────
  R.seccion('I — ortografia: modales y vistas sin palabras sin tilde (3.7.0)');
  // Las formas SIN tilde de palabras que siempre la llevan en la interfaz. `\b` es ASCII: "días" no la
  // dispara (la í no es letra para el regex), "dias" si.
  const SIN_TILDE = /\b(dias?|creditos?|prestamos?|interes|despues|proxim[oa]s?|ultim[oa]s?|numero|telefono|cedula|liquidacion|operacion|condonacion|reestructuracion|accion|informacion|automaticamente|tambien|ademas|version|validos?|invalid[oa]s?|dolares|maximo|minimo|saldaria|quedaria|podra|codigo|titulo|seccion|ubicacion|boton|imputacion|amortizacion|unico|descripcion|transaccion|configuracion|edicion|eliminacion|recalculo)\b/i;
  const lC = mods.filter(m => m.activo && m.loan.modalidad === 'Capital + Intereses' && m.enMora.length > 0)[0].loan;
  const lpC = lpDe(lC.id), cuotaC = lpC.filter(p => X.esCuotaRegular(p) && p.estadoPago !== 'Pagado')[0];
  const deuda = { id: 'd1', titulo: 'Compra del carro', acreedor: 'Banco', concepto: 'Cuota inicial', monto_original: 1000000,
    saldo_pendiente: 500000, estado: 'Activa', fecha_creacion: '2026-07-01', total_cargos: 0, total_abonos: 500000 };
  const nada = () => {};
  const PANTALLAS = [
    ['LoanModal (nuevo)', X.LoanModal, { loan: null, trm: 4000, pays: [], clientes: [], onSave: nada, onClose: nada }],
    ['LoanModal (editar)', X.LoanModal, { loan: lC, trm: 4000, pays: lpC, clientes: [], onSave: nada, onClose: nada }],
    ['PayModal', X.PayModal, { pay: cuotaC, loan: lC, allPays: pays, onMark: nada, onPartial: nada, onClose: nada }],
    ['AbonoModal', X.AbonoModal, { loan: lC, pays: lpC, onSave: nada, onClose: nada, onRequestLiquidar: nada }],
    ['CobroModal', X.CobroModal, { loan: lC, pays: lpC, onConfirm: nada, onClose: nada, onRequestLiquidar: nada }],
    ['CronogramaPdfModal', X.CronogramaPdfModal, { loan: lC, pays: lpC, onClose: nada }],
    ['CambiarDiaModal', X.CambiarDiaModal, { loan: lC, pays: lpC, onReload: nada, onClose: nada }],
    ['DeudorPanel', X.DeudorPanel, Object.assign({ deudor: deudores.filter(d => d.nombre === lC.nombre)[0], loans, pays, hoy: HOY, focoLoan: lC.id,
      datosPago: '', showToast: nada, onPay: nada }, acciones)],
    ['LiquidarModal', X.LiquidarModal, { loan: lC, pays: lpC, datosPago: '', onConfirm: nada, onClose: nada }],
    ['RestructureModal', X.RestructureModal, { loan: lC, pays: lpC, onSave: nada, onClose: nada }],
    ['CondonarModal', X.CondonarModal, { loan: lC, pays: lpC, onConfirm: nada, onClose: nada }],
    ['CorteModal', X.CorteModal, { loan: ld, pays: lpDe(ld.id), onSave: nada, onClose: nada }],
    ['PreflightMoraModal', X.PreflightMoraModal, { loan: lC, cuotas: [cuotaC], onCancel: nada, onContinue: nada, onMarkMora: nada }],
    ['DebtModal', X.DebtModal, { debt: null, existingAcreedores: ['Banco'], onSave: nada, onClose: nada }],
    ['DebtPayModal', X.DebtPayModal, { debt: deuda, onSave: nada, onClose: nada }],
    ['DeleteDebtModal', X.DeleteDebtModal, { debt: deuda, onConfirm: nada, onClose: nada }],
    ['ConfirmUndoModal', X.ConfirmUndoModal, { entry: { id: 'u1', accion: 'abono', descripcion: 'Abono de prueba', created_at: '2026-07-29 10:00:00',
      afecta_caja: 1, scope_tipo: 'loan', estado: 'disponible' }, onConfirm: nada, onClose: nada }],
    ['HistorialView', X.HistorialView, { actLog: ['prestamo', 'edicion', 'eliminacion', 'abono', 'reestructuracion', 'cambio-fecha', 'condonacion', 'deuda']
      .map((t, i) => ({ id: i, fecha: '2026-07-30 10:00:00', tipo: t, mensaje: 'Movimiento de prueba', undo_id: null })), undoLog: [], onRefresh: nada, onUndo: nada }],
    ['PortfolioView', X.PortfolioView, { loans, pays }],
    ['CalcView', X.CalcView, { onConfirm: nada }],
    ['DevView', X.DevView, { loans, pays, datosPago: '', isMac: false, showToast: nada, onSaveConfig: nada, onSync: nada, onConfirm: nada, onNeedsRestart: nada }],
    ['DebtsView', X.DebtsView, { debts: [deuda], onNew: nada, onEdit: nada, onPay: nada, onDelete: nada, onReload: nada }],
  ];
  const malas = [];
  let vistas = 0, textosI = '';
  for (const [nom, Comp, pr] of PANTALLAS) {
    let v = null, err = null;
    try { v = montar(Comp, pr, []); } catch (e) { err = e; }
    if (!v) { malas.push(nom + ': ' + (err && err.message)); continue; }
    vistas++;
    textosI += ' ' + v.t.join(' ');
    v.t.filter(s => SIN_TILDE.test(s)).forEach(s => malas.push(nom + ': "' + s.trim().slice(0, 80) + '"'));
  }
  R.check('I1 las ' + PANTALLAS.length + ' pantallas se renderizan sin excepciones', vistas === PANTALLAS.length, malas.filter(m => /: (?!")/.test(m)));
  R.check('I2 ninguna muestra una palabra sin su tilde', malas.length === 0, malas.slice(0, 12));
  R.check('I2 ANTI-VACIO: el guardian leyo texto de verdad (rotulos con tilde de las pantallas viejas)',
    ['Cédula', 'Teléfono', 'Tú eliges', 'Edición', 'Reestructuración', 'Valor de liquidación'].every(w => textosI.indexOf(w) !== -1),
    ['Cédula', 'Teléfono', 'Tú eliges', 'Edición', 'Reestructuración', 'Valor de liquidación'].filter(w => textosI.indexOf(w) === -1));
  R.check('I2 ANTI-TRIVIAL: el guardian detecta "Interes Diario" y "credito", y deja pasar "Interés diario"',
    SIN_TILDE.test('Interes Diario') && SIN_TILDE.test('el credito') && !SIN_TILDE.test('Interés diario · días · crédito · Más'));

  // ── J — LA CIFRA EN DOLARES (3.7.0, opcion A del PO) ──────────────────────
  // El dolar junto a los pesos va en tinta secundaria (`.dp-usd`) con su codigo "US$" en terciaria
  // (`.usd-c`, de `componentes/CifraUSD.js`). Se montan las pantallas de un prestamo EN DOLARES y se exige:
  //   J1 ningun importe "USD $" pintado con el azul en linea (el de abonos, parciales y enlaces);
  //   J2 toda sub-linea `.dp-usd` lleva el codigo "US$" en su pieza y ya no dice "USD $";
  //   J3 el anti-vacio: las pantallas de verdad tienen cifras en dolares;
  //   J4 la hoja de estilos: la sub-linea no es azul y en Cobros no hereda el tamano de los pesos;
  //   J5 el ayudante: parte el importe sin perder lo que lo rodea, y no toca un texto que no lo es.
  R.seccion('J — la cifra en dolares: tinta secundaria y "US$" tenue, sin azul (3.7.0)');
  const lU = loans.filter(l => l.id === '1782151590658w66y')[0];
  R.check('J0 ANTI-VACIO: el fixture tiene el C+I en dolares con mora', !!lU && lU.moneda === 'USD');
  if (lU) {
    const lpU = lpDe(lU.id);
    const moraU = lpU.filter(p => X.esCuotaRegular(p) && p.estadoPago === 'En Mora')[0] || lpU.filter(p => X.esCuotaRegular(p) && p.estadoPago !== 'Pagado')[0];
    const nadaJ = () => {};
    const USD_PANTALLAS = [
      ['DeudorPanel', X.DeudorPanel, propsPanel(lU)],
      ['CarteraView', X.CarteraView, propsCartera],
      ['CobrosView', X.CobrosView, propsCobros],
      ['PortfolioView', X.PortfolioView, { loans, pays }],
      ['PayModal', X.PayModal, { pay: moraU, loan: lU, allPays: pays, onMark: nadaJ, onPartial: nadaJ, onClose: nadaJ }],
      ['AbonoModal', X.AbonoModal, { loan: lU, pays: lpU, onSave: nadaJ, onClose: nadaJ, onRequestLiquidar: nadaJ }],
      ['RestructureModal', X.RestructureModal, { loan: lU, pays: lpU, onSave: nadaJ, onClose: nadaJ }],
      ['LiquidarModal', X.LiquidarModal, { loan: lU, pays: lpU, datosPago: '', onConfirm: nadaJ, onClose: nadaJ }],
      ['CronogramaPdfModal', X.CronogramaPdfModal, { loan: lU, pays: lpU, onClose: nadaJ }],
      ['CambiarDiaModal', X.CambiarDiaModal, { loan: lU, pays: lpU, onReload: nadaJ, onClose: nadaJ }],
      ['PreflightMoraModal', X.PreflightMoraModal, { loan: lU, cuotas: [moraU], onCancel: nadaJ, onContinue: nadaJ, onMarkMora: nadaJ }],
    ];
    const azules = [], subMalas = [], porPantalla = {};
    let errores = [];
    for (const [nom, Comp, pr] of USD_PANTALLAS) {
      let v = null;
      try { v = montar(Comp, pr, []); } catch (e) { errores.push(nom + ': ' + e.message); continue; }
      nodos(v.arbol, n => !!(n.props && n.props.style && n.props.style.color === 'var(--blue)'))
        .filter(n => /USD \$\d/.test(n.kids.filter(k => typeof k === 'string').join('')))
        .forEach(n => azules.push(nom + ': ' + n.kids.filter(k => typeof k === 'string').join('').slice(0, 40)));
      const subs = conClase(v.arbol, 'dp-usd');
      porPantalla[nom] = subs.length;
      subs.forEach(n => {
        const cod = nodos(n, x => !!(x.props && x.props.className === 'usd-c'));
        const txt = textos(n).join('');
        if (cod.length !== 1 || textos(cod[0]).join('') !== 'US$' || /USD \$/.test(txt)) subMalas.push(nom + ': "' + txt.slice(0, 40) + '"');
      });
    }
    R.check('J0 las ' + USD_PANTALLAS.length + ' pantallas de un prestamo en dolares se renderizan', errores.length === 0, errores);
    R.check('J1 ningun importe "USD $" queda pintado de azul', azules.length === 0, azules.slice(0, 8));
    R.check('J2 toda sub-linea en dolares lleva el codigo "US$" en su pieza (y ya no "USD $")', subMalas.length === 0, subMalas.slice(0, 8));
    R.check('J3 ANTI-VACIO: el panel muestra 20+ cifras en dolares y Cartera, Cobros y Rendimiento las suyas',
      porPantalla.DeudorPanel >= 20 && porPantalla.CarteraView >= 1 && porPantalla.CobrosView >= 1 && porPantalla.PortfolioView >= 1, porPantalla);
    // (Cambiar dia de pago solo muestra dolares cuando ya hay un dia elegido: entra en J1/J2, no aqui.)
    R.check('J3 ANTI-VACIO: los modales del prestamo tambien (abono, reestructurar, liquidar, cronograma, pre-flight, pago)',
      ['AbonoModal', 'RestructureModal', 'LiquidarModal', 'CronogramaPdfModal', 'PreflightMoraModal', 'PayModal'].every(k => porPantalla[k] >= 1), porPantalla);
  }
  const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'css', 'styles.css'), 'utf8');
  const regla = sel => { const m = new RegExp('(^|\\n)' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\{([^}]*)\\}').exec(css); return m ? m[2] : null; };
  R.check('J4 la sub-linea en dolares y la marca USD no usan el azul', !!regla('.dp-usd') && !/--blue/.test(regla('.dp-usd')) &&
    !!regla('.dp-usdtag') && !/--blue/.test(regla('.dp-usdtag')) && !/\.rz-chip\.usd/.test(css), [regla('.dp-usd'), regla('.dp-usdtag')]);
  R.check('J4 en Cobros la sub-linea no hereda el tamano ni la negrita de los pesos (venia a 14,5 px)',
    /font-size:11px/.test(regla('.cb-monto .dp-usd') || '') && /font-weight:500/.test(regla('.cb-monto .dp-usd') || '') &&
    css.indexOf('.cb-monto .dp-usd{') > css.indexOf('.cb-monto .mono{'), regla('.cb-monto .dp-usd'));
  const pz = X.usdPiezas('+USD $1,647.22 en dólares');
  R.check('J5 el ayudante parte el importe y conserva el signo y lo que sigue',
    Array.isArray(pz) && pz[0] === '+' && pz[1].props.className === 'usd-c' && pz[2] === '1,647.22 en dólares', pz);
  R.check('J5 ANTI-TRIVIAL: un texto que no es un importe en dolares queda intacto',
    X.usdPiezas('$ 1.200.000') === '$ 1.200.000' && X.usdPiezas(null) === '');

  // ── K — HISTORIAL (3.7.0) ────────────────────────────────────────────────
  // Rediseno pedido por el PO: el historial completo, agrupado por dia, con busqueda (sin tildes) y
  // filtros por periodo y tipo. El candado LIFO del boton Deshacer no cambia.
  R.seccion('K — Historial: dia por dia, busqueda, periodo, tipo y el candado de Deshacer (3.7.0)');
  R.check('K0 ANTI-VACIO: el historial completo trae mas que las 100 de siempre, y las incluye',
    historial.length > 100 && historial100.length === 100 && historial100.every((r, i) => r.id === historial[i].id), historial.length);
  const diaK = it => String(it.fecha).slice(0, 10);
  const navK = [];
  const propsK = { actLog: historial, undoLog: journal, loans, onUndo: () => {}, onRefresh: () => {}, onNameClick: n => navK.push(n) };
  // Clase exacta: `\b` corta en el guion, y `hs-dia` tambien encontraria a `hs-dia-n`.
  const conClaseK = c => n => ((n.props && typeof n.props.className === 'string') ? n.props.className.split(/\s+/) : []).indexOf(c) !== -1;
  const filasK = arbol => nodos(arbol, conClaseK('hs-fila'));
  const diasK = arbol => nodos(arbol, conClaseK('hs-dia')).map(d => textos(d)[0]);
  // Estado sembrado por posicion: q, periodo, desde, hasta, grupo, limite.
  const hist = (estado) => montar(X.HistorialView, propsK, estado || []);
  let hk = null, errK = null;
  try { hk = hist(); } catch (e) { errK = e; }
  R.check('K1 la vista se renderiza con el historial completo', !!hk, errK && (errK.stack || String(errK)));
  if (hk) {
    const f0 = filasK(hk.arbol);
    R.eq('K2 muestra de a 120 acciones, y avisa cuantas quedan', f0.length, Math.min(120, historial.length));
    R.check('K2 "Ver más" con las restantes', hk.todo.indexOf('Ver más (' + (historial.length - 120) + ' restantes)') !== -1);
    const diasEsperados = []; historial.slice(0, 120).forEach(it => { if (diasEsperados.indexOf(diaK(it)) === -1) diasEsperados.push(diaK(it)); });
    R.eq('K3 agrupa por dia, del mas reciente al mas viejo (un encabezado por dia)', diasK(hk.arbol), diasEsperados.map(d => X.hsDia(d, HOY)));
    R.check('K3 los rotulos del dia: Hoy, Ayer, el dia de la semana y el año si no es el actual',
      X.hsDia(HOY, HOY) === 'Hoy' && X.hsDia('2026-07-30', HOY) === 'Ayer' && X.hsDia('2026-07-28', HOY) === 'martes 28 de julio' &&
      X.hsDia('2025-12-01', HOY) === 'lunes 1 de diciembre de 2025');
    R.check('K3 cada accion lleva su hora', f0.slice(0, 5).every((f, i) => textos(f)[0] === historial[i].fecha.slice(11, 16)), f0.slice(0, 3).map(f => textos(f)[0]));
    // Busqueda sin tildes ni mayusculas: "PRÉSTAMO" encuentra "Nuevo prestamo: ...".
    const hq = hist(['PRÉSTAMO', undefined, undefined, undefined, undefined, 1000]);
    R.check('K4 la busqueda ignora tildes y mayusculas: todo lo que muestra "PRÉSTAMO" lo contiene',
      filasK(hq.arbol).length > 0 && filasK(hq.arbol).every(f => X.contiene(textos(f).join(' '), 'prestamo')), filasK(hq.arbol).length);
    const sinTildeK = historial.filter(it => /prestamo/i.test(it.mensaje));
    R.check('K4 ANTI-VACIO: hay ' + sinTildeK.length + ' mensajes guardados con "prestamo" SIN tilde, y la busqueda los encuentra todos',
      sinTildeK.length > 0 && sinTildeK.every(it => hq.todo.indexOf(it.mensaje) !== -1), sinTildeK.length);
    const hNada = hist(['zzzz-no-existe']);
    R.check('K4 sin coincidencias: lo dice y ofrece volver a todo el historial',
      filasK(hNada.arbol).length === 0 && hNada.todo.indexOf('Nada coincide') !== -1 && hNada.todo.indexOf('Ver todo el historial') !== -1);
    // Periodo.
    const enRango = (a, b) => historial.filter(it => diaK(it) >= a && diaK(it) <= b);
    const casosP = [['hoy', HOY, HOY], ['7', X.addDays(HOY, -6), HOY], ['30', X.addDays(HOY, -29), HOY], ['mes', HOY.slice(0, 8) + '01', HOY]];
    const malasP = casosP.filter(c => filasK(hist([undefined, c[0], undefined, undefined, undefined, 5000]).arbol).length !== enRango(c[1], c[2]).length)
      .map(c => c[0] + ': ' + enRango(c[1], c[2]).length);
    R.check('K5 los periodos (hoy, 7 dias, 30 dias, este mes) cuentan exactamente las acciones de esas fechas', malasP.length === 0, malasP);
    R.check('K5 ANTI-VACIO: cada periodo de prueba tiene acciones', casosP.every(c => enRango(c[1], c[2]).length > 0), casosP.map(c => enRango(c[1], c[2]).length));
    const hR = hist([undefined, 'rango', '2026-04-01', '2026-04-30', undefined, 5000]);
    R.eq('K5 un rango de fechas elegido (abril) muestra solo esas acciones', filasK(hR.arbol).length, enRango('2026-04-01', '2026-04-30').length);
    R.check('K5 y sus dias quedan dentro del rango', diasK(hR.arbol).length > 0 && diasK(hR.arbol).every(d => / de abril$/.test(d)), diasK(hR.arbol));
    // Los BORDES de cada periodo: el fixture no tiene acciones justo el dia que separa "entra" de "no entra"
    // (un "7 dias" que tomara 8 pasaba en verde). Se arma un historial con una accion en el primer dia que
    // entra y otra en el primero que no, para cada periodo.
    const bordes = [['hoy', HOY, X.addDays(HOY, -1)], ['7', X.addDays(HOY, -6), X.addDays(HOY, -7)],
      ['30', X.addDays(HOY, -29), X.addDays(HOY, -30)], ['mes', HOY.slice(0, 8) + '01', X.addDays(HOY.slice(0, 8) + '01', -1)]];
    const malasB = bordes.filter(bd => {
      const log = [{ id: 2, fecha: bd[1] + ' 08:00:00', tipo: 'pago', mensaje: 'Entra', undo_id: null },
                   { id: 1, fecha: bd[2] + ' 23:59:00', tipo: 'pago', mensaje: 'No entra', undo_id: null }];
      const v = montar(X.HistorialView, { actLog: log, undoLog: [], onUndo: () => {}, onRefresh: () => {} }, [undefined, bd[0]]);
      const t = filasK(v.arbol).map(f => textos(f).join(' '));
      return !(t.length === 1 && t[0].indexOf('Entra') !== -1);
    }).map(bd => bd[0]);
    R.check('K5 los bordes: el primer dia del periodo entra y el anterior no (hoy, 7 dias, 30 dias, este mes)', malasB.length === 0, malasB);
    // Tipo.
    const GRUPO = { pago: 'cobros', abono: 'cobros', deuda: 'deudas', deshacer: 'deshacer' };
    const grupoDe = it => GRUPO[it.tipo] || 'prestamos';
    const casosT = ['cobros', 'prestamos', 'deudas', 'deshacer'];
    const malasT = casosT.filter(g => filasK(hist([undefined, undefined, undefined, undefined, g, 5000]).arbol).length !== historial.filter(it => grupoDe(it) === g).length)
      .map(g => g + ': ' + historial.filter(it => grupoDe(it) === g).length);
    R.check('K6 el filtro por tipo (cobros, prestamos, mis deudas, deshechos) muestra solo ese tipo', malasT.length === 0, malasT);
    const chips = nodos(hk.arbol, n => n.tag === 'button' && /\bhs-filtro\b/.test(n.props.className || '')).map(b => textos(b).join(''));
    R.check('K6 cada tipo con su conteo', casosT.every((g, i) => chips.indexOf(['Cobros', 'Préstamos', 'Mis deudas', 'Deshechos'][i] + historial.filter(it => grupoDe(it) === g).length) !== -1) &&
      chips.indexOf('Todo' + historial.length) !== -1, chips);
    // "Ver en Cartera" cuando la accion nombra a un deudor (no en Mis Deudas).
    const conDeudor = f0.filter(f => nodos(f, n => n.tag === 'button' && /Ver en Cartera/.test(textos(n).join(''))).length);
    R.check('K7 "Ver en Cartera" aparece en las acciones que nombran a un deudor', conDeudor.length > 0, conDeudor.length);
    const iDeuda = historial.slice(0, 120).findIndex(it => it.tipo === 'deuda');
    R.check('K7 y no en las de Mis Deudas (alli el nombre es un acreedor)', iDeuda === -1 ||
      nodos(f0[iDeuda], n => n.tag === 'button' && /Ver en Cartera/.test(textos(n).join(''))).length === 0);
    navK.length = 0;
    const btnC = nodos(conDeudor[0], n => n.tag === 'button' && /Ver en Cartera/.test(textos(n).join('')))[0];
    btnC.props.onClick();
    R.check('K7 el clic abre a ese deudor en Cartera', navK.length === 1 && loans.some(l => l.nombre === navK[0]) &&
      X.contiene(textos(conDeudor[0]).join(' '), navK[0]), navK);
  }
  // El candado LIFO: dos acciones del mismo prestamo -> solo la mas reciente se puede deshacer; la otra
  // explica por que; una ya deshecha sale tachada con "Revertida".
  const actL = [
    { id: 3, fecha: '2026-07-31 10:00:00', tipo: 'abono', mensaje: 'Registraste abono de $50,000 a prueba', undo_id: 'u3' },
    { id: 2, fecha: '2026-07-31 09:00:00', tipo: 'pago', mensaje: 'Registraste pago de prueba', undo_id: 'u2' },
    { id: 1, fecha: '2026-07-30 09:00:00', tipo: 'abono', mensaje: 'Abono revertido de prueba', undo_id: 'u1' }];
  const undoL = [
    { id: 'u3', estado: 'disponible', scope_tipo: 'loan', scope_id: 'L1', descripcion: 'Abono de $50.000' },
    { id: 'u2', estado: 'disponible', scope_tipo: 'loan', scope_id: 'L1', descripcion: 'Pago de prueba' },
    { id: 'u1', estado: 'deshecho', scope_tipo: 'loan', scope_id: 'L1', descripcion: 'Abono viejo' }];
  const deshechos = [];
  const hL = montar(X.HistorialView, { actLog: actL, undoLog: undoL, onUndo: u => deshechos.push(u.id), onRefresh: () => {} }, []);
  const fl = filasK(hL.arbol);
  const btnD = f => nodos(f, n => n.tag === 'button' && /Deshacer/.test(textos(n).join('')))[0];
  R.check('K8 solo la accion mas reciente del prestamo se puede deshacer', !!btnD(fl[0]) && !btnD(fl[0]).props.disabled && !!btnD(fl[1]) && btnD(fl[1]).props.disabled);
  btnD(fl[0]).props.onClick();
  R.check('K8 el boton activo pide deshacer esa misma accion', deshechos.join() === 'u3', deshechos);
  R.check('K8 la bloqueada explica cual deshacer primero', textos(fl[1]).join(' ').indexOf('Primero debes deshacer la operación más reciente de este préstamo: "Abono de $50.000"') !== -1);
  R.check('K8 la ya deshecha sale con "Revertida" y sin boton', /\brevertida\b/.test(fl[2].props.className) && textos(fl[2]).join(' ').indexOf('Revertida') !== -1 && !btnD(fl[2]));
  // App le pasa el historial completo y la navegacion.
  const appK = fs.readFileSync(path.join(REPO, 'public', 'js', 'app.js'), 'utf8');
  R.check('K9 App pide el historial completo y le pasa a la vista los prestamos y la navegacion a Cartera',
    appK.indexOf("fetch('/api/activity?todo=1')") !== -1 && /h\(HistorialView,\{[^}]*loans:loans,onNameClick:openDebtorByName/.test(appK));

  process.exit(R.finalizar());
})().catch(e => { console.error(e); process.exit(1); });
