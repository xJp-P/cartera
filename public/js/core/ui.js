// public/js/core/ui.js — utilidades transversales de interfaz.
//
// Extraido de `app.js` en la Etapa 3 (B3) del refactor. Codigo VERBATIM.
//
// `_submitGuard` es la pieza importante: la guarda anti doble-submit que blinda
// LOS 13 BOTONES que escriben en la BD (Bug #29, cerrado en v1.18.1). Los
// endpoints NO son idempotentes, asi que un doble clic aplicaba la operacion dos
// veces. Implementacion UNICA y compartida: cinco copias serian cinco sitios donde
// equivocarse.

// ── Guarda anti doble-submit (Bug #29) ───────────────────────────────────────
// Ejecuta `fn` solo si no hay otra operacion en vuelo y libera SIEMPRE la bandera:
// al resolver, al rechazar, si `fn` no devuelve promesa (rutas que ceden el control a
// otro modal, como el pre-flight de mora) o si lanza de forma sincrona.
//
// La liberacion va en el .then y NO en un .catch a proposito: los helpers de API
// (API.get/post/put/del) atrapan el error y RESUELVEN null, nunca rechazan, asi que un
// .catch jamas correria y el boton quedaria bloqueado para siempre. El manejador de
// rechazo se conserva por si esos helpers dejaran de atrapar en el futuro.
//
// Implementacion unica y compartida: los endpoints de escritura NO son idempotentes, y
// cinco copias de esta logica serian cinco sitios donde equivocarse.
export function _submitGuard(sending,setSending,fn){
  if(sending) return;
  setSending(true);
  var p;
  try{ p=fn(); }catch(e){ setSending(false); throw e; }
  if(p&&typeof p.then==='function') p.then(function(){setSending(false);},function(){setSending(false);});
  else setSending(false);
}

// Proper Case (Capitalizacion de Titulos): "pa"->"Pa", "juan PEREZ"->"Juan Perez"
export function properCase(s){ return String(s||'').trim().split(/\s+/).map(function(w){return w?w.charAt(0).toUpperCase()+w.slice(1).toLowerCase():w;}).join(' '); }

export function freqLabel(loan){
  if(loan.modalidad==='Intereses') return '\u221E Indefinido';
  var n=loan.plazoMeses;
  var f=loan.frecuencia||'Mensual';
  if(f==='Semanal') return n+' semanas';
  if(f==='Quincenal') return n+' quincenas';
  return n+' cuotas';
}

export function freqCuotaLabel(f){return f==='Semanal'?'semanal':f==='Quincenal'?'quincenal':'mensual';}

export function nowStr()    { var d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }

export function addDays(s,n){ var d=new Date(s+'T12:00:00'); d.setDate(d.getDate()+n); return d.toISOString().split('T')[0]; }

// 3.7.0 — Texto PLEGADO para buscar: sin tildes ni dieresis, la enie como n y en minusculas, asi que
// "jose", "Jose" y "JOSE" (con o sin tilde) dan lo mismo. Solo sirve para COMPARAR: nunca se guarda
// ni se muestra. NFD separa la letra de su marca y el rango U+0300-U+036F son las marcas.
export function plegar(s){ return String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
// Todo buscador de la app pasa por aqui: `texto` contiene lo que se escribio, sin mirar tildes.
export function contiene(texto, q){ return plegar(texto).indexOf(plegar(q).trim()) !== -1; }

// ── CODIGO DE FACTURA DE COBRO (FC) ────────────────────────────────────────────
// El codigo NO se guarda en ningun lado: se recalcula cada vez que se imprime o se busca. Por eso
// la regla de las iniciales de una CUOTA esta CONGELADA tal como se imprime desde v1.16.0 (las 2
// primeras letras del deudor en Proper Case, con su tilde: "Án" para Ángela). Cambiarla cambiaria el
// codigo de facturas que ya estan en manos de los clientes. Lo que si cambio en 3.7.0 es BUSCARLO:
// el buscador pliega tildes, asi que "fc-an-465-21" encuentra la factura FC-Án-465-21.
function fcIniciales(nombre){ return properCase(String(nombre||'')).replace(/\s+/g,'').slice(0,2); }
// FC-[2 primeras letras del deudor]-[ultimos 3 del loanId]-[cuota 2 digitos]
export function facturaCode(p){
  if(!p) return '';
  return 'FC-'+fcIniciales(p.nombreCliente)+'-'+String(p.prestamoId||'').slice(-3)+'-'+String(p.cuotaN||0).padStart(2,'0');
}
// Credito abierto (Interes Diario): FC-[iniciales]-[ultimos 3 del loanId]-[DDMM de emision]. Hasta
// 3.6.0 sus iniciales salian de `[A-Za-z]` sin Proper Case, asi que perdian las letras con tilde
// ("ng" para Ángela) y no coincidian con las del mismo deudor en sus otras facturas. Desde 3.7.0
// usan la regla de las cuotas. No rompe ningun codigo ya emitido: este lleva la fecha de emision,
// asi que nunca se reimprimio igual; y el buscador acepta las dos formas (`fcCoincideDiario`).
function fcInicialesDiario36(nombre){ return String(nombre||'').trim().replace(/[^A-Za-z]/g,'').slice(0,2); }
export function fcCodigoDiario(loan, hasta){
  return 'FC-'+(fcIniciales(loan.nombre)||'XX')+'-'+String(loan.id).slice(-3)+'-'+String(hasta).slice(8,10)+String(hasta).slice(5,7);
}
// ¿El texto buscado es el codigo FC (o su comienzo) de este credito abierto? La parte estable del
// codigo es FC-iniciales-loanId; la fecha del final es opcional. Vale con las iniciales de 3.7.0 o
// con las de antes, para que un papel viejo se siga encontrando.
export function fcCoincideDiario(loan, q){
  var ql=plegar(q).trim();
  if(ql.indexOf('fc-')!==0) return false;
  var id3=String(loan.id||'').slice(-3);
  return [fcIniciales(loan.nombre), fcInicialesDiario36(loan.nombre)].some(function(ini){
    var base=plegar('FC-'+(ini||'XX')+'-'+id3);
    return base.indexOf(ql)===0 || (ql.indexOf(base)===0 && /^-\d{0,4}$/.test(ql.slice(base.length)));
  });
}

// Match del buscador de Cobros: si el texto empieza por "fc-" filtra por codigo de factura; si no, por
// nombre. Las dos comparaciones ignoran tildes y mayusculas.
export function payMatchesQuery(p,q){
  if(!q) return true;
  var ql=plegar(q).trim();
  if(ql.indexOf('fc-')===0) return plegar(facturaCode(p)).indexOf(ql)!==-1;
  return plegar(p.nombreCliente).indexOf(ql)!==-1;
}
