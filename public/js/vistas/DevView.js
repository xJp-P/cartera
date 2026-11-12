// public/js/vistas/DevView.js — Desarrollador: ruta de la BD, el sistema y sus actualizaciones, el Reporte de
// Prestamos Activos, los datos de pago de la factura y la sincronizacion de cronogramas.
//
// El estado global sigue viviendo en `App` y baja por PROPS (`showToast`, `onNeedsRestart`, `onSync` =
// `recalculate`, `onConfirm`, `loans`, `pays`, `datosPago`, `onSaveConfig` = `saveConfig`).
//
// REDISEÑO v4 (aprobado por el PO sobre el prototipo, integrado pestaña por pestaña): una rejilla de cinco
// tarjetas agrupadas por proposito (Base de datos, Sistema, Reporte de prestamos, Datos de pago y
// Sincronizar datos), cada una con su icono en un recuadro neutro, una sola accion principal en negro (o
// blanco, en oscuro) y su estado en un chip ("Al día", "Buscando…", "Sin guardar"...). Estilos en
// public/css/dev.css (`.v4v`, prefijo `dvv-`).
//
// MISMA conexion que la vista anterior, sin un solo cambio de logica: la capa de Electron es
// `window.electronAPI` (desktop/preload.js) con los mismos metodos y argumentos —`getDbPath`,
// `getAppVersion`, `onUpdateStatus` (sus seis estados), `pickDbFolder` -> `setDbPath(carpeta)`,
// `resetDbPath` tras la confirmacion, `checkForUpdates`, `downloadUpdate`, `installUpdate`—; los datos de
// pago se guardan con `onSaveConfig({ datos_pago })` (PUT /api/config); "Sincronizar" llama a `onSync`
// (POST /api/recalculate) y muestra de forma PERSISTENTE los prestamos que no se pudieron recalcular; y el
// reporte sale de `generateReportePrestamosPDF`, cuya logica no se toca. Sin Electron (en el navegador) las
// acciones del sistema de archivos se apagan y un aviso lo explica.
// Detalles nuevos, todos de presentacion: copiar la ruta, el chip de "Sin guardar" / "Guardado" de los
// datos de pago, y cuantos prestamos activos (y con cuotas en mora) entran al reporte.
// Nombres de nivel superior con prefijo dvv/Dvv (el arnes aplana los modulos en un ambito).

import { Ico } from '../componentes/iconos.js';
import { showError } from '../core/api.js';
import { h, useEffect, useState } from '../core/react.js';
import { generateReportePrestamosPDF } from '../pdf/reporte-activos.js';
import { V4Chip, v4PuedeAnimar } from './DashView.js';

function dvvPl(n, s, p){ return n + ' ' + (n === 1 ? s : (p || s + 's')); }

// Una tarjeta: icono en un recuadro neutro, titulo, subtitulo y, a la derecha, su chip de estado.
function DvvCard(p){
  return h('section', { className: 'v4-card dvv-card' + (p.className ? ' ' + p.className : ''), style: { '--i': p.i || 0 } },
    h('div', { className: 'dvv-card-h' },
      h('span', { className: 'dvv-ico' }, h(Ico, { name: p.icono, size: 17, sw: 2 })),
      h('div', { className: 'dvv-card-t' }, h('div', { className: 'v4-titulo' }, p.titulo), p.sub && h('div', { className: 'v4-sub' }, p.sub)),
      p.chip || null),
    p.children);
}

export function DevView(props){
  var showToast = props.showToast;
  var onNeedsRestart = props.onNeedsRestart;
  var onSync = props.onSync;
  var s1 = useState(''); var dbPath = s1[0]; var setDbPath = s1[1];
  var s2 = useState(false); var loading = s2[0]; var setLoading = s2[1];
  var s3 = useState(''); var appVersion = s3[0]; var setAppVersion = s3[1];
  var s4 = useState(null); var updateInfo = s4[0]; var setUpdateInfo = s4[1];
  var s5 = useState(props.datosPago || ''); var datosPago = s5[0]; var setDatosPago = s5[1];
  var s6 = useState(false); var savingPago = s6[0]; var setSavingPago = s6[1];
  // Prestamos que /recalculate no pudo reconstruir. El endpoint aisla al problematico y sigue con los
  // demas, asi que un "Sincronizado" a secas afirmaria algo falso. Se muestra de forma PERSISTENTE: es una
  // lista que hay que leer y sobre la que hay que actuar, no cabe en un toast de 2 segundos.
  var s7 = useState(null); var omitidos = s7[0]; var setOmitidos = s7[1];
  var s8 = useState(false); var sincronizando = s8[0]; var setSincronizando = s8[1];
  // Lo ultimo que quedo GUARDADO de los datos de pago: lo que hay en el campo y difiere es "Sin guardar".
  var s9 = useState(props.datosPago || ''); var guardado = s9[0]; var setGuardado = s9[1];
  var _an = useState(v4PuedeAnimar); var anima = _an[0];
  var hasAPI = typeof window.electronAPI !== 'undefined';

  function saveDatosPago(){
    if (!props.onSaveConfig) return;
    setSavingPago(true);
    Promise.resolve(props.onSaveConfig({ datos_pago: datosPago })).then(function(r){
      setSavingPago(false);
      // `saveConfig` resuelve `null` si el PUT fallo (los helpers de API no rechazan). El chip nuevo solo
      // dice "Guardado" con una respuesta real; el aviso de exito es el de siempre (ver el backlog).
      if (r) setGuardado(datosPago);
      showToast('Datos de pago guardados');
    }).catch(function(){ setSavingPago(false); });
  }

  useEffect(function(){
    if (!hasAPI) return;
    window.electronAPI.getDbPath().then(setDbPath);
    window.electronAPI.getAppVersion().then(setAppVersion);
    var unsub = window.electronAPI.onUpdateStatus(function(data){ setUpdateInfo(data); });
    return unsub;
  }, []);

  function pickFolder(){
    if (!hasAPI) return;
    setLoading(true);
    window.electronAPI.pickDbFolder().then(function(folder){
      if (!folder){ setLoading(false); return; }
      return window.electronAPI.setDbPath(folder).then(function(res){
        if (res && res.ok){ setDbPath(res.path); setLoading(false); onNeedsRestart(); }
        else { setLoading(false); showError(res && res.error ? res.error : 'Error al mover la base de datos'); }
      });
    }).catch(function(){ setLoading(false); showError('Error al mover la base de datos'); });
  }
  function resetPath(){
    if (!hasAPI) return;
    props.onConfirm({ title: 'Restaurar ubicación', message: '¿Volver a la ruta por defecto? La app usará la carpeta nativa del sistema.', okLabel: 'Restaurar', tono: 'aviso', onConfirm: function(){
      window.electronAPI.resetDbPath().then(function(res){
        if (res && res.ok){ setDbPath(res.path); onNeedsRestart(); }
        else showError(res && res.error ? res.error : 'Error al restaurar la base de datos');
      });
    } });
  }
  function copiarRuta(){
    if (!dbPath) return;
    try { navigator.clipboard.writeText(dbPath); showToast('Ruta copiada'); } catch (_){}
  }
  function buscarActualizaciones(){ if (hasAPI) window.electronAPI.checkForUpdates(); setUpdateInfo({ status: 'checking' }); }

  // ── Actualizaciones: los seis estados que emite `update-status`, cada uno con su chip ──
  var st = updateInfo ? updateInfo.status : 'not-available';
  var chipAct = st === 'checking' ? h(V4Chip, { tono: 'info' }, 'Buscando…')
    : st === 'dev-mode' ? h(V4Chip, { tono: 'warn' }, 'Modo desarrollo')
    : st === 'available' ? h(V4Chip, { tono: 'info' }, 'v' + updateInfo.version + ' disponible')
    : st === 'downloading' ? h(V4Chip, { tono: 'info' }, 'Descargando ' + (updateInfo.percent || 0) + '%')
    : st === 'downloaded' ? h(V4Chip, { tono: 'good', icono: 'check' }, 'Lista para instalar')
    : st === 'error' ? h(V4Chip, { tono: 'crit' }, 'Error')
    : h(V4Chip, { tono: 'good', icono: 'check' }, 'Al día');
  var cuerpoAct = st === 'checking'
    ? h('div', { className: 'dvv-act-msg' }, h('div', { className: 'spinner' }), 'Buscando actualizaciones…')
    : st === 'dev-mode'
      ? h('div', { className: 'dvv-act-msg warn' }, 'Las actualizaciones solo funcionan en la app instalada.')
    : st === 'available'
      ? [h('div', { key: 'm', className: 'dvv-act-msg' }, 'Hay una versión nueva: ', h('b', null, 'v' + updateInfo.version)),
         h('button', { key: 'b', className: 'v4-btn pri sm', onClick: function(){ window.electronAPI.downloadUpdate(); } }, h(Ico, { name: 'download', size: 14, sw: 2.3 }), 'Descargar actualización')]
    : st === 'downloading'
      ? [h('div', { key: 'm', className: 'dvv-act-msg' }, 'Descargando… ', h('b', null, (updateInfo.percent || 0) + '%')),
         h('div', { key: 'b', className: 'dvv-barra' }, h('i', { style: { width: (updateInfo.percent || 0) + '%' } }))]
    : st === 'downloaded'
      ? [h('div', { key: 'm', className: 'dvv-act-msg' }, h('b', null, 'v' + updateInfo.version), ' está lista para instalar.'),
         h('button', { key: 'b', className: 'v4-btn pri sm', onClick: function(){ window.electronAPI.installUpdate(); } }, h(Ico, { name: 'refresh', size: 14, sw: 2.3 }), 'Reiniciar e instalar')]
    : st === 'error'
      ? [h('div', { key: 'm', className: 'dvv-act-msg crit' }, 'No se pudo verificar: ' + (updateInfo.message || 'error desconocido')),
         h('button', { key: 'b', className: 'v4-btn ghost sm', onClick: buscarActualizaciones }, h(Ico, { name: 'refresh', size: 14, sw: 2.3 }), 'Reintentar')]
    : [h('div', { key: 'm', className: 'dvv-act-msg' }, 'Tienes la última versión.'),
       h('button', { key: 'b', className: 'v4-btn ghost sm', onClick: buscarActualizaciones, disabled: !hasAPI }, h(Ico, { name: 'refresh', size: 14, sw: 2.3 }), 'Buscar actualizaciones')];

  // Lo que entra al reporte: los prestamos activos y cuantos tienen alguna cuota en mora.
  var activos = (props.loans || []).filter(function(l){ return l.estado === 'Activo'; });
  var conMora = {};
  (props.pays || []).forEach(function(p){ if (p.estadoPago === 'En Mora') conMora[p.prestamoId] = 1; });
  var nMora = activos.filter(function(l){ return conMora[l.id]; }).length;
  var sinGuardar = datosPago !== guardado;

  return h('div', { className: 'v4v' + (anima ? ' anima' : '') },
    h('div', { className: 'dvv-intro', style: { '--i': -1 } }, 'Configuración avanzada: dónde vive tu información, los documentos que genera la app y su mantenimiento.'),

    h('div', { className: 'dvv-grid' },
      // ── Tu informacion ──
      h(DvvCard, { className: 'dvv-bd', i: 0, icono: 'folder', titulo: 'Base de datos', sub: 'Dónde se guarda toda tu información',
          chip: h(V4Chip, { tono: 'neutral' }, 'SQLite') },
        h('div', { className: 'dvv-ruta' },
          h('div', { className: 'dvv-ruta-c' }, h('span', { className: 'l' }, 'Ruta actual'), h('code', null, dbPath || 'Cargando…')),
          dbPath && h('button', { className: 'cbv-icono', title: 'Copiar la ruta', onClick: copiarRuta }, h(Ico, { name: 'clipboard', size: 15, sw: 2 }))),
        h('p', { className: 'dvv-p' }, 'Puedes guardarla en cualquier carpeta, por ejemplo una de iCloud Drive, OneDrive o Dropbox. Solo se mueve la base de datos; los archivos de la app quedan en su lugar.'),
        h('div', { className: 'dvv-acc' },
          h('button', { className: 'v4-btn pri sm', onClick: pickFolder, disabled: loading || !hasAPI }, h(Ico, { name: 'folder', size: 14, sw: 2.2 }), loading ? 'Moviendo…' : 'Cambiar ubicación'),
          h('button', { className: 'v4-btn ghost sm', onClick: resetPath, disabled: !hasAPI }, 'Restaurar la ruta por defecto')),
        !hasAPI && h('div', { className: 'dvv-aviso warn' }, h(Ico, { name: 'alert', size: 14, sw: 2.2 }), 'Esta función solo está disponible en la app de escritorio. En el navegador no se puede acceder al sistema de archivos.'),
        h('div', { className: 'dvv-notas' },
          h('div', { className: 'dvv-notas-t' }, 'Antes de cambiarla'),
          h('div', { className: 'dvv-nota' }, h(Ico, { name: 'check', size: 13, sw: 2.4 }), h('span', null, 'La base de datos actual se ', h('b', null, 'copia'), ' a la carpeta nueva.')),
          h('div', { className: 'dvv-nota' }, h(Ico, { name: 'refresh', size: 13, sw: 2.4 }), h('span', null, 'Después hay que ', h('b', null, 'reiniciar la app'), '.')),
          h('div', { className: 'dvv-nota' }, h(Ico, { name: 'activity', size: 13, sw: 2.4 }), h('span', null, 'En una carpeta en la nube (iCloud, OneDrive) se sincroniza sola.')),
          h('div', { className: 'dvv-nota warn' }, h(Ico, { name: 'alert', size: 13, sw: 2.4 }), h('span', null, 'No abras la app en dos equipos al mismo tiempo.')))),

      // ── El sistema ──
      h(DvvCard, { className: 'dvv-sis', i: 1, icono: 'settings', titulo: 'Sistema', sub: 'La versión instalada y sus actualizaciones', chip: chipAct },
        h('div', { className: 'dvv-version' }, h('span', { className: 'v' }, appVersion ? 'v' + appVersion : '…'), h('span', { className: 'l' }, 'Cartera')),
        h('div', { className: 'dvv-filas' },
          h('div', null, h('span', null, 'Motor'), h('b', null, 'Electron + Express')),
          h('div', null, h('span', null, 'Base de datos'), h('b', null, 'SQLite (better-sqlite3)')),
          h('div', null, h('span', null, 'Interfaz'), h('b', null, 'React 18'))),
        h('div', { className: 'dvv-act' }, cuerpoAct)),

      // ── Documentos ── (la generacion del PDF es la de siempre: aqui solo cambia la tarjeta)
      h(DvvCard, { className: 'dvv-rep', i: 2, icono: 'download', titulo: 'Reporte de préstamos activos', sub: 'Un PDF con toda la cartera vigente' },
        h('p', { className: 'dvv-p' }, 'Deudor, modalidad, tasa, saldo pendiente y estado de cada préstamo activo. Las cuotas en mora se detallan bajo cada préstamo y al final se totaliza el capital en la calle.'),
        h('div', { className: 'dvv-rep-stats' },
          h('div', null, h('b', null, activos.length), h('span', null, activos.length === 1 ? 'préstamo activo' : 'préstamos activos')),
          h('div', null, h('b', { className: nMora ? 'crit' : '' }, nMora), h('span', null, 'con cuotas en mora'))),
        h('div', { className: 'dvv-acc' },
          h('button', { className: 'v4-btn pri sm', onClick: function(){
            if (activos.length === 0){ showToast('No hay préstamos activos para el reporte', 'error'); return; }
            generateReportePrestamosPDF(props.loans, props.pays, document.documentElement.getAttribute('data-theme') === 'dark');
          } }, h(Ico, { name: 'download', size: 14, sw: 2.3 }), 'Descargar PDF'))),

      h(DvvCard, { className: 'dvv-pago', i: 3, icono: 'receipt', titulo: 'Datos de pago', sub: 'El bloque «Cómo pagar» de la factura de cobro',
          chip: sinGuardar ? h(V4Chip, { tono: 'warn' }, 'Sin guardar') : (guardado ? h(V4Chip, { tono: 'good', icono: 'check' }, 'Guardado') : null) },
        h('textarea', { className: 'dvv-txt', value: datosPago, onChange: function(e){ setDatosPago(e.target.value); }, rows: 5,
          placeholder: 'Transferencia / Nequi / Daviplata\nA nombre de …\nCel. …' }),
        h('div', { className: 'dvv-pago-pie' },
          h('span', null, 'Aparece en las facturas que generas desde Cobros. Si lo dejas vacío, el bloque no se muestra.'),
          h('button', { className: 'v4-btn pri sm', onClick: saveDatosPago, disabled: savingPago || !sinGuardar }, h(Ico, { name: 'check', size: 14, sw: 2.4 }), savingPago ? 'Guardando…' : 'Guardar'))),

      // ── Mantenimiento ──
      h(DvvCard, { className: 'dvv-sync', i: 4, icono: 'refresh', titulo: 'Sincronizar datos', sub: 'Recalcula todos los cronogramas activos' },
        h('div', { className: 'dvv-sync-c' },
          h('p', { className: 'dvv-p' }, 'Se ejecuta solo cada vez que abres la app. Úsalo únicamente si notas alguna inconsistencia.'),
          // El toast lo emite `recalculate` en App, que es quien conoce el resultado.
          h('button', { className: 'v4-btn ghost sm', disabled: sincronizando, onClick: function(){
              if (sincronizando) return;
              setSincronizando(true);
              Promise.resolve(onSync()).then(function(r){ setSincronizando(false); setOmitidos(r && r.omitidos ? r.omitidos : []); });
            } }, h(Ico, { name: 'refresh', size: 14, sw: 2.3 }), sincronizando ? 'Sincronizando…' : 'Sincronizar ahora')),
        omitidos && omitidos.length > 0 && h('div', { className: 'dvv-res crit' },
          h('div', { className: 'dvv-res-t' }, h(Ico, { name: 'alert', size: 14, sw: 2.3 }),
            dvvPl(omitidos.length, 'préstamo') + (omitidos.length === 1 ? ' no se pudo recalcular' : ' no se pudieron recalcular')),
          h('div', { className: 'dvv-res-s' }, 'Quedaron exactamente como estaban (su transacción se revirtió sola). El resto sí se sincronizó.'),
          omitidos.map(function(o, i){
            return h('div', { key: o.id || i, className: 'dvv-res-f' }, h('b', null, o.nombre || o.id), h('span', null, o.motivo));
          })),
        omitidos && omitidos.length === 0 && h('div', { className: 'dvv-res good' },
          h('div', { className: 'dvv-res-t' }, h(Ico, { name: 'check', size: 14, sw: 2.4 }), 'Todos los cronogramas activos se recalcularon sin omisiones.')))));
}
