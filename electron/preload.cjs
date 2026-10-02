const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('openbot', {
  isApp: true,
  platform: process.platform,
  setTheme: (mode) => ipcRenderer.send('theme', mode),
});
