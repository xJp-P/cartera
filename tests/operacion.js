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
  let loans, pays;
  try {
    // GET /api/payments corre la auto-mora a la fecha congelada: es el estado que ve la app.
    loans = await traer(S, '/api/loans');
    pays  = await traer(S, '/api/payments');
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

  process.exit(R.finalizar());
})().catch(e => { console.error(e); process.exit(1); });
