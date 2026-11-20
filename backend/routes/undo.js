// backend/routes/undo.js — el Boton Deshacer ("La Bestia").
//
// Extraido de `server.js` en la Etapa 2 (A5) del refactor. Codigo VERBATIM
// (unica sustitucion: `app.X` -> `router.X`).
//
// Estos 2 endpoints son los CONSUMIDORES del journal; quien lo ESCRIBE es
// `mutacionAtomica` (core/atomic.js), dentro de la misma transaccion que cada
// mutacion. Los candados que se aplican aca:
//   A  LIFO por scope: solo la entrada `disponible` mas reciente de ESE agregado
//      puede deshacerse; si no, 409 nombrando la que falta.
//   B  `post_hash` es DETECTOR, NO GATE. El arranque corre housekeeping
//      determinista (auto-mora, fixPrestamos) que cambia filas sin ser decision
//      del usuario; si el hash bloqueara, todos los undos caducarian con solo
//      reiniciar la app. Se restaura, se RE-APLICA el housekeeping y la
//      divergencia viaja como `warning`.
//   E  drift de esquema: el restore inserta por INTERSECCION de columnas.
//
// APPEND-ONLY: deshacer no borra la huella. La entrada queda `deshecho` y se
// agrega una compensatoria de tipo `deshacer` al activity_log.

const express = require('express');

module.exports = function crearRutasUndo(ctx) {
  const { db, logAction, hashSnapshot, snapshotActual, restoreScope, reHousekeepLoan } = ctx;
  const router = express.Router();

  // ¿Que prestamos toca una entrada? El suyo; una unificacion, el nuevo y los viejos; un renombre de
  // cliente (tipo 'grupo', 4.1.3), todos sus prestamos. El tipo se lee del comienzo del snapshot
  // (`JSON.stringify` deja `v` y `tipo` primero) para no parsear entradas grandes que no lo necesitan.
  function tipoSnap(txt) {
    const m = /^\{"v":1,"tipo":"([a-z]+)"/.exec(txt || '');
    return m ? m[1] : null;
  }
  function involucra(row, snap) {
    if (snap && snap.tipo === 'grupo') return (snap.ids || []).slice();
    if (snap && snap.tipo === 'unif') return [snap.nuevoId].concat(snap.viejosIds || []);
    return [row.scope_id];
  }
  function involucraFila(row) {
    const t = tipoSnap(row.snapshot);
    if (t !== 'grupo' && t !== 'unif') return [row.scope_id];
    try { return involucra(row, JSON.parse(row.snapshot)); } catch (_) { return [row.scope_id]; }
  }

  // ── API: Deshacer ────────────────────────────────────────────────────────────
  router.post('/api/undo/:id', (req, res) => {
    const entry = db.prepare('SELECT * FROM undo_journal WHERE id = ?').get(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Operación no encontrada en el historial' });
    if (entry.estado !== 'disponible') {
      return res.status(400).json({ error: 'Esta operación ya fue ' + (entry.estado === 'deshecho' ? 'deshecha' : 'invalidada') + ' y no puede revertirse de nuevo' });
    }
    // Candado A — LIFO estricto por scope: solo la entrada disponible MAS reciente
    // de este agregado puede deshacerse.
    const top = db.prepare("SELECT id, descripcion, created_at FROM undo_journal WHERE scope_tipo=? AND scope_id=? AND estado='disponible' ORDER BY rowid DESC LIMIT 1").get(entry.scope_tipo, entry.scope_id);
    if (top && top.id !== entry.id) {
      return res.status(409).json({ error: 'Primero debes deshacer la operación más reciente de este ' + (entry.scope_tipo === 'debt' ? 'registro' : 'préstamo') + ': "' + top.descripcion + '" (' + top.created_at + ')' });
    }
    let snap;
    try { snap = JSON.parse(entry.snapshot); } catch (_) { return res.status(500).json({ error: 'Snapshot corrupto: no se puede deshacer con seguridad' }); }

    // Candado G (4.1.3, renombre de un cliente): ese cambio toca TODOS los prestamos del cliente, que
    // siguen vivos. (1) No se deshace por encima de un movimiento posterior de CUALQUIERA de ellos:
    // restaurar su copia lo borraria. (2) Mientras el renombre siga en pie, no se deshace un movimiento
    // ANTERIOR de uno de ellos: su copia vieja le devolveria el nombre viejo a ese prestamo y el
    // cliente quedaria partido en dos. Solo entra en juego si una de las dos entradas es un renombre;
    // el mismo prestamo ya lo cubre el Candado A.
    if (entry.scope_tipo === 'loan') {
      const mios = involucra(entry, snap);
      const esGrupo = !!(snap && snap.tipo === 'grupo');
      const posteriores = db.prepare("SELECT id, descripcion, created_at, scope_id, snapshot FROM undo_journal WHERE scope_tipo='loan' AND estado='disponible' AND rowid > (SELECT rowid FROM undo_journal WHERE id = ?) ORDER BY rowid DESC").all(entry.id);
      const choca = posteriores.find(p => (esGrupo || tipoSnap(p.snapshot) === 'grupo') && involucraFila(p).some(id => mios.indexOf(id) !== -1));
      if (choca) {
        return res.status(409).json({ error: (esGrupo
          ? 'Este cambio de nombre tocó todos los préstamos del cliente, y uno de ellos tiene una operación posterior. Primero debes deshacer: "'
          : 'Después de esta operación se cambió el nombre del cliente en todos sus préstamos. Primero debes deshacer: "') + choca.descripcion + '" (' + choca.created_at + ')' });
      }
    }

    // Candado U (unificacion): un prestamo que se unifico en otro ya no es una deuda viva; deshacer
    // un movimiento suyo lo resucitaria al lado del nuevo (la deuda contada dos veces). Primero
    // hay que deshacer la unificacion, que es una entrada del prestamo NUEVO.
    if (entry.scope_tipo === 'loan' && !(snap && snap.tipo === 'unif')) {
      const l = db.prepare('SELECT unificadoEn FROM loans WHERE id = ?').get(entry.scope_id);
      if (l && l.unificadoEn) {
        return res.status(409).json({ error: 'Este préstamo se unificó en otro. Para deshacer sus movimientos, primero deshaz la unificación.' });
      }
    }

    // Candado B (DETECTOR, no gate): si el estado ACTUAL del agregado ya no coincide
    // con el post_hash del journal, algo lo cambio despues (housekeeping del arranque,
    // o una mutacion aun NO cubierta por el journal en esta fase). Se restaura igual
    // y se ADVIERTE — nunca se bloquea en silencio.
    const drift = hashSnapshot(snapshotActual(entry, snap)) !== entry.post_hash;

    const run = db.transaction(() => {
      restoreScope(snap, entry.scope_id);
      if (entry.scope_tipo === 'loan') reHousekeepLoan(entry.scope_id);
      if (snap && snap.tipo === 'unif') (snap.viejosIds || []).forEach(id => reHousekeepLoan(id));
      if (snap && snap.tipo === 'grupo') (snap.ids || []).forEach(id => { if (id !== entry.scope_id) reHousekeepLoan(id); });
      db.prepare("UPDATE undo_journal SET estado='deshecho', undone_at=datetime('now','localtime') WHERE id=?").run(entry.id);
      logAction.run('deshacer', 'Deshiciste: ' + entry.descripcion);
    });
    run();

    res.json({
      ok: true, deshecho: entry.id, accion: entry.accion, scope_id: entry.scope_id,
      warning: drift ? 'El estado había cambiado desde esta operación (housekeeping o una mutación no journalizada). Se restauró el snapshot y se re-aplicó el housekeeping; revisa el resultado.' : null
    });
  });

  // ── API: Historial de undo (para la UI y diagnostico) ────────────────────────
  router.get('/api/undo', (req, res) => {
    const { scopeTipo, scopeId } = req.query;
    const cols = 'id, created_at, accion, descripcion, scope_tipo, scope_id, estado, undone_at, afecta_caja, snapshot';
    const rows = (scopeTipo && scopeId)
      ? db.prepare('SELECT ' + cols + " FROM undo_journal WHERE scope_tipo=? AND scope_id=? ORDER BY rowid DESC LIMIT 50").all(scopeTipo, scopeId)
      : db.prepare('SELECT ' + cols + ' FROM undo_journal ORDER BY rowid DESC LIMIT 50').all();
    // 4.1.3: el Historial necesita saber que prestamos toca un renombre de cliente (`grupo`) para
    // mostrar el Candado G igual que el backend. El snapshot no viaja: solo lo que se deriva de el.
    res.json(rows.map(r => {
      const out = Object.assign({}, r);
      delete out.snapshot;
      const t = tipoSnap(r.snapshot);
      if (t === 'grupo') out.grupo = true;
      if (t === 'grupo' || t === 'unif') out.involucra = involucraFila(r);
      return out;
    }));
  });

  return router;
};
