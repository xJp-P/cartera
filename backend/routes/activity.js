// backend/routes/activity.js — historial de acciones.
//
// Extraido de `server.js` en la Etapa 2 (A5) del refactor. Codigo VERBATIM
// (unica sustitucion: `app.X` -> `router.X`).
//
// `activity_log` es APPEND-ONLY: deshacer una operacion no borra su huella, agrega
// una entrada compensatoria de tipo `deshacer`. La columna `undo_id` es lo que
// permite al Historial saber que fila es reversible sin aparear por texto.

const express = require('express');

module.exports = function crearRutasActivity(ctx) {
  const { db } = ctx;
  const router = express.Router();

  // ── API: Historial de acciones ────────────────────────────────────────────
  // Sin parametros, las 100 mas recientes (lo de siempre). Con `?todo=1`, el historial COMPLETO: lo pide
  // la pestana Historial desde 3.7.0, que filtra por fechas, busca y agrupa por dia en el cliente; con
  // solo 100 filas, un filtro por fecha no veria mas alla de unas semanas y diria "no hubo nada" en
  // meses que si tuvieron movimientos.
  router.get('/api/activity', (req, res) => {
    const todo = req.query && (req.query.todo === '1' || req.query.todo === 'true');
    const rows = db.prepare('SELECT * FROM activity_log ORDER BY id DESC' + (todo ? '' : ' LIMIT 100')).all();
    res.json(rows);
  });

  return router;
};
