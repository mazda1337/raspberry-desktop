const { contextBridge, ipcRenderer } = require('electron');

// Wizard API для безопасного взаимодействия с main process
contextBridge.exposeInMainWorld('wizardAPI', {
  // SEND (renderer -> main)
  selectServer: (data) => ipcRenderer.send('server-selected', data),
  selectFiles: (data) => ipcRenderer.send('files-selected', data),
  selectPlayer: (data) => ipcRenderer.send('player-selected', data),
  savePlaylist: (data) => ipcRenderer.send('save-playlist', data),
  copyMagnet: (data) => ipcRenderer.send('copy-magnet', data),
  downloadFile: (data) => ipcRenderer.send('download-file', data),
  choosePlayerPath: () => ipcRenderer.send('choose-player-path'),
  getExternalPlayerInfo: () => ipcRenderer.send('get-external-player-info'),

  // RECEIVE (main -> renderer)
  onInitWizard: (callback) => ipcRenderer.on('init-wizard', (event, data) => callback(data)),
  onStepProgress: (callback) => ipcRenderer.on('step-progress', (event, data) => callback(data)),
  onTorrentAdded: (callback) => ipcRenderer.on('torrent-added', (event, data) => callback(data)),
  onFilesReceived: (callback) => ipcRenderer.on('files-received', (event, data) => callback(data)),
  onPlayerLaunched: (callback) => ipcRenderer.on('player-launched', (event, data) => callback(data)),
  onExternalPlayerUpdated: (callback) => ipcRenderer.on('external-player-updated', (event, data) => callback(data)),
  onExternalPlayerInfo: (callback) => ipcRenderer.on('external-player-info', (event, data) => callback(data)),
  onStatsUpdate: (callback) => ipcRenderer.on('stats-update', (event, data) => callback(data)),
  onServersData: (callback) => ipcRenderer.on('servers-data', (event, data) => callback(data)),
  onError: (callback) => ipcRenderer.on('error', (event, data) => callback(data)),
  onPlayerPathSelected: (callback) => ipcRenderer.on('player-path-selected', (event, data) => callback(data)),
  onAutoChoosePlayer: (callback) => ipcRenderer.on('auto-choose-player', (event, data) => callback(data)),

  // CLEANUP
  removeAllListeners: () => {
    const channels = [
      'init-wizard',
      'step-progress',
      'torrent-added',
      'files-received',
      'player-launched',
      'external-player-updated',
      'external-player-info',
      'stats-update',
      'servers-data',
      'error',
      'player-path-selected',
      'auto-choose-player'
    ];
    channels.forEach(channel => ipcRenderer.removeAllListeners(channel));
  }
});
