// backend/core/cobros.js — DURABILIDAD DE LO COBRADO al regenerar un cronograma.
//
// Extraido de `server.js` en la Etapa 2 (A4) del refactor de modularizacion.
// Codigo movido VERBATIM.
//
// Es la respuesta al Bug #44: cinco endpoints borran cuotas para regenerarlas, y
// si una llevaba un PAGO PARCIAL encima, regenerarla destruye el registro del
// dinero — el cliente pago y el sistema lo olvida. Estas funciones son la UNICA
// implementacion del snapshot/restauracion; no duplicar la logica en cada endpoint.
//
// No necesita `db`: opera sobre las filas que el endpoint ya leyo y sobre el
// cronograma nuevo EN MEMORIA, antes de escribir. Por eso no es una factory.

const { ClientError } = require('./errors');

// ── Durabilidad de lo COBRADO al regenerar un cronograma ───────────────────
// Varios endpoints borran las cuotas Pendientes (y en un caso las En Mora) y las vuelven a
// generar. Si una de esas cuotas llevaba un PAGO PARCIAL encima, regenerarla destruye el
// registro del dinero: el cliente pago y el sistema lo olvida (misma clase de falla que el
// Bug #38, cuya guarda solo protege las cuotas Pagadas). Estos 3 helpers son la unica
// implementacion del snapshot/restauracion; no duplicar la logica en cada endpoint.
function snapshotCobros(filas) {
  const map = {};
  (filas || []).forEach(p => {
    const tieneLedger = p.recibos && p.recibos !== '[]';
    if ((p.partialPaid || 0) > 0 || p.observaciones || tieneLedger) {
      map[p.cuotaN] = {
        partialPaid: p.partialPaid || 0,
        observaciones: p.observaciones || '',
        recibos: p.recibos || '[]',
        // Los ACUMULADORES de lo recibido. Desde v2.6.1 (Bug #50) `/partial` suma aqui la caja
        // en pesos y los dolares de cada parcial, y los dos deciden cosas: `montoUSDRecibido`
        // alimenta `completaUSD` (si el USD ya entregado cubre la cuota, cierra) y
        // `montoCOPRecibido` es la caja con la que Ganancias mide el efecto cambiario. Este
        // snapshot es de v2.3.0, anterior a ese sprint, y no los guardaba: medido en
        // produccion, un abono con recalculo borro USD 40,14 y $123.446 de una cuota, y al
        // pagar exactamente lo que decian sus papeles la cuota quedaba abierta con $13 de
        // deuda fantasma.
        montoCOPRecibido: p.montoCOPRecibido || 0,
        montoUSDRecibido: p.montoUSDRecibido || 0
      };
    }
  });
  return map;
}
function restaurarCobros(schedule, map) {
  (schedule || []).forEach(p => {
    const s = map[p.cuotaN];
    if (!s) return;
    p.partialPaid = s.partialPaid;
    p.recibos = s.recibos;
    p.montoCOPRecibido = s.montoCOPRecibido;
    p.montoUSDRecibido = s.montoUSDRecibido;
    if (s.observaciones) p.observaciones = s.observaciones;
  });
}
// Cuotas con DINERO encima cuyo cuotaN no existe en el cronograma nuevo (p.ej. al acortar el
// plazo): restaurarlas es imposible y dejarlas caer seria perder plata en silencio. El endpoint
// debe abortar en FASE 1 -> 4xx con la BD intacta. Las observaciones sin dinero no cuentan.
function cobrosHuerfanos(schedule, map) {
  const nuevos = new Set((schedule || []).map(p => p.cuotaN));
  return Object.keys(map)
    .filter(n => (map[n].partialPaid || 0) > 0 && !nuevos.has(+n))
    .map(n => ({ cuotaN: +n, partialPaid: map[n].partialPaid }));
}
function abortarSiHuerfanos(schedule, map) {
  const h = cobrosHuerfanos(schedule, map);
  if (h.length === 0) return;
  const det = h.map(x => 'cuota ' + x.cuotaN + ' ($' + Math.round(x.partialPaid).toLocaleString('es-CO') + ')').join(', ');
  throw new ClientError(
    'La operacion eliminaria el registro de un pago parcial ya recibido: ' + det + '. ' +
    'El nuevo cronograma no incluye esa(s) cuota(s), asi que el dinero quedaria sin donde figurar. ' +
    'Completa o revierte ese pago parcial antes de continuar.'
  );
}

module.exports = { snapshotCobros, restaurarCobros, cobrosHuerfanos, abortarSiHuerfanos };
