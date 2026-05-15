/**
 * server.js — Express API
 * Exporta una función factory que recibe la ruta del DB.
 * desktop/main.js crea el servidor http y llama a .listen().
 */

const express  = require('express');
const Database = require('better-sqlite3');
const path     = require('path');

// Raíz del proyecto (un nivel arriba de /backend)
const PROJECT_ROOT = path.join(__dirname, '..');

// Fecha local (no UTC) en formato YYYY-MM-DD
function hoyStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

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
  app.use(express.static(path.join(PROJECT_ROOT, 'public')));

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
      modalidad   TEXT DEFAULT 'Intereses',
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
  try { db.exec('ALTER TABLE payments ADD COLUMN montoUSDRecibido REAL DEFAULT 0'); } catch(_){}
  // Pagos parciales: acumulado recibido antes de completar la cuota
  try { db.exec('ALTER TABLE payments ADD COLUMN partialPaid REAL DEFAULT 0'); } catch(_){}
  // Renombrar modalidad legacy
  try { db.exec("UPDATE loans SET modalidad = 'Intereses' WHERE modalidad = 'Solo Intereses'"); } catch(_){}
  // Migración: frecuencia de pago
  try { db.exec("ALTER TABLE loans ADD COLUMN frecuencia TEXT DEFAULT 'Mensual'"); } catch(_){}
  // Cierre forzoso: snapshot de pérdida (capital pendiente + intereses en mora al momento del cierre)
  try { db.exec('ALTER TABLE loans ADD COLUMN capitalPerdido REAL DEFAULT 0'); } catch(_){}
  try { db.exec('ALTER TABLE loans ADD COLUMN interesesPerdidos REAL DEFAULT 0'); } catch(_){}
  // Migración v1.8: renombrar 'Cancelado' legacy a 'Finalizado'. Antes 'Cancelado' significaba éxito;
  // ahora significa cierre forzoso con pérdidas. CORRE UNA SOLA VEZ — controlada por flag en config.
  try {
    var migRow = db.prepare("SELECT value FROM config WHERE key = 'mig_v18_rename_cancelado'").get();
    if (!migRow) {
      db.exec("UPDATE loans SET estado = 'Finalizado' WHERE estado = 'Cancelado'");
      db.prepare("INSERT OR REPLACE INTO config(key, value) VALUES ('mig_v18_rename_cancelado', '1')").run();
    }
  } catch(_){}
  // Migración correctiva (idempotente): si un préstamo quedó como 'Finalizado' pero tiene pérdidas
  // registradas, en realidad fue un cierre forzoso — corregir a 'Cancelado'.
  try { db.exec("UPDATE loans SET estado = 'Cancelado' WHERE estado = 'Finalizado' AND (capitalPerdido > 0 OR interesesPerdidos > 0)"); } catch(_){}

  // ── Tabla de historial de acciones ──────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS activity_log (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      fecha     TEXT DEFAULT (datetime('now','localtime')),
      tipo      TEXT NOT NULL,
      mensaje   TEXT NOT NULL
    )
  `);
  const logAction = db.prepare('INSERT INTO activity_log(tipo, mensaje) VALUES (?, ?)');
  try { db.exec("ALTER TABLE loans ADD COLUMN fechaDevolucion TEXT DEFAULT ''"); } catch(_){}


  // ── Motor financiero ──────────────────────────────────────────────────────
  function pmt(r, n, pv) {
    if (r === 0) return pv / n;
    return pv * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1);
  }

  function getPayDate(startISO, cuotaN, diaPago, frecuencia) {
    const d = new Date(startISO + 'T12:00:00');
    if (frecuencia === 'Semanal') {
      d.setDate(d.getDate() + cuotaN * 7);
      return d.toISOString().split('T')[0];
    }
    if (frecuencia === 'Quincenal') {
      d.setDate(d.getDate() + cuotaN * 14);
      return d.toISOString().split('T')[0];
    }
    // Mensual (default)
    d.setDate(1);
    d.setMonth(d.getMonth() + cuotaN);
    d.setDate(Math.min(diaPago, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
    return d.toISOString().split('T')[0];
  }

  // Convertir tasa mensual a tasa del período según frecuencia
  function tasaPeriodo(tasaMensual, frecuencia) {
    if (frecuencia === 'Semanal') return tasaMensual / 4.33;
    if (frecuencia === 'Quincenal') return tasaMensual / 2;
    return tasaMensual; // Mensual
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
  // Para Intereses: calcular cuántas cuotas generar hasta N períodos adelante de hoy
  function cuotasHastaHoy(fechaInicio, startN, periodosAdelante, frecuencia) {
    const hoy = new Date();
    const inicio = new Date(fechaInicio + 'T12:00:00');
    const diffMs = hoy - inicio;
    const diasDiff = diffMs / (24 * 60 * 60 * 1000);
    var periodosDesdeInicio;
    if (frecuencia === 'Semanal') periodosDesdeInicio = Math.ceil(diasDiff / 7);
    else if (frecuencia === 'Quincenal') periodosDesdeInicio = Math.ceil(diasDiff / 14);
    else periodosDesdeInicio = Math.ceil(diasDiff / 30.44);
    periodosDesdeInicio += periodosAdelante;
    return Math.max(3, periodosDesdeInicio - startN + 1);
  }

  function buildSchedule(loan, startN, startSaldo, numCuotas) {
    startN = startN || 1;
    const { id, nombre, tasaMensual, modalidad, fechaInicio, diaPago } = loan;
    const freq = loan.frecuencia || 'Mensual';
    const montoCOP = startSaldo !== undefined ? startSaldo : loan.montoCOP;
    const indefinido = modalidad === 'Intereses';
    const totalCuotas = numCuotas !== undefined ? numCuotas : (indefinido ? cuotasHastaHoy(fechaInicio, startN, 3, freq) : (loan.plazoMeses || 12));
    const r = tasaPeriodo(tasaMensual / 100, freq);
    let saldo = montoCOP;
    const cuotaFija = pmt(r, totalCuotas, montoCOP);
    const rows = [];

    // Prestamo sin intereses: 1 cuota por el capital total
    // interesPeriodo=1 (token) para que NO sea clasificado como abono a capital
    // (el filtro de abonos es: interesPeriodo===0 && abonoCapital>0)
    if (modalidad === 'Prestamo') {
      var fechaCuota = loan.fechaDevolucion || getPayDate(fechaInicio, 1, diaPago, freq);
      rows.push({
        id: `${id}-1`, prestamoId: id, nombreCliente: nombre, cuotaN: 1,
        fechaPago: fechaCuota,
        saldoInicial: Math.round(montoCOP), interesPeriodo: 0,
        abonoCapital: 0, cuotaTotal: Math.round(montoCOP),
        saldoFinal: 0, estadoPago: 'Pendiente', fechaRecaudo: null, observaciones: '',
        montoCOPRecibido: 0, montoUSDRecibido: 0, partialPaid: 0
      });
      return rows;
    }

    for (let i = 0; i < totalCuotas; i++) {
      const cuotaN = startN + i;
      const interes = Math.round(saldo * r * 100) / 100;
      const isLast  = indefinido ? false : (i === totalCuotas - 1);
      let capital, cuota;

      if (indefinido || modalidad === 'Intereses') {
        capital = isLast ? saldo : 0;
        cuota   = isLast ? Math.round((interes + saldo) * 100) / 100 : Math.round(interes * 100) / 100;
      } else {
        capital = isLast ? saldo : Math.round((cuotaFija - interes) * 100) / 100;
        cuota   = isLast ? Math.round((interes + saldo) * 100) / 100 : Math.round(cuotaFija * 100) / 100;
      }

      const saldoFinal = Math.max(0, Math.round((saldo - capital) * 100) / 100);
      rows.push({
        id: `${id}-${cuotaN}`, prestamoId: id, nombreCliente: nombre, cuotaN: cuotaN,
        fechaPago: getPayDate(fechaInicio, cuotaN, diaPago, freq),
        saldoInicial: Math.round(saldo), interesPeriodo: Math.round(interes),
        abonoCapital: Math.round(capital), cuotaTotal: Math.round(cuota),
        saldoFinal: Math.round(saldoFinal),
        estadoPago: 'Pendiente', fechaRecaudo: null, observaciones: '',
        montoCOPRecibido: 0, montoUSDRecibido: 0, partialPaid: 0
      });
      saldo = saldoFinal;
    }
    return rows;
  }

  const insPayment = db.prepare(`
    INSERT OR REPLACE INTO payments(id,prestamoId,nombreCliente,cuotaN,fechaPago,saldoInicial,
      interesPeriodo,abonoCapital,cuotaTotal,saldoFinal,estadoPago,fechaRecaudo,observaciones,montoCOPRecibido,montoUSDRecibido,partialPaid)
    VALUES (@id,@prestamoId,@nombreCliente,@cuotaN,@fechaPago,@saldoInicial,
      @interesPeriodo,@abonoCapital,@cuotaTotal,@saldoFinal,@estadoPago,@fechaRecaudo,@observaciones,@montoCOPRecibido,@montoUSDRecibido,@partialPaid)
  `);
  const insertSchedule = db.transaction(rows => rows.forEach(r => insPayment.run(r)));

  // ── Auto-mora al arrancar ─────────────────────────────────────────────────
  db.prepare(`UPDATE payments SET estadoPago='En Mora' WHERE estadoPago='Pendiente' AND fechaPago < ?`)
    .run(hoyStr());

  // ── Corregir cuotas en mora de Prestamo: cuotaTotal debe = saldo actual (montoCOP) ──
  // Solo para Prestamo (sin intereses, 1 cuota de capital). NO para Intereses (cuota = interés mensual fijo).
  const fixPrestamos = db.prepare("SELECT * FROM loans WHERE estado = 'Activo' AND modalidad = 'Prestamo'").all();
  fixPrestamos.forEach(fl => {
    db.prepare(`UPDATE payments SET cuotaTotal = ?, saldoFinal = 0
      WHERE prestamoId = ? AND estadoPago = 'En Mora'
      AND NOT (interesPeriodo = 0 AND abonoCapital > 0)`)
      .run(fl.montoCOP, fl.id);
  });

  // ── API: Recalcular cronogramas ───────────────────────────────────────────
  app.post('/api/recalculate', (_req, res) => {
    const activeLoans = db.prepare("SELECT * FROM loans WHERE estado = 'Activo'").all();
    let updated = 0;
    for (const loan of activeLoans) {
      const prev = db.prepare('SELECT * FROM payments WHERE prestamoId = ?').all(loan.id);
      // Preservar abonos (id contiene '-ab-'), solo borrar cuotas regulares
      const prevRegulares = prev.filter(p => !p.id || p.id.indexOf('-ab-') === -1);
      prevRegulares.forEach(p => {
        db.prepare('DELETE FROM payments WHERE id = ?').run(p.id);
      });
      // montoCOP ya tiene abonos descontados — NO restar de nuevo
      const schedule = buildSchedule(loan);
      schedule.forEach(p => {
        const ex = prevRegulares.find(e => e.cuotaN === p.cuotaN);
        if (ex && ex.estadoPago !== 'Pendiente') {
          p.estadoPago = ex.estadoPago;
          p.fechaRecaudo = ex.fechaRecaudo;
          p.observaciones = ex.observaciones;
          if (ex.montoCOPRecibido) p.montoCOPRecibido = ex.montoCOPRecibido;
          if (ex.partialPaid) p.partialPaid = ex.partialPaid;
        } else if (ex && ex.partialPaid) {
          // Cuota sigue Pendiente pero tenia pago parcial — preservarlo
          p.partialPaid = ex.partialPaid;
          p.observaciones = ex.observaciones;
        }
      });
      insertSchedule(schedule);
      updated++;
    }
    // Re-aplicar auto-mora
    db.prepare(`UPDATE payments SET estadoPago='En Mora' WHERE estadoPago='Pendiente' AND fechaPago < ?`)
      .run(hoyStr());
    // Fix cuotas en mora de Prestamo: cuotaTotal debe = saldo actual (montoCOP)
    const fixP = db.prepare("SELECT * FROM loans WHERE estado = 'Activo' AND modalidad = 'Prestamo'").all();
    fixP.forEach(fl => {
      db.prepare(`UPDATE payments SET cuotaTotal = ?, saldoFinal = 0
        WHERE prestamoId = ? AND estadoPago = 'En Mora'
        AND id NOT LIKE '%-ab-%'`)
        .run(fl.montoCOP, fl.id);
    });
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
    const loan = { fechaDevolucion: '', ...req.body, id: Date.now().toString() + Math.random().toString(36).slice(2,6) };
    db.prepare(`
      INSERT INTO loans(id,nombre,cedula,telefono,moneda,montoOrigen,trmAcordada,montoCOP,
        tasaMensual,plazoMeses,modalidad,fechaInicio,diaPago,estado,notas,frecuencia,fechaDevolucion)
      VALUES (@id,@nombre,@cedula,@telefono,@moneda,@montoOrigen,@trmAcordada,@montoCOP,
        @tasaMensual,@plazoMeses,@modalidad,@fechaInicio,@diaPago,@estado,@notas,@frecuencia,@fechaDevolucion)
    `).run(loan);
    insertSchedule(buildSchedule(loan));
    logAction.run('prestamo', 'Nuevo prestamo: ' + loan.nombre + ' por ' + (loan.moneda === 'USD' ? 'USD $' + loan.montoOrigen : '$' + Math.round(loan.montoCOP).toLocaleString()) + ' (' + loan.modalidad + ')');
    res.status(201).json(loan);
  });

  app.put('/api/loans/:id', (req, res) => {
    const loan = { fechaDevolucion: '', ...req.body, id: req.params.id };
    db.prepare(`
      UPDATE loans SET nombre=@nombre, cedula=@cedula, telefono=@telefono, moneda=@moneda,
        montoOrigen=@montoOrigen, trmAcordada=@trmAcordada, montoCOP=@montoCOP,
        tasaMensual=@tasaMensual, plazoMeses=@plazoMeses, modalidad=@modalidad,
        fechaInicio=@fechaInicio, diaPago=@diaPago, estado=@estado, notas=@notas, frecuencia=@frecuencia, fechaDevolucion=@fechaDevolucion
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
    logAction.run('edicion', 'Editaste prestamo de ' + loan.nombre);
    res.json(loan);
  });

  app.delete('/api/loans/:id', (req, res) => {
    const loan = db.prepare('SELECT nombre, montoCOP FROM loans WHERE id = ?').get(req.params.id);
    db.prepare('DELETE FROM payments WHERE prestamoId = ?').run(req.params.id);
    db.prepare('DELETE FROM loans WHERE id = ?').run(req.params.id);
    if (loan) logAction.run('eliminacion', 'Eliminaste prestamo de ' + loan.nombre);
    res.json({ ok: true });
  });

  // ── API: Payments ─────────────────────────────────────────────────────────
  // Auto-extender cuotas de Intereses si faltan pocas pendientes
  function autoExtendSoloIntereses() {
    const activeIndefinidos = db.prepare("SELECT * FROM loans WHERE estado = 'Activo' AND modalidad = 'Intereses'").all();
    for (const loan of activeIndefinidos) {
      const allPays = db.prepare('SELECT * FROM payments WHERE prestamoId = ? ORDER BY cuotaN DESC').all(loan.id);
      const regulares = allPays.filter(p => p.id.indexOf('-ab-') === -1);
      // Si quedan menos de 3 cuotas pendientes futuras, generar más
      const pendFuturas = regulares.filter(p => p.estadoPago === 'Pendiente');
      if (pendFuturas.length < 3) {
        const maxN = regulares.length > 0 ? Math.max(...regulares.map(p => p.cuotaN)) : 0;
        const nextN = maxN + 1;
        // Calcular saldo actual (considerando abonos)
        const abonos = allPays.filter(p => p.id.indexOf('-ab-') !== -1 && p.estadoPago === 'Pagado');
        const totalAbonado = abonos.reduce((s, p) => s + p.abonoCapital, 0);
        const saldo = Math.max(0, loan.montoCOP - totalAbonado);
        if (saldo > 0) {
          const nuevas = buildSchedule({ ...loan, montoCOP: saldo }, nextN, saldo, 3);
          // Solo insertar si no existen ya
          nuevas.forEach(p => {
            const exists = db.prepare('SELECT id FROM payments WHERE id = ?').get(p.id);
            if (!exists) insPayment.run(p);
          });
        }
      }
    }
  }

  app.get('/api/payments', (_req, res) => {
    autoExtendSoloIntereses();
    db.prepare(`UPDATE payments SET estadoPago='En Mora' WHERE estadoPago='Pendiente' AND fechaPago < ?`)
      .run(hoyStr());
    res.json(db.prepare('SELECT * FROM payments ORDER BY fechaPago, nombreCliente').all());
  });

  app.put('/api/payments/:id', (req, res) => {
    const { estadoPago, fechaRecaudo, observaciones, montoCOPRecibido, montoUSDRecibido } = req.body;
    const payBefore = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id);
    // Al marcar Pagado: partialPaid = cuotaTotal (recibido completo); al revertir: partialPaid = 0 (historial se pierde)
    let newPartial;
    if (estadoPago === 'Pagado' && payBefore) newPartial = payBefore.cuotaTotal;
    else if ((estadoPago === 'Pendiente' || estadoPago === 'En Mora') && payBefore) newPartial = 0;
    else newPartial = payBefore ? (payBefore.partialPaid || 0) : 0;
    db.prepare('UPDATE payments SET estadoPago=?, fechaRecaudo=?, observaciones=?, montoCOPRecibido=?, montoUSDRecibido=?, partialPaid=? WHERE id=?')
      .run(estadoPago, fechaRecaudo || null, observaciones || '', montoCOPRecibido || 0, montoUSDRecibido || 0, newPartial, req.params.id);
    if (payBefore) {
      const label = estadoPago === 'Pagado' ? 'Registraste pago' : estadoPago === 'En Mora' ? 'Marcaste en mora' : 'Revertiste a pendiente';
      logAction.run('pago', label + ': ' + payBefore.nombreCliente + ' cuota #' + payBefore.cuotaN + ' por $' + Math.round(payBefore.cuotaTotal).toLocaleString());
    }

    // Auto-finalización: si se marcó como Pagado, verificar si todas las cuotas regulares están pagadas
    if (estadoPago === 'Pagado') {
      const pay = db.prepare('SELECT prestamoId FROM payments WHERE id = ?').get(req.params.id);
      if (pay) {
        const allPays = db.prepare('SELECT * FROM payments WHERE prestamoId = ?').all(pay.prestamoId);
        // Cuotas regulares = las que NO son abonos a capital (abono = interesPeriodo=0 AND abonoCapital>0)
        const regulares = allPays.filter(p => !(p.interesPeriodo === 0 && p.abonoCapital > 0));
        const todasPagadas = regulares.length > 0 && regulares.every(p => p.estadoPago === 'Pagado');
        if (todasPagadas) {
          db.prepare("UPDATE loans SET estado = 'Finalizado' WHERE id = ? AND estado = 'Activo'").run(pay.prestamoId);
        }
      }
    }

    // Si se revierte a Pendiente/En Mora, reactivar el préstamo si estaba Finalizado por auto-finalización
    if (estadoPago === 'Pendiente' || estadoPago === 'En Mora') {
      const pay = db.prepare('SELECT prestamoId FROM payments WHERE id = ?').get(req.params.id);
      if (pay) {
        const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(pay.prestamoId);
        if (loan && loan.estado === 'Finalizado' && loan.montoCOP > 0) {
          db.prepare("UPDATE loans SET estado = 'Activo' WHERE id = ?").run(pay.prestamoId);
        }
      }
    }

    res.json({ ok: true });
  });

  // ── API: Pago Parcial ─────────────────────────────────────────────────────
  // Suma al campo partialPaid. Si con este pago se completa la cuota, auto-marca Pagado.
  app.post('/api/payments/:id/partial', (req, res) => {
    const { monto, fecha, observaciones, montoUSD } = req.body;
    const pay = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id);
    if (!pay) return res.status(404).json({ error: 'Cuota no encontrada' });
    if (pay.estadoPago === 'Pagado') return res.status(400).json({ error: 'La cuota ya está pagada' });
    if (pay.interesPeriodo === 0 && pay.abonoCapital > 0) return res.status(400).json({ error: 'No se pueden aplicar pagos parciales sobre un abono a capital' });
    const montoNum = Math.round(+monto || 0);
    if (montoNum <= 0) return res.status(400).json({ error: 'El monto debe ser mayor a 0' });
    const yaPagado = pay.partialPaid || 0;
    const restante = pay.cuotaTotal - yaPagado;
    if (montoNum > restante) return res.status(400).json({ error: 'El monto supera el saldo pendiente de la cuota ($' + Math.round(restante).toLocaleString() + ')' });

    const nuevoPartial = yaPagado + montoNum;
    const completa = nuevoPartial >= pay.cuotaTotal;
    const fechaPago = fecha || hoyStr();
    const obsPrev = pay.observaciones || '';
    const obsNueva = (observaciones || '').trim();
    const obsCombinada = [obsPrev, obsNueva && ('Parcial ' + fechaPago + ': $' + montoNum.toLocaleString() + (obsNueva ? ' — ' + obsNueva : ''))].filter(Boolean).join(' | ');

    if (completa) {
      // Completa la cuota: marcar Pagado
      const usdAcum = (pay.montoUSDRecibido || 0) + (+montoUSD || 0);
      db.prepare('UPDATE payments SET estadoPago=?, fechaRecaudo=?, observaciones=?, montoCOPRecibido=?, montoUSDRecibido=?, partialPaid=? WHERE id=?')
        .run('Pagado', fechaPago, obsCombinada, pay.cuotaTotal, Math.round(usdAcum * 100) / 100, pay.cuotaTotal, req.params.id);
      logAction.run('pago', 'Pago parcial final: ' + pay.nombreCliente + ' cuota #' + pay.cuotaN + ' $' + montoNum.toLocaleString() + ' (completo $' + Math.round(pay.cuotaTotal).toLocaleString() + ')');

      // Auto-finalización del préstamo
      const allPays = db.prepare('SELECT * FROM payments WHERE prestamoId = ?').all(pay.prestamoId);
      const regulares = allPays.filter(p => !(p.interesPeriodo === 0 && p.abonoCapital > 0));
      const todasPagadas = regulares.length > 0 && regulares.every(p => p.estadoPago === 'Pagado');
      if (todasPagadas) {
        db.prepare("UPDATE loans SET estado = 'Finalizado' WHERE id = ? AND estado = 'Activo'").run(pay.prestamoId);
      }
    } else {
      // Solo suma al partialPaid, estado permanece
      const copAcum = (pay.montoCOPRecibido || 0) + montoNum;
      const usdAcum = (pay.montoUSDRecibido || 0) + (+montoUSD || 0);
      db.prepare('UPDATE payments SET partialPaid=?, observaciones=?, montoCOPRecibido=?, montoUSDRecibido=? WHERE id=?')
        .run(nuevoPartial, obsCombinada, copAcum, Math.round(usdAcum * 100) / 100, req.params.id);
      const faltan = pay.cuotaTotal - nuevoPartial;
      logAction.run('pago', 'Pago parcial: ' + pay.nombreCliente + ' cuota #' + pay.cuotaN + ' $' + montoNum.toLocaleString() + ' (faltan $' + Math.round(faltan).toLocaleString() + ')');
    }
    res.json({ ok: true, completa, partialPaid: nuevoPartial, restante: Math.max(0, pay.cuotaTotal - nuevoPartial) });
  });

  // ── API: Abono a Capital ──────────────────────────────────────────────────
  app.post('/api/loans/:id/abono', (req, res) => {
    const { monto, fecha, observaciones, montoUSD, liquidar } = req.body;
    const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(req.params.id);
    if (!loan) return res.status(404).json({ error: 'No encontrado' });

    // Analizar cuotas existentes
    const allPays = db.prepare('SELECT * FROM payments WHERE prestamoId = ? ORDER BY cuotaN').all(req.params.id);

    // Saldo real: montoOrigen - todo capital pagado (formula confiable)
    const originalCOP = loan.moneda === 'USD' ? Math.round(loan.montoOrigen * loan.trmAcordada) : Math.round(loan.montoOrigen);
    const todoCapPagado = allPays.filter(p => p.estadoPago === 'Pagado').reduce((s, p) => s + p.abonoCapital, 0);
    const saldoReal = Math.max(0, originalCOP - todoCapPagado);
    const nuevoSaldo = Math.round(saldoReal - monto);
    if (nuevoSaldo < 0) return res.status(400).json({ error: 'El abono supera el saldo actual' });

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

    // Para Préstamo: actualizar cuotaTotal de cuotas En Mora al nuevo saldo
    // (Intereses NO: su cuota en mora sigue siendo el interés mensual fijo)
    if (loan.modalidad === 'Prestamo') {
      const moraRegulares = allPays.filter(p => p.estadoPago === 'En Mora' && !(p.interesPeriodo === 0 && p.abonoCapital > 0));
      moraRegulares.forEach(p => {
        db.prepare('UPDATE payments SET cuotaTotal = ?, saldoFinal = ? WHERE id = ?')
          .run(Math.max(0, nuevoSaldo), 0, p.id);
      });
    }

    // Registrar el abono como cuota especial (no cuenta como cuota regular)
    const abonoId = req.params.id + '-ab-' + Date.now();
    const fechaAbono = fecha || hoyStr();
    insPayment.run({
      id: abonoId,
      prestamoId: req.params.id,
      nombreCliente: loan.nombre,
      cuotaN: maxExistingN + 1,
      fechaPago: fechaAbono,
      saldoInicial: saldoReal,
      interesPeriodo: 0,
      abonoCapital: Math.round(monto),
      cuotaTotal: Math.round(monto),
      saldoFinal: Math.max(0, nuevoSaldo),
      estadoPago: 'Pagado',
      fechaRecaudo: fechaAbono,
      observaciones: observaciones || 'Abono a capital',
      montoCOPRecibido: Math.round(monto),
      montoUSDRecibido: montoUSD ? Math.round(montoUSD * 100) / 100 : 0,
      partialPaid: 0
    });

    if (nuevoSaldo <= 0) {
      // Capital saldado: eliminar cuotas pendientes (ya no hay capital que amortizar)
      db.prepare("DELETE FROM payments WHERE prestamoId = ? AND estadoPago = 'Pendiente'").run(req.params.id);
      const fechaLiq = fecha || hoyStr();
      if (liquidar) {
        // Liquidacion total: marcar cuotas en mora como pagadas tambien
        db.prepare("UPDATE payments SET estadoPago = 'Pagado', fechaRecaudo = ? WHERE prestamoId = ? AND estadoPago = 'En Mora'").run(fechaLiq, req.params.id);
        db.prepare("UPDATE loans SET montoCOP = 0, estado = 'Finalizado' WHERE id = ?").run(req.params.id);
      } else {
        // Solo abono a capital: cuotas en mora permanecen
        const moraRestante = db.prepare("SELECT COUNT(*) as c FROM payments WHERE prestamoId = ? AND estadoPago = 'En Mora'").get(req.params.id);
        if (moraRestante.c === 0) {
          db.prepare("UPDATE loans SET montoCOP = 0, estado = 'Finalizado' WHERE id = ?").run(req.params.id);
        } else {
          db.prepare("UPDATE loans SET montoCOP = 0 WHERE id = ?").run(req.params.id);
        }
      }
    } else {
      db.prepare('UPDATE loans SET montoCOP = ? WHERE id = ?').run(nuevoSaldo, req.params.id);

      // Calcular cuotas restantes
      const indefinido = loan.modalidad === 'Intereses';
      const remaining = indefinido ? 3 : Math.max(0, (loan.plazoMeses || 12) - regularConsumed);

      if (remaining > 0) {
        // startN = siguiente cuota regular (continua la numeracion original)
        const nextRegularN = regularConsumed + 1;
        const updatedLoan = Object.assign({}, loan, { montoCOP: nuevoSaldo });
        // numCuotas = remaining (solo las que faltan del plazo original)
        insertSchedule(buildSchedule(updatedLoan, nextRegularN, nuevoSaldo, remaining));
      }
    }

    logAction.run('abono', 'Registraste abono de $' + Math.round(monto).toLocaleString() + ' a ' + loan.nombre + (nuevoSaldo <= 0 ? ' (SALDADO)' : ' — saldo: $' + Math.round(nuevoSaldo).toLocaleString()));
    res.json({ ok: true, nuevoSaldo: Math.max(0, nuevoSaldo) });
  });

  // ── API: Cierre Forzoso ───────────────────────────────────────────────────
  // Marca el préstamo como 'Cancelado' (cierre con pérdidas), guarda snapshot
  // de capital pendiente + intereses en mora, y borra las cuotas restantes.
  app.post('/api/loans/:id/force-close', (req, res) => {
    const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(req.params.id);
    if (!loan) return res.status(404).json({ error: 'No encontrado' });
    if (loan.estado !== 'Activo') return res.status(400).json({ error: 'Solo se pueden cerrar préstamos activos' });

    const allPays = db.prepare('SELECT * FROM payments WHERE prestamoId = ?').all(req.params.id);
    const originalCOP = loan.moneda === 'USD' ? Math.round(loan.montoOrigen * loan.trmAcordada) : Math.round(loan.montoOrigen);
    const todoCapPagado = allPays.filter(p => p.estadoPago === 'Pagado').reduce((s, p) => s + p.abonoCapital, 0);
    const capitalPerdido = Math.max(0, Math.round(originalCOP - todoCapPagado));
    const interesesPerdidos = Math.round(allPays
      .filter(p => p.estadoPago === 'En Mora' && !(p.interesPeriodo === 0 && p.abonoCapital > 0))
      .reduce((s, p) => s + p.interesPeriodo, 0));

    db.prepare("DELETE FROM payments WHERE prestamoId = ? AND estadoPago IN ('Pendiente', 'En Mora')").run(req.params.id);
    db.prepare("UPDATE loans SET estado = 'Cancelado', capitalPerdido = ?, interesesPerdidos = ?, montoCOP = 0 WHERE id = ?")
      .run(capitalPerdido, interesesPerdidos, req.params.id);

    const totalPerdido = capitalPerdido + interesesPerdidos;
    logAction.run('cierre', 'Cerraste a la fuerza el préstamo de ' + loan.nombre + ' — pérdida: $' + totalPerdido.toLocaleString() + ' (capital $' + capitalPerdido.toLocaleString() + ' + intereses mora $' + interesesPerdidos.toLocaleString() + ')');
    res.json({ ok: true, capitalPerdido: capitalPerdido, interesesPerdidos: interesesPerdidos, totalPerdido: totalPerdido });
  });

  // ── API: Cambiar día de pago (con prorrateo) ──────────────────────────────
  // Cambia loan.diaPago, borra cuotas Pendientes/En Mora, regenera cronograma con
  // la nueva fecha y consolida en la primera cuota: intereses en mora previos +
  // prorrateo de los días extra hasta la nueva fecha.
  app.post('/api/loans/:id/cambiar-dia-pago', (req, res) => {
    const { nuevoDia, interesProrrateado, montoMoraConsolidada, diasExtra } = req.body;
    const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(req.params.id);
    if (!loan) return res.status(404).json({ error: 'No encontrado' });
    if (loan.estado !== 'Activo') return res.status(400).json({ error: 'Solo se puede cambiar la fecha de prestamos activos' });
    if (loan.modalidad === 'Prestamo') return res.status(400).json({ error: 'No aplica para prestamos sin interes' });
    const nuevoDiaInt = parseInt(nuevoDia, 10);
    if (!nuevoDiaInt || nuevoDiaInt < 1 || nuevoDiaInt > 31) return res.status(400).json({ error: 'Dia invalido' });
    if (nuevoDiaInt === loan.diaPago) return res.status(400).json({ error: 'El nuevo dia debe ser distinto al actual' });

    const extra = Math.round((+interesProrrateado || 0) + (+montoMoraConsolidada || 0));
    const moraCount = db.prepare("SELECT COUNT(*) as c FROM payments WHERE prestamoId = ? AND estadoPago = 'En Mora' AND NOT (interesPeriodo = 0 AND abonoCapital > 0)").get(req.params.id).c;

    // Borrar cuotas Pendientes y En Mora regulares (preserva Pagadas y abonos)
    db.prepare("DELETE FROM payments WHERE prestamoId = ? AND estadoPago IN ('Pendiente','En Mora') AND NOT (interesPeriodo = 0 AND abonoCapital > 0)").run(req.params.id);

    // Actualizar día de pago
    db.prepare('UPDATE loans SET diaPago = ? WHERE id = ?').run(nuevoDiaInt, req.params.id);
    const loanActualizado = db.prepare('SELECT * FROM loans WHERE id = ?').get(req.params.id);

    // Determinar punto de partida para el nuevo cronograma
    const todasCuotas = db.prepare('SELECT * FROM payments WHERE prestamoId = ?').all(req.params.id);
    const regularesExistentes = todasCuotas.filter(p => !(p.interesPeriodo === 0 && p.abonoCapital > 0));
    const regularConsumed = regularesExistentes.length; // cuotas Pagadas que quedan
    const nextRegularN = regularConsumed + 1;

    // Saldo actual (capital pendiente)
    const originalCOP = loan.moneda === 'USD' ? Math.round(loan.montoOrigen * loan.trmAcordada) : Math.round(loan.montoOrigen);
    const todoCapPagado = todasCuotas.filter(p => p.estadoPago === 'Pagado').reduce((s, p) => s + p.abonoCapital, 0);
    const saldoActual = Math.max(0, originalCOP - todoCapPagado);

    if (saldoActual <= 0) return res.status(400).json({ error: 'El prestamo no tiene saldo pendiente' });

    // Calcular cuántas cuotas generar
    const indefinido = loanActualizado.modalidad === 'Intereses';
    const remaining = indefinido ? 3 : Math.max(1, (loanActualizado.plazoMeses || 12) - regularConsumed);

    // Generar cronograma nuevo desde la cuota siguiente
    const nuevasCuotas = buildSchedule(loanActualizado, nextRegularN, saldoActual, remaining);

    // Sobrescribir la PRIMERA cuota nueva con el monto consolidado
    if (nuevasCuotas.length > 0 && extra > 0) {
      const primera = nuevasCuotas[0];
      primera.interesPeriodo = Math.round(primera.interesPeriodo + extra);
      primera.cuotaTotal = Math.round(primera.cuotaTotal + extra);
      const obsExtra = 'Cuota consolidada por cambio de fecha de pago. Incluye: '
        + (montoMoraConsolidada > 0 ? 'intereses en mora previos $' + Math.round(montoMoraConsolidada).toLocaleString('es-CO') : '')
        + (montoMoraConsolidada > 0 && interesProrrateado > 0 ? ' + ' : '')
        + (interesProrrateado > 0 ? 'prorrateo ' + diasExtra + ' dias $' + Math.round(interesProrrateado).toLocaleString('es-CO') : '');
      primera.observaciones = obsExtra;
    }

    insertSchedule(nuevasCuotas);

    const logMsg = 'Cambiaste dia de pago de ' + loan.nombre + ' del ' + loan.diaPago + ' al ' + nuevoDiaInt
      + (moraCount > 0 ? ' — consolidaste ' + moraCount + ' cuota' + (moraCount > 1 ? 's' : '') + ' en mora ($' + Math.round(montoMoraConsolidada || 0).toLocaleString('es-CO') + ')' : '')
      + (interesProrrateado > 0 ? ' + prorrateo ' + diasExtra + ' dias ($' + Math.round(interesProrrateado).toLocaleString('es-CO') + ')' : '')
      + (extra > 0 ? ' = primera cuota +$' + extra.toLocaleString('es-CO') : '');
    logAction.run('cambio-fecha', logMsg);

    res.json({
      ok: true,
      nuevoDia: nuevoDiaInt,
      primeraCuota: nuevasCuotas[0] || null,
      cuotasRecurrentes: nuevasCuotas.length > 1 ? nuevasCuotas[1].cuotaTotal : (nuevasCuotas[0] ? nuevasCuotas[0].cuotaTotal - extra : 0),
      moraConsolidada: Math.round(montoMoraConsolidada || 0),
      prorrateo: Math.round(interesProrrateado || 0),
      moraCount: moraCount
    });
  });

  // ── API: Historial de acciones ────────────────────────────────────────────
  app.get('/api/activity', (_req, res) => {
    const rows = db.prepare('SELECT * FROM activity_log ORDER BY id DESC LIMIT 100').all();
    res.json(rows);
  });

  return app;
};
