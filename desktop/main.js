const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs   = require('fs');
const http  = require('http');
const https = require('https');
const os    = require('os');
const { execSync } = require('child_process');

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
    dbError = 'No se encontro la base de datos en:\n' + prefs.dbPath + '\n\nSe creara una nueva base de datos en esa ubicacion.';
  } else {
    // La carpeta no existe (USB desconectado, iCloud inaccesible, etc.)
    dbError = 'No se puede acceder a la carpeta:\n' + path.dirname(prefs.dbPath) + '\n\nSe usara la base de datos local por defecto.';
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
          if (n <= 0) return reject(new Error('Servidor no respondio'));
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

function startBackend() {
  if (server) return; // ya iniciado, idempotente
  try {
    expressApp = require('../backend/server')(DB_PATH);
    server = http.createServer(expressApp);
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
    title: 'Cartera de Prestamos',
    backgroundColor: '#0d1117',
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
    await waitForServer(`http://127.0.0.1:${PORT}/`);
    await win.loadURL(`http://127.0.0.1:${PORT}`);
  } catch(err) {
    // Si el servidor no arrancó, mostrar error nativo
    dialog.showErrorBox('Error de arranque', 'El servidor interno no pudo iniciar.\n\n' + err.message + '\n\nLa aplicacion se cerrara.');
    app.quit();
    return null;
  }

  win.maximize();
  win.show();
  win.on('closed', () => { if (server) server.close(); app.quit(); });
  return win;
}

// ── Auto-updater ────────────────────────────────────────────────────────
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

let mainWin = null;
let splashWin = null;
let macUpdateVersion = null;

function sendUpdateStatus(status, info) {
  info = info || {};
  // v1.9.2: si el splash esta activo y la ventana principal aun no — rutear al splash
  if (splashWin && !splashWin.isDestroyed() && (!mainWin || mainWin.isDestroyed())) {
    if (status === 'downloading') {
      updateSplashMessage('Descargando v' + (info.version || macUpdateVersion || '') + '...', info.percent);
    } else if (status === 'downloaded') {
      updateSplashMessage('Listo. Reiniciando para instalar...');
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

// ── Mac: actualizador personalizado (sin firma de código) ────────────
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'cartera-prestamos' } }, (res) => {
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
  const zipUrl = `https://github.com/xJp-P/cartera-prestamos/releases/download/v${version}/Instalador-Mac-${version}.zip`;
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
        const extractedApp = path.join(tmpDir, 'Cartera de Prestamos.app');
        if (!fs.existsSync(extractedApp)) {
          sendUpdateStatus('error', { message: 'No se encontro la app en el zip' });
          return;
        }
        // Quitar restricción de macOS
        execSync(`xattr -cr "${extractedApp}"`);
        // Obtener ruta de la app actual (/Applications/Cartera de Prestamos.app)
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
ipcMain.handle('print-pdf', async (_e, html, filename) => {
  const { BrowserWindow: BW } = require('electron');
  const win = new BW({ show: false, width: 800, height: 600, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  const pdfBuf = await win.webContents.printToPDF({
    printBackground: true,
    preferCSSPageSize: true,
    margins: { marginType: 'default' }
  });
  win.destroy();
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
function createSplashWindow() {
  const w = new BrowserWindow({
    width: 420, height: 240,
    frame: false,
    resizable: false,
    movable: true,
    transparent: false,
    alwaysOnTop: true,
    backgroundColor: '#0d1117',
    center: true,
    skipTaskbar: false,
    title: 'Cartera de Prestamos',
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  w.setMenu(null);
  const version = app.getVersion();
  const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>'
    + 'body{margin:0;padding:0;background:#0d1117;color:#e6edf3;'
    + "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;"
    + 'display:flex;align-items:center;justify-content:center;'
    + 'height:100vh;flex-direction:column;'
    + 'border:1px solid #30363d;border-radius:12px;overflow:hidden;'
    + '-webkit-app-region:drag;-webkit-user-select:none;}'
    + '.spinner{width:36px;height:36px;border:3px solid #21262d;'
    + 'border-top-color:#3fb950;border-radius:50%;'
    + 'animation:spin 1s linear infinite;margin-bottom:18px;}'
    + '@keyframes spin{to{transform:rotate(360deg);}}'
    + 'h1{font-size:14px;font-weight:600;margin:0;letter-spacing:.2px;}'
    + 'p#msg{font-size:13px;color:#8b949e;margin:8px 0 0;text-align:center;padding:0 24px;}'
    + '.bar{width:280px;height:5px;background:#21262d;border-radius:99px;'
    + 'margin-top:14px;overflow:hidden;display:none;}'
    + '.bar.show{display:block;}'
    + '.bar-fill{height:100%;background:linear-gradient(90deg,#2ea043,#3fb950);'
    + 'width:0%;transition:width .3s ease;border-radius:99px;}'
    + 'small{font-size:11px;color:#6e7681;margin-top:14px;}'
    + '</style></head><body>'
    + '<div class="spinner"></div>'
    + '<h1>Cartera de Préstamos</h1>'
    + '<p id="msg">Buscando actualizaciones...</p>'
    + '<div class="bar" id="bar"><div class="bar-fill" id="fill"></div></div>'
    + '<small>v' + version + '</small>'
    + '</body></html>';
  w.loadURL('data:text/html;charset=UTF-8,' + encodeURIComponent(html));
  return w;
}

function updateSplashMessage(msg, percent) {
  if (!splashWin || splashWin.isDestroyed()) return;
  const safe = String(msg || '').replace(/'/g, "\\'").replace(/\\/g, '\\\\');
  const showBar = typeof percent === 'number';
  const pctClamped = Math.min(100, Math.max(0, percent || 0));
  const code = `
    (function(){
      var m = document.getElementById('msg'); if (m) m.textContent = '${safe}';
      var b = document.getElementById('bar'); var f = document.getElementById('fill');
      if (b && f) {
        ${showBar ? "b.classList.add('show'); f.style.width = '" + pctClamped + "%';" : "b.classList.remove('show');"}
      }
    })();
  `;
  splashWin.webContents.executeJavaScript(code).catch(() => {});
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
        'User-Agent': 'cartera-prestamos',
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
    const json = await httpsGetJson('https://api.github.com/repos/xJp-P/cartera-prestamos/releases/latest');
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

// ── Check de updates aislado (con timeout 60s) ───────────────────────────
async function checkForUpdatesAtBoot() {
  if (!app.isPackaged) return 'skip';
  return new Promise((resolve) => {
    let resolved = false;
    const finalize = (decision) => {
      if (resolved) return;
      resolved = true;
      resolve(decision);
    };
    const timer = setTimeout(() => finalize('skip'), 60000);

    if (process.platform === 'darwin') {
      checkMacUpdateAvailable().then(d => { clearTimeout(timer); finalize(d); })
        .catch(() => { clearTimeout(timer); finalize('skip'); });
    } else {
      autoUpdater.once('update-available', (info) => {
        clearTimeout(timer);
        macUpdateVersion = info.version;
        finalize('install');
      });
      autoUpdater.once('update-not-available', () => { clearTimeout(timer); finalize('skip'); });
      autoUpdater.once('error', () => { clearTimeout(timer); finalize('skip'); });
      try { autoUpdater.checkForUpdates(); }
      catch(_) { clearTimeout(timer); finalize('skip'); }
    }
  });
}

// ── Mac: descarga + instalacion automatica al arrancar ──────────────────
async function macDownloadAndInstallAtBoot(version) {
  const zipUrl = `https://github.com/xJp-P/cartera-prestamos/releases/download/v${version}/Instalador-Mac-${version}.zip`;
  const tmpDir = path.join(os.tmpdir(), 'cartera-update-' + Date.now());
  const zipPath = path.join(tmpDir, 'update.zip');
  fs.mkdirSync(tmpDir, { recursive: true });

  updateSplashMessage('Descargando v' + version + '...', 0);

  await new Promise((resolve, reject) => {
    httpsGet(zipUrl).then((res) => {
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let downloaded = 0;
      const file = fs.createWriteStream(zipPath);
      res.on('data', (chunk) => {
        downloaded += chunk.length;
        if (total > 0) updateSplashMessage('Descargando v' + version + '...', Math.round((downloaded/total)*100));
      });
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
      file.on('error', reject);
    }).catch(reject);
  });

  updateSplashMessage('Instalando v' + version + '...', 100);
  execSync(`unzip -o -q "${zipPath}" -d "${tmpDir}"`);
  const extractedApp = path.join(tmpDir, 'Cartera de Prestamos.app');
  if (!fs.existsSync(extractedApp)) throw new Error('No se encontro la app en el zip');
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

// ── Orquestador de boot: 4 fases ─────────────────────────────────────────
app.whenReady().then(async () => {
  // FASE 1: prefs + DB_PATH ya resueltos (top-level), nada conectado todavia.

  // FASE 2: splash inmediato (BD intacta)
  splashWin = createSplashWindow();

  // FASE 3: check de updates aislado (max 60s)
  const decision = await checkForUpdatesAtBoot();

  if (decision === 'install') {
    // FASE 4a: hay update — instalar SIN tocar BD
    updateSplashMessage('Actualizacion v' + macUpdateVersion + ' encontrada. Descargando...', 0);
    try {
      if (process.platform === 'darwin') {
        await macDownloadAndInstallAtBoot(macUpdateVersion);
        return; // app se cierra
      } else {
        await new Promise((resolve, reject) => {
          autoUpdater.on('download-progress', (prog) => {
            updateSplashMessage('Descargando v' + macUpdateVersion + '...', Math.round(prog.percent));
          });
          autoUpdater.once('update-downloaded', () => {
            updateSplashMessage('Instalando v' + macUpdateVersion + '...');
            setTimeout(() => autoUpdater.quitAndInstall(false, true), 1000);
            // app sale, no se resuelve
          });
          autoUpdater.once('error', reject);
          autoUpdater.downloadUpdate().catch(reject);
        });
        return;
      }
    } catch(err) {
      // Fallback: si falla la actualizacion, arrancar normal despues de 3s
      updateSplashMessage('Error al actualizar: ' + (err.message || 'desconocido') + '. Continuando con la version actual...');
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  // FASE 4b: sin update (o fallback) — arranque normal
  updateSplashMessage('Iniciando aplicacion...');
  startBackend();
  mainWin = await createWindow();
  if (splashWin && !splashWin.isDestroyed()) {
    splashWin.close();
    splashWin = null;
  }
});

app.on('window-all-closed', () => { if (server) server.close(); app.quit(); });
