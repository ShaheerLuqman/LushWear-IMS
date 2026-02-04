const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods for renderer process
contextBridge.exposeInMainWorld('electronAPI', {
    platform: process.platform,
    setFullScreen: (flag) => ipcRenderer.invoke('set-fullscreen', flag),
    onFullScreenChange: (cb) => {
        ipcRenderer.on('fullscreen-changed', (_e, isFullScreen) => cb(isFullScreen));
    }
});

