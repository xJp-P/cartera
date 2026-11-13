const { app, BrowserWindow, ipcMain, dialog, clipboard } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs   = require('fs');
const http  = require('http');
const https = require('https');
const os    = require('os');
const { execSync } = require('child_process');
// Rediseño v4: la ventana de arranque (su HTML y lo que se le cambia) vive en desktop/splash.js.
const { buildSplashHtml, PALETAS, jsMensaje, jsCuenta, jsVista, jsTextos, TEXTOS } = require('./splash');

const PORT = 3420;

// Raíz del proyecto (un nivel arriba de /desktop)
const PROJECT_ROOT = path.join(__dirname, '..');

// ── Ruta de preferencias (siempre en userData cuando está empaquetado) ───
const PREFS_FILE = path.join(
  app.isPackaged ? app.getPath('userData') : PROJECT_ROOT,
  'prefs.json'
);

function loadPrefs() {
  try { return JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')); }
  catch(_) { return {}; }
}
function savePrefs(p) { fs.writeFileSync(PREFS_FILE, JSON.stringify(p, null, 2)); }

// ── Tema de la ventana de arranque (rediseño v4, como en Control TC) ──────────
// El splash se dibuja antes de que exista la app, asi que no puede leer el localStorage de la ventana.
// La app escribe el tema en userData/apariencia.json cada vez que cambia (IPC 'tema-cambiado'). Sin
// archivo, o si no se puede leer: oscuro, el mismo valor por defecto de la app. No toca la base de datos.
function aparienciaPath() { return path.join(app.getPath('userData'), 'apariencia.json'); }
function leerTemaArranque() {
  try { return JSON.parse(fs.readFileSync(aparienciaPath(), 'utf8')).tema === 'light' ? 'light' : 'dark'; }
  catch (_) { return 'dark'; }
}
function guardarTemaArranque(tema) {
  const t = tema === 'light' ? 'light' : 'dark';
  if (leerTemaArranque() === t && fs.existsSync(aparienciaPath())) return;
  try {
    fs.mkdirSync(path.dirname(aparienciaPath()), { recursive: true });
    fs.writeFileSync(aparienciaPath(), JSON.stringify({ tema: t }), 'utf8');
  } catch (e) { console.log('[Arranque] no se pudo guardar el tema:', e.message); }
}
ipcMain.on('tema-cambiado', (_e, tema) => guardarTemaArranque(tema));

// ── Ruta de la BD ─────────────────────────────────────────────────────────
const prefs = loadPrefs();
const defaultDB = app.isPackaged
  ? path.join(app.getPath('userData'), 'cartera.db')
  : path.join(PROJECT_ROOT, 'cartera.db');

let DB_PATH = defaultDB;
let dbError = null;

if (prefs.dbPath) {
  if (fs.existsSync(prefs.dbPath)) {
    DB_PATH = prefs.dbPath;
  } else if (fs.existsSync(path.dirname(prefs.dbPath))) {
    // La carpeta existe pero el archivo no
    DB_PATH = prefs.dbPath;
    dbError = 'No se encontró la base de datos en:\n' + prefs.dbPath + '\n\nSe creará una nueva base de datos en esa ubicación.';
  } else {
    // La carpeta no existe (USB desconectado, iCloud inaccesible, etc.)
    dbError = 'No se puede acceder a la carpeta:\n' + path.dirname(prefs.dbPath) + '\n\nSe usará la base de datos local por defecto.';
    DB_PATH = defaultDB;
  }
}

// ── Limpiar BD anterior si quedó pendiente de borrar ──────────────────────
if (prefs.pendingDelete && prefs.pendingDelete !== DB_PATH && fs.existsSync(prefs.pendingDelete)) {
  try { fs.unlinkSync(prefs.pendingDelete); } catch(_) {}
  const p2 = loadPrefs();
  delete p2.pendingDelete;
  savePrefs(p2);
}

// ── Servidor Express ──────────────────────────────────────────────────────
function waitForServer(url, retries = 30, delay = 300) {
  return new Promise((resolve, reject) => {
    function attempt(n) {
      http.get(url, res => { res.resume(); resolve(); })
        .on('error', () => {
          if (n <= 0) return reject(new Error('Servidor no respondió'));
          setTimeout(() => attempt(n - 1), delay);
        });
    }
    attempt(retries);
  });
}

// v1.9.2 CHANGE: El backend NO se inicia al cargar el modulo. Se arranca explicitamente
// en startBackend() despues de que checkForUpdatesAtBoot() confirme que no hay update
// pendiente. Esto evita que codigo viejo (potencialmente con bugs que corrompan la BD)
// se ejecute sobre la base de datos antes de que el usuario tenga la oportunidad de
// instalar el parche.
let expressApp = null;
let server = null;
let serverError = null;
// Rediseño v4: si el puerto no se puede abrir (EADDRINUSE: otra copia de la app abierta), el evento
// 'error' del servidor ya no queda sin manejar (Electron lo mostraba en un cuadro nativo): se guarda
// aqui y el arranque lo muestra en la ventana de arranque, con el detalle para copiar.
let errorPuerto = null;

function startBackend() {
  if (server) return; // ya iniciado, idempotente
  try {
    expressApp = require('../backend/server')(DB_PATH);
    server = http.createServer(expressApp);
    server.on('error', (err) => { err.fase = 'puerto'; errorPuerto = err; });
    server.listen(PORT, '127.0.0.1');
  } catch(err) {
    serverError = 'Error al iniciar el servidor:\n' + err.message;
  }
}

// ── IPC: Desarrollador ───────────────────────────────────────────────────
ipcMain.handle('get-db-path', () => DB_PATH);

ipcMain.handle('pick-db-folder', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Elegir carpeta para la base de datos',
    properties: ['openDirectory']
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});

ipcMain.handle('set-db-path', (_e, newFolder) => {
  try {
    const newPath = path.join(newFolder, 'cartera.db');
    const destExists = fs.existsSync(newPath);
    if (newPath !== DB_PATH && !destExists && fs.existsSync(DB_PATH)) {
      fs.copyFileSync(DB_PATH, newPath);
    }
    const p = loadPrefs();
    p.dbPath = newPath;
    p.pendingDelete = (newPath !== DB_PATH && !destExists) ? DB_PATH : null;
    savePrefs(p);
    return { ok: true, path: newPath };
  } catch(err) {
    return { ok: false, error: 'Error al mover la base de datos:\n' + err.message };
  }
});

ipcMain.handle('reset-db-path', () => {
  try {
    const cur = loadPrefs();
    const oldPath = cur.dbPath;
    if (oldPath && fs.existsSync(oldPath) && oldPath !== defaultDB) {
      fs.copyFileSync(oldPath, defaultDB);
    }
    delete cur.dbPath;
    cur.pendingDelete = oldPath && oldPath !== defaultDB ? oldPath : null;
    savePrefs(cur);
    return { ok: true, path: defaultDB };
  } catch(err) {
    return { ok: false, error: 'Error al restaurar la base de datos:\n' + err.message };
  }
});

ipcMain.handle('relaunch-app', () => {
  app.relaunch();
  app.quit();
});

// ── IPC: Errores de arranque ─────────────────────────────────────────────
ipcMain.handle('get-startup-errors', () => {
  const errors = [];
  if (dbError) errors.push({ type: 'db', message: dbError });
  if (serverError) errors.push({ type: 'server', message: serverError });
  return errors;
});

// ── Ventana principal ─────────────────────────────────────────────────────
async function createWindow() {
  const win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 1000, minHeight: 700,
    title: 'Cartera',
    backgroundColor: PALETAS[leerTemaArranque()].bg,   // rediseño v4: el fondo del tema (--page), sin destello de otro color
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
  });

  win.setMenu(null);

  try {
    // Un tick para que un error del puerto (EADDRINUSE) llegue antes de preguntarle al servidor: si no,
    // waitForServer podria contestarse con la OTRA copia de la app que ocupa el puerto.
    await new Promise((r) => setImmediate(r));
    if (errorPuerto) throw errorPuerto;
    await waitForServer(`http://127.0.0.1:${PORT}/`);
    if (errorPuerto) throw errorPuerto;
    await win.loadURL(`http://127.0.0.1:${PORT}`);
  } catch(err) {
    // Rediseño v4: ya no hay cuadro nativo "Error de arranque". La ventana de arranque muestra la vista
    // "La app no pudo iniciar", con el detalle para copiar, y la app se cierra al elegir "Cerrar".
    if (!win.isDestroyed()) win.destroy();
    await showFatalInSplash(err);
    app.quit();
    return null;
  }

  // Se muestra con el fundido del orquestador (abrirVentanaPrincipal), cuando la ventana de arranque
  // ya se fue.
  win.on('closed', () => { if (server) server.close(); app.quit(); });
  return win;
}

// Rediseño v4: fundido de una ventana (opacidad nativa; en Windows y macOS) en `ms` milisegundos.
function fundir(win, de, a, ms) {
  return new Promise((resolve) => {
    if (!win || win.isDestroyed()) return resolve();
    const pasos = Math.max(1, Math.round(ms / 16));
    let i = 0;
    try { win.setOpacity(de); } catch (_) {}
    const t = setInterval(() => {
      i++;
      if (!win || win.isDestroyed()) { clearInterval(t); return resolve(); }
      const x = i / pasos, k = 1 - Math.pow(1 - x, 3);   // sale rapido y llega suave
      try { win.setOpacity(de + (a - de) * k); } catch (_) {}
      if (i >= pasos) { clearInterval(t); resolve(); }
    }, 16);
  });
}

// El paso del arranque a la app: la ventana de arranque se desvanece (180 ms) y la principal aparece
// maximizada con un fundido (200 ms); adentro, el marco de la app hace su propia entrada (arranque.css).
async function abrirVentanaPrincipal(win) {
  if (splashAlive()) {
    await fundir(splashWin, 1, 0, 180);
    if (splashAlive()) splashWin.close();
  }
  splashWin = null;
  if (!win || win.isDestroyed()) return;
  try { win.setOpacity(0); } catch (_) {}
  win.maximize();
  win.show();
  await fundir(win, 0, 1, 200);
}

// ── Auto-updater ────────────────────────────────────────────────────────
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;
// v1.15.3: fuerza la descarga del instalador COMPLETO en vez de la diferencial por blockmap.
// La descarga diferencial podia quedar parcial/corrupta (sobre todo al saltar muchas versiones
// de golpe) y el rename final 'temp-*.exe' -> '*.exe' fallaba con ENOENT. Baja mas MB pero es
// robusto. Solo aplica a Windows (Mac usa un updater propio).
autoUpdater.disableDifferentialDownload = true;

let mainWin = null;
let splashWin = null;
let macUpdateVersion = null;

function sendUpdateStatus(status, info) {
  info = info || {};
  // v1.9.2: si el splash esta activo y la ventana principal aun no — rutear al splash
  if (splashWin && !splashWin.isDestroyed() && (!mainWin || mainWin.isDestroyed())) {
    if (status === 'downloading') {
      updateSplashMessage(TEXTOS.descargando(info.version || macUpdateVersion), info.percent, '');
    } else if (status === 'downloaded') {
      updateSplashMessage(TEXTOS.instalando(info.version || macUpdateVersion), 100, TEXTOS.notaInstalando);
    } else if (status === 'error') {
      updateSplashMessage('Error: ' + (info.message || 'desconocido'));
    }
    return;
  }
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send('update-status', { status, ...info });
  }
}

autoUpdater.on('update-available', (info) => {
  macUpdateVersion = info.version;
  sendUpdateStatus('available', { version: info.version });
});

autoUpdater.on('update-not-available', () => {
  sendUpdateStatus('not-available', {});
});

autoUpdater.on('download-progress', (prog) => {
  sendUpdateStatus('downloading', { percent: Math.round(prog.percent) });
});

autoUpdater.on('update-downloaded', (info) => {
  sendUpdateStatus('downloaded', { version: info.version });
});

autoUpdater.on('error', (err) => {
  // En Mac ignorar errores de electron-updater (usamos flujo propio)
  if (process.platform === 'darwin') return;
  sendUpdateStatus('error', { message: err.message });
});

ipcMain.handle('check-for-updates', () => {
  if (!app.isPackaged) return { status: 'dev-mode' };
  autoUpdater.checkForUpdates();
  return { status: 'checking' };
});

// v1.15.3: limpia el folder `pending` del updater de Windows (%LOCALAPPDATA%\cartera-updater\
// pending). Ahi viven los temp-*.exe; si uno quedo parcial o bloqueado de un intento previo, el
// rename fallaba con ENOENT. Todo en try/catch: si algo sale mal, no interrumpe el arranque.
function cleanUpdaterPending() {
  try {
    const local = process.env.LOCALAPPDATA;
    if (!local) return;
    const pendingDir = path.join(local, app.getName() + '-updater', 'pending');
    if (fs.existsSync(pendingDir)) fs.rmSync(pendingDir, { recursive: true, force: true });
  } catch (_) { /* no-op */ }
}

// v1.15.3: descarga la actualizacion en Windows con 1 REINTENTO (limpiando `pending` antes de
// cada intento). En exito la app se cierra para instalar (la promesa nunca se resuelve); solo
// rechaza si el reintento tambien falla -> el llamador (FASE 4a) muestra la vista de error.
function downloadUpdateWindows() {
  const attempt = () => new Promise((resolve, reject) => {
    const onProgress = (prog) => updateSplashMessage(TEXTOS.descargando(macUpdateVersion), Math.round(prog.percent), '');
    const onDownloaded = () => {
      updateSplashMessage(TEXTOS.instalando(macUpdateVersion), 100, TEXTOS.notaInstalando);
      setTimeout(() => autoUpdater.quitAndInstall(false, true), 1000);
      // app sale; la promesa no se resuelve a proposito
    };
    function off() {
      autoUpdater.removeListener('download-progress', onProgress);
      autoUpdater.removeListener('update-downloaded', onDownloaded);
      autoUpdater.removeListener('error', onError);
    }
    function onError(err) { off(); reject(err); }
    autoUpdater.on('download-progress', onProgress);
    autoUpdater.on('update-downloaded', onDownloaded);
    autoUpdater.on('error', onError);
    autoUpdater.downloadUpdate().catch(function(err) { off(); reject(err); });
  });
  cleanUpdaterPending();
  return attempt().catch(function() {
    cleanUpdaterPending();
    updateSplashMessage(TEXTOS.reintentando(macUpdateVersion), 0, '');
    return attempt();
  });
}

// ── Mac: actualizador personalizado (sin firma de código) ────────────
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'cartera' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGet(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      resolve(res);
    }).on('error', reject);
  });
}

let macUpdateScript = null;

function macDownloadAndInstall(version) {
  const zipUrl = `https://github.com/xJp-P/cartera/releases/download/v${version}/Instalador-Mac-${version}.zip`;
  const tmpDir = path.join(os.tmpdir(), 'cartera-update-' + Date.now());
  const zipPath = path.join(tmpDir, 'update.zip');

  fs.mkdirSync(tmpDir, { recursive: true });
  sendUpdateStatus('downloading', { percent: 0 });

  httpsGet(zipUrl).then((res) => {
    const total = parseInt(res.headers['content-length'] || '0', 10);
    let downloaded = 0;
    const file = fs.createWriteStream(zipPath);

    res.on('data', (chunk) => {
      downloaded += chunk.length;
      if (total > 0) {
        sendUpdateStatus('downloading', { percent: Math.round((downloaded / total) * 100) });
      }
    });

    res.pipe(file);
    file.on('finish', () => {
      file.close();
      try {
        sendUpdateStatus('downloading', { percent: 100 });
        // Extraer zip
        execSync(`unzip -o -q "${zipPath}" -d "${tmpDir}"`);
        const extractedApp = path.join(tmpDir, 'Cartera.app');
        if (!fs.existsSync(extractedApp)) {
          sendUpdateStatus('error', { message: 'No se encontró la app en el zip' });
          return;
        }
        // Quitar restricción de macOS
        execSync(`xattr -cr "${extractedApp}"`);
        // Obtener ruta de la app actual (/Applications/Cartera.app)
        const appPath = path.dirname(path.dirname(path.dirname(app.getAppPath())));
        // Crear script que reemplaza la app después de cerrar
        const scriptPath = path.join(tmpDir, 'update.sh');
        const script = `#!/bin/bash
sleep 2
rm -rf "${appPath}"
cp -R "${extractedApp}" "${appPath}"
xattr -cr "${appPath}"
open "${appPath}"
rm -rf "${tmpDir}"
`;
        fs.writeFileSync(scriptPath, script, { mode: 0o755 });
        sendUpdateStatus('downloaded', { version: version });
        // Guardar script path para ejecutar al instalar
        macUpdateScript = scriptPath;
      } catch (err) {
        sendUpdateStatus('error', { message: 'Error al preparar: ' + err.message });
        try { fs.rmSync(tmpDir, { recursive: true }); } catch(_) {}
      }
    });
  }).catch((err) => {
    sendUpdateStatus('error', { message: 'Error al descargar: ' + err.message });
    try { fs.rmSync(tmpDir, { recursive: true }); } catch(_) {}
  });
}

ipcMain.handle('download-update', () => {
  if (process.platform === 'darwin' && macUpdateVersion) {
    macDownloadAndInstall(macUpdateVersion);
    return { status: 'downloading' };
  }
  autoUpdater.downloadUpdate();
  return { status: 'downloading' };
});

ipcMain.handle('install-update', () => {
  if (process.platform === 'darwin' && macUpdateScript) {
    require('child_process').exec(`bash "${macUpdateScript}"`);
    setTimeout(() => { app.quit(); }, 500);
    return;
  }
  autoUpdater.quitAndInstall(false, true);
});

ipcMain.handle('get-platform', () => process.platform);

ipcMain.handle('get-app-version', () => app.getVersion());

// ── Generar PDF con fondos (printBackground: true) ──────────────────────
// El render vive en desktop/pdf.js: ahi esta por que la ventana oculta NO es offscreen.
ipcMain.handle('print-pdf', async (_e, html, filename) => {
  const pdfBuf = await require('./pdf').htmlAPdf(html);
  const savePath = await dialog.showSaveDialog(mainWin, {
    title: 'Guardar PDF',
    defaultPath: path.join(app.getPath('documents'), (filename || 'documento') + '.pdf'),
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  });
  if (savePath.canceled || !savePath.filePath) return { ok: false };
  fs.writeFileSync(savePath.filePath, pdfBuf);
  return { ok: true, path: savePath.filePath };
});

// ═══════════════════════════════════════════════════════════════════════════
// v1.9.2 — BOOT SEQUENCE CON SPLASH + UPDATE CHECK PRE-BD
// ═══════════════════════════════════════════════════════════════════════════
// Garantiza que ningun codigo viejo (potencialmente bugueado) toque la BD
// antes de que el usuario tenga la oportunidad de instalar actualizaciones.

// ── Splash window: se muestra inmediatamente al arrancar ──────────────────
// Rediseño v4: el HTML es el de desktop/splash.js (diseño de Control TC v7), con el tema que la app dejo
// en apariencia.json y la tipografia Inter de public/fonts. Cuatro vistas: carga, sin conexion, error
// de la descarga y error grave. nodeIntegration habilitado para que los botones envien IPC al main.
// Contenido 100% local (data: URL) controlado por nosotros — sin riesgo.
function createSplashWindow() {
  const tema = leerTemaArranque();
  const w = new BrowserWindow({
    width: 440, height: 290,
    frame: false,
    resizable: false,
    movable: true,
    transparent: false,
    alwaysOnTop: true,
    backgroundColor: PALETAS[tema].bg,
    center: true,
    skipTaskbar: false,
    title: 'Cartera',
    show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  w.setMenu(null);
  let fuente = null;
  try { fuente = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'fonts', 'inter-latin-wght.woff2')).toString('base64'); } catch (_) {}
  const html = buildSplashHtml(tema, { fuente, version: app.getVersion() });
  w.loadURL('data:text/html;charset=UTF-8,' + encodeURIComponent(html));
  // Se muestra ya dibujada (sin destello blanco) y con un fundido corto.
  w.once('ready-to-show', () => {
    if (w.isDestroyed()) return;
    try { w.setOpacity(0); } catch (_) {}
    w.show();
    fundir(w, 0, 1, 220);
  });
  return w;
}

function splashAlive() { return !!(splashWin && !splashWin.isDestroyed()); }
function splashJs(codigo) {
  if (!splashAlive()) return;
  splashWin.webContents.executeJavaScript(codigo).catch(() => {});
}

// La linea de estado: con `percent`, la barra con su porcentaje; sin el, la barra fina que avanza sola.
// `nota`, si viene, es la frase de abajo.
function updateSplashMessage(msg, percent, nota) { splashJs(jsMensaje(msg, percent, nota)); }

// La cuenta atras de la busqueda de actualizaciones, como frase de abajo.
function updateSplashCountdown(seconds) { splashJs(jsCuenta(seconds)); }

// v1.9.3: cambia la vista del splash a la decision de offline y espera input del usuario
function showOfflineDecisionInSplash() {
  return new Promise((resolve) => {
    if (!splashAlive()) return resolve('continue');
    splashJs(jsVista('vOffline', 'btnContinue'));
    ipcMain.once('splash-decision', (_e, choice) => {
      resolve(choice === 'quit' ? 'quit' : 'continue');
    });
  });
}

// v1.9.4: cuando la descarga de actualizacion falla, mostrar vista de error con boton "Cerrar y
// reintentar" (el seguro, por eso tiene el foco) para forzar el reintento al reabrir.
// v1.9.5: se agrega "Seguir con la actual" como escape hatch — si el usuario necesita trabajar y el
// update fallo por algo transitorio (servidor caido, WiFi inestable), puede abrir la app con la version
// actual asumiendo el riesgo. Devuelve 'continue' | 'quit'. El mensaje tecnico va en "Detalle tecnico".
function showDownloadErrorInSplash(errMessage) {
  return new Promise((resolve) => {
    if (!splashAlive()) return resolve('quit');
    splashJs(jsTextos({ tUpdate: TEXTOS.tituloErrorUpdate(macUpdateVersion), updateErrorDetail: errMessage || 'desconocido' }));
    splashJs(jsVista('vUpdateError', 'btnQuitUpdate'));
    ipcMain.once('splash-decision', (_e, choice) => {
      resolve(choice === 'continue' ? 'continue' : 'quit');
    });
  });
}

// Rediseño v4: lo que se le dice al usuario cuando la app no puede iniciar (antes, el cuadro nativo
// "Error de arranque"). Un texto humano y el detalle tecnico aparte, para copiarlo.
function describirFalloArranque(err) {
  const code = (err && err.code) || '';
  const msg = (err && err.message) || String(err || 'desconocido');
  if (err && err.fase === 'puerto') {
    return {
      texto: code === 'EADDRINUSE'
        ? `Otro programa está usando el puerto ${PORT}. Puede que Cartera ya esté abierta: ciérrala y vuelve a abrirla.`
        : `No se pudo abrir el puerto ${PORT} que usa la app.`,
      detalle: `${code || 'ERROR'} · 127.0.0.1:${PORT}`,
    };
  }
  return {
    texto: 'El servidor interno de la app no pudo iniciar. Tus datos no se tocaron: cierra la app y vuelve a abrirla; si se repite, copia el detalle.',
    detalle: msg + (serverError ? ' · ' + String(serverError).replace(/\s+/g, ' ') : '') + ' · ' + DB_PATH,
  };
}

// Muestra la vista "La app no pudo iniciar" y espera a que el usuario la cierre ("Copiar el detalle" lo
// deja en el portapapeles). Si la ventana de arranque ya no existe, abre una para decirlo.
async function showFatalInSplash(err) {
  const f = describirFalloArranque(err);
  console.log('[Arranque] error grave:', f.detalle);
  if (!splashAlive()) {
    splashWin = createSplashWindow();
    await new Promise((r) => splashWin.webContents.once('did-finish-load', r));
  }
  await new Promise((resolve) => {
    splashJs(jsTextos({ fatalMsg: f.texto, fatalDetail: f.detalle }));
    splashJs(jsVista('vFatal', 'btnFatalQuit'));
    let listo = false;
    const fin = () => { if (listo) return; listo = true; ipcMain.removeListener('splash-fatal', alElegir); resolve(); };
    const alElegir = (_e, accion) => {
      if (accion === 'copiar') {
        clipboard.writeText(f.detalle);
        splashJs(jsTextos({ btnFatalCopy: 'Copiado' }));
        return;
      }
      fin();
    };
    ipcMain.on('splash-fatal', alElegir);
    // Si la ventana se cierra por otra via (Alt+F4), tambien se sale.
    splashWin.once('closed', fin);
  });
}

// ── Helpers para chequear updates en Mac (sin tocar BD) ───────────────────
function compareVersions(a, b) {
  const pa = String(a||'').split('.').map(n => parseInt(n,10) || 0);
  const pb = String(b||'').split('.').map(n => parseInt(n,10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i]||0) > (pb[i]||0)) return 1;
    if ((pa[i]||0) < (pb[i]||0)) return -1;
  }
  return 0;
}

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'cartera',
        'Accept': 'application/vnd.github+json'
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGetJson(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function checkMacUpdateAvailable() {
  try {
    const json = await httpsGetJson('https://api.github.com/repos/xJp-P/cartera/releases/latest');
    const latestTag = String(json.tag_name || '').replace(/^v/, '');
    const currentVer = app.getVersion();
    if (latestTag && compareVersions(latestTag, currentVer) > 0) {
      macUpdateVersion = latestTag;
      return 'install';
    }
    return 'skip';
  } catch(e) {
    return 'skip';
  }
}

// ── Check de updates aislado (max 60s con countdown visible) ────────────
// Retorna: 'install' (hay update) | 'skip' (no hay update) | 'timeout' (no respuesta)
// v1.9.3: cuando expira el timer NO se cae automaticamente a 'skip'. Devuelve 'timeout'
// para que el orquestador muestre el modal de decision offline al usuario.
async function checkForUpdatesAtBoot() {
  if (!app.isPackaged) return 'skip';
  return new Promise((resolve) => {
    let resolved = false;
    let secondsLeft = 60;
    const finalize = (decision) => {
      if (resolved) return;
      resolved = true;
      clearInterval(tick);
      resolve(decision);
    };
    // Countdown visible en el splash, tick cada segundo
    updateSplashCountdown(secondsLeft);
    const tick = setInterval(() => {
      secondsLeft--;
      updateSplashCountdown(secondsLeft);
      if (secondsLeft <= 0) finalize('timeout');
    }, 1000);

    if (process.platform === 'darwin') {
      checkMacUpdateAvailable().then(d => finalize(d))
        .catch(() => finalize('timeout'));
    } else {
      autoUpdater.once('update-available', (info) => {
        macUpdateVersion = info.version;
        finalize('install');
      });
      autoUpdater.once('update-not-available', () => finalize('skip'));
      autoUpdater.once('error', () => finalize('timeout'));
      try { autoUpdater.checkForUpdates(); }
      catch(_) { finalize('timeout'); }
    }
  });
}

// ── Mac: descarga + instalacion automatica al arrancar ──────────────────
async function macDownloadAndInstallAtBoot(version) {
  const zipUrl = `https://github.com/xJp-P/cartera/releases/download/v${version}/Instalador-Mac-${version}.zip`;
  const tmpDir = path.join(os.tmpdir(), 'cartera-update-' + Date.now());
  const zipPath = path.join(tmpDir, 'update.zip');
  fs.mkdirSync(tmpDir, { recursive: true });

  updateSplashMessage(TEXTOS.descargando(version), 0, '');

  await new Promise((resolve, reject) => {
    httpsGet(zipUrl).then((res) => {
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let downloaded = 0;
      const file = fs.createWriteStream(zipPath);
      res.on('data', (chunk) => {
        downloaded += chunk.length;
        if (total > 0) updateSplashMessage(TEXTOS.descargando(version), Math.round((downloaded/total)*100));
      });
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
      file.on('error', reject);
    }).catch(reject);
  });

  updateSplashMessage(TEXTOS.instalando(version), 100, TEXTOS.notaInstalando);
  execSync(`unzip -o -q "${zipPath}" -d "${tmpDir}"`);
  const extractedApp = path.join(tmpDir, 'Cartera.app');
  if (!fs.existsSync(extractedApp)) throw new Error('No se encontró la app en el zip');
  execSync(`xattr -cr "${extractedApp}"`);
  const appPath = path.dirname(path.dirname(path.dirname(app.getAppPath())));
  const scriptPath = path.join(tmpDir, 'update.sh');
  const script = `#!/bin/bash
sleep 2
rm -rf "${appPath}"
cp -R "${extractedApp}" "${appPath}"
xattr -cr "${appPath}"
open "${appPath}"
rm -rf "${tmpDir}"
`;
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });
  require('child_process').exec(`bash "${scriptPath}"`);
  setTimeout(() => app.quit(), 500);
}

// ── Orquestador de boot: 4 fases + decision offline ─────────────────────
app.whenReady().then(async () => {
  // FASE 1: prefs + DB_PATH ya resueltos (top-level), nada conectado todavia.

  // FASE 2: splash inmediato con countdown (BD intacta)
  splashWin = createSplashWindow();

  // FASE 3: check de updates aislado (max 60s con countdown visible)
  const decision = await checkForUpdatesAtBoot();

  if (decision === 'install') {
    // FASE 4a: hay update — instalar SIN tocar BD
    updateSplashMessage(TEXTOS.descargando(macUpdateVersion), 0, '');
    try {
      if (process.platform === 'darwin') {
        await macDownloadAndInstallAtBoot(macUpdateVersion);
        return; // app se cierra
      } else {
        // v1.15.3: descarga con reintento + limpieza de `pending` (fix del ENOENT al renombrar)
        await downloadUpdateWindows();
        return;
      }
    } catch(err) {
      // v1.9.4: si la descarga de la actualizacion falla, mostrar vista de error.
      // v1.9.5: el usuario elige — "Cerrar app" (seguro, reintenta al reabrir) o
      // "Continuar de todos modos" (escape hatch para situaciones de necesidad).
      // Si elige continuar, cae a FASE 4b igual que el offline-continue.
      const userChoice = await showDownloadErrorInSplash(err.message);
      if (userChoice === 'quit') {
        if (splashWin && !splashWin.isDestroyed()) splashWin.close();
        app.quit();
        return;
      }
      // userChoice === 'continue' → caer a FASE 4b (arranque normal con version actual)
    }
  } else if (decision === 'timeout') {
    // v1.9.3: cuando el chequeo expira por problemas de conexion, no decidimos por
    // el usuario — le mostramos las opciones y esperamos input.
    const userChoice = await showOfflineDecisionInSplash();
    if (userChoice === 'quit') {
      // Usuario eligio cerrar sin tocar la BD
      if (splashWin && !splashWin.isDestroyed()) splashWin.close();
      app.quit();
      return;
    }
    // userChoice === 'continue' → caer a FASE 4b
  }

  // FASE 4b: sin update (skip, timeout-continue, o continue tras error de descarga) — arranque normal.
  // Vuelve a la vista de carga si veniamos de la vista sin conexion o de la de error de la descarga.
  splashJs(jsVista('vLoading'));
  updateSplashMessage(TEXTOS.abriendo, undefined, TEXTOS.notaAbriendo);
  startBackend();
  mainWin = await createWindow();
  if (!mainWin) return;   // la app no pudo iniciar: ya se mostro la vista de error y la app sale
  await abrirVentanaPrincipal(mainWin);
});

app.on('window-all-closed', () => { if (server) server.close(); app.quit(); });
