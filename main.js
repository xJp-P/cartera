const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs   = require('fs');
const http  = require('http');

const PORT = 3420;

// ── Ruta de preferencias (siempre en userData, nunca se mueve) ────────────
const PREFS_FILE = path.join(
  app.isPackaged ? app.getPath('userData') : __dirname,
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
  : path.join(__dirname, 'cartera.db');

const DB_PATH = prefs.dbPath && fs.existsSync(path.dirname(prefs.dbPath))
  ? prefs.dbPath
  : defaultDB;

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

const expressApp = require('./server')(DB_PATH);
const server     = http.createServer(expressApp);
server.listen(PORT, '127.0.0.1');

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
  const newPath = path.join(newFolder, 'cartera.db');
  const destExists = fs.existsSync(newPath);
  if (newPath !== DB_PATH && !destExists && fs.existsSync(DB_PATH)) {
    // Solo copiar si el destino NO tiene BD aún
    fs.copyFileSync(DB_PATH, newPath);
  }
  const p = loadPrefs();
  p.dbPath = newPath;
  // Solo borrar la BD original si la copiamos nosotros (no si el destino ya existía)
  p.pendingDelete = (newPath !== DB_PATH && !destExists) ? DB_PATH : null;
  savePrefs(p);
  return newPath;
});

ipcMain.handle('reset-db-path', () => {
  const cur = loadPrefs();
  const oldPath = cur.dbPath;
  // Copiar BD de vuelta a la ruta por defecto
  if (oldPath && fs.existsSync(oldPath) && oldPath !== defaultDB) {
    fs.copyFileSync(oldPath, defaultDB);
  }
  // Guardar prefs: borrar dbPath + marcar pendingDelete
  delete cur.dbPath;
  cur.pendingDelete = oldPath && oldPath !== defaultDB ? oldPath : null;
  savePrefs(cur);
  return defaultDB;
});

ipcMain.handle('relaunch-app', () => {
  app.relaunch();
  app.quit();
});

// ── Ventana principal ─────────────────────────────────────────────────────
async function createWindow() {
  const win = new BrowserWindow({
    width: 460, height: 860, minWidth: 400, minHeight: 640,
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

  await waitForServer(`http://127.0.0.1:${PORT}/`);
  await win.loadURL(`http://127.0.0.1:${PORT}`);
  win.show();

  win.on('closed', () => { server.close(); app.quit(); });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { server.close(); app.quit(); });
