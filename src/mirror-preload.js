const { contextBridge, ipcRenderer } = require('electron');

// Mirror Selection API для безопасного взаимодействия с main process
contextBridge.exposeInMainWorld('mirrorAPI', {
  // INVOKE (request-response)
  getAppConfig: () => ipcRenderer.invoke('get-app-config'),
  getStoredMirror: () => ipcRenderer.invoke('get-stored-mirror'),
  getMirrorsList: () => ipcRenderer.invoke('get-mirrors-list'),

  // SEND (renderer -> main)
  selectMirror: (url) => ipcRenderer.send('mirror-selected', url),
  cancel: () => ipcRenderer.send('mirror-cancelled'),

  // CLEANUP
  removeAllListeners: () => {
    // No listeners to clean up for this window
  }
});
