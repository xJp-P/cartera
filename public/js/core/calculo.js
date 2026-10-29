// public/js/core/calculo.js — matematica de PREVISUALIZACION en el cliente.
//
// Extraido de `app.js` en la Etapa 3 (B7) del refactor. Codigo VERBATIM.
//
// OJO CON EL ALCANCE: esto NO es el motor financiero. El motor vive en
// `backend/core/engine.js` y es la unica autoridad sobre lo que se persiste.
// Estas funciones solo alimentan los PREVIEW que la UI muestra mientras el
// usuario teclea (la cuota estimada de la Calculadora, el impacto de un abono
// antes de confirmarlo). Si alguna vez difieren del backend, manda el backend.
//
// `pmt` y `_pmt` SON LA MISMA FORMULA DUPLICADA, y se dejan las dos A PROPOSITO.
// Consolidarlas seria un cambio de logica, que este refactor tiene prohibido:
// la duplicacion es preexistente y unificarla es una decision de diseno aparte,
// no un efecto colateral de mover archivos.

import {
  diasDelPeriodo, diasEntre, esTransitoria, interesPeriodoParcial, interesTransitoria, tasaDelPeriodo,
} from './dominio.js';

export function pmt(r,n,pv){ return r===0?pv/n:pv*r*Math.pow(1+r,n)/(Math.pow(1+r,n)-1); }
// ── AbonoModal ────────────────────────────────────────────────────────────────
// Helper: PMT (cuota fija de amortizacion francesa)
export function _pmt(r,n,pv){if(r===0)return pv/n;return pv*r*Math.pow(1+r,n)/(Math.pow(1+r,n)-1);}
// 3.3.0: una sola implementacion de la tasa del periodo, en dominio.js (ver `tasaDelPeriodo`).
export function _tasaPeriodo(tasaMensual,frecuencia){return tasaDelPeriodo(tasaMensual,frecuencia);}
// NPER: numero de cuotas dado PMT, r, pv. Devuelve null si PMT <= pv*r (impossible).
export function _nper(r,pmtVal,pv){var int1=pv*r;if(pmtVal<=int1)return null;return Math.log(pmtVal/(pmtVal-int1))/Math.log(1+r);}

// ── Cronograma TENTATIVO (preview de LoanModal y de la Calculadora) ──────────
// ESPEJO del bucle de `buildSchedule` (backend/core/engine.js). Vivia duplicado
// byte a byte en los dos sitios y ninguna de las dos copias tenia el arreglo del
// Bug #43: la ultima fila se calculaba como `interes + saldo residual`, asi que
// arrastraba el ruido de redondeo y se mostraba 1-2 pesos fuera del valor pactado
// ("$374.999" donde la cuota es $375.000). Medido sobre 3.600 combinaciones, el
// preview desviaba la ultima cuota en el 85,5% de los casos; el backend, en 0%.
//
// La regla es la del motor, con su MISMA tolerancia calibrada: la ultima cuota
// toma el capital residual exacto y, si la diferencia contra el nominal es ruido
// de redondeo, se fuerza al nominal y el interes absorbe el ajuste. Si la
// diferencia es un GLOBO legitimo (tasa y plazo tan altos que el PMT converge al
// interes puro y el prestamo no amortiza), se respeta: ahi la ultima cuota SI es
// distinta y ocultarlo seria mentir sobre la deuda.
//
// `soloIntereses` NO hace globo final a proposito: el preview de esa modalidad es
// una ventana truncada de un credito indefinido, no su cierre.
export function filasPreview(montoCOP, r, nFilas, soloIntereses, cuotaNominal){
  var rows=[];
  var saldo=Math.round(montoCOP);
  var nominal=Math.round(cuotaNominal);
  var tol=Math.max(nFilas*2+2, Math.ceil(nominal*0.02));
  for(var i=0;i<nFilas;i++){
    var interes=Math.round(saldo*r);
    var isLast=i===nFilas-1;
    var capital,cuota;
    if(soloIntereses){
      capital=0; cuota=interes;
    } else if(isLast){
      capital=saldo;
      var natural=interes+capital;
      if(Math.abs(natural-nominal)<=tol && nominal-capital>=0){
        cuota=nominal; interes=cuota-capital;
      } else {
        cuota=natural;
      }
    } else {
      capital=Math.min(saldo, nominal-interes);
      cuota=nominal;
    }
    var sf=Math.max(0, saldo-capital);
    rows.push({n:i+1,interes:interes,capital:capital,cuota:cuota,saldo:sf});
    saldo=sf;
  }
  return rows;
}

// ── LA CUOTA TRANSITORIA en el preview (3.2.0, Fase 1) ───────────────────────
// ESPEJO de `transitoriaDe` / `aplicarPeriodoIrregular` (backend/core/engine.js). Un
// prestamo que paso por "Cambiar fecha" tiene una cuota de periodo irregular que cobra
// sus DIAS REALES sobre el capital vivo, mas la mora consolidada en pesos. Desde 3.2.0
// el motor la re-deriva cada vez que un abono regenera el cronograma, asi que el preview
// del cobro tiene que hacer lo mismo: sin esto prometia esa cuota de mes completo y el
// motor la persistia prorrateada (lo atrapa la seccion F de `cascada-cobro`).
//
// El capital de la cuota no se toca, igual que en el motor: solo cambia su interes.
// (`esTransitoria` e `interesTransitoria` viven en dominio.js desde la Fase 3: la
// liquidacion tambien las necesita, y dominio no puede importar de aqui sin un ciclo.)
// `filas` son las de `filasPreview`, que arrancan en la cuota `startN` y parten de
// `saldoInicial`. La fecha de la transitoria se toma de su fila persistida (un abono no la
// mueve: sale de su `cuotaN`), buscada por su id determinista. Muta y devuelve `filas`.
export function aplicarTransitoriaPreview(loan, filas, startN, saldoInicial, loanPays){
  var n=+(loan&&loan.periodoIrregularN)||0;
  if(!esTransitoria(loan, n)) return filas;
  var i=n-startN;
  if(i<0||!filas||i>=filas.length) return filas;
  var persistida=(loanPays||[]).filter(function(p){ return String(p.id)===String(loan.id)+'-'+n; })[0];
  if(!persistida||!persistida.fechaPago) return filas;
  var f=filas[i];
  var si=i===0?Math.round(saldoInicial):filas[i-1].saldo;
  var nuevo=interesTransitoria(loan, si, persistida.fechaPago);
  f.cuota=f.cuota+(nuevo-f.interes);
  f.interes=nuevo;
  return filas;
}

// ── PRIMER PAGO del formulario (3.2.0, Fase 2; las tres frecuencias desde 3.3.0) ─
// ESPEJO de `getPayDate`, `primerPagoRegular`, `inicioPeriodoRegular` y `resolverPrimerPago`
// (backend/core/engine.js). El backend es el que decide: esto solo alimenta lo que el formulario
// muestra mientras se teclea. La prueba de paridad vive en `tests/periodo-irregular.js`.
export function fechaPagoMensual(baseISO, cuotaN, diaPago){
  var d=new Date(baseISO+'T12:00:00');
  if(isNaN(d)) return '';
  d.setDate(1);
  d.setMonth(d.getMonth()+cuotaN);
  d.setDate(Math.min(diaPago, new Date(d.getFullYear(), d.getMonth()+1, 0).getDate()));
  return d.toISOString().split('T')[0];
}
// Las tres ramas de `getPayDate`: Semanal y Quincenal cuentan 7 y 14 dias desde la base.
export function fechaPagoFrecuencia(baseISO, cuotaN, diaPago, frecuencia){
  if(frecuencia==='Semanal'||frecuencia==='Quincenal'){
    var d=new Date(baseISO+'T12:00:00');
    if(isNaN(d)) return '';
    d.setDate(d.getDate()+cuotaN*diasDelPeriodo(frecuencia));
    return d.toISOString().split('T')[0];
  }
  return fechaPagoMensual(baseISO, cuotaN, diaPago);
}
// El primer pago REGULAR: un periodo despues del inicio (7 o 14 dias, o el mismo dia del mes
// siguiente acotado a fin de mes). Es el que la app asumia siempre, y elegirlo deja el prestamo
// exactamente como antes.
export function primerPagoRegular(fechaInicio, frecuencia){
  if(!fechaInicio) return '';
  return fechaPagoFrecuencia(fechaInicio, 1, +String(fechaInicio).slice(8,10), frecuencia||'Mensual');
}
// El dia en que arranca el periodo regular que vence en `fecha`: un periodo antes. En Mensual,
// el mismo dia del mes anterior acotado a fin de mes (31-mar -> 28-feb).
export function inicioPeriodoRegular(fecha, frecuencia){
  if(!fecha) return '';
  if(frecuencia==='Semanal'||frecuencia==='Quincenal') return fechaPagoFrecuencia(fecha, -1, 0, frecuencia);
  var b=new Date(fecha+'T12:00:00');
  if(isNaN(b)) return '';
  b.setDate(1);                     // evita el desborde de mes antes de restar
  b.setMonth(b.getMonth()-1);
  return fechaPagoMensual(b.toISOString().split('T')[0], 0, +String(fecha).slice(8,10));
}
// El primer pago de un prestamo YA guardado, con su base, su dia de pago y su frecuencia.
export function primerPagoDe(loan){
  if(!loan||!loan.fechaInicio) return '';
  return fechaPagoFrecuencia(loan.fechaBaseCronograma||loan.fechaInicio, 1, +loan.diaPago||+String(loan.fechaInicio).slice(8,10), loan.frecuencia||'Mensual');
}
// Lo que el formulario necesita para ofrecer la decision: si el periodo es irregular, cuantos
// dias tiene y cuanto cobraria la cuota 1 de interes en cada opcion. 'completo' = el interes de
// una cuota normal (lo que calcula el motor); 'proporcional' = esa cuota x dias / dias del periodo.
//
// `caso` decide QUE se pregunta (3.3.0):
//   'gracia'     el primer pago llega mas lejos que un periodo: sobran dias, y 'completo' es
//                PERDONARLOS (el interes corre desde `inicioIntereses`, un periodo antes del pago).
//                La opcion por defecto es perdonar (decision del PO).
//   'sinGracia'  llega antes, o el mes no deja dias que perdonar: no hay gracia posible, y la
//                opcion por defecto sigue siendo cobrar los dias (la de 3.2.0).
// `graciaDias` e `inicioIntereses` replican la regla de `resolverPrimerPago`.
export function infoPrimerPeriodo(montoCOP, tasaMensual, fechaInicio, primerPago, frecuencia){
  var freq=frecuencia||'Mensual';
  var regular=primerPagoRegular(fechaInicio, freq);
  var irregular=!!primerPago&&!!regular&&primerPago!==regular&&primerPago>fechaInicio;
  var dias=(fechaInicio&&primerPago)?diasEntre(fechaInicio, primerPago):0;
  var arranque=irregular?inicioPeriodoRegular(primerPago, freq):'';
  var graciaDias=(irregular&&arranque>fechaInicio)?diasEntre(fechaInicio, arranque):0;
  var saldo=Math.round(+montoCOP||0);
  return {
    regular:regular, irregular:irregular, dias:dias, frecuencia:freq,
    diasRegular:regular?diasEntre(fechaInicio, regular):0,
    caso:!irregular?'regular':(graciaDias>0?'gracia':'sinGracia'),
    graciaDias:graciaDias,
    inicioIntereses:graciaDias>0?arranque:fechaInicio,
    modoPorDefecto:graciaDias>0?'completo':'proporcional',
    interesCompleto:Math.round(saldo*tasaDelPeriodo((+tasaMensual||0)/100, freq)),
    interesProporcional:interesPeriodoParcial(saldo, tasaMensual, freq, Math.max(1,dias))
  };
}

// ── PREVIEW DEL RECALCULO TRAS UN ABONO ──────────────────────────────────────
// Que le pasa al cronograma cuando entra un abono a capital, segun la opcion que
// elija el usuario. Extraido VERBATIM de `AbonoModal` en la fusion del modal de
// cobro (v2.9.6): las dos superficies lo consumen, de modo que no pueden anunciar
// cuotas distintas para el mismo abono.
//
//   saldo   — capital que queda DESPUES del abono
//   r       — tasa del periodo (ya convertida por frecuencia)
//   nActual — cuotas restantes hoy, para el modo 'mantener'
//   modo    — 'mantener' | 'modificarPlazo' | 'fijarCuota'
//   valor   — nuevas cuotas (modificarPlazo) o cuota fija en COP (fijarCuota)
//
// Devuelve `error` en vez de lanzar: el llamador lo pinta y apaga el boton. Una
// cuota que no cubre ni el interes del primer periodo NUNCA salda la deuda, y ese
// es el unico caso en que el modelo no tiene solucion.
export function previewRecalculo(saldo, r, nActual, modo, valor){
  if(!(saldo>0)) return null;
  var interesP=Math.round(saldo*r);
  if(modo==='modificarPlazo'){
    var nN=parseInt(valor,10);
    if(!nN||nN<1) return {modo:modo,cuota:0,nCuotas:0,interesP:interesP,ultimaResidual:0,
      error:'Ingresa un numero de cuotas valido (>= 1).'};
    return {modo:modo,cuota:Math.round(_pmt(r,nN,saldo)),nCuotas:nN,interesP:interesP,ultimaResidual:0,error:null};
  }
  if(modo==='fijarCuota'){
    var pmtFijo=Math.round(+valor||0);
    if(pmtFijo<=0) return {modo:modo,cuota:0,nCuotas:0,interesP:interesP,ultimaResidual:0,
      error:'Ingresa una cuota valida (> 0).'};
    if(pmtFijo<=interesP) return {modo:modo,cuota:pmtFijo,nCuotas:0,interesP:interesP,ultimaResidual:0,
      error:'La cuota debe superar los intereses del primer periodo. Con esta cuota la deuda nunca se saldaria.'};
    var nEnt=Math.ceil(_nper(r,pmtFijo,saldo));
    // Saldo tras (nEnt-1) cuotas iguales: lo que queda es la ultima, residual.
    var sR=saldo, resid=0;
    for(var i=0;i<nEnt-1;i++){ sR=sR-(pmtFijo-sR*r); }
    if(sR>0) resid=Math.round((sR+sR*r)*100)/100;
    return {modo:modo,cuota:pmtFijo,nCuotas:nEnt,interesP:interesP,ultimaResidual:resid,error:null};
  }
  var n=Math.max(1, nActual||1);
  return {modo:'mantener',cuota:Math.round(_pmt(r,n,saldo)),nCuotas:n,interesP:interesP,ultimaResidual:0,error:null};
}
