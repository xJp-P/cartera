const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getDbPath:   () => ipcRenderer.invoke('get-db-path'),
  pickDbFolder:() => ipcRenderer.invoke('pick-db-folder'),
  setDbPath:   (folder) => ipcRenderer.invoke('set-db-path', folder),
  resetDbPath: () => ipcRenderer.invoke('reset-db-path'),
  relaunch:    () => ipcRenderer.invoke('relaunch-app'),
  // Auto-updater
  getAppVersion:   () => ipcRenderer.invoke('get-app-version'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  downloadUpdate:  () => ipcRenderer.invoke('download-update'),
  installUpdate:   () => ipcRenderer.invoke('install-update'),
  onUpdateStatus:  (cb) => {
    ipcRenderer.on('update-status', (_e, data) => cb(data));
    return () => ipcRenderer.removeAllListeners('update-status');
  }
});
