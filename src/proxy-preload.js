const { contextBridge, ipcRenderer } = require('electron');

// Proxy Settings API для безопасного взаимодействия с main process
contextBridge.exposeInMainWorld('electronAPI', {
  getProxySettings: () => ipcRenderer.invoke('get-proxy-settings'),
  saveProxySettings: (settings) => ipcRenderer.invoke('save-proxy-settings', settings),
  closeProxyWindow: () => ipcRenderer.send('close-proxy-window'),
});
