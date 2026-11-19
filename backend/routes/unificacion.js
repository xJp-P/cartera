// backend/routes/unificacion.js — UNIFICAR los prestamos activos de un deudor en uno nuevo.
//
// POST /api/unificaciones
//   body: { loanIds, fecha, corridos {id: bool}, ganancias {id: bool}, destino, cuotasReparto,
//           nuevo: { modalidad, tasaMensual, plazo, frecuencia, primerPago, primerPeriodo },
//           esperado: { capital, interes } }
//
// Unificar = liquidar cada prestamo, pero en vez de entrar dinero entra un prestamo NUEVO. NO
// entra ni sale caja (`afectaCaja: false`): nada se marca cobrado que no se haya cobrado, y nada
// de lo cobrado se pierde.
//   - Cada prestamo viejo: sus cuotas Pagadas quedan intactas; una cuota sin saldar que ya traia
//     un abono se CIERRA por lo abonado (conserva su ledger de caja); el resto de sus cuotas sin
//     saldar se borra (esa deuda pasa al nuevo). Queda 'Finalizado' con `unificadoEn` (el nuevo),
//     `capitalTrasladado` e `interesTrasladado` (o, si se condonaron, `interesesCondonados`).
//   - El nuevo: capital = lo que se debia de capital (+ los intereses si se suman al capital),
//     con `unificaDe`, `capitalRefinanciado` (ese capital ya estaba prestado: no se cuenta dos
//     veces) e `interesCapitalizado`; y los intereses que se cobran en cuotas, como una CARGA que
//     el motor reparte (`cargaTrasladada` + `cargaCuotas`).
//   - El calculo lo rehace el server desde la BD (core/unificacion.js, espejo del modal); si no
//     coincide con lo que el usuario vio (`esperado`), 409: algo cambio en el camino.
//   - UNA entrada de deshacer con el snapshot de TODOS los agregados (scope: el nuevo). Deshacer
//     restaura los viejos tal cual y borra el nuevo; mientras el nuevo tenga movimientos
//     posteriores, el LIFO obliga a deshacerlos primero.

const express = require('express');
const { planUnificacion } = require('../core/unificacion');
const { primerPagoRegular } = require('../core/engine');

const MESES_U = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const fechaLegible = iso => +iso.slice(8, 10) + ' de ' + MESES_U[+iso.slice(5, 7) - 1] + ' de ' + iso.slice(0, 4);
const regularU = p => String(p.id).indexOf('-ab-') === -1 && String(p.id).indexOf('-ct-') === -1;
const porFecha = (a, b) => (a.fechaPago < b.fechaPago ? -1 : a.fechaPago > b.fechaPago ? 1 : a.cuotaN - b.cuotaN);

module.exports = function crearRutasUnificacion(ctx) {
  const {
    db, mutacionAtomica, snapshotUnif, insertSchedule, buildSchedule, resolverPrimerPago,
    cuotaCerradaPorLoAbonado, MODALIDAD_DIARIA, ClientError, hoyStr,
  } = ctx;
  const router = express.Router();

  router.post('/api/unificaciones', (req, res) => {
    const body = req.body || {};
    const ids = Array.isArray(body.loanIds) ? body.loanIds.map(String) : [];
    const unicos = ids.filter((id, i) => ids.indexOf(id) === i);
    if (unicos.length < 2) return res.status(400).json({ error: 'Para unificar hacen falta al menos dos préstamos distintos.' });
    const loans = unicos.map(id => db.prepare('SELECT * FROM loans WHERE id = ?').get(id));
    if (loans.some(l => !l)) return res.status(404).json({ error: 'Alguno de los préstamos no existe.' });
    const nuevoId = Date.now().toString() + Math.random().toString(36).slice(2, 6);

    return mutacionAtomica(req, res, {
      accion: 'unificacion', endpoint: 'POST /api/unificaciones', scopeTipo: 'loan', scopeId: nuevoId,
      snapshot: () => snapshotUnif(nuevoId, unicos),
    }, () => {
      // ── FASE 1: lectura + validacion + computo, sin escrituras ─────────────────
      const cache = {};
      const paysDe = id => (cache[id] = cache[id] || db.prepare('SELECT * FROM payments WHERE prestamoId = ?').all(id));
      const plan = planUnificacion(loans, paysDe, hoyStr(), body);
      const n = body.nuevo || {};
      // Los datos del deudor salen del prestamo mas reciente.
      const base = loans.slice().sort((a, b) => String(b.fechaInicio).localeCompare(String(a.fechaInicio)))[0];
      const esUSD = (base.moneda || 'COP') === 'USD';
      // En dolares el capital del nuevo se expresa en dolares a la TRM de cada prestamo viejo, y
      // la TRM del nuevo se fija para que round(montoOrigen * trm) devuelva EXACTO los pesos.
      let montoOrigen = plan.monto, trm = +base.trmAcordada || 0;
      if (esUSD) {
        const usd = plan.traslados.reduce((s, t) => {
          const cop = t.capital + (plan.destino === 'capital' ? t.interes : 0);
          return s + cop / (+t.loan.trmAcordada || 1);
        }, 0);
        montoOrigen = Math.round(usd * 100) / 100;
        trm = montoOrigen > 0 ? plan.monto / montoOrigen : trm;
      }
      const nuevo = {
        id: nuevoId, nombre: base.nombre, cedula: base.cedula || '', telefono: base.telefono || '',
        moneda: base.moneda || 'COP', montoOrigen: montoOrigen, trmAcordada: trm, montoCOP: plan.monto,
        tasaMensual: plan.tasa, plazoMeses: plan.modalidad === 'Capital + Intereses' ? plan.plazo : 0,
        modalidad: plan.modalidad, fechaInicio: plan.fecha, diaPago: +plan.fecha.slice(8, 10), estado: 'Activo',
        notas: 'Unificación de ' + loans.length + ' préstamos',
        frecuencia: plan.frecuencia, fechaDevolucion: '', comprasUSD: '', gananciaFija: 0,
        fechaUltimoCorte: null, interesAcumuladoPend: 0,
        fechaBaseCronograma: null, periodoIrregularN: null, periodoIrregularDesde: null, periodoIrregularMora: 0,
        fechaInicioIntereses: plan.fecha,
        unificaDe: JSON.stringify(unicos), capitalRefinanciado: plan.capital, interesCapitalizado: plan.capitalizado,
        cargaTrasladada: plan.carga, cargaCuotas: plan.K,
      };
      let schedule = [];
      if (plan.diario) {
        nuevo.fechaUltimoCorte = plan.fecha;
      } else {
        const pp = resolverPrimerPago(nuevo, n.primerPago || primerPagoRegular(plan.fecha, plan.frecuencia), n.primerPeriodo);
        nuevo.diaPago = pp.diaPago;
        nuevo.fechaBaseCronograma = pp.fechaBaseCronograma;
        nuevo.periodoIrregularN = pp.periodoIrregularN;
        nuevo.periodoIrregularDesde = pp.periodoIrregularDesde;
        nuevo.periodoIrregularMora = pp.periodoIrregularMora;
        nuevo.fechaInicioIntereses = pp.fechaInicioIntereses;
        schedule = plan.modalidad === 'Capital + Intereses' ? buildSchedule(nuevo, 1, plan.monto, plan.plazo) : buildSchedule(nuevo);
      }
      if (!plan.diario && !schedule.length) throw new ClientError('El préstamo nuevo no generó cuotas.');

      const condonar = plan.destino === 'condonar';
      const fmtP = v => '$' + Math.round(v).toLocaleString('es-CO');
      const destinoTxt = plan.interes <= 0 ? '' : ({
        repartir: ' + intereses ' + fmtP(plan.interes) + ' repartidos en ' + plan.K + ' cuotas',
        primera: ' + intereses ' + fmtP(plan.interes) + ' en la primera cuota',
        capital: ' (incluye ' + fmtP(plan.interes) + ' de intereses sumados al capital)',
        condonar: '; se condonaron ' + fmtP(plan.interes) + ' de intereses',
      })[plan.destino];
      return {
        afectaCaja: false,
        // Con los intereses sumados al capital, el capital del nuevo es `plan.monto` (lo que se debia
        // de capital + esos intereses): decir "capital $<lo de antes> (incluye...)" lo contradecia.
        descripcion: 'Unificaste ' + loans.length + ' préstamos de ' + base.nombre + ' en uno nuevo del ' + fechaLegible(plan.fecha) + ': capital ' +
          fmtP(plan.destino === 'capital' ? plan.monto : plan.capital) + destinoTxt,
        payload: { ok: true, nuevoId: nuevoId, capital: plan.capital, interes: plan.interes, destino: plan.destino, cuotas: schedule.length },
        // ── FASE 2: escrituras (dentro de la transaccion de mutacionAtomica) ────────
        aplicar: () => {
          const cerrar = db.prepare("UPDATE payments SET estadoPago=@estadoPago, interesPeriodo=@interesPeriodo, abonoCapital=@abonoCapital, " +
            "cuotaTotal=@cuotaTotal, saldoFinal=@saldoFinal, fechaRecaudo=@fechaRecaudo, observaciones=@observaciones, paidAt=datetime('now','localtime') WHERE id=@id");
          const borrar = db.prepare('DELETE FROM payments WHERE id = ?');
          plan.traslados.forEach(t => {
            let restoI = t.aInteres;
            paysDe(t.loan.id).filter(p => regularU(p) && p.estadoPago !== 'Pagado').sort(porFecha).forEach(p => {
              if ((+p.partialPaid || 0) > 0) {
                const i = Math.min(restoI, Math.round(+p.partialPaid));
                restoI -= i;
                cerrar.run(Object.assign({ id: p.id }, cuotaCerradaPorLoAbonado(p, i,
                  'Unificación del ' + fechaLegible(plan.fecha) + ': se cerró por lo abonado; el resto pasó al préstamo nuevo')));
              } else {
                borrar.run(p.id);
              }
            });
            db.prepare("UPDATE loans SET estado='Finalizado', unificadoEn=?, capitalTrasladado=?, interesTrasladado=?, " +
              'interesesCondonados=COALESCE(interesesCondonados,0)+?, montoCOP=0, cuotaFijaPactada=0, interesAcumuladoPend=0, ' +
              'fechaUltimoCorte=CASE WHEN modalidad=? THEN ? ELSE fechaUltimoCorte END WHERE id=?')
              .run(nuevoId, t.capital, condonar ? 0 : t.interes, condonar ? t.interes : 0, MODALIDAD_DIARIA, plan.fecha, t.loan.id);
          });
          db.prepare(`
            INSERT INTO loans(id,nombre,cedula,telefono,moneda,montoOrigen,trmAcordada,montoCOP,
              tasaMensual,plazoMeses,modalidad,fechaInicio,diaPago,estado,notas,frecuencia,fechaDevolucion,comprasUSD,gananciaFija,
              fechaUltimoCorte,interesAcumuladoPend,
              fechaBaseCronograma,periodoIrregularN,periodoIrregularDesde,periodoIrregularMora,fechaInicioIntereses,
              unificaDe,capitalRefinanciado,interesCapitalizado,cargaTrasladada,cargaCuotas)
            VALUES (@id,@nombre,@cedula,@telefono,@moneda,@montoOrigen,@trmAcordada,@montoCOP,
              @tasaMensual,@plazoMeses,@modalidad,@fechaInicio,@diaPago,@estado,@notas,@frecuencia,@fechaDevolucion,@comprasUSD,@gananciaFija,
              @fechaUltimoCorte,@interesAcumuladoPend,
              @fechaBaseCronograma,@periodoIrregularN,@periodoIrregularDesde,@periodoIrregularMora,@fechaInicioIntereses,
              @unificaDe,@capitalRefinanciado,@interesCapitalizado,@cargaTrasladada,@cargaCuotas)
          `).run(nuevo);
          if (schedule.length) insertSchedule(schedule);
        },
      };
    });
  });

  return router;
};
