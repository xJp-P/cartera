const { app, BrowserWindow } = require('electron');
const path = require('path');
const http = require('http');

const PORT = 3420;

const DB_PATH = app.isPackaged
  ? path.join(path.dirname(app.getPath('exe')), 'cartera.db')
  : path.join(__dirname, 'cartera.db');

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

async function createWindow() {
  const win = new BrowserWindow({
    width: 460, height: 860, minWidth: 400, minHeight: 640,
    title: 'Cartera de Prestamos',
    backgroundColor: '#0d1117',
    autoHideMenuBar: true,
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  win.setMenu(null);

  await waitForServer(`http://127.0.0.1:${PORT}/`);
  await win.loadURL(`http://127.0.0.1:${PORT}`);
  win.show();

  win.on('closed', () => { server.close(); app.quit(); });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { server.close(); app.quit(); });
