/**
 * server.js — Express API
 * Exporta una función factory que recibe la ruta del DB.
 * main.js crea el servidor http y llama a .listen().
 */

const express  = require('express');
const Database = require('better-sqlite3');
const path     = require('path');

module.exports = function createApp(dbPath) {

  const app = express();

  // ── Servir React desde node_modules (sin internet) ────────────────────────
  // Usamos package.json como punto de entrada porque React 18 restringe
  // el acceso directo a subcarpetas via require.resolve()
  app.get('/vendor/react.js', (_req, res) => {
    const base = path.dirname(require.resolve('react/package.json'));
    res.sendFile(path.join(base, 'umd', 'react.production.min.js'));
  });
  app.get('/vendor/react-dom.js', (_req, res) => {
    const base = path.dirname(require.resolve('react-dom/package.json'));
    res.sendFile(path.join(base, 'umd', 'react-dom.production.min.js'));
  });

  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  // ── Base de datos ─────────────────────────────────────────────────────────
  const db = new Database(dbPath);

  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS loans (
      id          TEXT PRIMARY KEY,
      nombre      TEXT NOT NULL,
      cedula      TEXT DEFAULT '',
      telefono    TEXT DEFAULT '',
      moneda      TEXT DEFAULT 'COP',
      montoOrigen REAL NOT NULL,
      trmAcordada REAL DEFAULT 1,
      montoCOP    REAL NOT NULL,
      tasaMensual REAL DEFAULT 0,
      plazoMeses  INTEGER NOT NULL,
      modalidad   TEXT DEFAULT 'Solo Intereses',
      fechaInicio TEXT NOT NULL,
      diaPago     INTEGER DEFAULT 15,
      estado      TEXT DEFAULT 'Activo',
      notas       TEXT DEFAULT '',
      createdAt   TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS payments (
      id             TEXT PRIMARY KEY,
      prestamoId     TEXT NOT NULL,
      nombreCliente  TEXT NOT NULL,
      cuotaN         INTEGER NOT NULL,
      fechaPago      TEXT NOT NULL,
      saldoInicial   REAL DEFAULT 0,
      interesPeriodo REAL DEFAULT 0,
      abonoCapital   REAL DEFAULT 0,
      cuotaTotal     REAL DEFAULT 0,
      saldoFinal     REAL DEFAULT 0,
      estadoPago     TEXT DEFAULT 'Pendiente',
      fechaRecaudo   TEXT,
      observaciones  TEXT DEFAULT '',
      FOREIGN KEY(prestamoId) REFERENCES loans(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    INSERT OR IGNORE INTO config(key, value) VALUES ('trm', '4100');
  `);

  // Migraciones seguras
  try { db.exec('ALTER TABLE payments ADD COLUMN montoCOPRecibido REAL DEFAULT 0'); } catch(_){}


  // ── Motor financiero ──────────────────────────────────────────────────────
  function pmt(r, n, pv) {
    if (r === 0) return pv / n;
    return pv * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1);
  }

  function getPayDate(startISO, mo, diaPago) {
    const d = new Date(startISO + 'T12:00:00');
    d.setDate(1); // evitar desbordamiento de mes en JS (ej: Jan 30 + Feb = Mar 2)
    d.setMonth(d.getMonth() + mo);
    d.setDate(Math.min(diaPago, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
    return d.toISOString().split('T')[0];
  }

  /**
   * buildSchedule — genera cronograma de cuotas
   * @param {object} loan        - datos del prestamo
   * @param {number} startN      - numero de cuota inicial (default 1)
   * @param {number} startSaldo  - saldo sobre el cual calcular (default loan.montoCOP)
   * @param {number} numCuotas   - cuantas cuotas generar (default: plazoMeses completo)
   *
   * startN tambien determina el offset de fecha: cuotaN=5 => mes 5 desde fechaInicio
   */
  function buildSchedule(loan, startN, startSaldo, numCuotas) {
    startN = startN || 1;
    const { id, nombre, tasaMensual, modalidad, fechaInicio, diaPago } = loan;
    const montoCOP = startSaldo !== undefined ? startSaldo : loan.montoCOP;
    const indefinido = modalidad === 'Solo Intereses';
    const totalCuotas = numCuotas !== undefined ? numCuotas : (indefinido ? 120 : (loan.plazoMeses || 12));
    const r = tasaMensual / 100;
    let saldo = montoCOP;
    const cuotaFija = pmt(r, totalCuotas, montoCOP);
    const rows = [];

    // Prestamo sin intereses: 1 cuota por el capital total
    // interesPeriodo=1 (token) para que NO sea clasificado como abono a capital
    // (el filtro de abonos es: interesPeriodo===0 && abonoCapital>0)
    if (modalidad === 'Prestamo') {
      rows.push({
        id: `${id}-1`, prestamoId: id, nombreCliente: nombre, cuotaN: 1,
        fechaPago: getPayDate(fechaInicio, 1, diaPago),
        saldoInicial: Math.round(montoCOP), interesPeriodo: 0,
        abonoCapital: 0, cuotaTotal: Math.round(montoCOP),
        saldoFinal: 0, estadoPago: 'Pendiente', fechaRecaudo: null, observaciones: ''
      });
      return rows;
    }

    for (let i = 0; i < totalCuotas; i++) {
      const cuotaN = startN + i;
      const interes = Math.round(saldo * r * 100) / 100;
      const isLast  = indefinido ? false : (i === totalCuotas - 1);
      let capital, cuota;

      if (indefinido || modalidad === 'Solo Intereses') {
        capital = isLast ? saldo : 0;
        cuota   = isLast ? Math.round((interes + saldo) * 100) / 100 : Math.round(interes * 100) / 100;
      } else {
        capital = isLast ? saldo : Math.round((cuotaFija - interes) * 100) / 100;
        cuota   = isLast ? Math.round((interes + saldo) * 100) / 100 : Math.round(cuotaFija * 100) / 100;
      }

      const saldoFinal = Math.max(0, Math.round((saldo - capital) * 100) / 100);
      rows.push({
        id: `${id}-${cuotaN}`, prestamoId: id, nombreCliente: nombre, cuotaN: cuotaN,
        fechaPago: getPayDate(fechaInicio, cuotaN, diaPago),
        saldoInicial: Math.round(saldo), interesPeriodo: Math.round(interes),
        abonoCapital: Math.round(capital), cuotaTotal: Math.round(cuota),
        saldoFinal: Math.round(saldoFinal),
        estadoPago: 'Pendiente', fechaRecaudo: null, observaciones: ''
      });
      saldo = saldoFinal;
    }
    return rows;
  }

  const insPayment = db.prepare(`
    INSERT OR REPLACE INTO payments(id,prestamoId,nombreCliente,cuotaN,fechaPago,saldoInicial,
      interesPeriodo,abonoCapital,cuotaTotal,saldoFinal,estadoPago,fechaRecaudo,observaciones)
    VALUES (@id,@prestamoId,@nombreCliente,@cuotaN,@fechaPago,@saldoInicial,
      @interesPeriodo,@abonoCapital,@cuotaTotal,@saldoFinal,@estadoPago,@fechaRecaudo,@observaciones)
  `);
  const insertSchedule = db.transaction(rows => rows.forEach(r => insPayment.run(r)));

  // ── Auto-mora al arrancar ─────────────────────────────────────────────────
  db.prepare(`UPDATE payments SET estadoPago='En Mora' WHERE estadoPago='Pendiente' AND fechaPago < ?`)
    .run(new Date().toISOString().split('T')[0]);

  // ── API: Recalcular cronogramas ───────────────────────────────────────────
  app.post('/api/recalculate', (_req, res) => {
    const activeLoans = db.prepare("SELECT * FROM loans WHERE estado = 'Activo'").all();
    let updated = 0;
    for (const loan of activeLoans) {
      const prev = db.prepare('SELECT * FROM payments WHERE prestamoId = ?').all(loan.id);
      // Separar abonos de cuotas regulares
      const prevAbonos = prev.filter(p => p.id && p.id.indexOf('-ab-') !== -1);
      const prevRegulares = prev.filter(p => !p.id || p.id.indexOf('-ab-') === -1);
      // Solo borrar cuotas regulares, preservar abonos intactos
      prevRegulares.forEach(p => {
        db.prepare('DELETE FROM payments WHERE id = ?').run(p.id);
      });
      // Recalcular saldo considerando abonos existentes
      const totalAbonado = prevAbonos.filter(p => p.estadoPago === 'Pagado')
        .reduce((s, p) => s + p.abonoCapital, 0);
      const saldoActual = Math.max(0, loan.montoCOP - totalAbonado);
      const schedule = buildSchedule({ ...loan, montoCOP: saldoActual });
      schedule.forEach(p => {
        const ex = prevRegulares.find(e => e.cuotaN === p.cuotaN);
        if (ex && ex.estadoPago !== 'Pendiente') {
          p.estadoPago = ex.estadoPago;
          p.fechaRecaudo = ex.fechaRecaudo;
          p.observaciones = ex.observaciones;
          if (ex.montoCOPRecibido) p.montoCOPRecibido = ex.montoCOPRecibido;
        }
      });
      insertSchedule(schedule);
      updated++;
    }
    // Re-aplicar auto-mora
    db.prepare(`UPDATE payments SET estadoPago='En Mora' WHERE estadoPago='Pendiente' AND fechaPago < ?`)
      .run(new Date().toISOString().split('T')[0]);
    res.json({ ok: true, updated });
  });

  // ── API: Config ───────────────────────────────────────────────────────────
  app.get('/api/config', (_req, res) => {
    const rows = db.prepare('SELECT key, value FROM config').all();
    res.json(Object.fromEntries(rows.map(r => [r.key, r.value])));
  });
  app.put('/api/config', (req, res) => {
    const stmt = db.prepare('INSERT OR REPLACE INTO config(key, value) VALUES (?, ?)');
    for (const [k, v] of Object.entries(req.body)) stmt.run(k, String(v));
    res.json({ ok: true });
  });

  // ── API: Loans ────────────────────────────────────────────────────────────
  app.get('/api/loans', (_req, res) => {
    res.json(db.prepare('SELECT * FROM loans ORDER BY createdAt').all());
  });

  app.post('/api/loans', (req, res) => {
    const loan = { ...req.body, id: Date.now().toString() + Math.random().toString(36).slice(2,6) };
    db.prepare(`
      INSERT INTO loans(id,nombre,cedula,telefono,moneda,montoOrigen,trmAcordada,montoCOP,
        tasaMensual,plazoMeses,modalidad,fechaInicio,diaPago,estado,notas)
      VALUES (@id,@nombre,@cedula,@telefono,@moneda,@montoOrigen,@trmAcordada,@montoCOP,
        @tasaMensual,@plazoMeses,@modalidad,@fechaInicio,@diaPago,@estado,@notas)
    `).run(loan);
    insertSchedule(buildSchedule(loan));
    res.status(201).json(loan);
  });

  app.put('/api/loans/:id', (req, res) => {
    const loan = { ...req.body, id: req.params.id };
    db.prepare(`
      UPDATE loans SET nombre=@nombre, cedula=@cedula, telefono=@telefono, moneda=@moneda,
        montoOrigen=@montoOrigen, trmAcordada=@trmAcordada, montoCOP=@montoCOP,
        tasaMensual=@tasaMensual, plazoMeses=@plazoMeses, modalidad=@modalidad,
        fechaInicio=@fechaInicio, diaPago=@diaPago, estado=@estado, notas=@notas
      WHERE id=@id
    `).run(loan);

    const prev = db.prepare('SELECT * FROM payments WHERE prestamoId = ?').all(loan.id);
    // Separar abonos (id contiene '-ab-') de cuotas regulares
    const prevAbonos = prev.filter(p => p.id.indexOf('-ab-') !== -1);
    const prevRegulares = prev.filter(p => p.id.indexOf('-ab-') === -1);
    // Solo borrar cuotas regulares, preservar abonos
    prevRegulares.forEach(p => {
      db.prepare('DELETE FROM payments WHERE id = ?').run(p.id);
    });
    // Recalcular saldo actual considerando abonos existentes
    const totalAbonado = prevAbonos.filter(p => p.estadoPago === 'Pagado')
      .reduce((s, p) => s + p.abonoCapital, 0);
    const saldoActual = Math.max(0, loan.montoCOP - totalAbonado);
    // Regenerar cronograma sobre el saldo post-abonos
    const schedule = buildSchedule({ ...loan, montoCOP: saldoActual });
    // Restaurar estados de cuotas previamente pagadas/en mora
    schedule.forEach(p => {
      const ex = prevRegulares.find(e => e.cuotaN === p.cuotaN);
      if (ex && ex.estadoPago !== 'Pendiente') {
        p.estadoPago = ex.estadoPago;
        p.fechaRecaudo = ex.fechaRecaudo;
        p.observaciones = ex.observaciones;
        if (ex.montoCOPRecibido) p.montoCOPRecibido = ex.montoCOPRecibido;
      }
    });
    insertSchedule(schedule);
    res.json(loan);
  });

  app.delete('/api/loans/:id', (req, res) => {
    db.prepare('DELETE FROM payments WHERE prestamoId = ?').run(req.params.id);
    db.prepare('DELETE FROM loans WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  // ── API: Payments ─────────────────────────────────────────────────────────
  app.get('/api/payments', (_req, res) => {
    db.prepare(`UPDATE payments SET estadoPago='En Mora' WHERE estadoPago='Pendiente' AND fechaPago < ?`)
      .run(new Date().toISOString().split('T')[0]);
    res.json(db.prepare('SELECT * FROM payments ORDER BY fechaPago, nombreCliente').all());
  });

  app.put('/api/payments/:id', (req, res) => {
    const { estadoPago, fechaRecaudo, observaciones, montoCOPRecibido } = req.body;
    db.prepare('UPDATE payments SET estadoPago=?, fechaRecaudo=?, observaciones=?, montoCOPRecibido=? WHERE id=?')
      .run(estadoPago, fechaRecaudo || null, observaciones || '', montoCOPRecibido || 0, req.params.id);

    // Auto-finalización: si se marcó como Pagado, verificar si todas las cuotas regulares están pagadas
    if (estadoPago === 'Pagado') {
      const pay = db.prepare('SELECT prestamoId FROM payments WHERE id = ?').get(req.params.id);
      if (pay) {
        const allPays = db.prepare('SELECT * FROM payments WHERE prestamoId = ?').all(pay.prestamoId);
        // Cuotas regulares = las que NO son abonos a capital (abono = interesPeriodo=0 AND abonoCapital>0)
        const regulares = allPays.filter(p => !(p.interesPeriodo === 0 && p.abonoCapital > 0));
        const todasPagadas = regulares.length > 0 && regulares.every(p => p.estadoPago === 'Pagado');
        if (todasPagadas) {
          db.prepare("UPDATE loans SET estado = 'Cancelado' WHERE id = ? AND estado = 'Activo'").run(pay.prestamoId);
        }
      }
    }

    // Si se revierte a Pendiente/En Mora, reactivar el préstamo si estaba Cancelado por auto-finalización
    if (estadoPago === 'Pendiente' || estadoPago === 'En Mora') {
      const pay = db.prepare('SELECT prestamoId FROM payments WHERE id = ?').get(req.params.id);
      if (pay) {
        const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(pay.prestamoId);
        if (loan && loan.estado === 'Cancelado' && loan.montoCOP > 0) {
          db.prepare("UPDATE loans SET estado = 'Activo' WHERE id = ?").run(pay.prestamoId);
        }
      }
    }

    res.json({ ok: true });
  });

  // ── API: Abono a Capital ──────────────────────────────────────────────────
  app.post('/api/loans/:id/abono', (req, res) => {
    const { monto, fecha, observaciones } = req.body;
    const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(req.params.id);
    if (!loan) return res.status(404).json({ error: 'No encontrado' });

    const nuevoSaldo = Math.round(loan.montoCOP - monto);
    if (nuevoSaldo < 0) return res.status(400).json({ error: 'El abono supera el saldo actual' });

    // Analizar cuotas existentes
    const allPays = db.prepare('SELECT * FROM payments WHERE prestamoId = ? ORDER BY cuotaN').all(req.params.id);

    // Cuotas regulares consumidas (Pagado o En Mora, excluyendo registros de abono)
    // Un registro de abono se identifica por interesPeriodo=0 AND abonoCapital>0
    const regularConsumed = allPays.filter(p =>
      (p.estadoPago === 'Pagado' || p.estadoPago === 'En Mora') &&
      !(p.interesPeriodo === 0 && p.abonoCapital > 0)
    ).length;

    // Siguiente cuotaN disponible (mayor existente + 1, sin colisionar con En Mora)
    const maxExistingN = allPays.reduce((max, p) => Math.max(max, p.cuotaN), 0);

    // Solo borrar cuotas PENDIENTES; las cuotas En Mora permanecen intactas (deuda independiente)
    db.prepare("DELETE FROM payments WHERE prestamoId = ? AND estadoPago = 'Pendiente'").run(req.params.id);

    // Registrar el abono como cuota especial (no cuenta como cuota regular)
    const abonoId = req.params.id + '-ab-' + Date.now();
    const fechaAbono = fecha || new Date().toISOString().split('T')[0];
    insPayment.run({
      id: abonoId,
      prestamoId: req.params.id,
      nombreCliente: loan.nombre,
      cuotaN: maxExistingN + 1,
      fechaPago: fechaAbono,
      saldoInicial: loan.montoCOP,
      interesPeriodo: 0,
      abonoCapital: Math.round(monto),
      cuotaTotal: Math.round(monto),
      saldoFinal: Math.max(0, nuevoSaldo),
      estadoPago: 'Pagado',
      fechaRecaudo: fechaAbono,
      observaciones: observaciones || 'Abono a capital',
      montoCOPRecibido: Math.round(monto)
    });

    if (nuevoSaldo <= 0) {
      db.prepare("UPDATE loans SET montoCOP = 0, estado = 'Cancelado' WHERE id = ?").run(req.params.id);
    } else {
      db.prepare('UPDATE loans SET montoCOP = ? WHERE id = ?').run(nuevoSaldo, req.params.id);

      // Calcular cuotas restantes respetando el plazo original
      const indefinido = loan.modalidad === 'Solo Intereses';
      const plazoOriginal = indefinido ? 120 : (loan.plazoMeses || 12);
      const remaining = Math.max(0, plazoOriginal - regularConsumed);

      if (remaining > 0) {
        // startN = siguiente cuota regular (continua la numeracion original)
        const nextRegularN = regularConsumed + 1;
        const updatedLoan = Object.assign({}, loan, { montoCOP: nuevoSaldo });
        // numCuotas = remaining (solo las que faltan del plazo original)
        insertSchedule(buildSchedule(updatedLoan, nextRegularN, nuevoSaldo, remaining));
      }
    }

    res.json({ ok: true, nuevoSaldo: Math.max(0, nuevoSaldo) });
  });

  return app;
};
