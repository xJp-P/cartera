const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getDbPath:   () => ipcRenderer.invoke('get-db-path'),
  pickDbFolder:() => ipcRenderer.invoke('pick-db-folder'),
  setDbPath:   (folder) => ipcRenderer.invoke('set-db-path', folder),
  resetDbPath: () => ipcRenderer.invoke('reset-db-path'),
  relaunch:    () => ipcRenderer.invoke('relaunch-app')
});
