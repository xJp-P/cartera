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

let expressApp, server;
let serverError = null;
try {
  expressApp = require('../backend/server')(DB_PATH);
  server = http.createServer(expressApp);
  server.listen(PORT, '127.0.0.1');
} catch(err) {
  serverError = 'Error al iniciar el servidor:\n' + err.message;
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
let macUpdateVersion = null;

function sendUpdateStatus(status, info) {
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

app.whenReady().then(async () => {
  mainWin = await createWindow();
  if (!mainWin) return;
  // Chequear updates 3s después de arrancar
  if (app.isPackaged) {
    setTimeout(() => autoUpdater.checkForUpdates(), 3000);
  }
});
app.on('window-all-closed', () => { if (server) server.close(); app.quit(); });
