// public/js/vistas/CalcView.js — Calculadora: simula un prestamo antes de registrarlo (rediseño v4).
//
// La MATEMATICA es la de siempre, sin un solo cambio: vive en `clvSimular` (pura, para que
// tests/calculadora.js la compare con el motor del backend y con la formula de antes). La cuota sale
// de `pmt` y el cronograma tentativo de `filasPreview` (core/calculo.js), el espejo del motor que
// comparte con el formulario del prestamo (Bug #51). "Confirmar y crear" pasa los datos a App, que
// abre el formulario del prestamo nuevo ya lleno (como antes).
//
// La PRESENTACION sigue el sistema v4 de las demas pestañas (estilos en public/css/calc.css, bajo
// `.v4k`, prefijo `clv-`): dos tarjetas (los datos y el resultado), campos de 44 px con el anillo azul
// de foco de los modales, moneda, modalidad y frecuencia en pastilla, la cuota como cifra grande,
// cifras neutras en Inter, y el boton principal negro/blanco.

import { Fld } from '../componentes/base.js';
import { Ico } from '../componentes/iconos.js';
import { showError } from '../core/api.js';
import { pmt, filasPreview } from '../core/calculo.js';
import { opModalidad } from '../core/operacion.js';
import { copToUsd, fmt, fmtN, fmtNumInput, parseNum } from '../core/format.js';
import { h, useMemo, useState } from '../core/react.js';
import { usdLinea } from '../componentes/CifraUSD.js';
import { V4Dinero, v4PuedeAnimar } from './DashView.js';
import { CbvSeg } from './CobrosView.js';

// La simulacion: { monto, modalidad, tasa, plazo, moneda, trm, frec } -> null (faltan datos) o
// { cuota, intP, capP, rows, totalInt, totalPagar, montoCOP }. Es el calculo de siempre de la Calculadora.
// (No se exporta: solo la usa esta vista; las pruebas la alcanzan por el arnes, que aplana los modulos.)
function clvSimular(e){
  var pv = e.moneda === 'USD' ? Math.round((+e.monto || 0) * (+e.trm || 1)) : (+e.monto || 0);
  var rMensual = (+e.tasa || 0) / 100;
  var r = e.frec === 'Semanal' ? rMensual / 4.33 : e.frec === 'Quincenal' ? rMensual / 2 : rMensual;
  var n = +e.plazo || 12;
  if (!pv || !r) return null;
  var cuota, intP, capP;
  if (e.modalidad === 'Intereses'){
    intP = Math.round(pv * r); capP = 0; cuota = intP;
  } else {
    cuota = Math.round(pmt(r, n, pv));
    intP = Math.round(pv * r); capP = cuota - intP;
  }
  // Mismo bucle que el preview de LoanModal: vive en `filasPreview` (core/calculo.js), espejo del motor.
  // Antes eran dos copias y ninguna corregia la ultima cuota (Bug #51).
  var nCuotas = e.modalidad === 'Intereses' ? Math.min(n || 12, 24) : n;
  var rows = filasPreview(pv, r, nCuotas, e.modalidad === 'Intereses', cuota);
  var totalInt = rows.reduce(function(s, x){ return s + x.interes; }, 0);
  var totalPagar = rows.reduce(function(s, x){ return s + x.cuota; }, 0);
  return { cuota: cuota, intP: intP, capP: capP, rows: rows, totalInt: totalInt, totalPagar: totalPagar, montoCOP: pv };
}

var CLV_MONEDAS = [['COP', 'Pesos (COP)'], ['USD', 'Dólares (USD)']];
var CLV_MODALIDADES = ['Intereses', 'Capital + Intereses'].map(function(m){ return [m, opModalidad(m)]; });
var CLV_FRECUENCIAS = [['Semanal', 'Semanal'], ['Quincenal', 'Quincenal'], ['Mensual', 'Mensual']];
var CLV_PERIODO = { Semanal: 'semanal', Quincenal: 'quincenal', Mensual: 'mensual' };

export function CalcView(props){
  var onConfirm = props.onConfirm;
  // El orden de estos estados es el de siempre (las pruebas siembran por posicion); la animacion, al final.
  var s1 = useState(''); var monto = s1[0]; var setMonto = s1[1];
  var s2 = useState('Intereses'); var modalidad = s2[0]; var setModalidad = s2[1];
  var s3 = useState(''); var tasa = s3[0]; var setTasa = s3[1];
  var s4 = useState(''); var plazo = s4[0]; var setPlazo = s4[1];
  var s5 = useState(false); var showCrono = s5[0]; var setShowCrono = s5[1];
  var s6 = useState('COP'); var moneda = s6[0]; var setMoneda = s6[1];
  var s7 = useState(''); var trmCalc = s7[0]; var setTrmCalc = s7[1];
  var s8 = useState('Mensual'); var frecCalc = s8[0]; var setFrecCalc = s8[1];
  var s9 = useState(v4PuedeAnimar); var anima = s9[0];

  var montoCOP = moneda === 'USD' ? Math.round((+monto || 0) * (+trmCalc || 1)) : (+monto || 0);
  var sim = useMemo(function(){
    return clvSimular({ monto: monto, modalidad: modalidad, tasa: tasa, plazo: plazo, moneda: moneda, trm: trmCalc, frec: frecCalc });
  }, [monto, modalidad, tasa, plazo, moneda, trmCalc, frecCalc]);
  var esUSD = moneda === 'USD';
  var usd = function(cop, estilo){ return esUSD && usdLinea(copToUsd(cop, +trmCalc), estilo || { fontSize: 11 }); };

  function limpiar(){ setMonto(''); setModalidad('Intereses'); setTasa(''); setPlazo(''); setShowCrono(false); setMoneda('COP'); setTrmCalc(''); setFrecCalc('Mensual'); }

  function confirmar(){
    if (!sim){ showError('Ingresa datos válidos para simular'); return; }
    var data = { montoOrigen: +monto, modalidad: modalidad, tasaMensual: +tasa, plazoMeses: +plazo || 12, frecuencia: frecCalc };
    if (moneda === 'USD'){ data.moneda = 'USD'; data.trmAcordada = +trmCalc || 1; }
    onConfirm(data);
  }

  var periodo = CLV_PERIODO[frecCalc] || 'mensual';
  var rotuloCuota = modalidad === 'Intereses' ? 'Cuota de interés ' + periodo : 'Cuota ' + periodo + ' fija';

  // Una cifra del resultado: rotulo arriba, valor (y su linea en dolares) abajo.
  function kv(rotulo, valor, clase){
    return h('div', { className: 'clv-kv' + (clase ? ' ' + clase : '') },
      h('div', { className: 'clv-kv-l' }, rotulo),
      h('div', { className: 'clv-kv-v' }, fmt(valor)),
      usd(valor));
  }

  return h('div', { className: 'v4k' + (anima ? ' anima' : '') },
    h('div', { className: 'clv-intro', style: { '--i': -1 } },
      h('span', null, 'Simula un préstamo antes de registrarlo: la cuota, lo que ganas y el cronograma tentativo. Nada se guarda hasta que confirmes.'),
      h('button', { className: 'v4-btn ghost sm', onClick: limpiar }, h(Ico, { name: 'x', size: 14, sw: 2.3 }), 'Limpiar')),

    h('div', { className: 'clv-grid' },
      // ── Los datos ──
      h('section', { className: 'v4-card clv-card clv-datos', style: { '--i': 0 } },
        h('div', { className: 'clv-card-h' },
          h('span', { className: 'clv-ico' }, h(Ico, { name: 'calc', size: 17, sw: 2 })),
          h('div', null, h('div', { className: 'v4-titulo' }, 'Datos del préstamo'), h('div', { className: 'v4-sub' }, 'La cuota se calcula mientras escribes.'))),
        h('div', { className: 'clv-campo' },
          h('div', { className: 'clv-campo-l' }, 'Moneda'),
          h(CbvSeg, { valor: moneda, onChange: setMoneda, opciones: CLV_MONEDAS })),
        esUSD && h(Fld, { label: 'TRM acordada *' },
          h('input', { type: 'text', inputMode: 'numeric', value: fmtNumInput(trmCalc), onChange: function(e){ setTrmCalc(parseNum(e.target.value)); }, placeholder: 'Ej: 4.200', className: 'inp' })),
        h(Fld, { label: 'Valor del préstamo (' + moneda + ') *' },
          h('input', { type: 'text', inputMode: 'numeric', value: fmtNumInput(monto), onChange: function(e){ setMonto(parseNum(e.target.value)); }, placeholder: esUSD ? 'Ej: 1.000' : 'Ej: 5.000.000', className: 'inp' }),
          esUSD && monto && trmCalc && h('div', { className: 'clv-pista' }, 'Equivale a ' + fmt(montoCOP) + ' en pesos')),
        h('div', { className: 'clv-campo' },
          h('div', { className: 'clv-campo-l' }, 'Modalidad',
            h('span', { className: 'tooltip-wrap clv-ayuda' },
              h('span', { className: 'clv-ayuda-i', 'aria-label': 'Qué significa cada modalidad' }, 'i'),
              h('span', { className: 'tooltip-box clv-ayuda-box' },
                h('b', null, 'Intereses:'), ' Solo paga intereses mensuales. El capital se devuelve al final. Plazo indefinido.', h('br', null), h('br', null),
                h('b', null, 'Capital + Intereses:'), ' Cuota fija mensual (amortización francesa). Cada cuota incluye intereses + parte del capital. Plazo fijo.', h('br', null), h('br', null),
                h('span', { className: 'clv-ayuda-nota' }, 'En todas las modalidades se pueden hacer abonos a capital para reducir el saldo.')))),
          h(CbvSeg, { valor: modalidad, onChange: setModalidad, opciones: CLV_MODALIDADES })),
        h('div', { className: 'clv-campo' },
          h('div', { className: 'clv-campo-l' }, 'Frecuencia de cobro'),
          h(CbvSeg, { valor: frecCalc, onChange: setFrecCalc, opciones: CLV_FRECUENCIAS })),
        h('div', { className: 'clv-dos' },
          h(Fld, { label: 'Tasa mensual (%) *' }, h('input', { type: 'number', step: '0.01', value: tasa, onChange: function(e){ setTasa(e.target.value); }, placeholder: 'Ej: 2', className: 'inp' })),
          h(Fld, { label: modalidad === 'Intereses' ? 'Simular cuotas (∞)' : (frecCalc === 'Semanal' ? 'Plazo (semanas)' : frecCalc === 'Quincenal' ? 'Plazo (quincenas)' : 'Plazo (meses)') },
            h('input', { type: 'number', value: plazo, onChange: function(e){ setPlazo(e.target.value); }, placeholder: modalidad === 'Intereses' ? '12 (simulación)' : '12', className: 'inp' })))),

      // ── El resultado ──
      h('section', { className: 'v4-card clv-card clv-res', style: { '--i': 1 } },
        h('div', { className: 'clv-card-h' },
          h('div', null, h('div', { className: 'v4-titulo' }, 'Resultado de la simulación'),
            h('div', { className: 'v4-sub' }, opModalidad(modalidad) + ' · cobro ' + periodo + (esUSD ? ' · en dólares' : '')))),
        !sim
          ? h('div', { className: 'clv-vacio' },
              h('span', { className: 'ico' }, h(Ico, { name: 'calc', size: 20, sw: 2 })),
              h('p', null, 'Escribe el valor del préstamo y la tasa para ver la cuota, la ganancia y el cronograma.'))
          : [
            h('div', { key: 'cuota', className: 'clv-cuota' },
              h('div', { className: 'clv-kv-l' }, rotuloCuota),
              h('div', { className: 'clv-cuota-v' }, h(V4Dinero, { v: sim.cuota })),
              usd(sim.cuota, { fontSize: 13 })),
            esUSD && h('div', { key: 'conv', className: 'clv-conv' },
              'USD $' + fmtN(+monto || 0) + ' × TRM $' + fmtN(+trmCalc || 0) + ' = ' + fmt(sim.montoCOP) + ' en pesos'),
            h('div', { key: 'kv', className: 'clv-kvs' },
              kv('Interés de la 1.ª cuota', sim.intP),
              kv('Abono a capital de la 1.ª cuota', sim.capP),
              kv('Ganancia en intereses', sim.totalInt, 'ganancia'),
              kv('Total a recibir', sim.totalPagar)),
            h('button', { key: 'ver', className: 'v4-link clv-ver', onClick: function(){ setShowCrono(!showCrono); } },
              showCrono ? 'Ocultar cronograma' : 'Ver cronograma tentativo', h(Ico, { name: showCrono ? 'chevdown' : 'chevright', size: 13, sw: 2.3 })),
            showCrono && h('div', { key: 'crono', className: 'clv-crono' },
              h('table', null,
                h('thead', null, h('tr', null, ['#', 'Interés', 'Abono a capital', 'Valor cuota', 'Saldo'].map(function(t){ return h('th', { key: t }, t); }))),
                h('tbody', null, sim.rows.map(function(r){
                  var t = +trmCalc || 1;
                  return h('tr', { key: r.n },
                    h('td', null, r.n),
                    h('td', null, fmtN(r.interes), esUSD && usdLinea(copToUsd(r.interes, t), { fontSize: 10 })),
                    h('td', null, fmtN(r.capital), esUSD && usdLinea(copToUsd(r.capital, t), { fontSize: 10 })),
                    h('td', { className: 'fuerte' }, fmtN(r.cuota), esUSD && usdLinea(copToUsd(r.cuota, t), { fontSize: 10 })),
                    h('td', { className: 'saldo' }, fmtN(r.saldo), esUSD && usdLinea(copToUsd(r.saldo, t), { fontSize: 10 })));
                }))))
          ],
        h('div', { className: 'clv-acc' },
          h('button', { className: 'v4-btn pri clv-crear', onClick: confirmar }, h(Ico, { name: 'check', size: 15, sw: 2.4 }), 'Confirmar y crear el préstamo')))));
}
