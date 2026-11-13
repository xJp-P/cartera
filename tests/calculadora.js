// tests/calculadora.js — la CALCULADORA (rediseño v4): los calculos exactos y la vista nueva.
//
// El rediseño de la Calculadora es estrictamente visual: la matematica de la simulacion paso, sin cambios,
// a la funcion pura `clvSimular` (vistas/CalcView.js). Esta suite fija:
//   A. LA EXACTITUD: (1) `clvSimular` da EXACTAMENTE lo mismo que el calculo de antes del rediseño (copiado
//      aqui tal cual) en un barrido de montos, tasas, plazos, frecuencias, modalidades y monedas; y (2) el
//      cronograma tentativo de Capital + Intereses coincide fila a fila con el que el MOTOR del backend
//      (`buildSchedule`) generaria al crear ese prestamo, en las tres frecuencias.
//   B. LA VISTA: dos tarjetas (datos y resultado), los campos `.inp`, la moneda, la modalidad y la
//      frecuencia en pastilla, el estado vacio, la cuota grande y las cuatro cifras que salen de la
//      simulacion, la conversion en dolares, el cronograma, "Confirmar y crear" (principal) con los mismos
//      datos que antes y "Limpiar"; sin colores en linea.
//   C. LA HOJA calc.css: enlazada en orden, cada clase `clv-` con su regla, los campos de 44 px con el anillo
//      azul, el boton principal negro/blanco (sin el verde viejo) y lo que salio de styles.css.
//
// Se ejecuta:
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron tests/calculadora.js

const fs   = require('fs');
const path = require('path');
const { Reporter } = require('./lib/report');
const { REPO }     = require('./lib/paths');

const R = new Reporter('calculadora');
const leer = p => fs.readFileSync(path.join(REPO, p), 'utf8');

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
const clsDe = n => ((n && n.props && n.props.className) || '').split(/\s+/).filter(Boolean);
const conClase = (arbol, c) => nodos(arbol, n => clsDe(n).indexOf(c) !== -1);
const unir = n => textos(n).join('');
const boton = (arbol, txt) => nodos(arbol, n => n.tag === 'button' && unir(n).indexOf(txt) !== -1)[0];

(async () => {
  const { cargarFrontend } = require('./lib/load-frontend');
  const FE = cargarFrontend({ silenciarConsola: true });
  const X = FE.sandbox;
  const engine = require('../backend/core/engine');

  // El calculo de la Calculadora ANTES del rediseño (el cuerpo del useMemo de la vista vieja, tal cual).
  function simViejo(monto, modalidad, tasa, plazo, moneda, trmCalc, frecCalc) {
    var pv = moneda === 'USD' ? Math.round((+monto || 0) * (+trmCalc || 1)) : (+monto || 0);
    var rMensual = (+tasa || 0) / 100;
    var r = frecCalc === 'Semanal' ? rMensual / 4.33 : frecCalc === 'Quincenal' ? rMensual / 2 : rMensual;
    var n = +plazo || 12;
    if (!pv || !r) return null;
    var cuota, intP, capP;
    if (modalidad === 'Intereses') { intP = Math.round(pv * r); capP = 0; cuota = intP; }
    else { cuota = Math.round(X.pmt(r, n, pv)); intP = Math.round(pv * r); capP = cuota - intP; }
    var nCuotas = modalidad === 'Intereses' ? Math.min(n || 12, 24) : n;
    var rows = X.filasPreview(pv, r, nCuotas, modalidad === 'Intereses', cuota);
    var totalInt = rows.reduce(function (s, r) { return s + r.interes; }, 0);
    var totalPagar = rows.reduce(function (s, r) { return s + r.cuota; }, 0);
    return { cuota: cuota, intP: intP, capP: capP, rows: rows, totalInt: totalInt, totalPagar: totalPagar, montoCOP: pv };
  }

  // ── A — LA EXACTITUD ──────────────────────────────────────────────────────
  R.seccion('A — los calculos: identicos a los de antes y al motor del backend');
  R.check('A0 el arnes ve CalcView y la simulacion pura', typeof X.CalcView === 'function' && typeof X.clvSimular === 'function');
  const MONTOS = ['', '1', '1000', '999999', '5000000', '123456789'], TASAS = ['', '0', '0.5', '2', '5', '7.25'], PLAZOS = ['', '1', '6', '12', '36'];
  const FRECS = ['Semanal', 'Quincenal', 'Mensual'], MODS = ['Intereses', 'Capital + Intereses'], MONEDAS = [['COP', ''], ['USD', '4200'], ['USD', '3987.5'], ['USD', '']];
  let casos = 0, conSim = 0; const malos = [];
  for (const m of MONTOS) for (const t of TASAS) for (const p of PLAZOS) for (const f of FRECS) for (const mo of MODS) for (const [mon, trm] of MONEDAS) {
    casos++;
    const a = JSON.stringify(X.clvSimular({ monto: m, modalidad: mo, tasa: t, plazo: p, moneda: mon, trm: trm, frec: f }));
    const b = JSON.stringify(simViejo(m, mo, t, p, mon, trm, f));
    if (b !== 'null') conSim++;
    if (a !== b && malos.length < 5) malos.push({ m, t, p, f, mo, mon, trm });
  }
  R.check('A1 en ' + casos + ' combinaciones (' + conSim + ' con simulacion) el resultado es identico al de antes del rediseño', malos.length === 0 && conSim > 1000, malos);
  R.check('A1 sin valor o sin tasa no hay simulacion (y no revienta)', X.clvSimular({ monto: '', tasa: '2', frec: 'Mensual', modalidad: 'Intereses', moneda: 'COP' }) === null &&
    X.clvSimular({ monto: '1000000', tasa: '', frec: 'Mensual', modalidad: 'Intereses', moneda: 'COP' }) === null);
  // Contra el MOTOR: el cronograma tentativo de C+I es el que se crearia.
  let filasMotor = 0; const distintos = [];
  for (const monto of [100000, 1000000, 5000000, 12345678]) for (const tasa of [1, 2.5, 5, 9.8933]) for (const plazo of [1, 6, 12, 24]) for (const f of FRECS) {
    const s = X.clvSimular({ monto: String(monto), modalidad: 'Capital + Intereses', tasa: String(tasa), plazo: String(plazo), moneda: 'COP', frec: f });
    const loan = { id: 'C', nombre: 'Simulado', modalidad: 'Capital + Intereses', montoCOP: monto, tasaMensual: tasa, plazoMeses: plazo, frecuencia: f, fechaInicio: '2026-07-01', diaPago: 1 };
    const mot = engine.buildSchedule(loan, 1, monto, plazo);
    filasMotor += mot.length;
    const ok = mot.length === s.rows.length && mot.every((r, i) => r.cuotaTotal === s.rows[i].cuota && r.interesPeriodo === s.rows[i].interes &&
      r.abonoCapital === s.rows[i].capital && r.saldoFinal === s.rows[i].saldo);
    if (!ok && distintos.length < 5) distintos.push({ monto, tasa, plazo, f });
  }
  R.check('A2 Capital + Intereses: el cronograma tentativo coincide fila a fila con el del motor (' + filasMotor + ' filas, tres frecuencias)', distintos.length === 0 && filasMotor > 1000, distintos);
  const si = X.clvSimular({ monto: '2000000', modalidad: 'Intereses', tasa: '3', plazo: '36', moneda: 'COP', frec: 'Mensual' });
  R.check('A3 Intereses: la cuota es el interes del periodo, sin capital, y se simulan hasta 24 cuotas', si.cuota === 60000 && si.capP === 0 && si.rows.length === 24 &&
    si.totalInt === 24 * 60000 && si.rows.every(r => r.capital === 0 && r.saldo === 2000000));
  const su = X.clvSimular({ monto: '1000', modalidad: 'Capital + Intereses', tasa: '2', plazo: '12', moneda: 'USD', trm: '4200', frec: 'Mensual' });
  R.check('A4 en dolares el calculo se hace en pesos a la TRM acordada', su.montoCOP === 4200000 && su.rows[11].saldo === 0 &&
    su.rows.reduce((s, r) => s + r.capital, 0) === 4200000);

  // ── B — LA VISTA ──────────────────────────────────────────────────────────
  R.seccion('B — la vista v4');
  const usOrig = X.useState;
  const montar = (props, estado) => {
    const llamadas = []; let i = 0;
    X.useState = init => { const k = i++; const v = (estado && k < estado.length && estado[k] !== undefined) ? estado[k] : (typeof init === 'function' ? init() : init);
      return [v, nuevo => llamadas.push([k, nuevo])]; };
    try { return { arbol: pintar({ type: X.CalcView, props, children: [] }), llamadas }; } finally { X.useState = usOrig; }
  };
  const confirmados = [];
  const props = { onConfirm: d => confirmados.push(d) };
  // Orden de estados: monto, modalidad, tasa, plazo, showCrono, moneda, trm, frecuencia, anima.
  const vacia = montar(props).arbol;
  R.check('B1 dos tarjetas: los datos y el resultado', clsDe(vacia).indexOf('v4k') !== -1 && conClase(vacia, 'clv-grid').length === 1 &&
    conClase(vacia, 'v4-card').length === 2 && conClase(vacia, 'clv-datos').length === 1 && conClase(vacia, 'clv-res').length === 1);
  const segs = conClase(vacia, 'cbv-seg');
  R.eq('B2 moneda, modalidad y frecuencia en pastilla, con la opcion elegida', segs.map(s => nodos(s, n => n.tag === 'button').map(b => (clsDe(b).indexOf('on') !== -1 ? '*' : '') + unir(b)).join('|')),
    ['*Pesos (COP)|Dólares (USD)', '*Solo intereses|Capital + Intereses', 'Semanal|Quincenal|*Mensual']);
  const inputs = nodos(vacia, n => n.tag === 'input');
  R.check('B2 los campos de texto son `.inp` (valor, tasa y plazo; la TRM aparece con dolares)', inputs.length === 3 && inputs.every(n => clsDe(n).indexOf('inp') !== -1));
  R.check('B3 sin datos: el estado vacio, sin cifras', conClase(vacia, 'clv-vacio').length === 1 && conClase(vacia, 'clv-cuota').length === 0);
  const est = ['5000000', 'Capital + Intereses', '2', '12', true, 'COP', '', 'Mensual', false];
  const v = montar(props, est).arbol;
  const s = X.clvSimular({ monto: '5000000', modalidad: 'Capital + Intereses', tasa: '2', plazo: '12', moneda: 'COP', trm: '', frec: 'Mensual' });
  const kvs = conClase(v, 'clv-kv').map(k => [unir(conClase(k, 'clv-kv-l')[0]), unir(conClase(k, 'clv-kv-v')[0])]);
  R.eq('B4 las cuatro cifras salen de la simulacion', kvs, [['Interés de la 1.ª cuota', X.fmt(s.intP)], ['Abono a capital de la 1.ª cuota', X.fmt(s.capP)],
    ['Ganancia en intereses', X.fmt(s.totalInt)], ['Total a recibir', X.fmt(s.totalPagar)]]);
  R.check('B4 la cuota grande, con su rotulo de la frecuencia', unir(conClase(v, 'clv-cuota')[0]).indexOf('Cuota mensual fija') === 0 &&
    unir(conClase(v, 'clv-cuota-v')[0]).replace(/\s/g, '') === X.fmt(s.cuota).replace(/\s/g, ''));
  const filas = nodos(conClase(v, 'clv-crono')[0], n => n.tag === 'tr').slice(1);
  R.check('B5 el cronograma tentativo: las columnas universales y una fila por cuota', filas.length === 12 &&
    nodos(conClase(v, 'clv-crono')[0], n => n.tag === 'th').map(unir).join('|') === '#|Interés|Abono a capital|Valor cuota|Saldo' &&
    filas.every((f, i) => unir(f.kids[3]) === X.fmtN(s.rows[i].cuota) && unir(f.kids[4]) === X.fmtN(s.rows[i].saldo)));
  const crear = boton(v, 'Confirmar y crear');
  R.check('B6 "Confirmar y crear" es el boton principal (negro/blanco)', clsDe(crear).join(' ') === 'v4-btn pri clv-crear');
  crear.props.onClick();
  R.eq('B6 y le pasa a App los mismos datos de siempre', confirmados, [{ montoOrigen: 5000000, modalidad: 'Capital + Intereses', tasaMensual: 2, plazoMeses: 12, frecuencia: 'Mensual' }]);
  const vu = montar(props, ['1000', 'Capital + Intereses', '2', '12', false, 'USD', '4200', 'Mensual', false]).arbol;
  boton(vu, 'Confirmar y crear').props.onClick();
  R.eq('B6 en dolares, con la moneda y la TRM', confirmados[1], { montoOrigen: 1000, modalidad: 'Capital + Intereses', tasaMensual: 2, plazoMeses: 12, frecuencia: 'Mensual', moneda: 'USD', trmAcordada: 4200 });
  R.check('B7 en dolares: el campo de la TRM, la equivalencia y la conversion, y cada cifra con su linea en dolares',
    nodos(vu, n => n.tag === 'input').length === 4 && unir(conClase(vu, 'clv-pista')[0]) === 'Equivale a ' + X.fmt(4200000) + ' en pesos' &&
    unir(conClase(vu, 'clv-conv')[0]).indexOf('= ' + X.fmt(4200000)) !== -1 && conClase(vu, 'clv-kv').every(k => conClase(k, 'dp-usd').length === 1));
  const lim = montar(props, est);
  boton(lim.arbol, 'Limpiar').props.onClick();
  R.eq('B8 "Limpiar" vuelve todo al inicio', lim.llamadas.map(c => c[0] + '=' + JSON.stringify(c[1])),
    ['0=""', '1="Intereses"', '2=""', '3=""', '4=false', '5="COP"', '6=""', '7="Mensual"']);
  const errores = []; const seAnt = X.showError; X.showError = m => errores.push(m);
  try { const n0 = confirmados.length; boton(vacia, 'Confirmar y crear').props.onClick(); R.check('B8 sin simulacion, "Confirmar" avisa y no crea nada', confirmados.length === n0 && errores.length === 1); }
  finally { X.showError = seAnt; }
  // Solo variables CSS (el retardo de entrada `--i` y la posicion de la pastilla `--n`/`--k`), nunca un color.
  const conEstilo = nodos(v, n => n.props && n.props.style && Object.keys(n.props.style).some(k => k.indexOf('--') !== 0));
  R.check('B9 sin colores ni estilos en linea (solo variables CSS: el retardo de entrada y la pastilla)', conEstilo.length === 0, conEstilo.slice(0, 3).map(n => n.props.style));

  // ── C — LA HOJA ───────────────────────────────────────────────────────────
  R.seccion('C — calc.css y lo que salio de styles.css');
  const css = leer('public/css/calc.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const cc = css.replace(/\s+/g, ' ');
  const fuente = leer('public/js/vistas/CalcView.js');
  // `clv-datos` y `clv-res` solo nombran las dos tarjetas (sin estilo propio: son `.v4-card clv-card`).
  const usadas = Array.from(new Set(fuente.match(/clv-[a-z0-9-]+/g) || [])).filter(c => c !== 'clv-datos' && c !== 'clv-res');
  const sinRegla = usadas.filter(c => !new RegExp('\\.' + c + '(?![A-Za-z0-9_-])').test(css));
  R.check('C1 cada clase clv- de la vista tiene su regla (' + usadas.length + ' clases)', usadas.length >= 25 && sinRegla.length === 0, sinRegla);
  R.check('C2 los campos: 44 px, superficie 2 y el anillo azul de foco, como en los modales',
    /\.v4k \.inp \{ min-height: 44px; padding: 10px 13px; border: 1px solid var\(--line\); border-radius: 12px; background: var\(--surface-2\);/.test(cc) &&
    cc.indexOf('.v4k .inp:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); background: var(--surface); }') !== -1);
  R.check('C3 sin el verde viejo: ni btn-primary ni colores de la paleta anterior en la vista o en la hoja',
    !/btn-primary|var\(--(green|green2|yellow|blue)\)|rgba\(63, ?185, ?80/.test(fuente) && !/var\(--(green|green2|yellow|blue)\b/.test(css));
  R.check('C4 a 1.100 px o menos, una tarjeta por fila', /@media \(max-width: 1100px\) \{ \.clv-grid \{ grid-template-columns: 1fr; \} \}/.test(cc));
  R.check('C5 index.html carga calc.css despues de historial.css', /href="\/css\/historial\.css">\s*<link[^>]*href="\/css\/calc\.css">/.test(leer('public/index.html')));
  R.check('C5 styles.css ya no trae `.fade-in` (solo la usaba la Calculadora vieja); fadeIn sigue (la usan otras)',
    !/\.fade-in/.test(leer('public/css/styles.css')) && /@keyframes fadeIn/.test(leer('public/css/styles.css')));
  R.check('C6 nada del prototipo en produccion', ['v4-forzar', 'proto-chip', 'PROTOTIPO'].every(x => css.indexOf(x) === -1 && fuente.indexOf(x) === -1));

  process.exit(R.finalizar());
})().catch(e => { console.error(e); process.exit(1); });
