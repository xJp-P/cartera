// public/js/core/dominio.js — EL CORAZON FINANCIERO DEL FRONTEND.
//
// Extraido de `app.js` en la Etapa 3 (B4) del refactor. Codigo VERBATIM: ni una
// constante, ni un redondeo, ni un `>=` cambiaron. Un cambio de comportamiento
// aqui no seria un bug de refactor, seria plata mal contada.
//
// Estos 6 helpers son la UNICA implementacion de sus reglas. La app tuvo tres
// doctrinas conviviendo para lo mismo (ignorar el parcial, contarlo como caja
// bruta, o volcarlo entero en el evento que saldaba la cuota) y de ahi salieron
// los Bugs #44 y #45. Nunca reimplementar ninguna de estas formulas inline.
//
// LO QUE SOSTIENEN, y que no se toca al moverlas:
//
//  cobrosDe(p)          Fuente de verdad del flujo de caja: ledger `recibos` CON
//                       FALLBACK EXCLUYENTE a fechaRecaudo. Ledger O fallback,
//                       jamas los dos -> por construccion no hay doble conteo.
//
//  imputarCobros(pay)   Reparte cada evento de caja en cascada INTERES -> CAPITAL
//                       (Codigo Civil art. 1653; decision de negocio del usuario).
//                       Invariante: interes + capital + ajuste === cop en CADA
//                       evento. `ajuste` es el hueco entre caja y composicion: en
//                       USD es el efecto cambiario; en COP, el residuo de
//                       redondeo de las filas legacy del Bug #43.
//                       Un evento en dolares que trae `obl` (post-4.1.4) cubre esa
//                       deuda, no sus pesos: el efecto TRM queda en ese pago.
//                       NUNCA filtrar por estadoPago==='Pagado' para decidir si un
//                       pago cuenta: eso es lo que hacia invisibles los parciales.
//
//  saldoConCaja()       El saldo CON CAJA APLICADA, que es el que se MUESTRA.
//                       Distinto del saldo del MOTOR (que gobierna decisiones y
//                       vive en el backend). Un parcial NO re-amortiza, asi que el
//                       del motor no baja; este si. Son dos cosas con dos nombres
//                       a proposito — confundirlos es la clase de falla de los
//                       Bugs #35 y #19.
//
//  computeLiquidacion() Unica fuente del "Valor de liquidacion", consumida por 5
//                       superficies. Resta los parciales APARTE del total; por eso
//                       los PDF no pueden migrarla a saldoConCaja (los restaria
//                       dos veces).
//
// Cubierto por tests/props-dominio.js: 116 asertos de invariantes sobre las 157
// cuotas y los 26 prestamos reales.

// v1.11.4: eventos de caja reales de un pago. Devuelve [{fecha:'YYYY-MM-DD', cop:int}].
// Fuente de verdad = ledger payments.recibos (cada parcial en su fecha + el pago final). Si la fila
// no tiene ledger (historico previo, abonos a capital, liquidaciones de mora) cae al FALLBACK: un
// unico evento en fechaRecaudo por (montoCOPRecibido||cuotaTotal). metrics.recibido y la curva del
// Resumen (3.4.0) usan ESTA funcion -> la cifra y el grafico cuadran por construccion, sin doble conteo.
import { esAbono, esCorte, esCuotaRegular } from './ids.js';

export function cobrosDe(p){
  if(!p) return [];
  if(p.recibos){
    var arr; try{arr=JSON.parse(p.recibos);}catch(_){arr=null;}
    if(Array.isArray(arr)&&arr.length){
      // Post-4.1.4: en dolares el evento trae tambien `usd` (los dolares de ese pago) y `obl` (la deuda
      // que extinguio, en pesos a la TRM pactada). Solo viajan si estan: un evento en pesos sigue igual.
      return arr.filter(function(r){return r&&r.fecha&&(+r.cop)>0;})
                .map(function(r){var e={fecha:String(r.fecha),cop:Math.round(+r.cop)};
                  if((+r.usd)>0) e.usd=Math.round(+r.usd*100)/100;
                  if((+r.obl)>0) e.obl=Math.round(+r.obl);
                  return e;});
    }
  }
  if(p.estadoPago==='Pagado'&&p.fechaRecaudo){
    return [{fecha:p.fechaRecaudo,cop:Math.round(p.montoCOPRecibido||p.cuotaTotal)}];
  }
  return [];
}
// ── IMPUTACION de lo cobrado entre INTERES y CAPITAL (Fase 1) ─────────────────
// UNA sola fuente de verdad para repartir el dinero de una cuota entre sus rubros. Antes este
// concepto NO existia: `partialPaid` era un escalar de caja sin composicion, asi que cada
// superficie improviso (unas ignoraban el parcial, otras lo contaban entero, y el Flujo de Caja
// volcaba interes y capital COMPLETOS en el evento que saldaba -> una fila de $50.000 declaraba
// $450.000 de rubros).
//
// REGLA DE NEGOCIO (decision del usuario, 2026-07-31): CASCADA INTERES -> CAPITAL.
//   Es el default legal en Colombia (Codigo Civil art. 1653: el pago se imputa primero a
//   intereses salvo consentimiento expreso del acreedor) y es coherente con el motor, que ya
//   devengo ese interes PARA ESE PERIODO. Imputar a capital primero dejaria interes devengado
//   y no cobrado sin columna donde vivir.
//
// ESTO ES PRESENTACION, NO AMORTIZACION. No toca buildSchedule, ni saldoFinal, ni el saldoReal
// del backend (techo del abono / liquidacion). Solo REPARTE una composicion que el motor ya fijo.
//
// Garantias, por construccion:
//   (1) En CADA evento:            interes + capital + ajuste === cop
//   (2) En una cuota SALDADA:      suma(interes) === interesPeriodo  y  suma(capital) === abonoCapital
//       -> reconcilia EXACTO con el motor y con la formula canonica de saldo, de modo que adoptar
//          este helper no mueve el saldo de ningun prestamo existente.
//   (3) `ajuste` es el hueco entre la caja y la composicion de la cuota. Dos origenes legitimos:
//       en USD, el efecto cambiario (Bug #23: una cuota queda Pagada con menos COP de los
//       proyectados) — concepto que la app YA modela; en COP, el residuo de redondeo de las filas
//       legacy del Bug #43 (medido: 4 prestamos, 1 a 3 pesos). Se NOMBRA en vez de esconderlo
//       inflando el capital, que es justo lo que descuadraria el saldo.
export function imputarCobros(pay){
  var vacio={eventos:[],totales:{cobrado:0,interes:0,capital:0,ajuste:0},sinLedger:0,saldada:false};
  if(!pay) return vacio;
  var evs=cobrosDe(pay);
  var saldada=pay.estadoPago==='Pagado';
  var intTotal=Math.round(pay.interesPeriodo||0);
  // Capital de la cuota: se ancla a `abonoCapital` PORQUE ES LA MISMA BASE de la formula canonica
  // de saldo (origCOP - suma abonoCapital de Pagadas). Anclarlo a la reconciliacion
  // `cuotaTotal - interes` (doctrina v1.18.0, correcta para las COLUMNAS del cronograma) haria
  // que el capital imputado difiera del canonico en las filas legacy con residuo de redondeo del
  // Bug #43 — medido sobre la cartera real: 4 prestamos, entre 1 y 3 pesos — y entonces adoptar
  // este helper MOVERIA el saldo de esos prestamos sin explicacion. Defensa: si la columna viene
  // en 0 con cuota viva (capital fantasma historico, Bugs #30/#34) se cae a la reconciliacion.
  var capTotal=Math.round(pay.abonoCapital||0);
  var reconc=Math.round(pay.cuotaTotal||0)-intTotal;
  if(capTotal<=0&&reconc>0) capTotal=reconc;
  if(capTotal<0) capTotal=0;
  var intPend=intTotal, capPend=capTotal, cobrado=0, aplicado=0;
  // Cada evento cubre su BASE: los pesos que entraron o, si el evento la trae (pagos en dolares desde
  // post-4.1.4), la deuda que ESE pago extinguio a la TRM pactada. Asi el efecto cambiario de cada pago
  // queda en su propia fila (ajuste = pesos - base) en vez de cargarse entero al ultimo. Los totales de
  // la cuota no cambian: la suma de las bases es la misma obligacion que se anclaba al final.
  // Registro MIXTO (post-4.1.5): pagos viejos SIN `obl` (anteriores a que se guardara) junto a pagos que lo
  // traen. La deuda de los viejos es la obligacion total menos la de los que la traen, y va al ULTIMO pago
  // viejo (los demas cubren sus pesos), igual que la regla de siempre anclaba el remanente. Sin esto el
  // efecto del pago viejo caia en el pago nuevo: su perdida se escondia y la ganancia de la cuota salia
  // inflada por la ganancia cambiaria del nuevo, que no debe sumar. Sin ningun `obl`, o con todos, no
  // cambia nada.
  var oblTot0=saldada?(intTotal+capTotal):Math.round(pay.partialPaid||0);
  var conObl=evs.map(function(e){return (+e.obl)>0;});
  var bases=evs.map(function(e,k){return conObl[k]?Math.round(+e.obl):Math.round(e.cop||0);});
  if(conObl.some(Boolean)&&conObl.some(function(x){return !x;})){
    var ultViejo=conObl.lastIndexOf(false);
    var otros=bases.reduce(function(s,b,k){return k===ultViejo?s:s+b;},0);
    bases[ultViejo]=Math.max(0,oblTot0-otros);
  }
  var out=evs.map(function(e,k){
    var cop=Math.round(e.cop||0);
    var base=bases[k];
    var ai=Math.min(base,intPend);         intPend-=ai;
    var ac=Math.min(base-ai,capPend);      capPend-=ac;
    cobrado+=cop; aplicado+=base;
    return {fecha:e.fecha,cop:cop,interes:ai,capital:ac,ajuste:0};
  });
  // Se imputa la OBLIGACION EXTINGUIDA, no la caja. En COP son la misma cifra; en un
  // prestamo USD la obligacion puede ser MAYOR, porque la deuda esta denominada en dolares
  // y se valua a la TRM pactada mientras la caja entra a la del dia. Ese hueco es efecto
  // cambiario — no dinero que el deudor siga debiendo — y por eso se reparte entre interes
  // y capital en vez de quedar como saldo vivo.
  //   - cuota SALDADA: la obligacion es la composicion completa (comportamiento previo).
  //   - parcial VIVO : la obligacion es `partialPaid`, que /partial ya escribe valuado a la
  //                    TRM pactada. En COP coincide con la caja -> extra 0 -> cero cambio.
  // El remanente se ancla al ULTIMO evento, para que los totales cuadren con el motor y el
  // desfase quede visible como `ajuste` en vez de disfrazarse de capital cobrado.
  var oblTotal=saldada?(intTotal+capTotal):Math.round(pay.partialPaid||0);
  var extra=Math.max(0,oblTotal-aplicado), absorbido=0;
  if(out.length>0&&extra>0&&(intPend>0||capPend>0)){
    var u=out[out.length-1];
    var ei=Math.min(extra,intPend); u.interes+=ei; intPend-=ei; extra-=ei; absorbido+=ei;
    var ec=Math.min(extra,capPend); u.capital+=ec; capPend-=ec;            absorbido+=ec;
  }
  // Identidad (1), calculada al final para que valga en TODOS los casos: si sobro caja sin
  // composicion que cubrir, el excedente cae aqui en vez de inflar un rubro. `ajuste` es
  // NEGATIVO cuando la obligacion supero a la caja (perdida cambiaria).
  var ti=0,tc=0,ta=0;
  out.forEach(function(r){ r.ajuste=r.cop-r.interes-r.capital; ti+=r.interes; tc+=r.capital; ta+=r.ajuste; });
  // Dinero registrado en partialPaid que NINGUN evento representa: solo puede ocurrir en filas
  // legacy anteriores al ledger `recibos` (v1.11.4). Se reporta en vez de inventarle una fecha,
  // para no romper la identidad "KPI == suma del grafico" que cobrosDe garantiza.
  // Se descuenta lo `absorbido`: ese hueco SI esta representado (es el efecto cambiario del
  // evento), y contarlo aqui marcaria la fila con el asterisco de baja fidelidad sin motivo.
  var sinLedger=Math.max(0,Math.round(pay.partialPaid||0)-aplicado-absorbido);
  return {eventos:out,totales:{cobrado:cobrado,interes:ti,capital:tc,ajuste:ta},
          sinLedger:sinLedger,saldada:saldada};
}
// ── GANANCIA REAL de una fila (regla del PO, 2026-09-13) ──────────────────────
// UNA sola definicion para el valor de la tarjeta "Ganancias", su grafico mensual y la
// "Ganancia obtenida" de Rendimiento, que hasta aqui eran tres copias de una formula que:
//   - solo veia cuotas `Pagado` y NO abonos: el interes cobrado por un parcial en vuelo
//     (medido: $42.681 en septiembre) y el de una liquidacion con el mes en curso eran
//     invisibles hasta que la cuota cerrara, y entonces caian enteros en ese mes;
//   - aplicaba el efecto cambiario de forma inconsistente: dentro de una cuota regular USD si
//     (`montoCOPRecibido - capital`), en abonos y parciales no (medido: -$242.244 en sept.).
//
// REGLA DEL PO. La ganancia de un pago es  max(0, intereses cobrados + perdida cambiaria):
//   - la PERDIDA cambiaria se descuenta del interes de ESA fila, nunca del resto del mes;
//   - si se come todo el interes, la fila aporta cero —"los intereses se perdieron"— y no
//     resta al consolidado. Es lo que distingue esto de una contabilidad de caja pura.
//   - la formula nombra solo el efecto NEGATIVO, y asi se implementa: una subida de TRM no
//     suma. Medido sobre la cartera real al definir la regla: el efecto positivo acumulado
//     en toda la historia era +1 peso (redondeo), asi que la lectura no cambia ninguna cifra.
//   - en COP no hay efecto cambiario: el `ajuste` de una fila COP es residuo de redondeo
//     legacy del Bug #43 y no se toca.
//
// El interes y la perdida salen de `imputarCobros`, que ya reparte cada evento de caja en
// interes -> capital -> ajuste; asi un parcial en vuelo cuenta el interes que REALMENTE cubrio.
//
// El piso se aplica sobre el ACUMULADO de la fila, evento a evento, y cada evento reconoce el
// incremento. Tres propiedades por construccion:
//   1. la suma de los eventos es exactamente max(0, interes + perdida) de la fila entera;
//   2. la suma de todos los meses del grafico es exactamente el valor de la tarjeta;
//   3. en la fila de un solo pago —casi todas— el evento vale lo mismo que la fila.
// Unico caso en que un evento reconoce un monto negativo: el pago final de una cuota en
// cuotas trae una perdida que se come interes ya reconocido en un pago anterior. Aun asi la
// fila jamas baja de cero: la perdida nunca sale del interes de esa misma cuota.
// UNIFICACION (post-4.0.0, regla del PO): si al unificar los intereses viejos se SUMARON AL CAPITAL
// del prestamo nuevo, esa parte del capital no es dinero prestado sino interes ya ganado. Se
// reconoce como ganancia A MEDIDA QUE SE COBRA el capital, en proporcion: cada peso de capital
// cobrado trae `ratioCap` (= interesCapitalizado / capital del nuevo) de ganancia. `ratioCap`
// viene de `ratioCapitalizado(loan)`; sin el (o 0), la formula de siempre.
// Lo que de un prestamo se cuenta como "capital PRESTADO" en los totales historicos. Un prestamo
// que nacio de una unificacion lleva capital que ya estaba prestado en los viejos (refinanciado) y,
// si se capitalizaron, intereses: ninguno es dinero nuevo. Sin esto la rentabilidad de la cartera
// (ganancia / todo lo prestado) contaria ese capital dos veces.
export function capitalRefinanciadoDe(loan){
  if(!loan) return 0;
  return Math.max(0, Math.round(+loan.capitalRefinanciado||0)+Math.round(+loan.interesCapitalizado||0));
}
export function ratioCapitalizado(loan){
  if(!loan||!((+loan.interesCapitalizado||0)>0)) return 0;
  var orig=loan.moneda==='USD'?Math.round(loan.montoOrigen*loan.trmAcordada):Math.round(loan.montoOrigen);
  return orig>0?Math.min(1,(+loan.interesCapitalizado)/orig):0;
}
export function gananciaDe(pay, esUSD, ratioCap){
  var imp=imputarCobros(pay);
  var cumInt=0, cumPerdida=0, reconocida=0;
  var eventos=imp.eventos.map(function(e){
    cumInt+=e.interes+(ratioCap>0?Math.round(e.capital*ratioCap):0);
    if(esUSD&&e.ajuste<0) cumPerdida+=e.ajuste;
    var g=Math.max(0, cumInt+cumPerdida);
    var ev={fecha:e.fecha, ganancia:g-reconocida};
    reconocida=g;
    return ev;
  });
  // `interes` y `perdida` (sin piso) van aparte para que una pantalla pueda explicar por que
  // la ganancia no es la resta que muestra en sus propias filas cuando el piso actuo.
  return {total:reconocida, interes:cumInt, perdida:cumPerdida, eventos:eventos};
}

// Ganancia en DOLARES de una fila: los dolares NATIVOS que entraron como ganancia.
// REGLA DEL PO (cuentas bimonetarias): el cliente paga lo pactado; si pago USD 50 de interes, la
// ganancia en dolares ES USD 50. La TRM castiga SOLO la ganancia en pesos (`gananciaDe`), nunca
// esta. Ratifica la doctrina de v1.12.8 (Bug #25a) y la extiende a las filas que aquella no veia:
//   - cuota saldada con dolares registrados: dolares recibidos menos el capital en dolares — la
//     formula de v1.12.8 tal cual, asi que las cifras historicas quedan identicas;
//   - cuota saldada sin dolares registrados, parcial en vuelo y abono: el interes que cubrieron,
//     a la TRM pactada. En un parcial la obligacion YA esta valuada a esa TRM (Bug #50), asi que
//     interes/trm SON los dolares que cubrieron interes; en un abono es el interes del mes de una
//     liquidacion (cero en un abono normal).
function gananciaUSDDe(pay, trm, ratioCap){
  if(!(trm>0)) return 0;
  var r=ratioCap>0?ratioCap:0;
  if(pay.estadoPago==='Pagado'&&!esAbono(pay)&&(+pay.montoUSDRecibido||0)>0){
    var capUSD=((pay.cuotaTotal||0)-(pay.interesPeriodo||0))/trm;
    return (+pay.montoUSDRecibido)-capUSD+capUSD*r;
  }
  var t=imputarCobros(pay).totales;
  return (t.interes+t.capital*r)/trm;
}

// Ganancia real de un PRESTAMO completo, en sus dos realidades. La consumen las cinco
// superficies que la muestran (tarjeta de Rendimiento, "Ganancia total" del perfil del deudor
// y de Cartera, historial de creditos cerrados) para que ninguna vuelva a tener su formula.
//   - `cop` = consolidado en pesos, con la perdida por TRM (piso en cero por cuota);
//   - `usd` = recibido en dolares, NATIVO: sin TRM (ver `gananciaUSDDe`);
//   - `interes` y `bruta` (= interes + perdida sin piso) le permiten a la pantalla explicar por
//     que los pesos no son los dolares convertidos.
export function gananciaDePrestamo(loan, loanPays){
  var vacio={cop:0, usd:0, interes:0, bruta:0, pisoAplicado:false};
  if(!loan) return vacio;
  var esUSD=loan.moneda==='USD';
  var trm=+loan.trmAcordada||0;
  var ratio=ratioCapitalizado(loan);
  var lp=(loanPays||[]).filter(function(p){ return String(p.prestamoId)===String(loan.id); });
  var cop=0, bruta=0, interes=0, usd=0;
  lp.forEach(function(p){
    var g=gananciaDe(p, esUSD, ratio);
    cop+=g.total; bruta+=g.interes+g.perdida; interes+=g.interes;
    if(esUSD) usd+=gananciaUSDDe(p, trm, ratio);
  });
  return {cop:Math.round(cop), usd:(esUSD&&trm>0)?Math.round(usd*100)/100:0, interes:Math.round(interes),
          bruta:Math.round(bruta), pisoAplicado:Math.round(cop)!==Math.round(bruta)};
}

// SALDO CON CAJA APLICADA (Fase 3) — la cifra que se MUESTRA, en pantalla y en los PDFs.
// = capital prestado - capital efectivamente cubierto (cuotas saldadas + abonos + la parte de
// capital de los parciales en curso, segun la cascada de imputarCobros).
// NO CONFUNDIR con el saldo del MOTOR (`originalCOP - suma abonoCapital de Pagadas`), que gobierna
// el techo del abono, la liquidacion y el recalculo del PMT y NO puede moverse por un parcial.
// Un solo helper para que ninguna superficie vuelva a inventar su propia formula: hasta la Fase 3
// convivian TRES definiciones distintas de "saldo" y los PDFs usaban la mas atrasada.
export function saldoConCaja(loan, loanPays){
  if(!loan) return 0;
  var origCOP=loan.moneda==='USD'?Math.round(loan.montoOrigen*loan.trmAcordada):Math.round(loan.montoOrigen);
  var lp=(loanPays||[]).filter(function(p){return String(p.prestamoId)===String(loan.id);});
  var cap=lp.reduce(function(s,p){return s+imputarCobros(p).totales.capital;},0);
  return Math.max(0,origCOP-Math.round(cap));
}
// Rubros que AUN se deben de una cuota, tras aplicar lo ya abonado en cascada interes -> capital.
// Los PDFs prospectivos (factura de cobro) deben exigir esto, no la composicion nominal: si no,
// el documento cobra un interes que el parcial ya cubrio y sus filas no suman el total exigido.
export function pendienteDeCuota(pay){
  var intTot=Math.round(pay.interesPeriodo||0);
  var capTot=Math.max(0,Math.round(pay.cuotaTotal||0)-intTot);
  var imp=imputarCobros(pay).totales;
  return {interes:Math.max(0,intTot-imp.interes), capital:Math.max(0,capTot-imp.capital)};
}

// ── FLUJO DE CAJA REAL de un prestamo (v2.2.0) ────────────────────────────────
// Reconstruye lo que REALMENTE entro, cuando entro, a partir de la unica fuente fiable:
// los eventos de caja de cobrosDe(p) — el ledger `recibos` con fallback a fechaRecaudo.
// Se descartaron las alternativas: activity_log es texto libre sin FK ni montos estructurados,
// y undo_journal solo guarda 200 entradas / 90 dias (no existe para prestamos historicos).
// Auditado sobre la BD real: NINGUNA cuota pagada carece de fechaRecaudo, asi que esta fuente
// cubre el 100% de la historia. Cada evento se enriquece con los metadatos de su fila padre:
// el ledger aporta CUANDO y CUANTO, la fila aporta QUE era.
// ── DOLARES RECIBIDOS (post-4.1.4, "dolares por pago") ─────────────────────────
// Los dolares que el cliente entrego en cada pago de una fila, alineados con sus eventos de caja
// (`cobrosDe`), y la TRM a la que entraron (pesos / dolares: no se guarda, se calcula):
//   - el evento trae sus dolares (registro de pagos en dolares desde post-4.1.4): esos;
//   - la fila tiene un solo pago: los dolares de la fila (`montoUSDRecibido`);
//   - varios pagos sin dolares por pago (registrados antes): el total va en el ULTIMO de esos pagos,
//     con la TRM promedio (`nPagos` dice cuantos cubre) y los demas quedan `enOtroPago`;
//   - sin dolares registrados (pagos de antes de que la app los pidiera): null. No se inventan.
export function dolaresPorPago(pay){
  var evs=cobrosDe(pay);
  var usdFila=Math.round((+(pay&&pay.montoUSDRecibido)||0)*100)/100;
  var out=evs.map(function(e){ return {usd:(+e.usd)>0?+e.usd:null, cop:e.cop, copBase:e.cop, nPagos:1, enOtroPago:false}; });
  var sinUsd=out.filter(function(x){ return x.usd==null; });
  if(usdFila>0&&sinUsd.length){
    var conocidos=out.reduce(function(s,x){ return s+(x.usd||0); },0);
    var resto=Math.round((usdFila-conocidos)*100)/100;
    if(resto>0){
      var ult=sinUsd[sinUsd.length-1];
      ult.usd=resto; ult.nPagos=sinUsd.length;
      ult.copBase=sinUsd.reduce(function(s,x){ return s+x.cop; },0);
      sinUsd.slice(0,-1).forEach(function(x){ x.enOtroPago=true; });
    }
  }
  return out.map(function(x){
    return {usd:x.usd, trm:x.usd>0?x.copBase/x.usd:null, nPagos:x.nPagos, enOtroPago:x.enOtroPago};
  });
}
// Totales de un prestamo en dolares: los dolares REGISTRADOS (suma de `montoUSDRecibido` de cada fila
// con dinero), cuantas filas con dinero no los tienen, y los pesos de las que si (para la TRM promedio).
// Es la cifra de "Total recibido" en dolares del panel y el pie del flujo de caja: las dos la leen de aqui.
export function dolaresRecibidos(loan, loanPays){
  var r={usd:0, sinUSD:0, copConUSD:0};
  if(!loan||loan.moneda!=='USD') return r;
  (loanPays||[]).filter(function(p){ return String(p.prestamoId)===String(loan.id); }).forEach(function(p){
    var evs=cobrosDe(p);
    if(!evs.length) return;
    var u=Math.round((+p.montoUSDRecibido||0)*100)/100;
    if(u>0){ r.usd+=u; r.copConUSD+=evs.reduce(function(s,e){ return s+e.cop; },0); }
    else r.sinUSD++;
  });
  r.usd=Math.round(r.usd*100)/100;
  return r;
}

export function flujoCajaDe(loan, loanPays){
  if(!loan) return {eventos:[],totales:{ingreso:0,interes:0,capital:0,ajuste:0},inferidos:0};
  var esUSD=loan.moneda==='USD';
  var origCOP=esUSD?Math.round(loan.montoOrigen*loan.trmAcordada):Math.round(loan.montoOrigen);
  var pays=(loanPays||[]).filter(function(p){return String(p.prestamoId)===String(loan.id);});
  var evs=[];
  pays.forEach(function(p){
    // Fase 2: el reparto interes/capital de CADA evento lo decide imputarCobros (cascada
    // interes -> capital). Antes se volcaba la composicion COMPLETA de la cuota en su ultimo
    // evento, de modo que un ingreso de $50.000 declaraba $450.000 de rubros y la fila del
    // parcial mostraba "—" con el saldo congelado.
    var imp=imputarCobros(p);
    // Sin ledger Y sin monto registrado, cobrosDe cae a cuotaTotal: el dato es RECONSTRUIDO.
    // Se marca para no presentarlo como registro exacto de caja (cobros previos a v1.11.4).
    // El ledger manda: si existe, el monto es REAL aunque montoCOPRecibido siga en 0 — que es lo
    // que pasa con un pago parcial en curso, donde /partial solo escribe partialPaid y `recibos`.
    var tieneLedger=false;
    try{var _l=JSON.parse(p.recibos||'[]'); tieneLedger=Array.isArray(_l)&&_l.length>0;}catch(_){}
    var inferido=!tieneLedger&&!(p.montoCOPRecibido>0);
    var dol=esUSD?dolaresPorPago(p):[];
    imp.eventos.forEach(function(ev,k){
      evs.push({fecha:String(ev.fecha),cop:ev.cop,interes:ev.interes,capital:ev.capital,ajuste:ev.ajuste,
        pay:p,k:k,nEv:imp.eventos.length,esUltimo:k===imp.eventos.length-1,inferido:inferido,dol:dol[k]||null});
    });
  });
  // Orden por fecha REAL del dinero; desempate por hora de registro. Importa: hay cuotas
  // registradas el mismo dia que corresponden a cobros de meses distintos.
  evs.sort(function(a,b){
    var c=a.fecha.localeCompare(b.fecha);
    if(c!==0) return c;
    return String(a.pay.paidAt||'').localeCompare(String(b.pay.paidAt||''));
  });
  var saldo=origCOP,ti=0,tc=0,tg=0,ta=0,inf=0;
  var out=evs.map(function(e,i){
    var p=e.pay;
    var filaEsAbono=esAbono(p);
    var saldado=p.estadoPago==='Pagado';
    // El capital ya viene imputado por evento -> el saldo baja con CADA peso que entra, no de
    // golpe en el evento que salda la cuota.
    saldo=Math.max(0,saldo-e.capital); ti+=e.interes; tc+=e.capital; tg+=e.cop; ta+=e.ajuste;
    if(e.inferido) inf++;
    var atraso=(!filaEsAbono&&p.fechaPago)?Math.round((new Date(e.fecha+'T12:00:00')-new Date(p.fechaPago+'T12:00:00'))/86400000):null;
    return {n:i+1,fecha:e.fecha,cop:e.cop,interes:e.interes,capital:e.capital,ajuste:e.ajuste,saldo:saldo,
      esAbono:filaEsAbono,parcialEnCurso:!saldado,inferido:e.inferido,
      cuotaN:p.cuotaN,vence:p.fechaPago,atraso:atraso,obs:p.observaciones||'',
      nEv:e.nEv,
      // En dolares (post-4.1.4): lo que el cliente entrego en ESTE pago y la TRM a la que entro.
      // null = no registrados. `nPagos` > 1: el total de varios pagos viejos, con la TRM promedio.
      usd:e.dol?e.dol.usd:null,trmDia:e.dol?e.dol.trm:null,
      nPagos:e.dol?e.dol.nPagos:1,enOtroPago:!!(e.dol&&e.dol.enOtroPago)};
  });
  return {eventos:out,totales:{ingreso:tg,interes:ti,capital:tc,ajuste:ta},inferidos:inf,origCOP:origCOP,
    dolares:dolaresRecibidos(loan,pays)};
}

// ══════════════════════════════════════════════════════════════════════════════
// INTERES DIARIO — ESPEJO del motor de backend/core/engine.js
// ══════════════════════════════════════════════════════════════════════════════
//
// Los CUERPOS de `diasEntre`, `interesDeTramo` y `devengoDiario` deben ser
// IDENTICOS a los del backend. Es la misma regla de negocio sobre los mismos
// datos; si divergen, la pantalla y el servidor dirian cosas distintas sobre lo
// que un cliente debe HOY — exactamente la clase de falla del Bug #45.
//
// La duplicacion es inevitable y deliberada: el backend es CommonJS, esto es un
// modulo ES, y el proyecto no tiene bundler a proposito. Lo que SI se puede hacer
// —y se hace— es verificar la equivalencia: tests/props-dominio.js ejecuta las dos
// implementaciones sobre el mismo espacio de casos y exige que coincidan.
//
// La doctrina completa (convencion de dias, tramos semiabiertos, base = saldo del
// MOTOR, sin capitalizacion, redondeo por tramo) esta documentada en el backend y
// NO se repite aqui para que exista una sola fuente que mantener.

export var MODALIDAD_DIARIA = 'Interes Diario';

export function esDiario(loan) {
  return !!loan && loan.modalidad === MODALIDAD_DIARIA;
}

// Dias reales entre dos fechas ISO, anclado a mediodia (TZ-safe).
export function diasEntre(desdeISO, hastaISO) {
  var a = new Date(String(desdeISO) + 'T12:00:00');
  var b = new Date(String(hastaISO) + 'T12:00:00');
  if (isNaN(a) || isNaN(b)) return 0;
  return Math.round((b - a) / 86400000);
}

// Interes de UN tramo, en pesos enteros. Se redondea por TRAMO, no por dia.
export function interesDeTramo(saldo, tasaMensual, dias) {
  if (!(dias > 0) || !(saldo > 0)) return 0;
  return Math.round(saldo * ((+tasaMensual || 0) / 100) * dias / 30);
}

// ── INTERES DE UNA FRACCION DE PERIODO (3.3.0, Fase 1) ──────────────────────
// ESPEJO de `tasaPeriodo`, `diasDelPeriodo` e `interesPeriodoParcial` (backend/core/engine.js).
// La tasa del periodo vive AQUI y `_tasaPeriodo` (calculo.js) delega en ella: calculo importa
// de dominio y no al reves, asi que es el unico sitio donde ambos pueden compartirla.
export function tasaDelPeriodo(tasaFrac, frecuencia) {
  if (frecuencia === 'Semanal') return tasaFrac / 4.33;
  if (frecuencia === 'Quincenal') return tasaFrac / 2;
  return tasaFrac;
}
// La quincena son 14 dias: es el calendario que genera el motor (decision del PO para 3.3.0).
export function diasDelPeriodo(frecuencia) {
  if (frecuencia === 'Semanal') return 7;
  if (frecuencia === 'Quincenal') return 14;
  return 30;
}
// interes = interes de una cuota normal x dias reales / dias del periodo. En Mensual delega en
// `interesDeTramo` (la expresion de siempre, intacta); en Semanal y Quincenal `dias / P` vale 1
// exacto cuando se cobra un periodo entero, asi que el resultado es la cuota normal al peso.
export function interesPeriodoParcial(saldo, tasaMensual, frecuencia, dias) {
  if (frecuencia !== 'Semanal' && frecuencia !== 'Quincenal') return interesDeTramo(saldo, tasaMensual, dias);
  if (!(dias > 0) || !(saldo > 0)) return 0;
  var r = tasaDelPeriodo((+tasaMensual || 0) / 100, frecuencia);
  return Math.round(saldo * r * (dias / diasDelPeriodo(frecuencia)));
}

// Espejo de `devengoDiario`. Ver engine.js para el porque de cada decision.
export function devengoDiario(loan, cortes, hastaISO) {
  var tasaMensual = +loan.tasaMensual || 0;
  var origCOP = loan.moneda === 'USD'
    ? Math.round(loan.montoOrigen * loan.trmAcordada)
    : Math.round(loan.montoOrigen);

  var ord = (cortes || []).slice().sort(function (a, b) {
    var c = String(a.fechaPago).localeCompare(String(b.fechaPago));
    return c !== 0 ? c : (a.cuotaN - b.cuotaN);
  });

  var tramos = [];
  var saldo = origCOP;
  var cursor = loan.fechaInicio;
  var interesDevengado = 0;
  var interesCobrado = 0;
  var capitalAbonado = 0;
  var condonado = Math.max(0, Math.round(+loan.interesesCondonados || 0));

  // Congelar (post-4.1.6, Fase 2): los periodos congelados no devengan (ver engine.js).
  var congs = congelamientosDe(loan).filter(function (c) { return c && c.desde; })
    .map(function (c) { return { a: String(c.desde), b: c.hasta ? String(c.hasta) : null }; });
  var empujar = function (desde, hasta, base) {
    var dias = diasEntre(desde, hasta);
    if (dias < 0) dias = 0;
    if (!congs.length || dias === 0) {
      var interes = interesDeTramo(base, tasaMensual, dias);
      tramos.push({ desde: desde, hasta: hasta, dias: dias, base: base, interes: interes });
      interesDevengado += interes;
      return;
    }
    var puntos = [desde];
    congs.forEach(function (c) { [c.a, c.b].forEach(function (p) { if (p && p > desde && p < hasta && puntos.indexOf(p) === -1) puntos.push(p); }); });
    puntos.sort();
    puntos.push(hasta);
    for (var i = 0; i < puntos.length - 1; i++) {
      var a = puntos[i], b = puntos[i + 1], d = Math.max(0, diasEntre(a, b));
      var quieto = congs.some(function (c) { return a >= c.a && (c.b === null || a < c.b); });
      var it = quieto ? 0 : interesDeTramo(base, tasaMensual, d);
      var t = { desde: a, hasta: b, dias: d, base: base, interes: it };
      if (quieto) t.congelado = true;
      tramos.push(t);
      interesDevengado += it;
    }
  };

  ord.forEach(function (c) {
    empujar(cursor, c.fechaPago, saldo);
    var abono = Math.round(+c.abonoCapital || 0);
    capitalAbonado += abono;
    saldo = Math.max(0, saldo - abono);
    interesCobrado += Math.round(+c.interesPeriodo || 0);
    cursor = c.fechaPago;
  });

  var iniAbierto = tramos.length;
  empujar(cursor, hastaISO, saldo);
  var abiertos = tramos.slice(iniAbierto);
  var interesAbierto = abiertos.reduce(function (s, t) { return s + t.interes; }, 0);
  var diasCongelados = abiertos.reduce(function (s, t) { return s + (t.congelado ? t.dias : 0); }, 0);

  var ultimo = ord.length ? ord[ord.length - 1] : null;
  return {
    origCOP: origCOP,
    capitalVivo: saldo,
    capitalAbonado: capitalAbonado,
    tramos: tramos,
    interesDevengado: interesDevengado,
    interesCobrado: interesCobrado,
    // Lo CONDONADO por acuerdo (`loans.interesesCondonados`, post-4.1.5) tambien sale de lo
    // pendiente: es interes que ya no se debe. Sin esto la condonacion de un credito abierto
    // no se sostenia (el interes reaparecia al instante).
    interesCondonado: condonado,
    interesPendiente: Math.max(0, interesDevengado - interesCobrado - condonado),
    fechaUltimoCorte: ultimo ? ultimo.fechaPago : null,
    diasDesdeUltimoCorte: diasEntre(ultimo ? ultimo.fechaPago : loan.fechaInicio, hastaISO),
    diasActivosDesdeUltimoCorte: Math.max(0, diasEntre(ultimo ? ultimo.fechaPago : loan.fechaInicio, hastaISO)) - diasCongelados,
    diasCongeladosDesdeUltimoCorte: diasCongelados,
    diasTotales: diasEntre(loan.fechaInicio, hastaISO),
    cache: {
      fechaUltimoCorte: ultimo ? ultimo.fechaPago : loan.fechaInicio,
      interesAcumuladoPend: Math.max(0, interesDevengado - interesCobrado - condonado
        - interesAbierto),
    },
  };
}

// Cortes de un credito abierto, en el orden en que ocurrieron.
export function cortesDe(loan, loanPays) {
  return (loanPays || [])
    .filter(function (p) { return String(p.prestamoId) === String(loan.id) && esCorte(p); })
    .sort(function (a, b) {
      var c = String(a.fechaPago).localeCompare(String(b.fechaPago));
      return c !== 0 ? c : (a.cuotaN - b.cuotaN);
    });
}

// Estado de un credito abierto a una fecha. Atajo para las superficies, que casi
// siempre quieren "el devengo de ESTE prestamo, hoy".
export function estadoDiario(loan, loanPays, hastaISO) {
  return devengoDiario(loan, cortesDe(loan, loanPays), hastaISO);
}

// ── CONDONACION: el monto escrito y el estado «Condonada» (post-4.1.5) ────────────
// Aprobado por el PO sobre un prototipo con un caso real. `payments.interesCondonado` guarda
// cuanto interes se le condono a cada cuota (acumulado); lo escribe /condonar-intereses.
export function condonadoDe(p) { return Math.round(+(p && p.interesCondonado) || 0); }

// «Condonada»: el perdon la saldo SIN que entrara dinero. Es un ROTULO: el estado guardado sigue
// siendo 'Pagado', asi el saldo, la auto-finalizacion y los conteos no cambian. Una cuota que
// ademas recibio un abono se rotula «Pagada» (si entro dinero), con lo condonado debajo.
export function esCondonada(p) {
  return !!p && p.estadoPago === 'Pagado' && condonadoDe(p) > 0 &&
    Math.round(+p.partialPaid || 0) <= 0 && !((+p.montoCOPRecibido || 0) > 0);
}

// Espejo del endpoint (routes/loans.js): lo condonable de cada cuota es su interes sin bajarla
// de lo ya abonado, min(interes, cuota - abonado), y un monto se reparte de la cuota MAS VIEJA a
// la mas nueva; la ultima a la que llega puede quedar condonada en parte. `monto` null = todo lo
// condonable. `error`: 'cero' (monto escrito <= 0) o 'excede' (mas de lo condonable).
export function planCondonacion(cuotas, monto) {
  var ord = (cuotas || []).slice().sort(function (a, b) {
    return String(a.fechaPago).localeCompare(String(b.fechaPago)) || ((a.cuotaN || 0) - (b.cuotaN || 0));
  });
  var conds = ord.map(function (p) {
    return { p: p, max: Math.max(0, Math.min(Math.round(p.interesPeriodo || 0), Math.round((p.cuotaTotal || 0) - (p.partialPaid || 0)))) };
  });
  var total = conds.reduce(function (s, x) { return s + x.max; }, 0);
  var objetivo = monto == null ? total : Math.round(monto);
  var error = monto != null && !(objetivo > 0) ? 'cero' : objetivo > total ? 'excede' : null;
  var resto = error ? 0 : objetivo;
  var filas = conds.map(function (x) {
    var c = Math.min(x.max, resto); resto -= c;
    var interes = Math.round(x.p.interesPeriodo || 0), ab = Math.round(x.p.partialPaid || 0), cuota = Math.round(x.p.cuotaTotal || 0) - c;
    return { p: x.p, max: x.max, condonar: c, interes: interes, interesQueda: interes - c, cuotaQueda: cuota, abonado: ab,
      parcial: c > 0 && c < interes, saldada: c > 0 && ab >= cuota, quedaDebiendo: Math.max(0, cuota - ab) };
  });
  return { total: total, condonado: error ? 0 : objetivo, filas: filas, error: error };
}

// El plan aplicado a una COPIA de las cuotas: el "despues" que muestra el modal, sin escribir nada.
export function aplicarCondonacion(pays, plan) {
  var por = {};
  plan.filas.forEach(function (f) { if (f.condonar > 0) por[f.p.id] = f; });
  return (pays || []).map(function (p) {
    var f = por[p.id];
    if (!f) return p;
    return Object.assign({}, p, { interesPeriodo: f.interesQueda, cuotaTotal: f.cuotaQueda,
      estadoPago: f.saldada ? 'Pagado' : p.estadoPago, interesCondonado: condonadoDe(p) + f.condonar });
  });
}

// ── PROGRESO de un credito abierto ────────────────────────────────────────────
// Las barras de progreso de la app miden cuota-a-cuota: `cuotas pagadas / total`
// o `monto cobrado / monto esperado`. Ninguna de las dos significa nada aqui, y
// la segunda ademas MIENTE: todo corte nace 'Pagado', asi que cobrado == esperado
// y la barra marca 100% mientras el cliente sigue debiendo el capital. Verificado
// en la app real: un credito con $600.000 vivos aparecia al 100%.
//
// En un credito abierto la pregunta con sentido es cuanto CAPITAL se ha devuelto,
// que es lo unico que de verdad avanza hacia el cierre. El interes se cobra y se
// vuelve a generar; no es progreso.
export function progresoCapital(loan, loanPays) {
  var origCOP = loan.moneda === 'USD'
    ? Math.round(loan.montoOrigen * loan.trmAcordada)
    : Math.round(loan.montoOrigen);
  if (!(origCOP > 0)) return 0;
  var abonado = cortesDe(loan, loanPays)
    .reduce(function (s, c) { return s + Math.round(+c.abonoCapital || 0); }, 0);
  return Math.min(100, Math.round(abonado / origCOP * 100));
}

// ── Cálculo CENTRALIZADO de la liquidación (v1.19.0) ──────────────────────────
// UNA sola fuente de verdad para el "Valor de liquidación": LiquidarModal, la
// cifra "Liquidar hoy" del panel del deudor (DeudorPanel) y los PDFs (cronograma + recibo de abono)
// llaman a este helper, así no pueden divergir. Regla de negocio:
//   Total = Capital pendiente + Intereses en mora (+ la mora consolidada dentro de la
//           cuota transitoria) − abonos parciales en curso (+ interés del próximo mes
//           si el checkbox está activo)
//   Capital pendiente = originalCOP − Σ abonoCapital de cuotas Pagadas (incluye abonos '-ab-').
//     Las cuotas EN MORA **no** restan capital: siguen debiéndose y se pagan al liquidar.
// Devuelve todo el desglose (incl. el valor por mes de los intereses) para renderizarlo.
// ── LA CUOTA TRANSITORIA (3.2.0) ─────────────────────────────────────────────
// ESPEJO de `transitoriaDe` / `aplicarPeriodoIrregular` (backend/core/engine.js): una cuota de
// periodo irregular —el primer periodo elegido al crear, o la cuota que sigue a un cambio de
// dia— cobra sus DIAS REALES sobre el capital vivo (dias / 30), mas la mora consolidada.
export function esTransitoria(loan, cuotaN){
  var n=+(loan&&loan.periodoIrregularN)||0;
  if(!n||!loan.periodoIrregularDesde||n!==cuotaN) return false;
  return loan.modalidad==='Intereses'||loan.modalidad==='Capital + Intereses';
}
export function interesTransitoria(loan, saldoInicial, fechaPago){
  var dias=Math.max(1, diasEntre(loan.periodoIrregularDesde, fechaPago));
  return interesPeriodoParcial(saldoInicial, loan.tasaMensual, loan.frecuencia||'Mensual', dias)+Math.max(0, Math.round(+loan.periodoIrregularMora||0));
}

// ── EL PERIODO EN CURSO ES IRREGULAR (3.2.0, Fase 3) ─────────────────────────
// La cuota "en curso" es la regular Pendiente mas proxima (la misma que usa el cobro en
// cascada). Si es la transitoria, el periodo que se esta corriendo NO es un mes: va desde
// `periodoIrregularDesde` hasta el vencimiento de esa cuota, y puede ser un tiempo muerto de
// 90 dias o uno corto de 15. Devuelve null si el periodo en curso es un mes normal.
export function periodoIrregularEnCurso(loan, loanPays, hasta){
  var enCurso=(loanPays||[]).filter(function(p){
    return String(p.prestamoId)===String(loan.id) && esCuotaRegular(p) && p.estadoPago==='Pendiente';
  }).sort(function(a,b){
    var d=String(a.fechaPago||'').localeCompare(String(b.fechaPago||''));
    return d!==0?d:((a.cuotaN||0)-(b.cuotaN||0));
  })[0];
  if(!enCurso||!esTransitoria(loan, enCurso.cuotaN)) return null;
  var desde=loan.periodoIrregularDesde;
  var diasPeriodo=Math.max(1, diasEntre(desde, enCurso.fechaPago));
  return {
    cuotaN:enCurso.cuotaN, desde:desde, hasta:enCurso.fechaPago, diasPeriodo:diasPeriodo,
    diasTranscurridos:Math.min(diasPeriodo, Math.max(0, diasEntre(desde, hasta)))
  };
}
function sumarDiasISO(iso, n){
  var d=new Date(String(iso)+'T12:00:00');
  d.setDate(d.getDate()+n);
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}

// ── CONGELAR PRESTAMO (post-4.1.6) — el espejo del motor (engine.js, "CONGELAR PRESTAMO") ──────
// `congelamientos` (JSON) es el historial de congelamientos como DECISIONES; `congeladoDesde`, el
// del abierto. Un prestamo congelado sigue Activo: lo vencido se debe y se cobra; desde esa fecha
// no corren intereses ni nacen cuotas. La cuota en curso se cerro con los dias corridos (fija).
export function congelamientosDe(loan){
  var v = loan && loan.congelamientos;
  if (Array.isArray(v)) return v;
  try { var a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch (_) { return []; }
}
export function congeladoAbierto(loan){
  if (!loan || !loan.congeladoDesde) return null;
  var a = congelamientosDe(loan), c = a[a.length - 1];
  return c && !c.hasta ? c : null;
}
// Congelado de verdad: activo y con un congelamiento abierto.
export function estaCongelado(loan){ return !!(loan && loan.estado === 'Activo' && congeladoAbierto(loan)); }
// El congelamiento que cerro la cuota N con sus dias corridos (o null).
export function cierreDeCuota(loan, n){
  return congelamientosDe(loan).filter(function(c){ return +c.cuotaN === +n && !c.perdona && Math.round(+c.interes || 0) > 0 && c.fecha; })[0] || null;
}

export function computeLiquidacion(loan, loanPays, opts){
  opts = opts || {};
  var esUSD = loan.moneda === 'USD';
  var origCOP = esUSD ? Math.round(loan.montoOrigen * loan.trmAcordada) : Math.round(loan.montoOrigen);
  var pays = (loanPays||[]).filter(function(p){ return String(p.prestamoId) === String(loan.id); });
  var regs = pays.filter(function(p){ return !esAbono(p); });
  var capPagadas = pays.filter(function(p){ return p.estadoPago === 'Pagado'; })
    .reduce(function(s,p){ return s + p.abonoCapital; }, 0);
  var capitalPendiente = Math.max(0, origCOP - capPagadas);
  var moraRows = regs.filter(function(p){ return p.estadoPago === 'En Mora'; });
  var moraCount = moraRows.length;
  var intMora = moraRows.reduce(function(s,p){ return s + p.interesPeriodo; }, 0);
  var moraInts = moraRows.map(function(p){ return Math.round(p.interesPeriodo); });
  var moraUniforme = moraCount > 0 && moraInts.every(function(v){ return v === moraInts[0]; });
  // valor por mes de los intereses en mora: exacto si todas las cuotas son iguales (Intereses o
  // C+I de 1 cuota); si varían (C+I multi-mora) se muestra el promedio, marcado como tal.
  var moraValorMes = moraCount > 0 ? (moraUniforme ? moraInts[0] : Math.round(intMora / moraCount)) : 0;
  var partialPend = regs.filter(function(p){ return p.estadoPago !== 'Pagado'; })
    .reduce(function(s,p){ return s + (p.partialPaid || 0); }, 0);
  var aplicaInteres = loan.modalidad !== 'Prestamo' && loan.modalidad !== 'Pago Unico' && (+loan.tasaMensual || 0) > 0;
  var hastaLiq = opts.hasta || (function () {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  })();
  // ── EL PERIODO EN CURSO ES EL DE LA FRECUENCIA (3.3.0, Fase 3) ──────────────
  // La casilla cobra UN periodo normal: el interes de la cuota que el motor genera para ese
  // capital. En Semanal y Quincenal eso es una semana o una quincena, no un mes: hasta 3.2.0
  // un semanal de 4.000.000 al 10% ofrecia 400.000 (un mes) cuando su cuota cobra 92.379. En
  // Mensual se conserva la expresion de siempre, bit a bit (`x * t / 100` y `x * (t / 100)` no
  // siempre redondean igual).
  var frecuencia = loan.frecuencia || 'Mensual';
  var periodoCorto = !esDiario(loan) && (frecuencia === 'Semanal' || frecuencia === 'Quincenal');
  var intProxMes = !aplicaInteres ? 0
    : periodoCorto ? Math.round(capitalPendiente * tasaDelPeriodo((+loan.tasaMensual || 0) / 100, frecuencia))
    : Math.round(capitalPendiente * (+loan.tasaMensual || 0) / 100);
  // ── LA GRACIA SE RESPETA AL LIQUIDAR (3.3.0, Fase 3, regla del PO) ──────────
  // Si al crear se perdonaron los dias muertos, el interes corre desde `fechaInicioIntereses`.
  // Liquidar ANTES de esa fecha es liquidar dentro de la gracia: todavia no corre ningun
  // periodo, asi que no hay interes que cobrar por adelantado (0) y la casilla no se ofrece.
  // Gana sobre el periodo irregular: una transitoria creada por un cambio de dia dentro de la
  // gracia arranca en esa misma fecha (Bug #73) y tampoco ha corrido.
  var enGracia = aplicaInteres && !esDiario(loan) && !!loan.fechaInicioIntereses &&
    String(loan.fechaInicioIntereses) > String(loan.fechaInicio || '') && hastaLiq < String(loan.fechaInicioIntereses);
  if (enGracia) intProxMes = 0;
  var incluye = !!opts.incluyeProxMes && aplicaInteres && !enGracia;

  // ── PERIODO IRREGULAR EN CURSO: DIAS VARIABLES (3.2.0, Fase 3, regla del PO) ──
  // Si la cuota en curso es la transitoria (primer periodo elegido al crear, o la que sigue
  // a un cambio de dia), "el interes del mes en curso" no es un mes: un tiempo muerto de 92
  // dias no se liquida con 30, ni uno de 15 con 30. El administrador ESCOGE cuantos dias
  // cobrar (`opts.diasProxMes`); por defecto, los que ya corrieron hasta `hasta` (si liquida
  // al dia 10 de un periodo de 15, cobra 10). Se acota a [0, dias del periodo]: cobrar mas
  // pediria mas de lo que la propia cuota pide. La formula es la del motor (3.3.0): el
  // interes de una cuota normal x dias / dias del periodo de la frecuencia.
  // `validoHasta`: hasta cuando cubre ese interes. Los dias cobrados cuentan desde el inicio
  // del periodo; si son menos de los ya transcurridos, la cifra vale solo para `hasta`.
  var irregular = (aplicaInteres && !esDiario(loan) && !enGracia) ? periodoIrregularEnCurso(loan, pays, hastaLiq) : null;
  var diasCobrados = 0, validoHasta = null;
  if (irregular) {
    var pedidos = opts.diasProxMes;
    pedidos = (pedidos === undefined || pedidos === null || pedidos === '' || !isFinite(+pedidos))
      ? irregular.diasTranscurridos : Math.round(+pedidos);
    diasCobrados = Math.max(0, Math.min(irregular.diasPeriodo, pedidos));
    intProxMes = interesPeriodoParcial(capitalPendiente, +loan.tasaMensual || 0, frecuencia, diasCobrados);
    var cubre = sumarDiasISO(irregular.desde, diasCobrados);
    validoHasta = cubre < hastaLiq ? hastaLiq : cubre;
  }
  // ── CONGELADO (post-4.1.6, regla del PO) ────────────────────────────────────
  // Mientras esta congelado no corre ningun periodo: "el interes del periodo en curso" son los dias
  // hasta el congelamiento, que viven en la cuota de cierre (si no se perdonaron y aun no vencio:
  // vencida, ya esta en `intMora`). La casilla los ofrece en vez de un periodo entero.
  var cong = aplicaInteres ? congeladoAbierto(loan) : null;
  var filaCierre = null;
  if (cong && esDiario(loan)) {
    // Credito abierto congelado (Fase 2): lo devengado hasta el congelamiento se debe y se cobra
    // (va en `interesDevengado`), pero hacia adelante no corre nada: no hay interes que adelantar.
    intProxMes = 0; incluye = false;
  } else if (cong) {
    irregular = null; diasCobrados = 0; validoHasta = null;
    filaCierre = cong.perdona ? null : (regs.filter(function(p){ return p.cuotaN === +cong.cuotaN && p.estadoPago === 'Pendiente'; })[0] || null);
    intProxMes = filaCierre ? Math.max(0, Math.round((+filaCierre.interesPeriodo || 0) - (+filaCierre.cargaTrasladada || 0))) : 0;
  }
  var intExtra = incluye ? intProxMes : 0;

  // ── MORA CONSOLIDADA DENTRO DE LA CUOTA TRANSITORIA (3.2.0, Fase 4) ─────────
  // `/cambiar-dia-pago` BORRA las cuotas En Mora y consolida sus intereses dentro de la
  // cuota transitoria (`loans.periodoIrregularMora`). Es deuda YA CAUSADA, pero deja de
  // vivir en una fila `En Mora`, asi que `intMora` no la ve; y como liquidar borra el
  // cronograma, esa fila desaparece y el dinero se perdia ENTERO (medido con el server
  // real: un total de 3.382.739 caia a 3.000.000 justo despues del cambio de dia).
  // Se suma SIEMPRE, no depende del checkbox: no es el interes de un periodo por correr
  // --eso se pacta con el deudor-- sino atraso ya devengado, como cualquier cuota vencida.
  // El gate es el ESTADO de la propia fila transitoria, para no contarla dos veces:
  //   Pendiente -> hay que cobrarla aparte (esta rama);
  //   En Mora   -> su `interesPeriodo` YA la incluye, y `intMora` ya la sumo;
  //   Pagado    -> ya se cobro (la columna no se limpia al pagar: queda inerte).
  var filaTrans = (+loan.periodoIrregularN || 0)
    ? regs.filter(function(p){ return p.cuotaN === +loan.periodoIrregularN; })[0] : null;
  var moraConsolidada = (filaTrans && filaTrans.estadoPago === 'Pendiente' && esTransitoria(loan, filaTrans.cuotaN))
    ? Math.max(0, Math.round(+loan.periodoIrregularMora || 0)) : 0;

  // ── INTERES DIARIO ──────────────────────────────────────────────────────────
  // Un credito abierto no tiene cuotas En Mora, asi que `intMora` sale 0 y la
  // liquidacion se quedaria en el capital pelado: se regalaria TODO el interes
  // devengado y no cobrado, que en este producto es la renta entera. El interes no
  // esta en ninguna fila — vive derivado del tiempo transcurrido — asi que hay que
  // pedirselo al motor.
  //
  // `capitalPendiente` NO necesita rama: los cortes son 'Pagado' y llevan su
  // `abonoCapital`, asi que la formula canonica ya devuelve el capital vivo exacto.
  var diario = esDiario(loan);
  var devengo = 0, diasDevengados = 0, interesDia = 0, diasCongeladosDiario = 0;
  if (diario) {
    // `hasta` es un PARAMETRO y no `new Date()` por dentro: el valor de liquidacion
    // depende del dia, y dejar que la funcion lo decida sola la volveria imposible
    // de probar y de reproducir en un PDF fechado.
    var hasta = opts.hasta || (function () {
      var d = new Date();
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    })();
    var dev = estadoDiario(loan, pays, hasta);
    devengo = dev.interesPendiente;
    // Los dias que explican el devengo son los que corrieron (sin los congelados): "N dias a $X".
    diasDevengados = dev.diasActivosDesdeUltimoCorte;
    diasCongeladosDiario = dev.diasCongeladosDesdeUltimoCorte;
    interesDia = interesDeTramo(dev.capitalVivo, +loan.tasaMensual || 0, 30) / 30;
  }

  // ── INTERESES TRASLADADOS DE UNA UNIFICACION (post-4.0.0) ───────────────────
  // Un prestamo que nacio de una unificacion puede cobrar, como CARGA fija en sus cuotas, los
  // intereses que debian los prestamos viejos. Esa carga vive dentro del interes de cada cuota:
  // las Pagadas ya la cobraron y las En Mora ya la traen en `intMora`; la de las cuotas
  // Pendientes (y la de las que aun no nacen) se borraria al liquidar. Es deuda ya causada: se
  // suma SIEMPRE, como la mora consolidada, y quien liquida la cobra en el `intExtra`.
  var cargaPendiente = Math.max(0, Math.round(+loan.cargaTrasladada || 0) - regs
    .filter(function(p){ return p.estadoPago === 'Pagado' || p.estadoPago === 'En Mora'; })
    .reduce(function(s, p){ return s + Math.round(+p.cargaTrasladada || 0); }, 0));

  var total = Math.max(0, capitalPendiente + intMora + moraConsolidada + cargaPendiente + devengo - partialPend + intExtra);
  return {
    esUSD: esUSD, trm: loan.trmAcordada, tasaMensual: +loan.tasaMensual || 0,
    cargaPendiente: cargaPendiente,
    capitalPendiente: capitalPendiente,
    intMora: intMora, moraCount: moraCount, moraUniforme: moraUniforme, moraValorMes: moraValorMes,
    // Mora consolidada VIVA dentro de la cuota transitoria (3.2.0, Fase 4). No es opcional:
    // es atraso ya causado. Quien liquide tiene que COBRARLA ademas del capital, y como su
    // fila se borra al liquidar, viaja al backend dentro del `intExtra` del abono (app.js).
    moraConsolidada: moraConsolidada,
    moraConsolidadaFecha: moraConsolidada > 0 ? filaTrans.fechaPago : null,
    partialPend: partialPend,
    aplicaInteres: aplicaInteres, intProxMes: intProxMes,
    incluyeProxMes: incluye, intExtra: intExtra,
    // Campos propios del credito abierto. En las otras 4 modalidades valen 0, asi
    // que las superficies pueden leerlos sin ramificar.
    esDiario: diario, interesDevengado: devengo,
    diasDevengados: diasDevengados, interesDia: Math.round(interesDia),
    diasCongeladosDiario: diasCongeladosDiario,
    // Periodo irregular en curso (3.2.0). Fuera de el valen false/0/null.
    periodoIrregular: !!irregular,
    periodoDesde: irregular ? irregular.desde : null,
    periodoHasta: irregular ? irregular.hasta : null,
    diasPeriodo: irregular ? irregular.diasPeriodo : 0,
    diasTranscurridos: irregular ? irregular.diasTranscurridos : 0,
    diasCobrados: diasCobrados,
    validoHasta: validoHasta,
    // 3.3.0: la frecuencia nombra el periodo en curso, y la gracia lo anula mientras dure.
    frecuencia: frecuencia,
    enGracia: enGracia,
    graciaHasta: enGracia ? String(loan.fechaInicioIntereses) : null,
    // Congelado (post-4.1.6): la casilla del periodo en curso son los dias hasta el congelamiento.
    congelado: !!cong, congeladoDesde: cong ? cong.desde : null,
    cierreDias: filaCierre ? (+cong.dias || 0) : 0, cierreFecha: filaCierre ? filaCierre.fechaPago : null,
    total: total
  };
}

// ── COMO SE NOMBRA EL PERIODO EN CURSO (3.3.0, Fase 3) ───────────────────────
// La casilla, el modal y los tres documentos dicen "el interes del mes en curso". En un credito
// semanal o quincenal ese periodo es una semana o una quincena; en Mensual el texto queda como
// siempre, asi que ningun documento mensual cambia.
export function periodoEnCursoDe(frecuencia) {
  if (frecuencia === 'Semanal') return 'de la semana en curso';
  if (frecuencia === 'Quincenal') return 'de la quincena en curso';
  return 'del mes en curso';
}
// La sub-linea que explica esa cifra: un periodo de interes sobre el capital pendiente.
export function detalleInteresEnCurso(frecuencia, tasaMensual) {
  var t = +tasaMensual || 0;
  if (frecuencia === 'Semanal') return 'Una semana de interés al ' + t + '% mensual sobre el capital pendiente';
  if (frecuencia === 'Quincenal') return 'Una quincena de interés al ' + t + '% mensual sobre el capital pendiente';
  return t + '% sobre el capital pendiente';
}

// ── PROXIMO VENCIMIENTO de un credito de cuotas (3.1.0) ──────────────────────
// Hasta cuando vale un valor de liquidacion que incluye el interes del mes en curso:
// el deudor queda cubierto justo hasta la proxima cuota. Lo imprimen el Estado de
// Liquidacion y el Cronograma; vivia dentro del primero y se mudo aqui para que los dos
// papeles no puedan anunciar fechas distintas.
// Sale de las FILAS PERSISTIDAS (la menor cuota regular sin pagar posterior a `hasta`),
// nunca de `diaPago` ni de un calculo de calendario: asi respeta sola cualquier
// prorroga o cambio de dia de cobro hecho a ese credito. `null` si no queda ninguna.
export function proximoVencimiento(loan, loanPays, hasta) {
  var futuras = (loanPays || [])
    .filter(function (p) {
      return String(p.prestamoId) === String(loan.id) && esCuotaRegular(p) &&
        p.estadoPago !== 'Pagado' && String(p.fechaPago) > String(hasta);
    })
    .map(function (p) { return String(p.fechaPago); })
    .sort();
  return futuras.length ? futuras[0] : null;
}

// ── ¿Se pregunta por el interes del mes antes de imprimir el cronograma? (3.1.0) ──
// El cronograma cierra con el valor de liquidacion, y ese valor puede incluir o no el
// interes del mes en curso: la misma decision que la casilla de Liquidar deuda. Solo se
// pregunta cuando la pregunta tiene respuesta: el credito puede cobrar ese interes (la
// misma regla `aplicaInteres` que decide si esa casilla existe) y le queda capital. En
// Prestamo, Pago Unico y tasa 0 el PDF sale directo, como siempre. Interes Diario queda
// fuera: su boton imprime el Estado de Cuenta, no el cronograma.
export function preguntaInteresMes(loan, loanPays) {
  if (!loan || esDiario(loan)) return false;
  var L = computeLiquidacion(loan, loanPays, {});
  // Congelado (post-4.1.6): solo si queda la cuota de cierre por vencer (sus dias corridos).
  if (L.congelado) return L.intProxMes > 0 && L.capitalPendiente > 0;
  // 3.3.0: dentro de la gracia no corre interes, asi que no hay nada que preguntar.
  return !!L.aplicaInteres && L.capitalPendiente > 0 && !L.enGracia;
}

// Saldo restante de una cuota considerando pagos parciales.
// Convive con `pendienteDeCuota` (arriba), que hace el mismo calculo por otra via.
// NO se consolidan: la duplicacion es preexistente y unificarla seria cambiar logica.
// Saldo restante de una cuota considerando pagos parciales
export function pendCuota(p){ return Math.max(0,(p.cuotaTotal||0)-(p.partialPaid||0)); }

// ── LO QUE FALTA DE UNA CUOTA EN DOLARES, Y CUANDO UN PAGO LA SALDA (4.1.4, bloque 4) ─────────────
// `faltaUSD` es la UNICA cifra de "lo que falta" en dolares: lo que falta en pesos (la obligacion a
// la TRM pactada) convertido al centavo. La usan el cobro, el recibo de pago, el formulario de pago y
// la factura; hasta 4.1.3 la factura calculaba la suya (dolares contra dolares) y en el 0,7% de las
// cuotas con un abono las dos diferian en un centavo.
// `cierraEnDolares` es el ESPEJO de la regla del backend (backend/core/cobros.js): el pago salda la
// cuota si cubre `faltaUSD`, o si los dolares entregados en total cubren la cuota en dolares (Bug
// #23), con medio centavo de tolerancia. `pay` es la cuota ANTES del pago.
export function faltaUSD(pay, trm){ return trm>0 ? Math.round(pendCuota(pay)/trm*100)/100 : 0; }
export function cierraEnDolares(pay, usd, trm){
  if(!(trm>0)||!(usd>0)) return false;
  var u=Math.round(usd*100)/100;
  var cuotaUSD=Math.round((+pay.cuotaTotal||0)/trm*100)/100;
  var acum=Math.round(((+pay.montoUSDRecibido||0)+u)*100)/100;
  return (cuotaUSD>0&&acum>=cuotaUSD-0.005)||u>=faltaUSD(pay,trm)-0.005;
}
