// backend/core/util.js — helpers puros compartidos.
//
// Extraidos de `server.js` en la Etapa 2 (A3) del refactor de modularizacion.
// Codigo movido VERBATIM. Ya vivian FUERA del closure `createApp`, asi que
// mudarlos a su propio archivo no cambia su semantica en nada.
//
// Existen como modulo propio porque `db/housekeeping.js` necesita `hoyStr` y los
// routers necesitan `genId`; la alternativa era duplicarlos, que es justo lo que
// este refactor no debe hacer.

// Fecha local (no UTC) en formato YYYY-MM-DD
function hoyStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// Fecha y hora local "YYYY-MM-DD HH:MM:SS" desplazada `dias` dias: el mismo formato que
// escribe SQLite con datetime('now','localtime'), leida del MISMO reloj que `hoyStr`.
// La usa la poda del journal de undo: antes le preguntaba la hora a SQLite, que es el
// unico sitio del backend donde una DECISION dependia de un reloj distinto al de JS
// (y por eso ninguna suite podia fijarlo).
function ahoraLocal(dias) {
  const d = new Date();
  if (dias) d.setDate(d.getDate() + dias);
  const dd = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + dd(d.getMonth() + 1) + '-' + dd(d.getDate()) + ' ' +
         dd(d.getHours()) + ':' + dd(d.getMinutes()) + ':' + dd(d.getSeconds());
}

// ID unico estilo timestamp + sufijo aleatorio (mismo formato que los IDs de loans)
function genId() {
  return Date.now().toString() + Math.random().toString(36).slice(2, 6);
}

module.exports = { hoyStr, ahoraLocal, genId };
