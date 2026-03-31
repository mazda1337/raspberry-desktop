const { contextBridge, ipcRenderer } = require('electron');

// Magnet Input API для безопасного взаимодействия с main process
contextBridge.exposeInMainWorld('magnetAPI', {
  // SEND (renderer -> main)
  submitResult: (result) => ipcRenderer.send('magnet-input-result', result),

  // CLEANUP
  removeAllListeners: () => {
    // No listeners to clean up for this window
  }
});
