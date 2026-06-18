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

// ID unico estilo timestamp + sufijo aleatorio (mismo formato que los IDs de loans)
function genId() {
  return Date.now().toString() + Math.random().toString(36).slice(2, 6);
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
  // v1.11.1: timestamp real (YYYY-MM-DD HH:MM:SS) de cuando se marco Pagado. Permite ordenar
  // "Transacciones recientes" por HORA exacta y no solo por fecha de recaudo (que empata el mismo dia).
  try { db.exec('ALTER TABLE payments ADD COLUMN paidAt TEXT'); } catch(_){}
  // v1.11.4: ledger de recibos (flujo de caja real). JSON [{fecha,cop}] — un evento por
  // transaccion (cada parcial en su fecha de recaudo + el pago final). Permite que "Cobros del
  // Mes" cuente los parciales en curso en su dia exacto sin doble conteo. Las filas sin ledger
  // (historico, abonos, liquidaciones de mora) usan fallback a fechaRecaudo en el frontend.
  try { db.exec("ALTER TABLE payments ADD COLUMN recibos TEXT DEFAULT '[]'"); } catch(_){}
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
  // Compras fraccionadas de USD: desglose de lotes con su tasa. JSON: [{monto, tasa}, ...]
  try { db.exec("ALTER TABLE loans ADD COLUMN comprasUSD TEXT DEFAULT ''"); } catch(_){}
  // Extra consolidado en una cuota (prorrateo + mora del cambio-dia-pago) que debe preservarse al recalcular
  try { db.exec("ALTER TABLE payments ADD COLUMN extraConsolidado REAL DEFAULT 0"); } catch(_){}
  // Extra pendiente del prorrateo a aplicar a la PROXIMA cuota regular del prestamo.
  // Persiste en loans para sobrevivir cualquier regeneracion del cronograma (recalculate, edit, etc.).
  // Se aplica a la primera cuota Pendiente cuyo cuotaN >= proximaCuotaExtraN.
  // Se limpia automaticamente cuando esa cuota se paga.
  try { db.exec("ALTER TABLE loans ADD COLUMN proximaCuotaExtra REAL DEFAULT 0"); } catch(_){}
  try { db.exec("ALTER TABLE loans ADD COLUMN proximaCuotaExtraN INTEGER DEFAULT 0"); } catch(_){}
  // Cuota fija pactada (modo "Fijar cuota" de abono opcion 3): cuando > 0, el cronograma debe
  // regenerarse usando buildScheduleFixedPMT en vez de buildSchedule.
  // Se limpia al saldar el prestamo o al hacer un abono con otra opcion (Mantener/Modificar plazo).
  try { db.exec("ALTER TABLE loans ADD COLUMN cuotaFijaPactada REAL DEFAULT 0"); } catch(_){}

  // ── Tabla de historial de acciones ──────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS activity_log (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      fecha     TEXT DEFAULT (datetime('now','localtime')),
      tipo      TEXT NOT NULL,
      mensaje   TEXT NOT NULL
    )
  `);

  // ── Modulo "Mis Deudas" (lo que YO debo) — registro manual ──────────────────
  // Sin intereses ni cuotas automaticas. El saldo se reduce manualmente via abonos
  // registrados en el ledger pagos_deudas. mis_deudas primero (la FK la referencia).
  db.exec(`
    CREATE TABLE IF NOT EXISTS mis_deudas (
      id              TEXT PRIMARY KEY,
      acreedor        TEXT NOT NULL,
      concepto        TEXT DEFAULT '',
      monto_original  REAL NOT NULL DEFAULT 0,
      saldo_pendiente REAL NOT NULL DEFAULT 0,
      estado          TEXT NOT NULL DEFAULT 'Activa',
      fecha_creacion  TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS pagos_deudas (
      id           TEXT PRIMARY KEY,
      deuda_id     TEXT NOT NULL,
      monto_pagado REAL NOT NULL DEFAULT 0,
      fecha_pago   TEXT NOT NULL,
      notas        TEXT DEFAULT '',
      FOREIGN KEY(deuda_id) REFERENCES mis_deudas(id) ON DELETE CASCADE
    );
  `);
  // QA2: campo "titulo" independiente de la descripcion (migracion segura e idempotente).
  try { db.exec("ALTER TABLE mis_deudas ADD COLUMN titulo TEXT DEFAULT ''"); } catch(_){}
  // QA5: tipo de movimiento en el ledger ('abono' reduce la deuda, 'cargo' la aumenta).
  try { db.exec("ALTER TABLE pagos_deudas ADD COLUMN tipo TEXT DEFAULT 'abono'"); } catch(_){}
  const logAction = db.prepare('INSERT INTO activity_log(tipo, mensaje) VALUES (?, ?)');
  try { db.exec("ALTER TABLE loans ADD COLUMN fechaDevolucion TEXT DEFAULT ''"); } catch(_){}
  // v1.10.0: ganancia para modalidad 'Pago Unico' (monto unico pactado en COP)
  try { db.exec("ALTER TABLE loans ADD COLUMN gananciaFija REAL DEFAULT 0"); } catch(_){}


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
        montoCOPRecibido: 0, montoUSDRecibido: 0, partialPaid: 0, extraConsolidado: 0
      });
      return rows;
    }

    // v1.10.0 — Pago Unico: 1 cuota con capital + ganancia fija pactada
    // interesPeriodo carga la ganancia → entra al KPI Ganancias del Dashboard
    // abonoCapital carga el capital → entra al calculo de Saldo Pendiente
    // cuotaTotal = capital + ganancia → entra al Recaudo del mes
    if (modalidad === 'Pago Unico') {
      var fechaCuotaPU = loan.fechaDevolucion || getPayDate(fechaInicio, 1, diaPago, freq);
      var capitalPU = Math.round(montoCOP);
      var gananciaPU = Math.round(+loan.gananciaFija || 0);
      rows.push({
        id: `${id}-1`, prestamoId: id, nombreCliente: nombre, cuotaN: 1,
        fechaPago: fechaCuotaPU,
        saldoInicial: capitalPU,
        interesPeriodo: gananciaPU,
        abonoCapital: capitalPU,
        cuotaTotal: capitalPU + gananciaPU,
        saldoFinal: 0, estadoPago: 'Pendiente', fechaRecaudo: null, observaciones: '',
        montoCOPRecibido: 0, montoUSDRecibido: 0, partialPaid: 0, extraConsolidado: 0
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
        montoCOPRecibido: 0, montoUSDRecibido: 0, partialPaid: 0, extraConsolidado: 0
      });
      saldo = saldoFinal;
    }
    return rows;
  }

  /**
   * buildScheduleFixedPMT — genera cronograma con cuota fija y cuota residual final.
   * Usado por opcion 3 del recalculo (Fijar valor de cuota).
   * Genera N-1 cuotas iguales de cuotaFija + 1 ultima cuota que ajusta el saldo a 0.
   *
   * @param {object} loan        - datos del prestamo (necesita id, nombre, fechaInicio, diaPago, frecuencia, modalidad, tasaMensual)
   * @param {number} startN      - numero de cuota inicial
   * @param {number} saldoInicial - saldo de capital sobre el cual aplicar
   * @param {number} cuotaFija   - cuota deseada por periodo (debe ser > saldoInicial * r)
   * @returns {Array<object>} - filas de cuotas (la ultima es la residual)
   * @throws Error si cuotaFija <= saldoInicial * r (cuota insuficiente para cubrir intereses)
   */
  function buildScheduleFixedPMT(loan, startN, saldoInicial, cuotaFija) {
    const { id, nombre, tasaMensual, fechaInicio, diaPago } = loan;
    const freq = loan.frecuencia || 'Mensual';
    const r = tasaPeriodo(tasaMensual / 100, freq);
    const interesInicial = saldoInicial * r;
    // Validacion: cuota debe cubrir al menos el interes del primer periodo
    if (cuotaFija <= interesInicial) {
      throw new Error('Cuota insuficiente: $' + Math.round(cuotaFija).toLocaleString('es-CO') +
        ' no cubre el interes del primer periodo ($' + Math.round(interesInicial).toLocaleString('es-CO') + ').');
    }
    const rows = [];
    let saldo = saldoInicial;
    let cuotaN = startN;
    const MAX_ITER = 1000; // safety net
    let i = 0;
    while (saldo > 0.5 && i < MAX_ITER) {
      const interes = Math.round(saldo * r * 100) / 100;
      // Si esta cuota completa o exceria el saldo, es la ultima (residual)
      const saldoMasInteres = saldo + interes;
      let capital, cuotaTotal, saldoFinal;
      if (saldoMasInteres <= cuotaFija + 0.5) {
        // Ultima cuota: residual exacto
        capital = saldo;
        cuotaTotal = Math.round(saldoMasInteres * 100) / 100;
        saldoFinal = 0;
      } else {
        capital = Math.round((cuotaFija - interes) * 100) / 100;
        cuotaTotal = cuotaFija;
        saldoFinal = Math.max(0, Math.round((saldo - capital) * 100) / 100);
      }
      rows.push({
        id: `${id}-${cuotaN}`,
        prestamoId: id,
        nombreCliente: nombre,
        cuotaN: cuotaN,
        fechaPago: getPayDate(fechaInicio, cuotaN, diaPago, freq),
        saldoInicial: Math.round(saldo),
        interesPeriodo: Math.round(interes),
        abonoCapital: Math.round(capital),
        cuotaTotal: Math.round(cuotaTotal),
        saldoFinal: Math.round(saldoFinal),
        estadoPago: 'Pendiente',
        fechaRecaudo: null,
        observaciones: '',
        montoCOPRecibido: 0,
        montoUSDRecibido: 0,
        partialPaid: 0,
        extraConsolidado: 0
      });
      saldo = saldoFinal;
      cuotaN++;
      i++;
    }
    if (i >= MAX_ITER) throw new Error('Cuota demasiado baja: requiere mas de ' + MAX_ITER + ' cuotas para saldar.');
    return rows;
  }

  const insPayment = db.prepare(`
    INSERT OR REPLACE INTO payments(id,prestamoId,nombreCliente,cuotaN,fechaPago,saldoInicial,
      interesPeriodo,abonoCapital,cuotaTotal,saldoFinal,estadoPago,fechaRecaudo,observaciones,montoCOPRecibido,montoUSDRecibido,partialPaid,extraConsolidado)
    VALUES (@id,@prestamoId,@nombreCliente,@cuotaN,@fechaPago,@saldoInicial,
      @interesPeriodo,@abonoCapital,@cuotaTotal,@saldoFinal,@estadoPago,@fechaRecaudo,@observaciones,@montoCOPRecibido,@montoUSDRecibido,@partialPaid,@extraConsolidado)
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
  // v1.9.0 FIX: solo borra Pendientes regulares. Cuotas Pagadas y En Mora se preservan
  // intactas (son deuda historica / causada y no deben ser recalculadas). nextRegularN
  // se deriva de las cuotas (Pagadas + Mora) existentes para que las nuevas Pendientes
  // no colisionen con los cuotaN existentes.
  app.post('/api/recalculate', (_req, res) => {
    const activeLoans = db.prepare("SELECT * FROM loans WHERE estado = 'Activo'").all();
    let updated = 0;
    for (const loan of activeLoans) {
      const prev = db.prepare('SELECT * FROM payments WHERE prestamoId = ?').all(loan.id);
      const prevRegulares = prev.filter(p => !p.id || p.id.indexOf('-ab-') === -1);
      const prevPagadasYMora = prevRegulares.filter(p => p.estadoPago === 'Pagado' || p.estadoPago === 'En Mora');
      const prevPendientes = prevRegulares.filter(p => p.estadoPago === 'Pendiente');

      // Snapshot de partialPaid + observaciones de Pendientes (para restaurar tras regenerar)
      const partialMap = {};
      prevPendientes.forEach(p => {
        if ((p.partialPaid || 0) > 0 || p.observaciones) {
          partialMap[p.cuotaN] = { partialPaid: p.partialPaid || 0, observaciones: p.observaciones || '' };
        }
      });

      // Borrar SOLO las Pendientes — Pagadas y Mora quedan intactas
      prevPendientes.forEach(p => {
        db.prepare('DELETE FROM payments WHERE id = ?').run(p.id);
      });

      const regularConsumed = prevPagadasYMora.length;
      const nextRegularN = regularConsumed + 1;
      const cuotaFija = Math.round(+loan.cuotaFijaPactada || 0);
      const indefinido = loan.modalidad === 'Intereses';

      // v1.9.x FIX (bug general de cuotas infladas): NO usar loan.montoCOP que puede
      // estar stale (solo se actualiza con /abono, no al marcar pagos sin abono).
      // Calcular saldo real desde formula confiable: originalCOP - capitalPagado total
      // (cuotas Pagadas regulares + abonos a capital Pagados). Aplica solo a modalidades
      // que necesitan amortizacion (Capital + Intereses, Intereses). Prestamo se mantiene
      // con montoCOP porque su flujo es diferente.
      const originalCOPRec = loan.moneda === 'USD' ? Math.round(loan.montoOrigen * loan.trmAcordada) : Math.round(loan.montoOrigen);
      const capPorAbonos = prev.filter(p => p.id.indexOf('-ab-') !== -1 && p.estadoPago === 'Pagado').reduce((s, p) => s + p.abonoCapital, 0);
      const capPorCuotasPagadas = prevPagadasYMora.filter(p => p.estadoPago === 'Pagado').reduce((s, p) => s + p.abonoCapital, 0);
      const saldoReal = Math.max(0, originalCOPRec - capPorAbonos - capPorCuotasPagadas);
      let schedule = [];

      if (saldoReal > 0) {
        if (cuotaFija > 0 && loan.modalidad === 'Capital + Intereses') {
          try {
            schedule = buildScheduleFixedPMT(loan, nextRegularN, saldoReal, cuotaFija);
          } catch (e) {
            const remaining = Math.max(0, (loan.plazoMeses || 12) - regularConsumed);
            if (remaining > 0) schedule = buildSchedule(loan, nextRegularN, saldoReal, remaining);
          }
        } else if (loan.modalidad === 'Prestamo') {
          // Para Prestamo (sin intereses, 1 cuota) seguimos usando montoCOP — su flujo
          // no es PMT y montoCOP refleja el saldo correctamente tras abonos.
          if (regularConsumed === 0 && loan.montoCOP > 0) schedule = buildSchedule(loan);
        } else if (loan.modalidad === 'Pago Unico') {
          // v1.10.0: espejo de Prestamo — 1 cuota unica, regenera si no se consumio
          if (regularConsumed === 0 && loan.montoCOP > 0) schedule = buildSchedule(loan);
        } else {
          // Intereses o Capital+Intereses sin cuotaFija — usar saldoReal computado
          const remaining = indefinido
            ? Math.max(0, cuotasHastaHoy(loan.fechaInicio, nextRegularN, 3, loan.frecuencia || 'Mensual'))
            : Math.max(0, (loan.plazoMeses || 12) - regularConsumed);
          if (remaining > 0) schedule = buildSchedule(loan, nextRegularN, saldoReal, remaining);
        }
      }

      // Aplicar extra del prorrateo (proximaCuotaExtra) a la cuota objetivo si aun esta pendiente
      const extraLoan = Math.round(+loan.proximaCuotaExtra || 0);
      const extraN = +loan.proximaCuotaExtraN || 0;
      schedule.forEach(p => {
        const partial = partialMap[p.cuotaN];
        if (partial) {
          p.partialPaid = partial.partialPaid;
          if (partial.observaciones) p.observaciones = partial.observaciones;
        }
        if (extraLoan > 0 && p.cuotaN === extraN) {
          p.interesPeriodo = Math.round(p.interesPeriodo + extraLoan);
          p.cuotaTotal = Math.round(p.cuotaTotal + extraLoan);
          p.extraConsolidado = extraLoan;
          if (!p.observaciones) p.observaciones = 'Cuota consolidada por cambio de fecha de pago (+$' + extraLoan.toLocaleString('es-CO') + ')';
        }
      });
      if (schedule.length > 0) insertSchedule(schedule);
      updated++;
    }
    // Re-aplicar auto-mora a Pendientes que cruzaron la fecha
    db.prepare(`UPDATE payments SET estadoPago='En Mora' WHERE estadoPago='Pendiente' AND fechaPago < ?`)
      .run(hoyStr());
    // Fix cuotas en mora de Prestamo (sin intereses): cuotaTotal = saldo actual
    // v1.10.0 fix housekeeping: tambien saldoInicial y abonoCapital para mantener
    // consistencia interna de la cuota tras abonos previos.
    const fixP = db.prepare("SELECT * FROM loans WHERE estado = 'Activo' AND modalidad = 'Prestamo'").all();
    fixP.forEach(fl => {
      const ns = Math.round(fl.montoCOP);
      db.prepare(`UPDATE payments SET saldoInicial = ?, abonoCapital = ?, cuotaTotal = ?, saldoFinal = 0
        WHERE prestamoId = ? AND estadoPago = 'En Mora'
        AND id NOT LIKE '%-ab-%'`)
        .run(ns, ns, ns, fl.id);
    });
    // v1.10.0 — Fix cuotas en mora de Pago Unico: cuotaTotal = saldo + ganancia
    // (la ganancia pactada se mantiene aunque el deudor caiga en mora)
    const fixPU = db.prepare("SELECT * FROM loans WHERE estado = 'Activo' AND modalidad = 'Pago Unico'").all();
    fixPU.forEach(fl => {
      const gPU = Math.round(+fl.gananciaFija || 0);
      const nsPU = Math.round(fl.montoCOP);
      db.prepare(`UPDATE payments SET saldoInicial = ?, abonoCapital = ?, cuotaTotal = ?, saldoFinal = 0
        WHERE prestamoId = ? AND estadoPago = 'En Mora'
        AND id NOT LIKE '%-ab-%'`)
        .run(nsPU, nsPU, nsPU + gPU, fl.id);
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
    const loan = { fechaDevolucion: '', comprasUSD: '', gananciaFija: 0, ...req.body, id: Date.now().toString() + Math.random().toString(36).slice(2,6) };
    // Si comprasUSD viene como array/objeto, serializar a JSON
    if (loan.comprasUSD && typeof loan.comprasUSD !== 'string') loan.comprasUSD = JSON.stringify(loan.comprasUSD);
    // v1.10.0: gananciaFija solo aplica para modalidad Pago Unico — forzar 0 en el resto
    if (loan.modalidad !== 'Pago Unico') loan.gananciaFija = 0;
    else loan.gananciaFija = Math.round(+loan.gananciaFija || 0);
    db.prepare(`
      INSERT INTO loans(id,nombre,cedula,telefono,moneda,montoOrigen,trmAcordada,montoCOP,
        tasaMensual,plazoMeses,modalidad,fechaInicio,diaPago,estado,notas,frecuencia,fechaDevolucion,comprasUSD,gananciaFija)
      VALUES (@id,@nombre,@cedula,@telefono,@moneda,@montoOrigen,@trmAcordada,@montoCOP,
        @tasaMensual,@plazoMeses,@modalidad,@fechaInicio,@diaPago,@estado,@notas,@frecuencia,@fechaDevolucion,@comprasUSD,@gananciaFija)
    `).run(loan);
    insertSchedule(buildSchedule(loan));
    var detalleLog = (loan.moneda === 'USD' ? 'USD $' + loan.montoOrigen : '$' + Math.round(loan.montoCOP).toLocaleString()) + ' (' + loan.modalidad + ')';
    if (loan.modalidad === 'Pago Unico' && loan.gananciaFija > 0) {
      detalleLog += ' [ganancia $' + Math.round(loan.gananciaFija).toLocaleString('es-CO') + ']';
    }
    logAction.run('prestamo', 'Nuevo prestamo: ' + loan.nombre + ' por ' + detalleLog);
    res.status(201).json(loan);
  });

  app.put('/api/loans/:id', (req, res) => {
    const loan = { fechaDevolucion: '', comprasUSD: '', gananciaFija: 0, ...req.body, id: req.params.id };
    if (loan.comprasUSD && typeof loan.comprasUSD !== 'string') loan.comprasUSD = JSON.stringify(loan.comprasUSD);
    // v1.10.0: gananciaFija solo aplica para modalidad Pago Unico — forzar 0 en el resto
    if (loan.modalidad !== 'Pago Unico') loan.gananciaFija = 0;
    else loan.gananciaFija = Math.round(+loan.gananciaFija || 0);
    db.prepare(`
      UPDATE loans SET nombre=@nombre, cedula=@cedula, telefono=@telefono, moneda=@moneda,
        montoOrigen=@montoOrigen, trmAcordada=@trmAcordada, montoCOP=@montoCOP,
        tasaMensual=@tasaMensual, plazoMeses=@plazoMeses, modalidad=@modalidad,
        fechaInicio=@fechaInicio, diaPago=@diaPago, estado=@estado, notas=@notas, frecuencia=@frecuencia, fechaDevolucion=@fechaDevolucion, comprasUSD=@comprasUSD, gananciaFija=@gananciaFija
      WHERE id=@id
    `).run(loan);

    // v1.9.0 FIX: solo borrar Pendientes regulares. Cuotas Pagadas y En Mora se preservan
    // intactas (deuda historica/causada). Esto garantiza que un edit nunca afecta cuotas
    // ya pactadas con el deudor.
    const prev = db.prepare('SELECT * FROM payments WHERE prestamoId = ?').all(loan.id);
    const prevAbonos = prev.filter(p => p.id.indexOf('-ab-') !== -1);
    const prevRegulares = prev.filter(p => p.id.indexOf('-ab-') === -1);
    const prevPagadasYMora = prevRegulares.filter(p => p.estadoPago === 'Pagado' || p.estadoPago === 'En Mora');
    const prevPendientes = prevRegulares.filter(p => p.estadoPago === 'Pendiente');

    // Snapshot de partialPaid + observaciones de Pendientes
    const partialMapEdit = {};
    prevPendientes.forEach(p => {
      if ((p.partialPaid || 0) > 0 || p.observaciones) {
        partialMapEdit[p.cuotaN] = { partialPaid: p.partialPaid || 0, observaciones: p.observaciones || '' };
      }
    });

    // Borrar SOLO Pendientes — Pagadas, Mora y abonos quedan intactos
    prevPendientes.forEach(p => {
      db.prepare('DELETE FROM payments WHERE id = ?').run(p.id);
    });

    // Saldo actual considerando abonos previos (montoCOP es el del request, pero defendemos
    // contra valores incorrectos restando los abonos confirmados).
    const totalAbonado = prevAbonos.filter(p => p.estadoPago === 'Pagado')
      .reduce((s, p) => s + p.abonoCapital, 0);
    // capital ya consumido por cuotas Pagadas regulares (no abonos)
    const capPorCuotasPagadas = prevPagadasYMora
      .filter(p => p.estadoPago === 'Pagado')
      .reduce((s, p) => s + p.abonoCapital, 0);
    const originalCOPEdit = loan.moneda === 'USD' ? Math.round(loan.montoOrigen * loan.trmAcordada) : Math.round(loan.montoOrigen);
    const saldoActual = Math.max(0, originalCOPEdit - totalAbonado - capPorCuotasPagadas);
    const regularConsumedEdit = prevPagadasYMora.length;
    const nextRegularNEdit = regularConsumedEdit + 1;
    const cuotaFijaEdit = Math.round(+loan.cuotaFijaPactada || 0);
    const indefinidoEdit = loan.modalidad === 'Intereses';

    let schedule = [];
    if (saldoActual > 0) {
      if (cuotaFijaEdit > 0 && loan.modalidad === 'Capital + Intereses') {
        try {
          schedule = buildScheduleFixedPMT({ ...loan, montoCOP: saldoActual }, nextRegularNEdit, saldoActual, cuotaFijaEdit);
        } catch (e) {
          const remaining = Math.max(0, (loan.plazoMeses || 12) - regularConsumedEdit);
          if (remaining > 0) schedule = buildSchedule({ ...loan, montoCOP: saldoActual }, nextRegularNEdit, saldoActual, remaining);
        }
      } else if (loan.modalidad === 'Prestamo') {
        if (regularConsumedEdit === 0) schedule = buildSchedule({ ...loan, montoCOP: saldoActual });
      } else if (loan.modalidad === 'Pago Unico') {
        // v1.10.0: igual que Prestamo — solo regenera si no se consumio la cuota unica
        if (regularConsumedEdit === 0) schedule = buildSchedule({ ...loan, montoCOP: saldoActual });
      } else {
        const remaining = indefinidoEdit
          ? Math.max(0, cuotasHastaHoy(loan.fechaInicio, nextRegularNEdit, 3, loan.frecuencia || 'Mensual'))
          : Math.max(0, (loan.plazoMeses || 12) - regularConsumedEdit);
        if (remaining > 0) schedule = buildSchedule({ ...loan, montoCOP: saldoActual }, nextRegularNEdit, saldoActual, remaining);
      }
    }

    // Aplicar extra del prorrateo + restaurar partialPaid
    const extraLoanEdit = Math.round(+loan.proximaCuotaExtra || 0);
    const extraNEdit = +loan.proximaCuotaExtraN || 0;
    schedule.forEach(p => {
      const partial = partialMapEdit[p.cuotaN];
      if (partial) {
        p.partialPaid = partial.partialPaid;
        if (partial.observaciones) p.observaciones = partial.observaciones;
      }
      if (extraLoanEdit > 0 && p.cuotaN === extraNEdit) {
        p.interesPeriodo = Math.round(p.interesPeriodo + extraLoanEdit);
        p.cuotaTotal = Math.round(p.cuotaTotal + extraLoanEdit);
        p.extraConsolidado = extraLoanEdit;
        if (!p.observaciones) p.observaciones = 'Cuota consolidada por cambio de fecha de pago (+$' + extraLoanEdit.toLocaleString('es-CO') + ')';
      }
    });
    if (schedule.length > 0) insertSchedule(schedule);
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
    // v1.11.1: paidAt = hora real del marcado. Se conserva si ya estaba pagado; se limpia al revertir.
    const nowTs = db.prepare("SELECT datetime('now','localtime') AS t").get().t;
    let newPaidAt;
    if (estadoPago === 'Pagado') newPaidAt = (payBefore && payBefore.paidAt) ? payBefore.paidAt : nowTs;
    else if (estadoPago === 'Pendiente' || estadoPago === 'En Mora') newPaidAt = null;
    else newPaidAt = payBefore ? (payBefore.paidAt || null) : null;
    // v1.11.4: ledger de recibos. Al marcar Pagado, anadir el REMANENTE (lo que falta para cubrir
    // el monto recibido) como un evento en fechaRecaudo: preserva parciales previos en sus fechas
    // reales y nunca duplica. En el flujo normal (cuota sin parciales) el remanente == monto total.
    // Al revertir se limpia el ledger (coherente con partialPaid=0). En otros casos se conserva.
    let newRecibos;
    let prevRec; try { prevRec = JSON.parse((payBefore && payBefore.recibos) || '[]'); } catch (_) { prevRec = []; }
    if (!Array.isArray(prevRec)) prevRec = [];
    if (estadoPago === 'Pagado' && payBefore) {
      const target = Math.round((montoCOPRecibido || payBefore.cuotaTotal) || 0);
      const prevSum = prevRec.reduce((a, r) => a + (Math.round(+r.cop) || 0), 0);
      const remanente = target - prevSum;
      if (remanente > 0) prevRec.push({ fecha: fechaRecaudo || hoyStr(), cop: remanente });
      newRecibos = JSON.stringify(prevRec);
    } else if ((estadoPago === 'Pendiente' || estadoPago === 'En Mora') && payBefore) {
      newRecibos = '[]';
    } else {
      newRecibos = (payBefore && payBefore.recibos) || '[]';
    }
    db.prepare('UPDATE payments SET estadoPago=?, fechaRecaudo=?, observaciones=?, montoCOPRecibido=?, montoUSDRecibido=?, partialPaid=?, recibos=?, paidAt=? WHERE id=?')
      .run(estadoPago, fechaRecaudo || null, observaciones || '', montoCOPRecibido || 0, montoUSDRecibido || 0, newPartial, newRecibos, newPaidAt, req.params.id);
    if (payBefore) {
      const label = estadoPago === 'Pagado' ? 'Registraste pago' : estadoPago === 'En Mora' ? 'Marcaste en mora' : 'Revertiste a pendiente';
      logAction.run('pago', label + ': ' + payBefore.nombreCliente + ' cuota #' + payBefore.cuotaN + ' por $' + Math.round(payBefore.cuotaTotal).toLocaleString());
    }

    // Auto-finalización: si se marcó como Pagado, verificar si todas las cuotas regulares están pagadas
    if (estadoPago === 'Pagado') {
      const pay = db.prepare('SELECT prestamoId, cuotaN FROM payments WHERE id = ?').get(req.params.id);
      if (pay) {
        // Si la cuota pagada era la de proximaCuotaExtra → limpiar para que recalculate no la vuelva a aplicar.
        const loanRow = db.prepare('SELECT proximaCuotaExtraN FROM loans WHERE id = ?').get(pay.prestamoId);
        if (loanRow && loanRow.proximaCuotaExtraN === pay.cuotaN) {
          db.prepare('UPDATE loans SET proximaCuotaExtra = 0, proximaCuotaExtraN = 0 WHERE id = ?').run(pay.prestamoId);
        }
        const allPays = db.prepare('SELECT * FROM payments WHERE prestamoId = ?').all(pay.prestamoId);
        // Cuotas regulares = las que NO son abonos a capital (abono = interesPeriodo=0 AND abonoCapital>0)
        const regulares = allPays.filter(p => !(p.interesPeriodo === 0 && p.abonoCapital > 0));
        const todasPagadas = regulares.length > 0 && regulares.every(p => p.estadoPago === 'Pagado');
        if (todasPagadas) {
          db.prepare("UPDATE loans SET estado = 'Finalizado', cuotaFijaPactada = 0 WHERE id = ? AND estado = 'Activo'").run(pay.prestamoId);
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
    // v1.11.4: registrar este parcial como evento de caja en el ledger (con su fecha real de
    // recaudo). La suma de los parciales == cuotaTotal al completar (montoNum <= restante).
    let recibosArr; try { recibosArr = JSON.parse(pay.recibos || '[]'); } catch (_) { recibosArr = []; }
    if (!Array.isArray(recibosArr)) recibosArr = [];
    recibosArr.push({ fecha: fechaPago, cop: montoNum });
    const recibosJSON = JSON.stringify(recibosArr);

    if (completa) {
      // Completa la cuota: marcar Pagado
      const usdAcum = (pay.montoUSDRecibido || 0) + (+montoUSD || 0);
      db.prepare("UPDATE payments SET estadoPago=?, fechaRecaudo=?, observaciones=?, montoCOPRecibido=?, montoUSDRecibido=?, partialPaid=?, recibos=?, paidAt=datetime('now','localtime') WHERE id=?")
        .run('Pagado', fechaPago, obsCombinada, pay.cuotaTotal, Math.round(usdAcum * 100) / 100, pay.cuotaTotal, recibosJSON, req.params.id);
      logAction.run('pago', 'Pago parcial final: ' + pay.nombreCliente + ' cuota #' + pay.cuotaN + ' $' + montoNum.toLocaleString() + ' (completo $' + Math.round(pay.cuotaTotal).toLocaleString() + ')');

      // Si era la cuota con proximaCuotaExtra, limpiarla del loan
      const loanRow = db.prepare('SELECT proximaCuotaExtraN FROM loans WHERE id = ?').get(pay.prestamoId);
      if (loanRow && loanRow.proximaCuotaExtraN === pay.cuotaN) {
        db.prepare('UPDATE loans SET proximaCuotaExtra = 0, proximaCuotaExtraN = 0 WHERE id = ?').run(pay.prestamoId);
      }
      // Auto-finalización del préstamo
      const allPays = db.prepare('SELECT * FROM payments WHERE prestamoId = ?').all(pay.prestamoId);
      const regulares = allPays.filter(p => !(p.interesPeriodo === 0 && p.abonoCapital > 0));
      const todasPagadas = regulares.length > 0 && regulares.every(p => p.estadoPago === 'Pagado');
      if (todasPagadas) {
        db.prepare("UPDATE loans SET estado = 'Finalizado', cuotaFijaPactada = 0 WHERE id = ? AND estado = 'Activo'").run(pay.prestamoId);
      }
    } else {
      // Solo suma al partialPaid, estado permanece
      const copAcum = (pay.montoCOPRecibido || 0) + montoNum;
      const usdAcum = (pay.montoUSDRecibido || 0) + (+montoUSD || 0);
      db.prepare('UPDATE payments SET partialPaid=?, observaciones=?, montoCOPRecibido=?, montoUSDRecibido=?, recibos=? WHERE id=?')
        .run(nuevoPartial, obsCombinada, copAcum, Math.round(usdAcum * 100) / 100, recibosJSON, req.params.id);
      const faltan = pay.cuotaTotal - nuevoPartial;
      logAction.run('pago', 'Pago parcial: ' + pay.nombreCliente + ' cuota #' + pay.cuotaN + ' $' + montoNum.toLocaleString() + ' (faltan $' + Math.round(faltan).toLocaleString() + ')');
    }
    res.json({ ok: true, completa, partialPaid: nuevoPartial, restante: Math.max(0, pay.cuotaTotal - nuevoPartial) });
  });

  // ── API: Abono a Capital ──────────────────────────────────────────────────
  // ATOMICO (v1.9.0): toda validacion + buildSchedule(FixedPMT) ocurre ANTES de cualquier
  // escritura. Si algo falla, se retorna 400 sin tocar la BD. Las escrituras se aplican
  // dentro de una transaccion SQLite (all-or-nothing).
  app.post('/api/loans/:id/abono', (req, res) => {
    const { monto, fecha, observaciones, montoUSD, liquidar, recalcMode, recalcValor } = req.body;
    const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(req.params.id);
    if (!loan) return res.status(404).json({ error: 'No encontrado' });

    // ── FASE 1: LECTURA + VALIDACION (sin escrituras) ────────────────────────
    const allPays = db.prepare('SELECT * FROM payments WHERE prestamoId = ? ORDER BY cuotaN').all(req.params.id);

    const originalCOP = loan.moneda === 'USD' ? Math.round(loan.montoOrigen * loan.trmAcordada) : Math.round(loan.montoOrigen);
    const todoCapPagado = allPays.filter(p => p.estadoPago === 'Pagado').reduce((s, p) => s + p.abonoCapital, 0);
    const saldoReal = Math.max(0, originalCOP - todoCapPagado);
    const montoNum = +monto || 0;
    if (montoNum <= 0) return res.status(400).json({ error: 'El monto del abono debe ser mayor a 0' });
    const nuevoSaldo = Math.round(saldoReal - montoNum);
    if (nuevoSaldo < 0) return res.status(400).json({ error: 'El abono supera el saldo actual' });

    // Un registro de abono se identifica por interesPeriodo=0 AND abonoCapital>0
    const regularConsumed = allPays.filter(p =>
      (p.estadoPago === 'Pagado' || p.estadoPago === 'En Mora') &&
      !(p.interesPeriodo === 0 && p.abonoCapital > 0)
    ).length;
    const maxExistingN = allPays.reduce((max, p) => Math.max(max, p.cuotaN), 0);

    const indefinido = loan.modalidad === 'Intereses';
    const esCapInt = loan.modalidad === 'Capital + Intereses';
    const remainingDefault = indefinido ? 3 : Math.max(0, (loan.plazoMeses || 12) - regularConsumed);
    const nextRegularN = regularConsumed + 1;
    const updatedLoan = Object.assign({}, loan, { montoCOP: nuevoSaldo });

    // Pre-computar TODO el cronograma nuevo (si aplica) ANTES de tocar BD.
    let nuevasCuotas = [];
    let nuevoPlazoMeses = null;     // null = no actualizar plazoMeses
    let nuevaCuotaFija = null;      // null = no actualizar; 0 = limpiar; >0 = persistir
    let logRecalc = '';

    if (nuevoSaldo > 0) {
      if (esCapInt && recalcMode === 'modificarPlazo') {
        const nuevoN = parseInt(recalcValor, 10);
        if (!nuevoN || nuevoN < 1) return res.status(400).json({ error: 'Numero de cuotas invalido. Debe ser >= 1.' });
        nuevasCuotas = buildSchedule(updatedLoan, nextRegularN, nuevoSaldo, nuevoN);
        nuevoPlazoMeses = regularConsumed + nuevoN;
        nuevaCuotaFija = 0; // limpiar (el usuario cambio de opinion)
        logRecalc = ' — plazo ajustado a ' + nuevoN + ' cuota' + (nuevoN > 1 ? 's' : '') + ' restantes (total: ' + nuevoPlazoMeses + ')';
      } else if (esCapInt && recalcMode === 'fijarCuota') {
        const cuotaDeseada = +recalcValor || 0;
        if (cuotaDeseada <= 0) return res.status(400).json({ error: 'Cuota invalida. Debe ser > 0.' });
        const r = tasaPeriodo((loan.tasaMensual || 0) / 100, loan.frecuencia || 'Mensual');
        const interesPrimerPeriodo = nuevoSaldo * r;
        if (cuotaDeseada <= interesPrimerPeriodo) {
          return res.status(400).json({
            error: 'La cuota debe ser mayor a $' + Math.round(interesPrimerPeriodo).toLocaleString('es-CO') +
              ' (intereses del primer periodo). Con $' + Math.round(cuotaDeseada).toLocaleString('es-CO') +
              ' nunca se saldaria la deuda.'
          });
        }
        try {
          nuevasCuotas = buildScheduleFixedPMT(updatedLoan, nextRegularN, nuevoSaldo, cuotaDeseada);
        } catch (e) {
          return res.status(400).json({ error: e.message });
        }
        nuevoPlazoMeses = regularConsumed + nuevasCuotas.length;
        nuevaCuotaFija = Math.round(cuotaDeseada);
        logRecalc = ' — cuota fija $' + Math.round(cuotaDeseada).toLocaleString('es-CO') + ' x ' + nuevasCuotas.length + ' cuotas (total: ' + nuevoPlazoMeses + ')';
      } else {
        // Opcion 1 (default): mantener plazo, baja la cuota
        if (loan.cuotaFijaPactada && +loan.cuotaFijaPactada > 0) nuevaCuotaFija = 0; // limpia (cambio de opinion)
        if (remainingDefault > 0) {
          nuevasCuotas = buildSchedule(updatedLoan, nextRegularN, nuevoSaldo, remainingDefault);
        }
      }
    }

    // ── FASE 2: ESCRITURA (transaccion atomica) ──────────────────────────────
    const abonoId = req.params.id + '-ab-' + Date.now();
    const fechaAbono = fecha || hoyStr();
    const aplicar = db.transaction(() => {
      // Solo borrar cuotas PENDIENTES; las cuotas En Mora permanecen intactas (deuda independiente)
      db.prepare("DELETE FROM payments WHERE prestamoId = ? AND estadoPago = 'Pendiente'").run(req.params.id);

      // Para Prestamo: actualizar cuotaTotal de cuotas En Mora al nuevo saldo
      // v1.10.0 fix housekeeping: tambien actualizar saldoInicial y abonoCapital para
      // que la cuota refleje correctamente el estado tras el abono. Sin este fix los
      // valores quedaban con el monto original e inflaban marginalmente el KPI de
      // "capital recuperado" cuando se pagaba la cuota en mora.
      if (loan.modalidad === 'Prestamo') {
        const moraRegulares = allPays.filter(p => p.estadoPago === 'En Mora' && !(p.interesPeriodo === 0 && p.abonoCapital > 0));
        const ns = Math.max(0, nuevoSaldo);
        moraRegulares.forEach(p => {
          db.prepare('UPDATE payments SET saldoInicial = ?, abonoCapital = ?, cuotaTotal = ?, saldoFinal = ? WHERE id = ?')
            .run(ns, ns, ns, 0, p.id);
        });
      }
      // v1.10.0 — Pago Unico: igual que Prestamo pero conservando la ganancia pactada
      // (cuotaTotal = capital restante + ganancia; abonoCapital solo el capital)
      if (loan.modalidad === 'Pago Unico') {
        const gPU2 = Math.round(+loan.gananciaFija || 0);
        const moraRegularesPU = allPays.filter(p => p.estadoPago === 'En Mora' && !(p.interesPeriodo === 0 && p.abonoCapital > 0));
        const nsPU = Math.max(0, nuevoSaldo);
        moraRegularesPU.forEach(p => {
          db.prepare('UPDATE payments SET saldoInicial = ?, abonoCapital = ?, cuotaTotal = ?, saldoFinal = ? WHERE id = ?')
            .run(nsPU, nsPU, nsPU + gPU2, 0, p.id);
        });
      }

      // Registrar el abono como cuota especial
      insPayment.run({
        id: abonoId,
        prestamoId: req.params.id,
        nombreCliente: loan.nombre,
        cuotaN: maxExistingN + 1,
        fechaPago: fechaAbono,
        saldoInicial: saldoReal,
        interesPeriodo: 0,
        abonoCapital: Math.round(montoNum),
        cuotaTotal: Math.round(montoNum),
        saldoFinal: Math.max(0, nuevoSaldo),
        estadoPago: 'Pagado',
        fechaRecaudo: fechaAbono,
        observaciones: observaciones || 'Abono a capital',
        montoCOPRecibido: Math.round(montoNum),
        montoUSDRecibido: montoUSD ? Math.round(montoUSD * 100) / 100 : 0,
        partialPaid: 0,
        extraConsolidado: 0
      });
      db.prepare("UPDATE payments SET paidAt = datetime('now','localtime') WHERE id = ?").run(abonoId);

      if (nuevoSaldo <= 0) {
        // Capital saldado
        if (liquidar) {
          db.prepare("UPDATE payments SET estadoPago = 'Pagado', fechaRecaudo = ?, paidAt = datetime('now','localtime') WHERE prestamoId = ? AND estadoPago = 'En Mora'").run(fechaAbono, req.params.id);
          db.prepare("UPDATE loans SET montoCOP = 0, estado = 'Finalizado', cuotaFijaPactada = 0 WHERE id = ?").run(req.params.id);
        } else {
          const moraRestante = db.prepare("SELECT COUNT(*) as c FROM payments WHERE prestamoId = ? AND estadoPago = 'En Mora'").get(req.params.id);
          if (moraRestante.c === 0) {
            db.prepare("UPDATE loans SET montoCOP = 0, estado = 'Finalizado', cuotaFijaPactada = 0 WHERE id = ?").run(req.params.id);
          } else {
            db.prepare("UPDATE loans SET montoCOP = 0 WHERE id = ?").run(req.params.id);
          }
        }
      } else {
        db.prepare('UPDATE loans SET montoCOP = ? WHERE id = ?').run(nuevoSaldo, req.params.id);
        if (nuevasCuotas.length > 0) insertSchedule(nuevasCuotas);
        if (nuevoPlazoMeses !== null) {
          db.prepare('UPDATE loans SET plazoMeses = ? WHERE id = ?').run(nuevoPlazoMeses, req.params.id);
        }
        if (nuevaCuotaFija !== null) {
          db.prepare('UPDATE loans SET cuotaFijaPactada = ? WHERE id = ?').run(nuevaCuotaFija, req.params.id);
        }
      }
    });
    aplicar();

    let logBase = 'Registraste abono de $' + Math.round(montoNum).toLocaleString() + ' a ' + loan.nombre + (nuevoSaldo <= 0 ? ' (SALDADO)' : ' — saldo: $' + Math.round(nuevoSaldo).toLocaleString());
    if (recalcMode === 'modificarPlazo' || recalcMode === 'fijarCuota') {
      logBase += ' [recalc: ' + recalcMode + ']';
    }
    logAction.run('abono', logBase);
    res.json({ ok: true, nuevoSaldo: Math.max(0, nuevoSaldo) });
  });

  // ── API: Reestructurar Prestamo (sin abono) ──────────────────────────────
  // Permite recalcular el cronograma de cuotas FUTURAS sin necesidad de hacer un abono.
  // SOLO para modalidad Capital + Intereses. Cuotas Pagadas y En Mora NO se tocan.
  // Atomico: valida + computa todo antes de cualquier escritura.
  app.post('/api/loans/:id/reestructurar', (req, res) => {
    const { recalcMode, recalcValor } = req.body;
    const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(req.params.id);
    if (!loan) return res.status(404).json({ error: 'No encontrado' });
    if (loan.estado !== 'Activo') return res.status(400).json({ error: 'Solo se pueden reestructurar prestamos activos' });
    if (loan.modalidad !== 'Capital + Intereses') return res.status(400).json({ error: 'La reestructuracion solo aplica para prestamos de Capital + Intereses' });
    if (recalcMode !== 'modificarPlazo' && recalcMode !== 'fijarCuota') {
      return res.status(400).json({ error: 'Modo de recalculo invalido. Debe ser "modificarPlazo" o "fijarCuota".' });
    }

    // ── FASE 1: LECTURA + VALIDACION (sin escrituras) ────────────────────────
    const allPays = db.prepare('SELECT * FROM payments WHERE prestamoId = ? ORDER BY cuotaN').all(req.params.id);

    const originalCOP = loan.moneda === 'USD' ? Math.round(loan.montoOrigen * loan.trmAcordada) : Math.round(loan.montoOrigen);
    const todoCapPagado = allPays.filter(p => p.estadoPago === 'Pagado').reduce((s, p) => s + p.abonoCapital, 0);
    const saldoReal = Math.max(0, originalCOP - todoCapPagado);
    if (saldoReal <= 0) return res.status(400).json({ error: 'El prestamo no tiene saldo de capital pendiente para reestructurar' });

    const regularConsumed = allPays.filter(p =>
      (p.estadoPago === 'Pagado' || p.estadoPago === 'En Mora') &&
      !(p.interesPeriodo === 0 && p.abonoCapital > 0)
    ).length;
    const nextRegularN = regularConsumed + 1;
    const updatedLoan = Object.assign({}, loan, { montoCOP: saldoReal });

    let nuevasCuotas = [];
    let nuevoPlazoMeses;
    let nuevaCuotaFija; // 0 = limpiar, >0 = persistir
    let logRecalc;

    if (recalcMode === 'modificarPlazo') {
      const nuevoN = parseInt(recalcValor, 10);
      if (!nuevoN || nuevoN < 1) return res.status(400).json({ error: 'Numero de cuotas invalido. Debe ser >= 1.' });
      nuevasCuotas = buildSchedule(updatedLoan, nextRegularN, saldoReal, nuevoN);
      nuevoPlazoMeses = regularConsumed + nuevoN;
      nuevaCuotaFija = 0;
      logRecalc = ' — plazo ajustado a ' + nuevoN + ' cuota' + (nuevoN > 1 ? 's' : '') + ' restantes (total: ' + nuevoPlazoMeses + ')';
    } else {
      // fijarCuota
      const cuotaDeseada = +recalcValor || 0;
      if (cuotaDeseada <= 0) return res.status(400).json({ error: 'Cuota invalida. Debe ser > 0.' });
      const r = tasaPeriodo((loan.tasaMensual || 0) / 100, loan.frecuencia || 'Mensual');
      const interesPrimerPeriodo = saldoReal * r;
      if (cuotaDeseada <= interesPrimerPeriodo) {
        return res.status(400).json({
          error: 'La cuota debe ser mayor a $' + Math.round(interesPrimerPeriodo).toLocaleString('es-CO') +
            ' (intereses del primer periodo). Con $' + Math.round(cuotaDeseada).toLocaleString('es-CO') +
            ' nunca se saldaria la deuda.'
        });
      }
      try {
        nuevasCuotas = buildScheduleFixedPMT(updatedLoan, nextRegularN, saldoReal, cuotaDeseada);
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
      nuevoPlazoMeses = regularConsumed + nuevasCuotas.length;
      nuevaCuotaFija = Math.round(cuotaDeseada);
      logRecalc = ' — cuota fija $' + Math.round(cuotaDeseada).toLocaleString('es-CO') + ' x ' + nuevasCuotas.length + ' cuotas (total: ' + nuevoPlazoMeses + ')';
    }

    // ── FASE 2: ESCRITURA (transaccion atomica) ──────────────────────────────
    const aplicar = db.transaction(() => {
      // Borrar cuotas Pendientes (regulares, no abonos). Mora y Pagadas intactas.
      db.prepare("DELETE FROM payments WHERE prestamoId = ? AND estadoPago = 'Pendiente' AND id NOT LIKE '%-ab-%'").run(req.params.id);
      insertSchedule(nuevasCuotas);
      db.prepare('UPDATE loans SET plazoMeses = ?, cuotaFijaPactada = ? WHERE id = ?').run(nuevoPlazoMeses, nuevaCuotaFija, req.params.id);
    });
    aplicar();

    logAction.run('reestructuracion', 'Reestructuraste ' + loan.nombre + logRecalc);
    res.json({ ok: true, nuevasCuotas: nuevasCuotas.length, nuevoPlazoMeses, cuotaFijaPactada: nuevaCuotaFija });
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
    db.prepare("UPDATE loans SET estado = 'Cancelado', capitalPerdido = ?, interesesPerdidos = ?, montoCOP = 0, cuotaFijaPactada = 0 WHERE id = ?")
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
      primera.extraConsolidado = extra; // Persistir en la cuota tambien (referencia)
      const obsExtra = 'Cuota consolidada por cambio de fecha de pago. Incluye: '
        + (montoMoraConsolidada > 0 ? 'intereses en mora previos $' + Math.round(montoMoraConsolidada).toLocaleString('es-CO') : '')
        + (montoMoraConsolidada > 0 && interesProrrateado > 0 ? ' + ' : '')
        + (interesProrrateado > 0 ? 'prorrateo ' + diasExtra + ' dias $' + Math.round(interesProrrateado).toLocaleString('es-CO') : '');
      primera.observaciones = obsExtra;
      // PERSISTIR el extra en el LOAN: sobrevive a cualquier regeneracion del cronograma.
      // proximaCuotaExtraN = la cuotaN a la que se debe aplicar el extra al regenerar.
      db.prepare('UPDATE loans SET proximaCuotaExtra = ?, proximaCuotaExtraN = ? WHERE id = ?')
        .run(extra, primera.cuotaN, req.params.id);
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

  // ── API: Modulo "Mis Deudas" (registro manual, sin intereses) ───────────────

  // Lista todas las deudas con su saldo_pendiente actual (Activas primero, luego por fecha desc)
  app.get('/api/debts', (_req, res) => {
    // QA5: agrega total_cargos / total_abonos por deuda para que la barra de progreso del frontend
    // tenga base dinamica (monto_original + cargos) sin pedir el detalle de cada una.
    res.json(db.prepare(`
      SELECT d.*,
        COALESCE((SELECT SUM(CASE WHEN p.tipo = 'cargo' THEN p.monto_pagado ELSE 0 END) FROM pagos_deudas p WHERE p.deuda_id = d.id), 0) AS total_cargos,
        COALESCE((SELECT SUM(CASE WHEN p.tipo = 'cargo' THEN 0 ELSE p.monto_pagado END) FROM pagos_deudas p WHERE p.deuda_id = d.id), 0) AS total_abonos
      FROM mis_deudas d
      ORDER BY d.estado ASC, d.fecha_creacion DESC, d.id DESC
    `).all());
  });

  // Detalle de una deuda + su historial de pagos (ledger pagos_deudas)
  app.get('/api/debts/:id', (req, res) => {
    const deuda = db.prepare('SELECT * FROM mis_deudas WHERE id = ?').get(req.params.id);
    if (!deuda) return res.status(404).json({ error: 'Deuda no encontrada' });
    const pagos = db.prepare('SELECT * FROM pagos_deudas WHERE deuda_id = ? ORDER BY fecha_pago DESC, id DESC').all(req.params.id);
    res.json({ ...deuda, pagos });
  });

  // Crea una deuda. saldo_pendiente arranca igual al monto_original; estado 'Activa'.
  app.post('/api/debts', (req, res) => {
    const titulo = (req.body.titulo || '').trim();
    const acreedor = (req.body.acreedor || '').trim();
    const concepto = (req.body.concepto || '').trim();
    const monto = Math.round(+req.body.monto_original || 0);
    if (!titulo) return res.status(400).json({ error: 'El titulo es obligatorio' });
    if (!acreedor) return res.status(400).json({ error: 'El acreedor es obligatorio' });
    if (monto <= 0) return res.status(400).json({ error: 'El monto original debe ser mayor a 0' });
    // QA3: fecha_creacion editable. Si viene en el payload se usa; si no, el INSERT omite la
    // columna y queda el DEFAULT (datetime('now','localtime')).
    const fecha = (req.body.fecha_creacion || '').toString().slice(0, 10);
    const id = genId();
    if (fecha) {
      db.prepare(`INSERT INTO mis_deudas(id, titulo, acreedor, concepto, monto_original, saldo_pendiente, estado, fecha_creacion)
                  VALUES (?, ?, ?, ?, ?, ?, 'Activa', ?)`).run(id, titulo, acreedor, concepto, monto, monto, fecha);
    } else {
      db.prepare(`INSERT INTO mis_deudas(id, titulo, acreedor, concepto, monto_original, saldo_pendiente, estado)
                  VALUES (?, ?, ?, ?, ?, ?, 'Activa')`).run(id, titulo, acreedor, concepto, monto, monto);
    }
    logAction.run('deuda', 'Nueva deuda "' + titulo + '" con ' + acreedor + ' por $' + monto.toLocaleString('es-CO'));
    res.json(db.prepare('SELECT * FROM mis_deudas WHERE id = ?').get(id));
  });

  // Registra un abono manual: inserta en pagos_deudas y resta saldo_pendiente.
  // Si el saldo llega a 0 -> estado 'Pagada'. ATOMICO: valida y computa TODO antes
  // de la primera escritura; las mutaciones van dentro de db.transaction (all-or-nothing).
  app.post('/api/debts/:id/pay', (req, res) => {
    // FASE 1 — lectura + validacion (sin escrituras)
    const deuda = db.prepare('SELECT * FROM mis_deudas WHERE id = ?').get(req.params.id);
    if (!deuda) return res.status(404).json({ error: 'Deuda no encontrada' });
    // QA5 "Cuenta Rotativa": 'abono' reduce la deuda, 'cargo' la aumenta (sin tope).
    const tipo = req.body.tipo === 'cargo' ? 'cargo' : 'abono';
    const monto = Math.round(+req.body.monto_pagado || 0);
    if (monto <= 0) return res.status(400).json({ error: 'El monto del movimiento debe ser mayor a 0' });
    // Solo el abono tiene tope (no se puede abonar mas que el saldo). El cargo NO tiene limite,
    // y puede reactivar una deuda 'Pagada'.
    if (tipo === 'abono' && monto > deuda.saldo_pendiente) {
      return res.status(400).json({ error: 'El abono ($' + monto.toLocaleString('es-CO') + ') supera el saldo pendiente ($' + Math.round(deuda.saldo_pendiente).toLocaleString('es-CO') + ')' });
    }
    const fecha = (req.body.fecha_pago || hoyStr()).toString().slice(0, 10);
    const notas = (req.body.notas || '').trim();
    const pagoId = genId();

    // FASE 2 — escrituras atomicas (all-or-nothing). El saldo se RECALCULA desde el ledger:
    // saldo = monto_original + SUM(cargos) - SUM(abonos). Estado vuelve a 'Activa' si saldo > 0.
    const aplicar = db.transaction(() => {
      db.prepare('INSERT INTO pagos_deudas(id, deuda_id, monto_pagado, fecha_pago, notas, tipo) VALUES (?, ?, ?, ?, ?, ?)')
        .run(pagoId, deuda.id, monto, fecha, notas, tipo);
      const agg = db.prepare("SELECT COALESCE(SUM(CASE WHEN tipo = 'cargo' THEN monto_pagado ELSE 0 END), 0) AS cargos, COALESCE(SUM(CASE WHEN tipo = 'cargo' THEN 0 ELSE monto_pagado END), 0) AS abonos FROM pagos_deudas WHERE deuda_id = ?").get(deuda.id);
      const saldo = Math.round((deuda.monto_original + agg.cargos - agg.abonos) * 100) / 100;
      const estado = saldo <= 0 ? 'Pagada' : 'Activa';
      db.prepare('UPDATE mis_deudas SET saldo_pendiente = ?, estado = ? WHERE id = ?').run(saldo, estado, deuda.id);
    });
    aplicar();

    const actualizada = db.prepare('SELECT * FROM mis_deudas WHERE id = ?').get(deuda.id);
    logAction.run('deuda', (tipo === 'cargo' ? 'Cargo' : 'Abono') + ' a deuda con ' + deuda.acreedor + ': $' + monto.toLocaleString('es-CO')
      + ' — saldo: $' + Math.round(actualizada.saldo_pendiente).toLocaleString('es-CO') + (actualizada.estado === 'Pagada' ? ' (PAGADA)' : ''));

    res.json({ ok: true, pago: db.prepare('SELECT * FROM pagos_deudas WHERE id = ?').get(pagoId), deuda: actualizada });
  });

  // Edita una deuda (acreedor, concepto, monto_original). Recalcula saldo y estado.
  // Validacion: el nuevo monto_original NO puede ser menor a lo ya pagado en el ledger.
  app.put('/api/debts/:id', (req, res) => {
    const deuda = db.prepare('SELECT * FROM mis_deudas WHERE id = ?').get(req.params.id);
    if (!deuda) return res.status(404).json({ error: 'Deuda no encontrada' });
    const titulo = (req.body.titulo || '').trim();
    const acreedor = (req.body.acreedor || '').trim();
    const concepto = (req.body.concepto || '').trim();
    const monto = Math.round(+req.body.monto_original || 0);
    if (!titulo) return res.status(400).json({ error: 'El titulo es obligatorio' });
    if (!acreedor) return res.status(400).json({ error: 'El acreedor es obligatorio' });
    if (monto <= 0) return res.status(400).json({ error: 'El monto original debe ser mayor a 0' });
    // QA5: saldo = monto_original + SUM(cargos) - SUM(abonos). La proteccion impide bajar el monto
    // por debajo de lo ya abonado NETO (abonos - cargos), que dejaria el saldo negativo.
    const agg = db.prepare("SELECT COALESCE(SUM(CASE WHEN tipo = 'cargo' THEN monto_pagado ELSE 0 END), 0) AS cargos, COALESCE(SUM(CASE WHEN tipo = 'cargo' THEN 0 ELSE monto_pagado END), 0) AS abonos FROM pagos_deudas WHERE deuda_id = ?").get(req.params.id);
    const netAbonado = Math.round(agg.abonos - agg.cargos);
    if (monto < netAbonado) {
      return res.status(400).json({ error: 'El monto ($' + monto.toLocaleString('es-CO') + ') no puede ser menor a lo ya abonado neto ($' + netAbonado.toLocaleString('es-CO') + ')' });
    }
    const nuevoSaldo = Math.round((monto + agg.cargos - agg.abonos) * 100) / 100;
    const nuevoEstado = nuevoSaldo <= 0 ? 'Pagada' : 'Activa';
    // QA3: fecha_creacion editable; si el payload no la trae, se conserva la existente.
    const fecha = (req.body.fecha_creacion || '').toString().slice(0, 10) || deuda.fecha_creacion;
    db.prepare('UPDATE mis_deudas SET titulo = ?, acreedor = ?, concepto = ?, monto_original = ?, saldo_pendiente = ?, estado = ?, fecha_creacion = ? WHERE id = ?')
      .run(titulo, acreedor, concepto, monto, nuevoSaldo, nuevoEstado, fecha, req.params.id);
    logAction.run('deuda', 'Editaste la deuda "' + titulo + '" con ' + acreedor + ' (monto $' + monto.toLocaleString('es-CO') + ', saldo $' + nuevoSaldo.toLocaleString('es-CO') + ')');
    res.json(db.prepare('SELECT * FROM mis_deudas WHERE id = ?').get(req.params.id));
  });

  // Elimina una deuda y su ledger. La FK tiene ON DELETE CASCADE; ademas borramos el
  // ledger explicitamente (robustez) dentro de una transaccion all-or-nothing.
  app.delete('/api/debts/:id', (req, res) => {
    const deuda = db.prepare('SELECT * FROM mis_deudas WHERE id = ?').get(req.params.id);
    if (!deuda) return res.status(404).json({ error: 'Deuda no encontrada' });
    const borrar = db.transaction(() => {
      db.prepare('DELETE FROM pagos_deudas WHERE deuda_id = ?').run(req.params.id);
      db.prepare('DELETE FROM mis_deudas WHERE id = ?').run(req.params.id);
    });
    borrar();
    logAction.run('deuda', 'Eliminaste la deuda con ' + deuda.acreedor + ' ($' + Math.round(deuda.monto_original).toLocaleString('es-CO') + ')');
    res.json({ ok: true });
  });

  return app;
};
