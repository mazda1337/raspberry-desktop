const { contextBridge, ipcRenderer } = require('electron');

// Auth API для безопасного взаимодействия с main process
contextBridge.exposeInMainWorld('authAPI', {
  // INVOKE (request-response)
  getStoredCredentials: () => ipcRenderer.invoke('get-stored-credentials'),

  // SEND (renderer -> main)
  submitAuth: (data) => ipcRenderer.send('auth-submitted', data),
  cancelAuth: () => ipcRenderer.send('auth-cancelled'),
  showInputContextMenu: () => ipcRenderer.send('show-input-context-menu'),

  // RECEIVE (main -> renderer)
  onAuthError: (callback) => ipcRenderer.on('auth-error', (event, message) => callback(message)),

  // CLEANUP
  removeAllListeners: () => {
    ipcRenderer.removeAllListeners('auth-error');
  }
});
