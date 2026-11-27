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
  // El rediseño v4 (fase 2 de la integracion): mismos datos y mismo comportamiento que la vista de
  // 3.5.0, con clases `cbv-`. Las cifras grandes cuentan desde 0 al montarse y el arnes no corre
  // efectos: se pinta con la ventana "oculta", el caso en que la vista muestra el valor final.
  R.seccion('B — la vista Cobros (rediseño v4) renderizada');
  X.document.hidden = true;
  const sinPeso = v => String(v).replace(/^-?\$\s*/, '');
  const llamadasAcc = [];
  const acciones = {};
  ['onCobro', 'onCorte', 'onLiquidar', 'onReestructurar', 'onCambiarDia', 'onCondonar', 'onCongelar', 'onDescongelar', 'onEdit', 'onDelete', 'onForceClose', 'onNewLoan']
    .forEach(k => { acciones[k] = arg => llamadasAcc.push({ k, arg }); });
  // El recibo general (post-4.0.0, punto 4): el boton le pide a App `onReciboGeneral(nombre, prestamos)`.
  const llamadasRG = [];
  acciones.onReciboGeneral = (nombre, ls) => llamadasRG.push({ nombre, ls });
  // Lo que hace App con esa llamada: `abrirReciboGeneral` decide si pregunta; si pregunta, el modal
  // REAL (con las casillas que se le pasen) y su boton "Generar el recibo". Devuelve si se abrio.
  const rgEmitir = (ls, marcas) => {
    let abrio = false;
    X.abrirReciboGeneral(ls, pays, HOY, '', () => { abrio = true; });
    if (abrio) {
      const mo = montar(X.ReciboGeneralModal, { deudor: 'x', hoy: HOY, loans: ls, pays, onClose: () => {},
        onGenerar: o => X.generateReciboGeneral(ls, pays, '', o) }, [marcas || {}]);
      botones(mo.arbol, /Generar el recibo/)[0].props.onClick();
    }
    return abrio;
  };
  const pagos = [];
  const propsCobros = { loans, pays, deudores, hoy: HOY, acciones, onPay: p => pagos.push(p), datosPago: '', showToast: () => {} };
  let cb = null, error = null;
  try { cb = montar(X.CobrosView, propsCobros, []); } catch (e) { error = e; }
  R.check('B1 la vista se renderiza sin excepciones', !!cb, error && (error.stack || String(error)));
  if (cb) {
    const TRAMOS = ['vencido', 'hoy', 'semana', 'mes', 'despues'];
    const tarjetas = conClase(cb.arbol, 'cbv-tramo');
    R.eq('B1 cinco tarjetas de tramo', tarjetas.length, 5);
    const valorTramo = t => { const n = tarjetas[TRAMOS.indexOf(t)]; return n ? textos(n).join('|') : ''; };
    R.check('B1 cada tarjeta muestra el total de su tramo (en orden: vencido, hoy, 7 dias, este mes, mas adelante)',
      TRAMOS.every(t => valorTramo(t).indexOf(sinPeso(X.fmt(totTramo(t)))) !== -1),
      TRAMOS.map(valorTramo));
    // Lo vencido se agrupa por credito: un grupo por prestamo con 2+ cuotas vencidas.
    const porLoan = {};
    tramo('vencido').forEach(f => { porLoan[f.l.id] = (porLoan[f.l.id] || 0) + 1; });
    const conVarias = Object.keys(porLoan).filter(id => porLoan[id] > 1);
    const grupos = conClase(cb.arbol, 'cbv-grupo');
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
    const cabG = conClase(grupoG, 'cbv-grupo-h')[0];
    const chevG = conClase(cabG, 'cbv-chev')[0];
    R.check('B2 acordeon plegado por defecto: el grupo no muestra sus cuotas (y su chevron lo dice)',
      conClase(grupoG, 'cbv-grupo-cuotas').length === 0 && !!chevG && chevG.tag === 'button' && chevG.props['aria-expanded'] === false &&
      !/\babierto\b/.test(grupoG.props.className));
    const txtG = textos(cabG).join(' ');
    R.check('B2 su fila: cuantas cuotas, cuanto suman y los dias de la mas vieja',
      txtG.indexOf(fsG.length + ' cuotas vencidas') !== -1 && txtG.indexOf(X.fmt(suma(fsG, f => f.pend))) !== -1 &&
      txtG.indexOf((-fsG[0].dias) + ' días de mora') !== -1, txtG);
    // Dos clics distintos (ajuste del PO en la integracion): el chevron SOLO pliega o despliega, y no deja
    // que su clic llegue a la fila; el resto de la fila abre al deudor en el panel, sin tocar el acordeon.
    const grupoDe = r => conClase(r.arbol, 'cbv-grupo').filter(g => textos(g).join(' ').indexOf(X.properCase(loanMap[idG].nombre)) !== -1)[0];
    const r0 = montar(X.CobrosView, propsCobros, []);
    let corto = 0;
    conClase(grupoDe(r0), 'cbv-chev')[0].props.onClick({ stopPropagation: () => { corto++; } });
    R.check('B2 un clic en el chevron despliega las cuotas y NO abre al deudor',
      r0.llamadas.some(x => x.k === 7 && x.nuevo[idG] === true) && !r0.llamadas.some(x => x.k === 3) && corto === 1, { llamadas: r0.llamadas, corto });
    const r0b = montar(X.CobrosView, propsCobros, []);
    conClase(grupoDe(r0b), 'cbv-grupo-h')[0].props.onClick();
    R.check('B2 un clic en el resto de la fila abre al deudor en el panel y NO toca el acordeon',
      r0b.llamadas.some(x => x.k === 3 && x.nuevo.loanId === idG && x.nuevo.payId === null) && !r0b.llamadas.some(x => x.k === 7), r0b.llamadas);
    R.check('B2 el chevron es el unico boton de la fila que pliega (el "Cobrar" y el recibo siguen aparte)',
      conClase(grupoDe(r0b), 'cbv-grupo-h')[0].props['aria-expanded'] === undefined && botones(grupoDe(r0b), /^Cobrar$/).length === 1);
    // Con una cuota del grupo elegida el grupo se abre solo; si el usuario lo cierra con el chevron, se cierra.
    const cuotaDentro = { nombre: loanMap[idG].nombre, loanId: idG, payId: fsG[1].p.id };
    const conDentro = montar(X.CobrosView, propsCobros, [undefined, undefined, undefined, cuotaDentro]);
    const cerradoAMano = {}; cerradoAMano[idG] = false;
    const conDentroCerrado = montar(X.CobrosView, propsCobros, [undefined, undefined, undefined, cuotaDentro, undefined, undefined, undefined, cerradoAMano]);
    R.check('B2 con una cuota de adentro elegida el grupo se abre solo, y el chevron puede cerrarlo igual',
      conClase(grupoDe(conDentro), 'cbv-grupo-cuotas').length === 1 && conClase(grupoDe(conDentroCerrado), 'cbv-grupo-cuotas').length === 0);
    const abiertoG = {}; abiertoG[idG] = true;
    const cbG = montar(X.CobrosView, propsCobros, [undefined, undefined, undefined, undefined, undefined, undefined, undefined, abiertoG]);
    R.eq('B2 abierto, muestra sus ' + fsG.length + ' cuotas una por una', conClase(cbG.arbol, 'cbv-fila en-grupo').length, fsG.length);
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
      const grupoB6 = conClase(cbB6.arbol, 'cbv-grupo').filter(g => textos(g).join(' ').indexOf(X.properCase(nomG)) !== -1)[0];
      const rgB6 = nodos(grupoB6, n => n.tag === 'button' && n.props && /Recibo de cobro general/.test(n.props.title || ''))[0];
      llamadasRG.length = 0;
      rgB6.props.onClick();
      R.eq('B6 le pide a App el recibo de TODOS los prestamos del deudor (no solo el de la fila)',
        llamadasRG.length === 1 ? [llamadasRG[0].nombre, llamadasRG[0].ls.map(x => x.id).sort()] : null,
        [nomG, loansB6.filter(x => x.nombre === nomG).map(x => x.id).sort()]);
      FE.captura.pdfs.length = 0;
      llamadasRG.length = 0;
      rg[0].props.onClick();
      if (llamadasRG.length === 1) rgEmitir(llamadasRG[0].ls);
      const docG = FE.captura.pdfs[0];
      R.check('B6 emite el recibo general de ese deudor con TODA su mora (' + nDeudor + ' cuotas)',
        FE.captura.pdfs.length === 1 && docG.html.indexOf('Recibo de cobro general') !== -1 &&
        docG.html.indexOf(nDeudor + ' cuotas vencidas') !== -1 && docG.fname === 'Recibo de cobro general - ' + nomG + ' - ' + HOY,
        docG && docG.fname);
    }
    // Desplegado (verDespues = true, el 7o useState), aparecen.
    const cbAbierto = montar(X.CobrosView, propsCobros, [undefined, undefined, undefined, undefined, undefined, undefined, true]);
    R.eq('B4 desplegado, "Más adelante" muestra sus cuotas', botones(cbAbierto.arbol, /^Pagó$/).length, B.length - enGrupos);
    // El tramo que llega por props (las insignias del encabezado) abre la bandeja filtrada.
    const cbVenc = montar(X.CobrosView, Object.assign({}, propsCobros, { tramo: 'vencido' }), []);
    R.check('B5 tramo "vencido": solo la seccion Vencido', conClase(cbVenc.arbol, 'cbv-sec').length === 1 &&
      conClase(cbVenc.arbol, 't-vencido').length === 1 && cbVenc.t.indexOf('Hoy') === cbVenc.t.lastIndexOf('Hoy'), conClase(cbVenc.arbol, 'cbv-sec').length);
    R.check('B5 y su tarjeta queda marcada (con la X para volver a todos)',
      /\bon\b/.test(conClase(cbVenc.arbol, 'cbv-tramo')[0].props.className) && conClase(cbVenc.arbol, 'cbv-tramo').filter(n => /\bon\b/.test(n.props.className)).length === 1);
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
    R.check('B7 la vista lo muestra en "Entró en caja"', cobr.t.indexOf('Entró en caja') !== -1 && cobr.t.indexOf(sinPeso(X.fmt(caja))) !== -1);
    R.check('B7 interes + capital + efecto TRM = caja, evento por evento', ev.every(e => Math.abs(e.interes + e.capital + (e.ajuste || 0) - e.cop) < 1e-6));
    R.check('B7 y muestra los intereses del mes y el capital devuelto', cobr.t.indexOf(sinPeso(X.fmt(suma(ev, e => e.interes)))) !== -1 &&
      cobr.t.indexOf(sinPeso(X.fmt(suma(ev, e => e.capital)))) !== -1);
    const segCaja = conClase(conClase(cobr.arbol, 'cbv-segbar')[0], 'seg');
    const repEsp = [suma(ev, e => e.interes), suma(ev, e => e.capital)].filter(v => v > 0);
    R.check('B7 la barra de la caja reparte intereses y capital devuelto',
      segCaja.length === repEsp.length && segCaja.every((n, i) => Math.abs(n.props.style.flexGrow - repEsp[i]) < 1e-6), [segCaja.map(n => n.props.style.flexGrow), repEsp]);
    // Con una cuota elegida, el panel del deudor aparece al lado con ese prestamo.
    const f0 = tramo('vencido')[0];
    const cbSel = montar(X.CobrosView, propsCobros, [undefined, undefined, undefined, { nombre: f0.l.nombre, loanId: f0.l.id, payId: f0.p.id }]);
    const panel = conClase(cbSel.arbol, 'dp');
    R.check('B8 elegir una cuota abre el panel de su deudor, con la cuota resaltada en el cronograma',
      panel.length === 1 && conClase(panel[0], 'dp-crono-f foco').length === 1);
    R.check('B8 la raiz lleva el diseño nuevo de la bandeja y del panel (`v4c v4p`) y, con el panel, `con-panel`',
      /^op v4c v4p\b/.test(cb.arbol.props.className) && /\bcon-panel\b/.test(cbSel.arbol.props.className) && !/\bcon-panel\b/.test(cb.arbol.props.className),
      [cb.arbol.props.className, cbSel.arbol.props.className]);

    // ── Lo nuevo del rediseño: el encabezado, la barra de tramos, el selector y "Tu día de cobro" ──
    const hero = conClase(cb.arbol, 'cbv-hero')[0];
    const deudoresB = Object.keys(B.reduce((a, f) => { a[f.p.nombreCliente] = 1; return a; }, {})).length;
    R.check('B9 el encabezado: lo que falta cobrar de toda la bandeja, en ' + B.length + ' cuotas de ' + deudoresB + ' deudores',
      textos(hero).indexOf(sinPeso(X.fmt(suma(B, f => f.pend)))) !== -1 && textos(hero).indexOf(B.length + ' cuotas de ' + deudoresB + ' deudores') !== -1,
      textos(hero).slice(0, 6));
    const segs = conClase(conClase(hero, 'cbv-segbar')[0], 'seg');
    const conValor = TRAMOS.filter(t => totTramo(t) > 0);
    R.check('B9 la barra reparte lo por cobrar en los tramos con algo, cada uno de su largo (su total)',
      segs.length === conValor.length && segs.every((n, i) => Math.abs(n.props.style.flexGrow - totTramo(conValor[i])) < 1e-6),
      [segs.map(n => n.props.style.flexGrow), conValor.map(totTramo)]);
    const total = suma(B, f => f.pend);
    R.check('B9 cada tramo de la barra dice su cifra y su porcentaje en el globo',
      segs.every((n, i) => { const tx = textos(n).join(' '); return tx.indexOf(X.fmt(totTramo(conValor[i]))) !== -1 && tx.indexOf(Math.round(totTramo(conValor[i]) / total * 100) + '%') !== -1; }),
      segs.map(n => textos(n).join(' ')));
    const r9 = montar(X.CobrosView, propsCobros, []);
    conClase(conClase(conClase(r9.arbol, 'cbv-hero')[0], 'cbv-segbar')[0], 'seg')[conValor.indexOf('hoy')].props.onClick();
    R.check('B9 un clic en un tramo de la barra filtra la bandeja a ese tramo', r9.llamadas.some(x => x.k === 1 && x.nuevo === 'hoy'), r9.llamadas);
    const vMarcada = montar(X.CobrosView, Object.assign({}, propsCobros, { tramo: 'vencido' }), []);
    R.check('B9 con un tramo elegido, los demas tramos de la barra se apagan',
      conClase(conClase(vMarcada.arbol, 'cbv-segbar')[0], 'seg').filter(n => /\bapagado\b/.test(n.props.className)).length === conValor.length - 1);
    // El selector Por cobrar / Cobrado: la pastilla se desliza a la opcion elegida (`--k`).
    const segSel = conClase(hero, 'cbv-seg')[0];
    R.check('B10 el selector nace en "Por cobrar" (la pastilla en la primera opcion)',
      segSel.props.style['--n'] === 2 && segSel.props.style['--k'] === 0 && conClase(segSel, 'cbv-seg-thumb').length === 1);
    R.eq('B10 en "Cobrado" la pastilla pasa a la segunda opcion', conClase(conClase(cobr.arbol, 'cbv-hero')[0], 'cbv-seg')[0].props.style['--k'], 1);
    const r10 = montar(X.CobrosView, propsCobros, []);
    botones(conClase(conClase(r10.arbol, 'cbv-hero')[0], 'cbv-seg')[0], /^Cobrado$/)[0].props.onClick();
    R.check('B10 un clic en "Cobrado" cambia el modo', r10.llamadas.some(x => x.k === 0 && x.nuevo === 'cobrado'), r10.llamadas);
    // Sin cuota elegida, al lado va "Tu día de cobro" con los mismos totales de los tramos.
    const lado = conClase(cb.arbol, 'cbv-lado')[0];
    R.check('B11 "Tu día de cobro": lo de hoy, lo vencido, los próximos 7 días y el resto del mes',
      !!lado && textos(lado).indexOf(sinPeso(X.fmt(totTramo('hoy')))) !== -1 && ['vencido', 'semana', 'mes'].every(t => textos(lado).indexOf(X.fmt(totTramo(t))) !== -1) &&
      textos(lado).join(' ').indexOf(tramo('hoy').length + ' cuotas hoy') !== -1, lado && textos(lado));
    R.check('B11 con una cuota elegida, el panel del deudor reemplaza a "Tu día de cobro"', conClase(cbSel.arbol, 'cbv-lado').length === 0);

    // ── El panel del deudor: el diseño nuevo en Cobros y en Cartera (fase 3 de la integracion) ──
    // Un prestamo en dolares con compras de dolares: su panel muestra la TRM de cada compra.
    const lLotes = loans.filter(l => l.estado === 'Activo' && l.comprasUSD && l.comprasUSD.length > 2)[0];
    R.check('B12 ANTI-VACIO: el fixture tiene un prestamo activo con compras de dolares', !!lLotes);
    if (lLotes) {
      const enCobros = montar(X.CobrosView, propsCobros, [undefined, undefined, undefined, { nombre: lLotes.nombre, loanId: lLotes.id, payId: null }]);
      const pC = conClase(enCobros.arbol, 'dp')[0];
      const enCartera = montar(X.CarteraView, { loans, pays, deudores, hoy: HOY, acciones, onPay: () => {}, onNuevo: () => {}, datosPago: '', showToast: () => {},
        foco: { nombre: lLotes.nombre, loanId: lLotes.id } }, []);
      const pK = conClase(enCartera.arbol, 'dp')[0];
      const trm = n => textos(n).filter(x => /^TRM \$/.test(x)).length, arroba = n => textos(n).filter(x => /^@ \$/.test(x)).length;
      R.check('B12 en Cobros, el panel dice "TRM $ X" en cada compra de dolares y trae el flujo de caja nuevo',
        !!pC && trm(pC) > 0 && arroba(pC) === 0 && conClase(pC, 'fcv-btn').length === 1, pC && { trm: trm(pC), arroba: arroba(pC), fcv: conClase(pC, 'fcv-btn').length });
      R.check('B12 en Cartera, el mismo panel con el mismo diseño: "TRM $ X" y el flujo de caja nuevo',
        !!pK && trm(pK) === trm(pC) && arroba(pK) === 0 && conClase(pK, 'fcv-btn').length === 1, pK && { trm: trm(pK), arroba: arroba(pK) });
      R.check('B12 las raices de Cobros y de Cartera llevan `v4p` (el diseño del panel, panel.css)',
        /\bv4p\b/.test(enCobros.arbol.props.className) && /\bv4p\b/.test(enCartera.arbol.props.className), [enCobros.arbol.props.className, enCartera.arbol.props.className]);
      R.check('B12 el flujo de caja viejo salio: un solo FlujoCajaPanel (el del diseño nuevo)',
        typeof X.FlujoCajaPanel === 'function' && typeof X.FlujoCajaPanelV4 === 'undefined');
      // El flujo de caja, abierto: una fila por movimiento de `flujoCajaDe` y sus totales, sobre el prestamo
      // con MAS movimientos de caja del fixture.
      const lFj = loans.slice().sort((x, y) => X.flujoCajaDe(y, lpDe(y.id)).eventos.length - X.flujoCajaDe(x, lpDe(x.id)).eventos.length)[0];
      const fj = X.flujoCajaDe(lFj, lpDe(lFj.id));
      const fv4 = montar(X.FlujoCajaPanel, { loan: lFj, pays: lpDe(lFj.id) }, [true]);
      const filasV4 = nodos(fv4.arbol, n => n.tag === 'tr').length;
      R.check('B13 el flujo de caja trae una fila por cada uno de sus ' + fj.eventos.length + ' movimientos y la fila de totales (interes, capital, ingreso)',
        fj.eventos.length >= 5 && filasV4 === fj.eventos.length + 2 && conClase(fv4.arbol, 'fcv-tot').length === 1 &&
        [fj.totales.interes, fj.totales.capital, fj.totales.ingreso].every(v => textos(conClase(fv4.arbol, 'fcv-tot')[0]).indexOf(X.fmtN(v)) !== -1),
        { filasV4, eventos: fj.eventos.length });
      R.check('B13 y ninguna celda lleva color en linea (el estado va por clase)',
        nodos(fv4.arbol, n => (n.tag === 'td' || n.tag === 'th') && n.props && n.props.style && n.props.style.color).length === 0);
    }
  }

  // ── C — CARTERA ───────────────────────────────────────────────────────────
  // El rediseño v4 (fase 3 de la integracion): mismo comportamiento y mismos datos que la vista de 3.7.1,
  // con clases `ctv-`. Se sigue pintando con la ventana "oculta" (B): las cifras grandes, en su valor final.
  R.seccion('C — la vista Cartera (rediseño v4) renderizada');
  const propsCartera = { loans, pays, deudores, hoy: HOY, acciones, onPay: () => {}, onNuevo: () => {}, datosPago: '', showToast: () => {}, foco: null };
  let ct = null; error = null;
  try { ct = montar(X.CarteraView, propsCartera, []); } catch (e) { error = e; }
  R.check('C1 la vista se renderiza sin excepciones', !!ct, error && (error.stack || String(error)));
  if (ct) {
    const filas = conClase(ct.arbol, 'ctv-fila');
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
    const chips = conClase(ct.arbol, 'ctv-filtro').map(n => textos(n).join(' '));
    R.check('C3 el filtro "En mora" cuenta 3', chips.some(c => /^En mora 3$/.test(c)), chips);
    R.check('C3 el filtro "Activos" cuenta los deudores con prestamos activos', chips.some(c => c === 'Activos ' + conActivos.length), chips);
    const heroCt = conClase(ct.arbol, 'ctv-hero')[0];
    R.check('C4 el encabezado dice lo mismo que el Resumen: en la calle, prestado y cuanto ya volvio',
      textos(heroCt).indexOf(sinPeso(X.fmt(MR.vivo))) !== -1 &&
      textos(heroCt).indexOf('de ' + X.fmt(MR.prestado) + ' prestados · ' + Math.round((1 - MR.vivo / MR.prestado) * 100) + '% ya volvió') !== -1, textos(heroCt));
    // La calle por estado, recalculada APARTE desde modeloDeudor: al dia, cobran esta semana, en mora, abierto.
    const GR = { aldia: 'aldia', hoy: 'pronto', semana: 'pronto', mora: 'mora', abierto: 'abierto' };
    const porEst = { aldia: [0, 0], pronto: [0, 0], mora: [0, 0], abierto: [0, 0] };
    MD.filter(x => x.activos.length).forEach(x => { const g = porEst[GR[x.estado]]; if (g) { g[0] += x.saldo; g[1]++; } });
    const ley = conClase(heroCt, 'ctv-ley-f').map(n => textos(n));
    R.eq('C7 la leyenda: cada estado con su conteo y lo que suma en la calle', ley.map(t => [t[0], t[1], t[2]]),
      [['Al día', 'aldia'], ['Esta semana', 'pronto'], ['Con mora', 'mora'], ['Abierto', 'abierto']].map(([r, k]) => [r, String(porEst[k][1]), X.fmt(porEst[k][0])]));
    R.eq('C7 la leyenda suma lo que esta en la calle', suma(Object.keys(porEst), k => porEst[k][0]), MR.vivo);
    // La correccion del PO: en un solo renglon el conteo quedaba pegado al monto. Cada estado va en dos
    // renglones: arriba el rotulo con su conteo (en su chip), abajo el monto, cada uno en su propio bloque.
    R.check('C7 cada estado de la leyenda en dos bloques: el rotulo con su conteo, y el monto aparte',
      conClase(heroCt, 'ctv-ley-f').every(n => n.kids.length === 2 && conClase(n.kids[0], 'n').length === 1 && n.kids[1].tag === 'b'));
    const segCt = conClase(conClase(heroCt, 'cbv-segbar')[0], 'seg');
    R.check('C7 la barra del encabezado reparte la calle en los estados con algo, cada uno de su largo',
      segCt.length === Object.keys(porEst).filter(k => porEst[k][0] > 0).length &&
      segCt.every(n => Object.keys(porEst).some(k => Math.abs(porEst[k][0] - n.props.style.flexGrow) < 1e-6)), segCt.map(n => n.props.style.flexGrow));
    // "Lo urgente primero" agrupa la lista por estado, cada grupo con cuantos y cuanto suman.
    const grH = conClase(ct.arbol, 'ctv-grupo-h').map(n => textos(n));
    R.eq('C8 en "Lo urgente primero" la lista va agrupada por estado, en el orden de la urgencia',
      grH.map(t => t[0]), ['En mora', 'Cobran esta semana', 'Al día', 'Crédito abierto'].filter(r => grH.some(t => t[0] === r)));
    const moraG = grH.filter(t => t[0] === 'En mora')[0];
    R.check('C8 el grupo "En mora" dice cuantos deudores y cuanto tienen vencido',
      !!moraG && moraG[1] === String(MD.filter(x => x.estado === 'mora').length) && moraG[2] === X.fmt(suma(MD.filter(x => x.estado === 'mora'), x => x.mora)), moraG);
    R.check('C8 ANTI-VACIO: el fixture llena al menos tres grupos', grH.length >= 3, grH.map(t => t[0]));
    const ctSaldo = montar(X.CarteraView, propsCartera, [undefined, undefined, 'saldo']);
    R.eq('C8 con otro orden la lista no se agrupa', conClase(ctSaldo.arbol, 'ctv-grupo-h').length, 0);
    // Cada fila: el chip de un prestamo abre ESE prestamo; la barra fina dice cuanto ya volvio.
    const f0 = filas[0], x0 = MD.filter(x => X.properCase(x.nombre) === textos(f0)[1])[0];
    const rC9 = montar(X.CarteraView, propsCartera, []);
    const chipC9 = conClase(conClase(rC9.arbol, 'ctv-fila')[0], 'ctv-chip')[0];
    let cortoC9 = 0;
    chipC9.props.onClick({ stopPropagation: () => { cortoC9++; } });
    R.check('C9 el chip de un prestamo abre a su deudor con ESE prestamo (sin que el clic llegue a la fila)',
      cortoC9 === 1 && rC9.llamadas.some(x => x.k === 4 && x.nuevo === x0.nombre) && rC9.llamadas.some(x => x.k === 5 && x.nuevo && x.nuevo.loan === x0.activos[0].loan.id),
      rC9.llamadas);
    const pctF0 = Math.max(0, Math.min(100, Math.round((1 - x0.saldo / x0.prestado) * 100)));
    R.check('C9 la barra de cada fila dice cuanto del capital ya volvio (' + pctF0 + '%)',
      textos(conClase(f0, 'ctv-meter')[0]).indexOf(pctF0 + '%') !== -1 && conClase(f0, 'pista')[0].kids[0].props.style.width === pctF0 + '%');
    R.check('C10 la raiz lleva el diseño nuevo de la lista y del panel (`op ct v4t v4p`)', /^op ct v4t v4p\b/.test(ct.arbol.props.className), ct.arbol.props.className);
    // El foco (desde el Resumen o la busqueda): un deudor sin mora y uno de sus prestamos.
    const otro = MD.filter(x => x.activos.length > 0 && x.moraN === 0)[0];
    const lf = otro.activos[otro.activos.length - 1].loan;
    const ctF = montar(X.CarteraView, Object.assign({}, propsCartera, { foco: { nombre: otro.nombre, loanId: lf.id, t: 1 } }), []);
    const pestOn = conClase(ctF.arbol, 'dp-tab on');
    R.check('C5 el foco abre ESE deudor con ESE prestamo seleccionado',
      conClase(ctF.arbol, 'ctv-fila on').length === 1 && textos(conClase(ctF.arbol, 'ctv-fila on')[0])[1] === X.properCase(otro.nombre) &&
      pestOn.length === 1 && textos(pestOn[0]).join(' ').indexOf(X.fmt(X.modeloPrestamo(lf, lpDe(lf.id), HOY).saldo)) !== -1);
    const ctInact = montar(X.CarteraView, propsCartera, [undefined, 'inactivos']);
    R.eq('C6 el filtro "Sin préstamos activos" lista los demas', conClase(ctInact.arbol, 'ctv-fila').length, MD.length - conActivos.length);
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
      llamadasRG.length = 0;
      rgP[0].props.onClick();
      R.eq('D8 le pide a App el recibo de ese deudor con sus prestamos activos',
        llamadasRG.length === 1 ? [llamadasRG[0].nombre, llamadasRG[0].ls.map(x => x.id).sort()] : null,
        [l.nombre, loans.filter(x => x.nombre === l.nombre && x.estado === 'Activo').map(x => x.id).sort()]);
      if (llamadasRG.length === 1) rgEmitir(llamadasRG[0].ls);
      R.check('D8 emite el recibo general de ese deudor', FE.captura.pdfs.length === 1 &&
        FE.captura.pdfs[0].html.indexOf('Recibo de cobro general') !== -1 && FE.captura.pdfs[0].fname === 'Recibo de cobro general - ' + l.nombre + ' - ' + HOY,
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
    llamadasRG.length = 0;
    botones(dpM.arbol, /^Recibo general$/)[0].props.onClick();
    if (llamadasRG.length === 1) rgEmitir(llamadasRG[0].ls);
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
  const cobrosCss = leer('public/css/cobros.css').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, '');
  const panelCss = leer('public/css/panel.css').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, '');
  const carteraCss = leer('public/css/cartera.css').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, '');
  R.check('F4 index.html carga cobros.css, panel.css y cartera.css, en ese orden, despues de base.css y resumen.css',
    /href="\/css\/base\.css">\s*<link[^>]*href="\/css\/resumen\.css">\s*<link[^>]*href="\/css\/cobros\.css">\s*<link[^>]*href="\/css\/panel\.css">\s*<link[^>]*href="\/css\/cartera\.css">/.test(leer('public/index.html')));
  R.check('F4 cobros.css trae la bandeja (`.v4c`); el panel ya no vive ahi',
    ['.v4c.op{', '.cbv-tramos{', '.cbv-segbar{', '.cbv-seg-thumb{', '.cbv-fila{', '.cbv-grupo{', '.cbv-chev{'].every(x => cobrosCss.indexOf(x) !== -1) && cobrosCss.indexOf('.v4p') === -1);
  R.check('F4 panel.css trae el panel del deudor que comparten las dos pestañas (`.v4p`), con su flujo de caja',
    ['.v4p.dp{', '.v4p.dp-head{', '.v4p.dp-crono{', '.v4p.fcv-btn{', '.v4p.fcv-tot', '.v4p.op-lado:not(.superpuesto){'].every(x => panelCss.indexOf(x) !== -1));
  R.check('F4 cartera.css trae la lista (`.v4t`, `ctv-`) y la leyenda en dos renglones (la correccion del PO)',
    ['.v4t.op.ct,', '.ctv-hero{', '.ctv-filtro{', '.ctv-fila{', '.ctv-chip{', '.ctv-grupo-h{'].every(x => carteraCss.indexOf(x) !== -1) &&
    /\.ctv-ley-f\{display:flex;flex-direction:column;/.test(carteraCss) && /\.ctv-ley-f\.n\{margin-left:auto;/.test(carteraCss) && /\.ctv-ley-fb\{padding-left:16px;/.test(carteraCss));
  // Las clases de las vistas de 3.5.0 (`cb-` de Cobros, `ct-` de Cartera) salieron: ni en el codigo ni en styles.css.
  const viejas = /\.(cb|ct)-[a-z0-9-]+/g;
  const enJs = ['public/js/vistas/CarteraView.js', 'public/js/vistas/CobrosView.js', 'public/js/componentes/DeudorPanel.js'].map(leer).join(' ');
  R.eq('F4 sin clases `cb-` ni `ct-` de las vistas de 3.5.0, ni en el codigo ni en styles.css (salvo `ct-main`, que no lleva regla)',
    [Array.from(new Set(reglas.match(viejas) || [])), Array.from(new Set(enJs.match(/\b(cb|ct)-[a-z0-9-]+/g) || []))], [[], ['ct-main']]);
  R.check('F4 styles.css trae el maestro-detalle y el panel superpuesto en ventana angosta',
    /\.op\{display:grid/.test(reglas) && /\.dp\{/.test(reglas) && /\.op\.ct,\.op\.ct\.con-panel\{/.test(reglas) &&
    /@media \(max-width:1099px\)\{(?:\s*[^{}]+\{[^}]*\})*?\s*\.op-lado\.superpuesto\{position:fixed/.test(reglas));

  // ── G — LA MEMORIA DE CARTERA ─────────────────────────────────────────────
  R.seccion('G — Cartera recuerda el filtro, el orden y el deudor entre visitas');
  const filasDe  = a => conClase(a.arbol, 'ctv-fila').map(f => textos(f)[1]);
  const filaOn   = a => conClase(a.arbol, 'ctv-fila on').map(f => textos(f)[1]);
  const filtroOn = a => conClase(a.arbol, 'ctv-filtro on').map(n => textos(n)[0]);
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
    const bDol = conClase(v1.arbol, 'ctv-filtro').filter(n => textos(n)[0] === 'En dólares')[0];
    bDol.props.onClick();
    nodos(v1.arbol, n => n.tag === 'select')[0].props.onChange({ target: { value: 'saldo' } });
    const filaEl = conClase(v1.arbol, 'ctv-fila').filter(f => textos(f)[1] === PC(elegido.nombre))[0];
    const chipsEl = filaEl ? conClase(filaEl, 'ctv-chip').filter(n => n.props.className.indexOf('cerrado') === -1) : [];
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
      conClase(v4.arbol, 'ctv-elige').length === 1 && v4.todo.indexOf('Elige un deudor de la lista') !== -1);
    // Elegir una fila: deudor nuevo y SIN prestamo recordado (abre el primero de los suyos).
    conClase(v4.arbol, 'ctv-fila').filter(f => textos(f)[1] === PC(elegido.nombre))[0].props.onClick();
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
      filtroOn(v6).join() === 'Activos' && filasDe(v6).length === actSinMora && !conClase(v6.arbol, 'ctv-filtro').some(n => textos(n)[0] === 'En mora'),
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
    conClase(va.arbol, 'ctv-filtro').filter(n => textos(n)[0] === 'En dólares')[0].props.onClick();
    nodos(va.arbol, n => n.tag === 'select')[0].props.onChange({ target: { value: 'saldo' } });
    const filaE = conClase(va.arbol, 'ctv-fila').filter(f => textos(f)[1] === PC(elegido.nombre))[0];
    conClase(filaE, 'ctv-chip').filter(n => n.props.className.indexOf('cerrado') === -1)[1].props.onClick({ stopPropagation: () => {} });
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
    R.check('G10 el panel cerrado tambien sobrevive al reinicio', filaOn(vc).length === 0 && conClase(vc.arbol, 'ctv-elige').length === 1 && vc.todo.indexOf('Elige un deudor de la lista') !== -1 &&
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
  // 4.1.3 ("un nombre en todo", decision del PO): renombrar a un cliente cambia las iniciales de sus
  // codigos, asi que el codigo tambien se busca SIN ellas cuando el texto trae el prestamo completo.
  // Lo que NO puede pasar: que respondan otro prestamo, otra cuota o un prestamo a medio escribir.
  R.check('H5 ANTI-TRIVIAL: otro prestamo, otra cuota o el prestamo a medio escribir no la encuentran', !!pA &&
    !X.payMatchesQuery(pA, 'fc-an-zzz') && !X.payMatchesQuery(pA, 'fc-án-' + idA + '-99') && !X.payMatchesQuery(pA, 'fc-ng-' + idA.slice(0, 2)));
  const nnA = pA ? String(pA.cuotaN).padStart(2, '0') : '';
  R.check('H7 el codigo con las iniciales de ANTES de un renombre encuentra la cuota por prestamo y numero (4.1.3)',
    !!pA && ['fc-ye-' + idA + '-' + nnA, 'FC-Zz-' + idA, 'fc-ye-' + idA + '-' + nnA.slice(0, 1)].every(q => X.payMatchesQuery(pA, q)));
  R.check('H7 ...y ninguna cuota de otro prestamo, ni otra cuota del mismo, responde a ese codigo',
    !!pA && regulares.filter(p => p.id !== pA.id && (String(p.prestamoId).slice(-3) !== idA || p.cuotaN !== pA.cuotaN))
      .every(p => !X.payMatchesQuery(p, 'fc-ye-' + idA + '-' + nnA)));
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
  R.check('H7 credito abierto: el papel con las iniciales de antes de un renombre se encuentra por el credito (4.1.3)',
    ['fc-ye-' + idD, 'FC-Ye-' + idD + '-0611'].every(q => X.fcCoincideDiario(ldA, q)) &&
    !X.fcCoincideDiario(ldA, 'fc-ye-' + idD + '-061199') && !X.fcCoincideDiario(ldA, 'fc-ye-zzz'));
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
    ['CobroModal', X.CobroModal, { loan: lC, pays: lpC, onConfirm: nada, onClose: nada, onRequestLiquidar: nada }],
    ['CronogramaPdfModal', X.CronogramaPdfModal, { loan: lC, pays: lpC, onClose: nada }],
    ['ReciboGeneralModal', X.ReciboGeneralModal, { deudor: X.properCase(lC.nombre), hoy: HOY, loans: loans.filter(x => x.nombre === lC.nombre), pays, onClose: nada, onGenerar: nada }],
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
    // ("Valor de liquidación" salia del formulario de abono, que se borro en 4.1.4.)
    ['Cédula', 'Teléfono', 'Tú eliges', 'Edición', 'Reestructuración'].every(w => textosI.indexOf(w) !== -1),
    ['Cédula', 'Teléfono', 'Tú eliges', 'Edición', 'Reestructuración'].filter(w => textosI.indexOf(w) === -1));
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
    R.check('J3 ANTI-VACIO: los modales del prestamo tambien (reestructurar, liquidar, cronograma, pre-flight, pago)',
      ['RestructureModal', 'LiquidarModal', 'CronogramaPdfModal', 'PreflightMoraModal', 'PayModal'].every(k => porPantalla[k] >= 1), porPantalla);
  }
  const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'css', 'styles.css'), 'utf8');
  const regla = sel => { const m = new RegExp('(^|\\n)' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\{([^}]*)\\}').exec(css); return m ? m[2] : null; };
  R.check('J4 la sub-linea en dolares y la marca USD no usan el azul', !!regla('.dp-usd') && !/--blue/.test(regla('.dp-usd')) &&
    !!regla('.dp-usdtag') && !/--blue/.test(regla('.dp-usdtag')) && !/\.rz-chip\.usd/.test(css), [regla('.dp-usd'), regla('.dp-usdtag')]);
  // Rediseño v4: la cifra en pesos de Cobros va en su propio bloque (`.cbv-monto .v`), asi que la sub-linea
  // en dolares ya no la tiene de padre; cobros.css le fija 11 px y el gris del resto de la app.
  const cssCob = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'css', 'cobros.css'), 'utf8').replace(/\s+/g, ' ');
  R.check('J4 en Cobros la sub-linea en dolares va aparte de la cifra en pesos, a 11 px y en gris (no azul)',
    /\.cbv-monto \.dp-usd \{ display: block; font-size: 11px;/.test(cssCob) && !/\.dp-usd[^{]*\{[^}]*--blue/.test(cssCob) &&
    /\.v4p \.dp-usd \{ color: var\(--ink-3\); \}/.test(require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'css', 'panel.css'), 'utf8')));
  const pz = X.usdPiezas('+USD $1,647.22 en dólares');
  R.check('J5 el ayudante parte el importe y conserva el signo y lo que sigue',
    Array.isArray(pz) && pz[0] === '+' && pz[1].props.className === 'usd-c' && pz[2] === '1,647.22 en dólares', pz);
  R.check('J5 ANTI-TRIVIAL: un texto que no es un importe en dolares queda intacto',
    X.usdPiezas('$ 1.200.000') === '$ 1.200.000' && X.usdPiezas(null) === '');

  // ── K — HISTORIAL (3.7.0) ────────────────────────────────────────────────
  // Rediseno pedido por el PO: el historial completo, agrupado por dia, con busqueda (sin tildes) y
  // filtros por periodo y tipo. El candado LIFO del boton Deshacer no cambia.
  R.seccion('K — Historial: dia por dia, busqueda, periodo, tipo y el candado de Deshacer (3.7.0, rediseño v4)');
  R.check('K0 ANTI-VACIO: el historial completo trae mas que las 100 de siempre, y las incluye',
    historial.length > 100 && historial100.length === 100 && historial100.every((r, i) => r.id === historial[i].id), historial.length);
  const diaK = it => String(it.fecha).slice(0, 10);
  const navK = [];
  const propsK = { actLog: historial, undoLog: journal, loans, onUndo: () => {}, onRefresh: () => {}, onNameClick: n => navK.push(n) };
  // Clase exacta: `\b` corta en el guion. Rediseño v4: las clases de la vista llevan el prefijo `hsv-`.
  const conClaseK = c => n => ((n.props && typeof n.props.className === 'string') ? n.props.className.split(/\s+/) : []).indexOf(c) !== -1;
  const filasK = arbol => nodos(arbol, conClaseK('hsv-fila'));
  const diasK = arbol => nodos(arbol, conClaseK('hsv-dia')).map(d => textos(d)[0]);
  // Estado sembrado por posicion: q, periodo, desde, hasta, grupo, limite (y la animacion al final).
  const hist = (estado) => montar(X.HistorialView, propsK, estado || []);
  let hk = null, errK = null;
  try { hk = hist(); } catch (e) { errK = e; }
  R.check('K1 la vista se renderiza con el historial completo', !!hk, errK && (errK.stack || String(errK)));
  if (hk) {
    const f0 = filasK(hk.arbol);
    R.eq('K2 muestra de a 120 acciones, y avisa cuantas quedan', f0.length, Math.min(120, historial.length));
    R.check('K2 "Ver más" con las restantes', hk.todo.indexOf('Ver más · ' + (historial.length - 120) + ' restantes') !== -1);
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
    const chips = nodos(hk.arbol, n => n.tag === 'button' && conClaseK('ctv-filtro')(n)).map(b => textos(b).join(''));
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
  R.check('K8 Deshacer: morado (`hsv-deshacer on`) cuando se puede, apagado y sin accion cuando el candado lo bloquea',
    btnD(fl[0]).props.className === 'hsv-deshacer on' && btnD(fl[1]).props.className === 'hsv-deshacer' && btnD(fl[1]).props.onClick === null);
  R.check('K8 cada tipo con su etiqueta suave (y "Revertida" en morado)', nodos(fl[0], n => n.props && n.props.className === 'v4-tag good').length === 1 &&
    nodos(fl[2], n => n.props && n.props.className === 'v4-tag purple' && textos(n).join('') === 'Revertida').length === 1);

  // K11 (4.1.3) — el CANDADO G en la UI: renombrar a un cliente toca todos sus prestamos (`grupo`, con
  // `involucra`). La misma regla de routes/undo.js: el renombre no se deshace por encima de un
  // movimiento posterior de cualquiera de ellos, y un movimiento anterior de uno de ellos no se
  // deshace antes que el renombre. Un prestamo de OTRO cliente no se entera.
  const actG = [
    { id: 5, fecha: '2026-07-31 12:00:00', tipo: 'pago', mensaje: 'Pago posterior en B', undo_id: 'g5' },
    { id: 4, fecha: '2026-07-31 11:00:00', tipo: 'edicion', mensaje: 'Editaste préstamo de Nueva (antes «Vieja»)', undo_id: 'g4' },
    { id: 3, fecha: '2026-07-31 10:00:00', tipo: 'pago', mensaje: 'Pago anterior en B', undo_id: 'g3' },
    { id: 2, fecha: '2026-07-31 09:00:00', tipo: 'pago', mensaje: 'Pago de otro cliente', undo_id: 'g2' }];
  const undoG = [
    { id: 'g5', estado: 'disponible', scope_tipo: 'loan', scope_id: 'LB', descripcion: 'Pago posterior en B' },
    { id: 'g4', estado: 'disponible', scope_tipo: 'loan', scope_id: 'LA', descripcion: 'Renombre', grupo: true, involucra: ['LA', 'LB'] },
    { id: 'g3', estado: 'disponible', scope_tipo: 'loan', scope_id: 'LB', descripcion: 'Pago anterior en B' },
    { id: 'g2', estado: 'disponible', scope_tipo: 'loan', scope_id: 'LZ', descripcion: 'Pago de otro cliente' }];
  const flG = filasK(montar(X.HistorialView, { actLog: actG, undoLog: undoG, onUndo: () => {}, onRefresh: () => {} }, []).arbol);
  const activoG = f => !!btnD(f) && !btnD(f).props.disabled;
  R.eq('K11 con un pago posterior en B: se deshace ese pago y el del otro cliente; el renombre y el pago anterior, no',
    flG.map(activoG), [true, false, false, true]);
  R.check('K11 el renombre explica que uno de sus prestamos tiene una operacion posterior',
    textos(flG[1]).join(' ').indexOf('Este cambio de nombre tocó todos los préstamos del cliente, y uno de ellos tiene una operación posterior. Primero debes deshacer: "Pago posterior en B"') !== -1);
  const undoG2 = undoG.map(u => u.id === 'g5' ? Object.assign({}, u, { estado: 'deshecho' }) : u);
  const flG2 = filasK(montar(X.HistorialView, { actLog: actG, undoLog: undoG2, onUndo: () => {}, onRefresh: () => {} }, []).arbol);
  R.eq('K11 deshecho ese pago: el renombre ya se puede deshacer y el pago anterior de B sigue esperando', flG2.slice(1).map(activoG), [true, false, true]);
  R.check('K11 el pago anterior explica que despues se renombro al cliente',
    textos(flG2[2]).join(' ').indexOf('Después de esta operación se cambió el nombre del cliente en todos sus préstamos. Primero debes deshacer: "Renombre"') !== -1);

  // ── El encabezado v4: cuantas acciones, la actividad de 30 dias y el dia elegido con un clic ──
  if (hk) {
    const enc = nodos(hk.arbol, conClaseK('hsv-cifra-v'))[0];
    R.check('K10 el encabezado dice cuantas acciones hay en lo filtrado', !!enc && textos(enc).join('') === historial.length.toLocaleString('es-CO'));
    const barras = nodos(hk.arbol, n => n.tag === 'button' && n.props && /(^|\s)b(\s|$)/.test(n.props.className || ''));
    const conteo30 = d => historial.filter(it => diaK(it) === d).length;
    const malasBar = barras.filter((b, i) => b.props['aria-label'] !== X.hsDia(X.addDays(HOY, i - 29), HOY) + ': ' + conteo30(X.addDays(HOY, i - 29)));
    R.check('K10 la actividad: 30 barras, de hace 29 dias a hoy, cada una con sus acciones', barras.length === 30 && malasBar.length === 0, malasBar.slice(0, 3).map(b => b.props['aria-label']));
    const iUna = barras.findIndex(b => !/vacia/.test(b.props.className));
    const vk = montar(X.HistorialView, propsK, []);
    const bk = nodos(vk.arbol, n => n.tag === 'button' && n.props && /(^|\s)b(\s|$)/.test(n.props.className || ''))[iUna];
    bk.props.onClick();
    const dElegido = X.addDays(HOY, iUna - 29);
    const puestos = {}; vk.llamadas.forEach(l => { puestos[l.k] = l.nuevo; });
    R.check('K10 un clic en una barra muestra solo ese dia (rango desde = hasta = ese dia)', iUna !== -1 && puestos[1] === 'rango' && puestos[2] === dElegido && puestos[3] === dElegido, puestos);
    R.check('K10 las barras sin acciones no se pueden pulsar', barras.filter(b => /vacia/.test(b.props.className)).every(b => b.props.onClick === null && b.props.tabIndex === -1));
  }
  const hcss = fs.readFileSync(path.join(REPO, 'public', 'css', 'historial.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const fHist = fs.readFileSync(path.join(REPO, 'public', 'js', 'vistas', 'HistorialView.js'), 'utf8');
  // `hsv-cifra` solo nombra el bloque de la cifra (sin estilo propio, como en el prototipo aprobado).
  const usadasH = Array.from(new Set(fHist.match(/hsv-[a-z0-9-]+/g) || [])).filter(c => c !== 'hsv-cifra');
  const sinReglaH = usadasH.filter(c => !new RegExp('\\.' + c + '(?![A-Za-z0-9_-])').test(hcss));
  R.check('K11 cada clase hsv- que pinta la vista tiene su regla en historial.css (' + usadasH.length + ' clases)', usadasH.length > 25 && sinReglaH.length === 0, sinReglaH);
  R.check('K11 lo propio vive bajo `.v4h`, con las etiquetas que el Historial agrega (rojo, morado, neutro) acotadas a la vista',
    /\.v4h \{ display: flex; flex-direction: column;/.test(hcss) && ['crit', 'purple', 'neutral'].every(t => new RegExp('\\.v4h \\.v4-tag\\.' + t + ' \\{').test(hcss)) &&
    !/(^|\})\s*\.v4-tag\./.test(hcss));
  R.check('K11 Deshacer en morado cuando se puede', /\.hsv-deshacer\.on \{[^}]*color: var\(--purple\); border-color: var\(--purple-bd\); background: var\(--purple-bg\);/.test(hcss));
  const idxK = fs.readFileSync(path.join(REPO, 'public', 'index.html'), 'utf8');
  R.check('K12 index.html carga historial.css despues de rendimiento.css (reutiliza las hojas anteriores)',
    /href="\/css\/rendimiento\.css">\s*<link[^>]*href="\/css\/historial\.css">/.test(idxK));
  R.check('K12 styles.css ya no trae nada del Historial viejo (.hs, .hs-)', !/\.hs[{-]/.test(fs.readFileSync(path.join(REPO, 'public', 'css', 'styles.css'), 'utf8')));
  R.check('K12 nada del prototipo en produccion', ['v4-forzar', 'historial-actual', 'PROTOTIPO'].every(s => hcss.indexOf(s) === -1 && fHist.indexOf(s) === -1));
  // App le pasa el historial completo y la navegacion.
  const appK = fs.readFileSync(path.join(REPO, 'public', 'js', 'app.js'), 'utf8');
  R.check('K9 App pide el historial completo y le pasa a la vista los prestamos y la navegacion a Cartera',
    appK.indexOf("fetch('/api/activity?todo=1')") !== -1 && /h\(HistorialView,\{[^}]*loans:loans,onNameClick:openDebtorByName/.test(appK));
  R.check('K9 Deshacer abre la confirmacion de App (ConfirmUndoModal, con sus candados) con esa operacion',
    /h\(HistorialView,\{[^}]*onUndo:function\(entry\)\{setUndoDlg\(entry\);\}/.test(appK) && /undoDlg&&h\(ConfirmUndoModal,\{entry:undoDlg,onConfirm:confirmarUndo,/.test(appK));


  // ── L — EL RECIBO GENERAL: EL MODAL PREVIO (post-4.0.0, punto 4 del PO) ───
  // Antes de imprimir, el modal pregunta por el interes del periodo en curso, credito por credito
  // (la casilla de Liquidar deuda), y muestra las tres cifras de "Tu deuda hoy" tal como se imprimen.
  // Las cifras se recalculan APARTE con `computeLiquidacion` (la de Liquidar deuda) y `pendCuota`.
  R.seccion('L — el recibo general: el modal previo del interés en curso y "Tu deuda hoy"');
  const lsDe = n => loans.filter(x => x.nombre === n);
  const activosRG = n => lsDe(n).filter(x => x.estado === 'Activo' && !X.esDiario(x));
  const preguntaN = n => X.modeloReciboGeneral(lsDe(n), pays, { hasta: HOY }).conMes.length;
  const nombresRG = deudores.map(d => d.nombre).filter(n => X.puedeReciboGeneral(lsDe(n)));
  const nCop = nombresRG.filter(n => preguntaN(n) >= 2 && activosRG(n).every(x => x.moneda !== 'USD'))[0];
  const nUsd = nombresRG.filter(n => preguntaN(n) >= 2 && activosRG(n).every(x => x.moneda === 'USD'))[0];
  const nSin = nombresRG.filter(n => preguntaN(n) === 0)[0];
  R.check('L0 ANTI-VACIO: deudores con 2+ creditos que preguntan (pesos y dolares) y uno que no pregunta', !!(nCop && nUsd && nSin), [nCop, nUsd, nSin]);
  const liqDe = (n, marcas) => suma(activosRG(n), x => X.computeLiquidacion(x, lpDe(x.id), { hasta: HOY, incluyeProxMes: !!(marcas && marcas[x.id]) }).total);
  const cifrasModal = arbol => conClase(arbol, 'rg-cifra').map(c => textos(c)[1]);
  if (nCop && nUsd && nSin) {
    // L1 — la puerta: con pregunta abre el modal y no imprime; sin pregunta imprime directo, sin el interes.
    let abrio = false;
    FE.captura.pdfs.length = 0;
    X.abrirReciboGeneral(lsDe(nCop), pays, HOY, '', () => { abrio = true; });
    R.check('L1 con creditos que pueden cobrar el interes en curso, el boton abre el modal y no imprime nada todavia',
      abrio && FE.captura.pdfs.length === 0 && X.rgPregunta(lsDe(nCop), pays, HOY));
    abrio = false;
    X.abrirReciboGeneral(lsDe(nSin), pays, HOY, '', () => { abrio = true; });
    R.check('L1 sin nada que preguntar (' + activosRG(nSin).map(x => x.modalidad).join(', ') + ') imprime directo, con hoy como corte',
      !abrio && FE.captura.pdfs.length === 1 && FE.captura.pdfs[0].fname === 'Recibo de cobro general - ' + nSin + ' - ' + HOY && !X.rgPregunta(lsDe(nSin), pays, HOY),
      FE.captura.pdfs.length && FE.captura.pdfs[0].fname);
    // L2 — las tres cifras del modal, recalculadas aparte.
    const vencDe = n => suma(activosRG(n), x => suma(lpDe(x.id).filter(p => X.esCuotaRegular(p) && (p.estadoPago === 'En Mora' || (p.estadoPago === 'Pendiente' && p.fechaPago < HOY))), X.pendCuota));
    const faltaDe = n => suma(activosRG(n), x => suma(lpDe(x.id).filter(p => X.esCuotaRegular(p) && p.estadoPago !== 'Pagado'), X.pendCuota));
    const generados = [];
    const propsRG = n => ({ deudor: X.properCase(n), hoy: HOY, loans: lsDe(n), pays, onClose: () => generados.push('cerrar'), onGenerar: o => generados.push(o) });
    const moC = montar(X.ReciboGeneralModal, propsRG(nCop), [{}]);
    const venc0 = vencDe(nCop);
    R.eq('L2 el modal muestra Vencido · Debe hoy · Si sigue con sus cuotas (lo de Liquidar deuda y lo que falta de cada cuota)',
      cifrasModal(moC.arbol), [venc0 ? X.fmt(venc0) : '—', X.fmt(liqDe(nCop)), X.fmt(faltaDe(nCop))]);
    R.check('L2 una casilla por credito que puede cobrar el interes, todas desmarcadas',
      conClase(moC.arbol, 'rg-corr').length === preguntaN(nCop) && conClase(moC.arbol, 'rg-corr on').length === 0);
    // L3 — sin marcar: el recibo sale con el mismo "Debes hoy" del modal.
    generados.length = 0;
    botones(moC.arbol, /Generar el recibo/)[0].props.onClick();
    FE.captura.pdfs.length = 0;
    if (generados.length === 1) X.generateReciboGeneral(lsDe(nCop), pays, '', generados[0]);
    const doc3 = FE.captura.pdfs.length === 1 ? FE.captura.pdfs[0].html : '';
    R.check('L3 "Generar" pasa la fecha y las casillas, y el papel trae el mismo "Debes hoy" sin el interés en curso',
      generados.length === 1 && generados[0].hasta === HOY && doc3.indexOf('Tu deuda hoy') !== -1 &&
      doc3.indexOf(X.fmt(liqDe(nCop))) !== -1 && doc3.indexOf('interés del periodo en curso') === -1);
    // L4 — una sola casilla marcada: sube "Debe hoy" en el interes de ESE credito, y el papel tambien.
    const conMesC = X.modeloReciboGeneral(lsDe(nCop), pays, { hasta: HOY }).conMes.map(m => m.l.id);
    const c1 = activosRG(nCop).filter(x => conMesC.indexOf(x.id) !== -1)[0];
    const marcas1 = {}; marcas1[c1.id] = true;
    const moC1 = montar(X.ReciboGeneralModal, propsRG(nCop), [marcas1]);
    const liq1 = liqDe(nCop, marcas1);
    R.check('L4 marcar un credito sube "Debe hoy" en su interés en curso (= computeLiquidacion con la casilla)',
      cifrasModal(moC1.arbol)[1] === X.fmt(liq1) && liq1 > liqDe(nCop) && conClase(moC1.arbol, 'rg-corr on').length === 1,
      [cifrasModal(moC1.arbol)[1], X.fmt(liq1)]);
    R.eq('L4 lo vencido y las cuotas no se mueven', [cifrasModal(moC1.arbol)[0], cifrasModal(moC1.arbol)[2]], [cifrasModal(moC.arbol)[0], cifrasModal(moC.arbol)[2]]);
    generados.length = 0;
    botones(moC1.arbol, /Generar el recibo/)[0].props.onClick();
    FE.captura.pdfs.length = 0;
    if (generados.length === 1) X.generateReciboGeneral(lsDe(nCop), pays, '', generados[0]);
    const doc4 = FE.captura.pdfs.length === 1 ? FE.captura.pdfs[0].html : '';
    R.check('L4 el papel imprime ese mismo total y nombra el interés del periodo en curso',
      generados.length === 1 && !!generados[0].interesMes && generados[0].interesMes[c1.id] === true &&
      doc4.indexOf(X.fmt(liq1)) !== -1 && doc4.indexOf('interés del periodo en curso') !== -1);
    // L5 — la casilla de arriba marca todas.
    const cab = conClase(moC.arbol, 'rg-corr-cab')[0];
    const chk = cab ? nodos(cab, n => n.tag === 'input')[0] : null;
    if (chk) chk.props.onChange();
    const ultima = moC.llamadas[moC.llamadas.length - 1];
    R.check('L5 la casilla de arriba marca todos los creditos que preguntan',
      !!ultima && Object.keys(ultima.nuevo).length === preguntaN(nCop) && Object.keys(ultima.nuevo).every(k => ultima.nuevo[k] === true));
    // L5b — la casilla de arriba dice cuanto sumaria el interes ANTES de marcarla (con un solo credito
    // es la unica cifra que se ve): la suma de lo que Liquidar deuda cobraria con su casilla.
    const posC = suma(activosRG(nCop), x => { const L = X.computeLiquidacion(x, lpDe(x.id), { hasta: HOY, incluyeProxMes: true }); return L.incluyeProxMes ? L.intExtra : 0; });
    const totCab = cab ? textos(conClase(cab, 'rg-corr-tot')[0]).join('') : '';
    R.check('L5b sin marcar, la casilla de arriba ya muestra lo que sumaria el interés en curso (y va atenuada)',
      posC > 0 && totCab === '+ ' + X.fmt(posC) && cab.props.className === 'rg-corr-cab', [totCab, X.fmt(posC)]);
    const nUno = nombresRG.filter(n => preguntaN(n) === 1 && activosRG(n).length === 1)[0];
    if (nUno) {
      const moUno = montar(X.ReciboGeneralModal, propsRG(nUno), [{}]);
      const lU = activosRG(nUno)[0], LU = X.computeLiquidacion(lU, lpDe(lU.id), { hasta: HOY, incluyeProxMes: true });
      R.check('L5b con un solo credito: sin filas por credito, y la casilla dice cuanto suma',
        conClase(moUno.arbol, 'rg-corr').length === 0 && textos(conClase(moUno.arbol, 'rg-corr-tot')[0]).join('') === '+ ' + X.fmt(LU.intExtra) && LU.intExtra > 0);
    } else R.check('L5b ANTI-VACIO: el fixture tiene un deudor de un credito que pregunta', false);
    // L6 — Cancelar no imprime.
    generados.length = 0;
    FE.captura.pdfs.length = 0;
    botones(moC.arbol, /^Cancelar$/)[0].props.onClick();
    R.check('L6 Cancelar cierra sin imprimir', generados.join() === 'cerrar' && FE.captura.pdfs.length === 0);
    // L7 — en dolares: el modal, solo en dolares (decision del PO de 3.7.0).
    const moU = montar(X.ReciboGeneralModal, propsRG(nUsd), [{}]);
    const tU = moU.t.join(' ');
    R.check('L7 un deudor en dolares: las tres cifras del modal en dolares y ningun peso',
      cifrasModal(moU.arbol).every(v => v === '—' || /^USD \$[\d,]+\.\d\d$/.test(v)) && !/\$\s\d/.test(tU), cifrasModal(moU.arbol));
  }
  // L8 — el cableado: los dos botones van por App, y App abre el modal o imprime directo.
  const appL = leer('public/js/app.js'), dpL = leer('public/js/componentes/DeudorPanel.js'), cbL = leer('public/js/vistas/CobrosView.js');
  R.check('L8 App: onReciboGeneral pasa por abrirReciboGeneral y el modal imprime con los datos de pago',
    /onReciboGeneral:function\(nombre,ls\)\{abrirReciboGeneral\(ls,pays,nowStr\(\),cfg\.datos_pago,/.test(appL) &&
    /reciboGeneralModal&&h\(ReciboGeneralModal,\{/.test(appL) && /generateReciboGeneral\(loans\.filter\([\s\S]{0,120}?\),pays,cfg\.datos_pago,opts\)/.test(appL));
  R.check('L8 el panel y Cobros ya no imprimen por su cuenta: le piden el recibo a App',
    dpL.indexOf('generateReciboGeneral') === -1 && cbL.indexOf('generateReciboGeneral') === -1 &&
    dpL.indexOf('props.onReciboGeneral(d.nombre') !== -1 && cbL.indexOf('props.acciones.onReciboGeneral(l.nombre') !== -1);
  const cssL = leer('public/css/modales.css');
  R.check('L8 el estilo del modal vive en modales.css, sin restos del prototipo', /\.rg-deuda \{/.test(cssL) && !/proto-/.test(cssL));

  // ── M (4.1.3) — renombrar al cliente: el panel abierto lo sigue ───────────────
  // Cobros y Cartera recuerdan al deudor abierto POR NOMBRE. Corregir el nombre lo cambia en todos sus
  // prestamos, asi que sin el mapa de App (`renombres`, {viejo: nuevo}) el panel se cerraba solo.
  R.seccion('M — renombrar al cliente: el panel abierto de Cobros y de Cartera lo sigue (4.1.3)');
  const viejoM = deudores.filter(d => loans.filter(l => l.nombre === d.nombre).length >= 2)[0];
  R.check('M0 anti-vacio: hay un deudor con varios prestamos', !!viejoM);
  if (viejoM) {
    const NUEVO_M = 'Nombre Corregido M';
    const loansM = loans.map(l => l.nombre === viejoM.nombre ? Object.assign({}, l, { nombre: NUEVO_M }) : l);
    const paysM = pays.map(p => p.nombreCliente === viejoM.nombre ? Object.assign({}, p, { nombreCliente: NUEVO_M }) : p);
    const deudoresM = deudores.map(d => d.nombre === viejoM.nombre ? Object.assign({}, d, { nombre: NUEVO_M }) : d);
    const lM = loansM.filter(l => l.nombre === NUEVO_M)[0];
    const propsM = extra => Object.assign({}, propsCobros, { loans: loansM, pays: paysM, deudores: deudoresM }, extra || {});
    const selCb = [undefined, undefined, undefined, { nombre: viejoM.nombre, loanId: lM.id, payId: null }];
    const panelCb = r => conClase(montar(X.CobrosView, r, selCb).arbol, 'dp');
    R.eq('M1 Cobros: sin el mapa, el panel del deudor renombrado se cerraba (el caso que se arregla)', panelCb(propsM()).length, 0);
    const conMapa = panelCb(propsM({ renombres: { [viejoM.nombre]: NUEVO_M } }));
    R.check('M1 Cobros: con el mapa de App, el panel sigue abierto y ya muestra el nombre nuevo',
      conMapa.length === 1 && textos(conMapa[0]).join(' ').indexOf(NUEVO_M) !== -1);
    const propsCtM = extra => Object.assign({}, propsCartera, { loans: loansM, pays: paysM, deudores: deudoresM }, extra || {});
    const selCt = [undefined, undefined, undefined, undefined, viejoM.nombre];
    const ctSin = montar(X.CarteraView, propsCtM(), selCt), ctCon = montar(X.CarteraView, propsCtM({ renombres: { [viejoM.nombre]: NUEVO_M } }), selCt);
    R.eq('M2 Cartera: sin el mapa, el panel del deudor renombrado se cerraba', conClase(ctSin.arbol, 'dp').length, 0);
    R.check('M2 Cartera: con el mapa, el panel sigue abierto con el nombre nuevo y su fila marcada',
      conClase(ctCon.arbol, 'dp').length === 1 && textos(conClase(ctCon.arbol, 'dp')[0]).join(' ').indexOf(NUEVO_M) !== -1 &&
      conClase(ctCon.arbol, 'ctv-fila on').length === 1 && textos(conClase(ctCon.arbol, 'ctv-fila on')[0]).join(' ').indexOf(NUEVO_M) !== -1);
    // El mapa lo lleva App: de un solo paso, y la memoria de Cartera (la que sobrevive al cierre) tambien.
    const appM = leer('public/js/app.js');
    R.check('M3 App anota el renombre tras guardar y se lo pasa a las dos vistas',
      /if\(previo&&savedLoan\.nombre&&savedLoan\.nombre!==previo\.nombre\) anotarRenombre\(previo\.nombre,savedLoan\.nombre\);/.test(appM) &&
      /h\(CobrosView,\{[^}]*renombres:renombres\.current/.test(appM) && /h\(CarteraView,\{[^}]*renombres:renombres\.current/.test(appM));
  }
  // ── N — el panel pegado no se sale por arriba al bajar hasta el final (4.1.4, hallazgo #2) ──
  // El arnes no corre CSS: se fija la REGLA y su relacion con el relleno del contenido. Medido en la app
  // (1.600 x 900, Cartera con "En dolares" y con "Todos", y Cobros): al final del desplazamiento el
  // borde de arriba del panel queda justo bajo el encabezado (antes, 40 px por debajo de el).
  R.seccion('N — el panel pegado queda entero al bajar hasta el final');
  {
    const panelCss = leer('public/css/panel.css'), baseCss = leer('public/css/base.css');
    const relleno = (/\.main-content \{ padding: \d+px \d+px (\d+)px;/.exec(baseCss) || [])[1];
    R.check('N1 el contenido tiene un relleno de abajo (y es el que la lista absorbe)', relleno === '40', relleno);
    R.check('N1 con el panel abierto, la rejilla se come ese relleno y la lista lo lleva por dentro',
      panelCss.indexOf('.v4p.op.con-panel { margin-bottom: -' + relleno + 'px; }') !== -1 &&
      panelCss.indexOf('.v4p.op.con-panel > .op-main { padding-bottom: ' + relleno + 'px; }') !== -1);
  }

  R.seccion('O — el flujo de caja a todo el ancho y los dolares de cada pago (post-4.1.4)');
  {
    // El prestamo de USD 4.800 del fixture: cuotas 1 y 2 sin dolares registrados, 3 y 4 con USD 460.
    const lG = loans.filter(l => l.moneda === 'USD' && Math.round(l.montoOrigen) === 4800)[0];
    const lpG = lG ? lpDe(lG.id) : [];
    R.check('O0 ANTI-VACIO: el prestamo de USD 4.800 tiene pagos con y sin dolares registrados',
      !!lG && lpG.some(p => p.estadoPago === 'Pagado' && p.montoUSDRecibido > 0) && lpG.some(p => p.estadoPago === 'Pagado' && !(p.montoUSDRecibido > 0)));
    if (lG) {
      // O1 El flujo es el TERCER hijo de la rejilla (`dp-cuerpo-ancho`), no va dentro de la columna principal:
      // con el panel en dos columnas baja a una franja de borde a borde.
      const dpG = montar(X.DeudorPanel, propsPanel(lG), []);
      const cuerpo = conClase(dpG.arbol, 'dp-cuerpo')[0];
      const hijos = cuerpo ? cuerpo.kids.filter(k => k && k.props) : [];
      R.check('O1 la rejilla del panel tiene tres hijos: la columna principal, la de las tarjetas y el flujo de caja',
        hijos.length === 3 && /\bdp-cuerpo-main\b/.test(hijos[0].props.className) && /\bdp-cuerpo-lado\b/.test(hijos[1].props.className) &&
        /\bfcv\b/.test(hijos[2].props.className) && /\bdp-cuerpo-ancho\b/.test(hijos[2].props.className), hijos.map(k => k.props.className));
      R.eq('O1 y la columna principal ya no lo lleva adentro', conClase(conClase(dpG.arbol, 'dp-cuerpo-main')[0], 'fcv').length, 0);
      const estilos = leer('public/css/styles.css').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, '');
      R.check('O1 el CSS: en una columna el flujo va justo bajo el cronograma; en dos, de borde a borde',
        estilos.indexOf('.dp-cuerpo-main{order:0}.dp-cuerpo-ancho{order:1}.dp-cuerpo-lado{order:2}') !== -1 &&
        estilos.indexOf('@container(min-width:880px){.dp-cuerpo-main{grid-column:1;grid-row:1}.dp-cuerpo-lado{grid-column:2;grid-row:1}.dp-cuerpo-ancho{grid-column:1/-1;grid-row:2}}') !== -1);
      const panelCssO = leer('public/css/panel.css').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, '');
      R.check('O1 y con el panel angosto la TRM pasa a segunda linea bajo los dolares (la columna se esconde)',
        panelCssO.indexOf('.v4p.fcv.fcv-col-trm,.v4p.fcv.fcv-g-ancho{display:none;}') !== -1 &&
        panelCssO.indexOf('@container(min-width:880px){.v4p.fcv.fcv-col-trm,.v4p.fcv.fcv-g-ancho{display:table-cell;}') !== -1);

      // O2 La tabla en dolares, abierta.
      const fG = montar(X.FlujoCajaPanel, { loan: lG, pays: lpG }, [true]);
      const ths = nodos(fG.arbol, n => n.tag === 'th').map(n => textos(n).join(''));
      R.check('O2 en dolares: "Pesos recibidos", "Dolares entregados" y "TRM del ingreso", bajo "Lo que entró"',
        ['Pesos recibidos', 'Dólares entregados', 'TRM del ingreso', 'Lo que entró', 'Cómo se aplicó'].every(t => ths.indexOf(t) !== -1) && ths.indexOf('Ingreso') === -1, ths);
      const filas = nodos(fG.arbol, n => n.tag === 'tr' && !(n.props && n.props.className)).filter(n => n.kids.some(k => k.tag === 'td'));
      const fila = cuotaN => filas.filter(f => textos(f).indexOf('Cuota #' + cuotaN) !== -1)[0];
      const t3 = fila(3) ? textos(fila(3)) : [], t1 = fila(1) ? textos(fila(1)) : [];
      R.check('O2 la cuota 3: los USD 460 que entrego y la TRM a la que entraron (1.571.196 / 460)',
        t3.indexOf('460.00') !== -1 && t3.indexOf(new Intl.NumberFormat('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(1571196 / 460)) !== -1, t3);
      R.check('O2 la cuota 1, sin dolares registrados: "—" y "sin registrar" (no se inventan)', t1.indexOf('—') !== -1 && t1.indexOf('sin registrar') !== -1, t1);
      R.check('O2 ya no hay linea "US$" bajo los pesos (era pesos / TRM pactada, no los dolares del cliente)',
        conClase(fG.arbol, 'dp-usd').length === 0 && !/US\$/.test(fG.todo), conClase(fG.arbol, 'dp-usd').length);
      const tot = conClase(fG.arbol, 'fcv-tot')[0];
      R.check('O2 el pie suma los dolares registrados (USD 920,00) y dice cuantos pagos no incluye',
        !!tot && textos(tot).indexOf('920.00') !== -1 && textos(tot).indexOf('no incluye 2 pagos') !== -1, tot && textos(tot));
      R.check('O2 el titulo trae la TRM pactada', fG.todo.indexOf('TRM pactada $ ' + X.fmtN(lG.trmAcordada)) !== -1);

      // O3 Cuadratura: "Total recibido" del panel = el pie del flujo de caja (la misma cifra).
      const rec = conClase(dpG.arbol, 'dp-hero-mini')[0];
      R.check('O3 "Total recibido" en dolares = USD 920,00, la cifra del pie del flujo, y dice que no incluye 2 pagos',
        !!rec && rec.kids && textos(rec).join(' ').indexOf('920.00') !== -1 && textos(rec).join(' ').indexOf('no incluye 2 pagos sin dólares registrados') !== -1, rec && textos(rec));

      // O4 Un prestamo en pesos: la tabla de siempre, sin columnas de dolares.
      const lC = loans.filter(l => l.moneda !== 'USD' && X.flujoCajaDe(l, lpDe(l.id)).eventos.length >= 3)[0];
      const fC = montar(X.FlujoCajaPanel, { loan: lC, pays: lpDe(lC.id) }, [true]);
      const thsC = nodos(fC.arbol, n => n.tag === 'th').map(n => textos(n).join(''));
      R.check('O4 en pesos la tabla no cambia: "Ingreso" y sin dolares, TRM ni grupos',
        thsC.indexOf('Ingreso') !== -1 && ['Dólares entregados', 'TRM del ingreso', 'Lo que entró'].every(t => thsC.indexOf(t) === -1) && fC.todo.indexOf('TRM pactada') === -1, thsC);
    }
  }

  R.seccion('P — la cuota con pago parcial: una franja bajo su fila, con los pesos reales (post-4.1.5)');
  {
    // El prestamo de USD 1.600 del fixture, con su cuota 2 a medio pagar en memoria: un pago VIEJO (sin dolares
    // ni deuda por pago, como antes de 4.1.5) de USD 100 que entraron como $ 307.539, y uno NUEVO de USD 10 que
    // entraron como $ 40.000 (TRM 4.000).
    const lU = loans.filter(l => l.moneda === 'USD' && Math.round(l.montoOrigen) === 1600 && l.estado === 'Activo')[0];
    const c2 = lU && pays.filter(p => p.prestamoId === lU.id && p.cuotaN === 2)[0];
    R.check('P0 ANTI-VACIO: el prestamo de USD 1.600 y su cuota 2 sin pagar', !!c2 && c2.estadoPago !== 'Pagado', c2 && c2.estadoPago);
    if (c2) {
      const trm = lU.trmAcordada, obl1 = Math.round(100 * trm), obl2 = Math.round(10 * trm);
      const c2p = Object.assign({}, c2, { partialPaid: obl1 + obl2, montoCOPRecibido: 307539 + 40000, montoUSDRecibido: 110,
        recibos: JSON.stringify([{ fecha: '2026-07-20', cop: 307539 }, { fecha: '2026-07-28', cop: 40000, usd: 10, obl: obl2 }]) });
      const paysU = pays.map(p => p.id === c2.id ? c2p : p);
      const dpU = montar(X.DeudorPanel, Object.assign(propsPanel(lU), { pays: paysU }), []);
      const filas = conClase(dpU.arbol, 'dp-crono-f');
      const fila2 = filas.filter(f => /\bcon-parc\b/.test(f.props.className))[0];
      const franja = conClase(dpU.arbol, 'dp-crono-parc')[0];
      const tf = franja ? textos(franja).join('') : '';
      R.check('P1 la cuota con pago parcial lleva su franja, y la celda "Valor cuota" ya no dice "abonó · falta"',
        !!fila2 && !!franja && textos(fila2).join(' ').indexOf('abonó') === -1, fila2 && textos(fila2));
      const efectoNeto = (307539 + 40000) - (obl1 + obl2);
      R.check('P2 "Abonó": los dolares entregados y los PESOS QUE ENTRARON, con la TRM promedio',
        tf.indexOf('110.00') !== -1 && tf.indexOf('entraron ' + X.fmt(347539) + ' · TRM promedio ' + X.dpTRM(347539 / 110)) !== -1, tf);
      R.check('P2 "Falta": los dolares que faltan y los pesos "a la TRM pactada"',
        tf.indexOf(String(X.faltaUSD(c2p, trm).toFixed(2))) !== -1 && tf.indexOf(X.fmt(X.pendCuota(c2p)) + ' a la TRM pactada') !== -1, tf);
      R.check('P3 un renglon por pago con SU efecto TRM (el viejo, por diferencia) y el neto',
        tf.indexOf('−' + X.fmt(obl1 - 307539)) !== -1 && tf.indexOf('+' + X.fmt(40000 - obl2)) !== -1 &&
        tf.indexOf('Efecto TRM neto −' + X.fmt(-efectoNeto)) !== -1 && conClase(franja, 'dp-parc-pf').length === 4, tf);
      // Cobros: la misma regla en la fila de la cuota.
      const cbU = montar(X.CobrosView, Object.assign({}, propsCobros, { pays: paysU }), []);
      const filaCb = conClase(cbU.arbol, 'cbv-fila').map(f => textos(f).join(' ')).filter(t => /ya abonó/.test(t))[0] || '';
      R.check('P4 en Cobros: "ya abonó US$ 110.00 · entraron $ 347.539" (no la deuda a la TRM pactada)',
        filaCb.indexOf('ya abonó US$ 110.00 · entraron ' + X.fmt(347539)) !== -1, filaCb);
    }
    // En pesos: lo que entro es lo que se abono; sin TRM ni efecto.
    const lC = loans.filter(l => l.moneda !== 'USD' && l.estado === 'Activo' && l.modalidad === 'Capital + Intereses')[0];
    const cC = lC && pays.filter(p => p.prestamoId === lC.id && p.estadoPago !== 'Pagado' && !X.esAbono(p)).sort((a, b) => a.fechaPago.localeCompare(b.fechaPago))[0];
    if (cC) {
      const cCp = Object.assign({}, cC, { partialPaid: 71000, montoCOPRecibido: 71000, recibos: JSON.stringify([{ fecha: '2026-07-20', cop: 71000 }]) });
      const dpC = montar(X.DeudorPanel, Object.assign(propsPanel(lC), { pays: pays.map(p => p.id === cC.id ? cCp : p) }), []);
      const frC = conClase(dpC.arbol, 'dp-crono-parc')[0];
      const tC = frC ? textos(frC).join('') : '';
      R.check('P5 en pesos: "Abonó $ 71.000" y lo que falta, sin TRM ni efecto TRM',
        !!frC && tC.indexOf(X.fmt(71000)) !== -1 && tC.indexOf(X.fmt(X.pendCuota(cCp))) !== -1 && !/TRM/.test(tC), tC);
    } else R.check('P5 ANTI-VACIO: un prestamo en pesos con una cuota sin pagar', false);
    const panelCssP = leer('public/css/panel.css');
    R.check('P6 los estilos de la franja viven en panel.css', ['.v4p .dp-crono-parc {', '.v4p .dp-parc-pagos {', '.v4p .dp-parc-efecto {'].every(x => panelCssP.indexOf(x) !== -1));
  }

  R.seccion('Q — condonar con monto: el modal, el rótulo «Condonada» y Cobros (post-4.1.5)');
  {
    // El credito de solo intereses del fixture (cuotas de $300.000) con sus 5 cuotas vencidas al 31-jul.
    const lA = loans.find(l => l.id === '1773655076017');
    const moraA = pays.filter(p => p.prestamoId === lA.id && p.estadoPago === 'En Mora').sort((a, b) => a.fechaPago.localeCompare(b.fechaPago));
    R.check('Q0 ANTI-VACIO: 5 cuotas vencidas de $300.000', moraA.length === 5 && moraA.every(p => Math.round(p.cuotaTotal) === 300000), moraA.length);
    // El modal con $1.000.000 escritos (orden de useState: seleccion, motivo, enviando, monto).
    const enviados = [];
    const propsC = { loan: lA, pays, onConfirm: function(){ enviados.push([].slice.call(arguments)); return Promise.resolve(); }, onClose: () => {} };
    const mo = montar(X.CondonarModal, propsC, [undefined, undefined, undefined, '1.000.000']);
    const efectos = conClase(mo.arbol, 'cdm-ef').map(n => textos(n).join(''));
    R.eq('Q1 cada cuota dice lo que le pasaria: 3 condonadas, la cuarta en parte y la quinta sin cambio',
      efectos, ['Condonada', 'Condonada', 'Condonada', 'En parte · queda ' + X.fmt(200000), 'sin cambio']);
    const comp = conClase(mo.arbol, 'cdm-comp').map(n => textos(n).join(' '));
    const linea = r => comp.find(t => t.indexOf(r) === 0) || '';
    R.check('Q2 el antes y el despues: lo vencido de $1.500.000 a $500.000 y "Debes hoy" baja $1.000.000',
      linea('Lo vencido').indexOf(X.fmt(1500000) + ' → ' + X.fmt(500000)) !== -1 &&
      linea('Debes hoy').indexOf(X.fmt(4500000) + ' → ' + X.fmt(3500000)) !== -1 && linea('Cuotas vencidas').indexOf('5 → 2') !== -1, comp);
    const btn = botones(mo.arbol, /^Condonar \$/)[0];
    R.check('Q3 el boton dice cuanto se condona', !!btn && textos(btn).join('') === 'Condonar ' + X.fmt(1000000), btn && textos(btn));
    if (btn) btn.props.onClick();
    R.check('Q3 y manda el monto escrito en pesos, con las 5 cuotas marcadas', enviados.length === 1 && enviados[0][3] === 1000000 && enviados[0][1].length === 5, enviados);
    const mas = montar(X.CondonarModal, propsC, [undefined, undefined, undefined, '1.600.000']);
    const btnMas = botones(mas.arbol, /^Condonar/)[0];
    R.check('Q4 un monto mayor que lo vencido: el error lo dice y el boton queda apagado',
      conClase(mas.arbol, 'cdm-error').length === 1 && !!btnMas && btnMas.props.disabled === true, mas.todo.slice(0, 200));

    // Despues de condonar (en memoria, con el mismo reparto del modal): el panel y Cobros.
    const paysC = X.aplicarCondonacion(pays, X.planCondonacion(moraA, 1000000));
    const dp = montar(X.DeudorPanel, Object.assign(propsPanel(lA), { pays: paysC }), []);
    const chips = conClase(dp.arbol, 'op-chip').map(n => textos(n).join(''));
    R.eq('Q5 el cronograma rotula «Condonada» las 3 que el perdon saldo (siguen guardadas como pagadas)', chips.filter(t => t === 'Condonada').length, 3);
    const subs = conClase(dp.arbol, 'dp-condonado').map(n => textos(n).join(''));
    R.check('Q6 bajo el interes: «condonado $300.000» en las saldadas y «se condonó $100.000 de $300.000» en la que quedo en parte',
      subs.filter(t => t === 'condonado ' + X.fmt(300000)).length === 3 && subs.indexOf('se condonó ' + X.fmt(100000) + ' de ' + X.fmt(300000)) !== -1, subs);
    // En Cobros, las vencidas de un credito con 2+ van en un grupo plegado: se condona hasta dejar UNA
    // (4 completas y $100.000 de la quinta), que se ve como fila propia.
    const paysC1 = X.aplicarCondonacion(pays, X.planCondonacion(moraA, 1300000));
    const cb = montar(X.CobrosView, Object.assign({}, propsCobros, { pays: paysC1 }), []);
    const filaCb = conClase(cb.arbol, 'cbv-fila').map(f => textos(f).join(' ')).filter(t => t.indexOf('se condonó') !== -1);
    R.check('Q7 en Cobros, la cuota condonada en parte lo dice bajo lo que falta', filaCb.length === 1 && filaCb[0].indexOf('se condonó ' + X.fmt(100000)) !== -1 &&
      filaCb[0].indexOf(X.fmt(200000)) !== -1, filaCb);
    R.check('Q8 la app le pasa el monto escrito al backend (el modal lo manda en su cuarto argumento)',
      /function _doCondonar\(loanId,cuotas,obs,monto,genPdf\)\{[\s\S]{0,800}if\(monto!=null\) body\.monto=monto;/.test(leer('public/js/app.js')) &&
      /onConfirm:_doCondonar/.test(leer('public/js/app.js')));
    // La constancia en PDF: una casilla marcada por defecto; desmarcada, el modal manda `false` y la app no la emite.
    const casilla = conClase(mo.arbol, 'cdm-gen')[0];
    const chk = casilla && nodos(casilla, n => n.tag === 'input')[0];
    R.check('Q9 la casilla «Generar constancia de condonación (PDF)» nace marcada y viaja en el quinto argumento',
      !!chk && chk.props.checked === true && textos(casilla).join('') === 'Generar constancia de condonación (PDF)' && enviados[0][4] === true, enviados[0]);
    const sinPdf = montar(X.CondonarModal, propsC, [undefined, undefined, undefined, '1.000.000', false]);
    const btnSin = botones(sinPdf.arbol, /^Condonar \$/)[0];
    if (btnSin) btnSin.props.onClick();
    R.check('Q9 desmarcada, el modal manda false', enviados.length === 2 && enviados[1][4] === false, enviados[1]);
    const app = leer('public/js/app.js');
    R.check('Q10 la app la emite DESPUES de recargar, con lo aplicado (la respuesta del backend), solo si la casilla esta marcada',
      /function _doCondonar\(loanId,cuotas,obs,monto,genPdf\)/.test(app) &&
      /return reload\(\)\.then\(function\(fresh\)\{[\s\S]{0,1400}if\(fl&&genPdf!==false\) generateConstanciaCondonacion\(fl,fp,\{fecha:nowStr\(\),condonado:r\.condonado,cuotas:r\.cuotas/.test(app) &&
      /pre:\{loan:loanPre,pays:paysPre\}/.test(app));
    R.check('Q7 y las saldadas por el perdon ya no estan por cobrar', !conClase(cb.arbol, 'cbv-fila').some(f => moraA.slice(0, 3).some(m => textos(f).join(' ').indexOf(X.opCorta(m.fechaPago)) !== -1 && textos(f).join(' ').indexOf('Elena') !== -1)));
  }

  // ── R — CONGELAR PRESTAMO EN LA INTERFAZ (post-4.1.6, Fase 1) ────────────────────────
  // El credito de solo intereses del fixture (Elena, 3.000.000 al 10 %, dia 7, cuotas 4 a 8 vencidas),
  // congelado el 20-jul cobrando los 13 dias corridos: armado en memoria con el espejo de los modales
  // (`cgPlanCongelar`), que la seccion F de tests/congelar.js ata al servidor fila a fila.
  R.seccion('R — congelar: la marca, el aviso, los botones, la cuota de cierre y la marca en Cartera y Cobros');
  {
    const clsDe = n => ((n && n.props && n.props.className) || '').split(/\s+/);
    const lE = loans.find(l => l.id === '1773655076017');
    const plan = X.cgPlanCongelar(lE, pays, '2026-07-20', false, HOY);
    R.check('R0 ANTI-VACIO: el plan congela con cuota de cierre de $ 130.000 (13 dias) y quita 3 cuotas',
      plan.ok && plan.cierre && plan.cierre.interes === 130000 && plan.quitadas.length === 3, plan.error);
    const lC = plan.loanN;
    const paysC = pays.filter(p => p.prestamoId !== lE.id).concat(plan.paysN);
    const loansC = loans.map(l => l.id === lE.id ? lC : l);
    const pp = extra => Object.assign(propsPanel(lC), { loans: loansC, pays: paysC }, extra || {});
    const dp = montar(X.DeudorPanel, pp(), []);
    const t = dp.todo.replace(/ /g, ' ');
    R.check('R1 la marca «❄ Congelado desde 20 jul» en la cabecera del prestamo y «congelado» en su pestaña',
      conClase(dp.arbol, 'dp-chip-hielo').some(n => textos(n).join('') === '❄ Congelado desde 20 jul') && /❄ congelado/.test(t));
    const aviso = conClase(dp.arbol, 'dp-hielo-aviso')[0];
    const tAv = aviso ? textos(aviso).join('').replace(/ /g, ' ') : '';
    R.check('R2 el aviso: desde cuando, lo vencido que se sigue debiendo y la cuota que se cerro con sus dias',
      /Congelado desde el 20 jul 2026\./.test(tAv) && /Las 5 cuotas vencidas se siguen debiendo/.test(tAv) &&
      /La cuota del 7 ago 2026 se cerró con 13 días de interés \(\$ 130\.000 en vez de \$ 300\.000\)/.test(tAv) && /El capital no cambia/.test(tAv), tAv);
    llamadasAcc.length = 0;
    const bDes = botones(dp.arbol, /^Descongelar$/);
    R.check('R3 el boton «Descongelar» a la vista, ANTES de Registrar cobro, y abre su ventana con ese prestamo',
      bDes.length === 1 && nodos(conClase(dp.arbol, 'dp-acc')[0], n => n.tag === 'button').map(b => textos(b).join(''))[0] === 'Descongelar');
    if (bDes[0]) bDes[0].props.onClick();
    R.eq('R3 (la accion)', llamadasAcc.map(x => x.k + ':' + x.arg.id), ['onDescongelar:' + lE.id]);
    R.check('R3 «Registrar cobro» sigue (lo vencido se cobra), ya no como boton principal',
      botones(dp.arbol, /^Registrar cobro$/).length === 1 && clsDe(botones(dp.arbol, /^Registrar cobro$/)[0]).indexOf('pri') === -1);
    const dpM = montar(X.DeudorPanel, pp(), [undefined, undefined, true]);
    const menu = conClase(dpM.arbol, 'dp-menu')[0];
    const ops = menu ? nodos(menu, n => n.tag === 'button').map(b => textos(b).join('')) : [];
    R.eq('R4 el menu «Más» congelado: sin cambiar dia ni congelar otra vez (condonar y editar siguen)',
      ops, ['Condonar intereses', 'Editar datos', 'Cerrar préstamo (forzar)', 'Eliminar préstamo']);
    R.check('R4 y dice por que: «Cambiar el día de pago: descongélalo primero.»',
      conClase(dpM.arbol, 'dp-menu-nota').some(n => textos(n).join('') === 'Cambiar el día de pago: descongélalo primero.'));
    const cierre = conClase(dp.arbol, 'cierre').filter(n => clsDe(n).indexOf('dp-crono-f') !== -1)[0];
    const tCi = cierre ? textos(cierre).join(' ').replace(/ /g, ' ') : '';
    R.check('R5 el cronograma: la cuota de cierre con su chip, sus dias (del 7 jul al 20 jul), sin capital, y lo que valia antes',
      !!cierre && /Cierre/.test(tCi) && /cierre: 13 días de interés \(del 7 jul al 20 jul\), sin capital/.test(tCi) && /antes \$ 300\.000/.test(tCi) && /\$ 130\.000/.test(tCi), tCi);
    R.check('R5 y la franja del congelamiento al final («no corren intereses ni se generan cuotas»)',
      conClase(dp.arbol, 'dp-hielo').some(n => /Congelado desde el 20 jul 2026 · no corren intereses ni se generan cuotas/.test(textos(n).join(''))));
    R.check('R6 «Lo que queda por vencer»: la de cierre, y despues nada; la renta mensual, en pausa',
      /Lo que queda por vencer/.test(t) && /la de cierre; después, nada/.test(t) && /En pausa/.test(t));
    // Sin congelar, el mismo prestamo ofrece «Congelar préstamo» y la abre con ese prestamo.
    const dpN = montar(X.DeudorPanel, propsPanel(lE), [undefined, undefined, true]);
    const opN = nodos(conClase(dpN.arbol, 'dp-menu')[0], n => n.tag === 'button');
    llamadasAcc.length = 0;
    opN.filter(b => textos(b).join('') === 'Congelar préstamo').forEach(b => b.props.onClick());
    R.eq('R7 sin congelar, «Más» ofrece «Congelar préstamo» y abre su ventana', llamadasAcc.map(x => x.k + ':' + x.arg.id), ['onCongelar:' + lE.id]);
    const lPU = loans.find(l => l.modalidad === 'Pago Unico' && l.estado === 'Activo');
    const opPU = nodos(conClase(montar(X.DeudorPanel, propsPanel(lPU), [undefined, undefined, true]).arbol, 'dp-menu')[0], n => n.tag === 'button').map(b => textos(b).join(''));
    R.check('R7 un Pago único no ofrece congelar (no genera interés por período)', !!lPU && opPU.indexOf('Congelar préstamo') === -1, opPU);
    // Descongelado: la franja del periodo congelado va antes de la primera cuota nueva, que dice sus dias.
    const plan2 = X.cgPlanDescongelar(lC, paysC, HOY, null, HOY);
    const paysD = paysC.filter(p => p.prestamoId !== lE.id).concat(plan2.paysN);
    const dpD = montar(X.DeudorPanel, Object.assign(propsPanel(plan2.loanN), { loans: loans.map(l => l.id === lE.id ? plan2.loanN : l), pays: paysD }), []);
    const tD = dpD.todo.replace(/ /g, ' ');
    R.check('R8 descongelado: «Congelado del 20 jul 2026 al 31 jul 2026 · 11 días sin intereses ni cuotas», y la cuota 10 cobra 7 dias desde el 31 jul',
      plan2.ok && conClase(dpD.arbol, 'dp-hielo').some(n => textos(n).join('') === 'Congelado del 20 jul 2026 al 31 jul 2026 · 11 días sin intereses ni cuotas') &&
      /primera tras descongelar: 7 días de interés desde el 31 jul/.test(tD) && conClase(dpD.arbol, 'reanuda').length === 1 &&
      conClase(dpD.arbol, 'dp-hielo-aviso').length === 0 && botones(dpD.arbol, /^Descongelar$/).length === 0,
      { ok: plan2.ok, franja: /Congelado del 20 jul 2026 al 31 jul 2026 · 11 días sin intereses ni cuotas/.test(tD), primera: /primera tras descongelar: 7 días de interés desde el 31 jul/.test(tD),
        reanuda: conClase(dpD.arbol, 'reanuda').length, hielo: conClase(dpD.arbol, 'dp-hielo').map(n => textos(n).join('')), crono: conClase(dpD.arbol, 'dp-crono-f').map(n => textos(n).join(' ')).slice(-4) });
    // Cartera: el filtro «Congelados» solo existe con alguien congelado, y el chip del prestamo lo dice.
    const ctC = montar(X.CarteraView, Object.assign({}, propsCartera, { loans: loansC, pays: paysC }), []);
    const filtros = conClase(ctC.arbol, 'ctv-filtro').map(n => textos(n).join(''));
    R.check('R9 Cartera: el filtro «Congelados» con su conteo (1) y el chip «· ❄ congelado»',
      filtros.indexOf('Congelados1') !== -1 && conClase(ctC.arbol, 'congelado').some(n => /❄ congelado/.test(textos(n).join(''))), filtros);
    const ctN = montar(X.CarteraView, propsCartera, []);
    R.check('R9 sin ningun congelado, el filtro no aparece', conClase(ctN.arbol, 'ctv-filtro').every(n => !/^Congelados/.test(textos(n).join(''))));
    const ctF = montar(X.CarteraView, Object.assign({}, propsCartera, { loans: loansC, pays: paysC }), [undefined, 'congelados']);
    R.check('R9 y filtra: solo queda Elena', conClase(ctF.arbol, 'ctv-nombre').map(n => textos(n).join('')).join('|') === 'Elena Vargas',
      conClase(ctF.arbol, 'ctv-nombre').map(n => textos(n).join('')));
    // Cobros: lo vencido de un credito congelado se sigue cobrando, con su marca; la cuota de cierre lo dice.
    const cb = montar(X.CobrosView, Object.assign({}, propsCobros, { loans: loansC, pays: paysC }), []);
    const filasE = conClase(cb.arbol, 'cbv-fila').map(f => textos(f).join(' ')).filter(x => x.indexOf('Elena') !== -1);
    R.check('R10 Cobros: las filas de Elena llevan «❄ congelado» y la del 7 ago dice «de cierre»',
      filasE.length >= 2 && filasE.every(x => /❄ congelado/.test(x)) && filasE.some(x => /cuota 9 · de cierre/.test(x)), filasE);
    // El Historial nombra los dos movimientos nuevos.
    const log = [{ id: 1, fecha: '2026-07-31 10:00:00', tipo: 'congelar', mensaje: 'Congelaste el préstamo de Elena Vargas desde el 20 de julio de 2026', undo_id: null },
      { id: 2, fecha: '2026-07-31 11:00:00', tipo: 'descongelar', mensaje: 'Descongelaste el préstamo de Elena Vargas el 31 de julio de 2026', undo_id: null }];
    const hv = montar(X.HistorialView, { actLog: log, undoLog: [], onUndo: () => {}, onRefresh: () => {}, deudores: deudores }, []);
    R.check('R12 Historial: «Congelado» y «Descongelado» con su rotulo (no el tipo crudo)', /Congelado/.test(hv.todo) && /Descongelado/.test(hv.todo) && !/\bcongelar\b|\bdescongelar\b/.test(hv.todo), hv.todo.slice(0, 200));
    // La edicion bloquea los campos financieros de un prestamo con un congelamiento en su historia.
    R.check('R13 LoanModal: un congelamiento en la historia cuenta como actividad (campos financieros bloqueados)',
      /if\(loan\.congeladoDesde\|\|congelamientosDe\(loan\)\.length\) return true;/.test(leer('public/js/modales/LoanModal.js')));
  }

  process.exit(R.finalizar());
})().catch(e => { console.error(e); process.exit(1); });
