const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods for renderer process
contextBridge.exposeInMainWorld('electronAPI', {
    platform: process.platform,
    setFullScreen: (flag) => ipcRenderer.invoke('set-fullscreen', flag),
    onFullScreenChange: (cb) => {
        ipcRenderer.on('fullscreen-changed', (_e, isFullScreen) => cb(isFullScreen));
    },
    openFile: (filePath) => ipcRenderer.invoke('open-file', filePath),
    saveAndOpenPDF: (buffer, filename) => ipcRenderer.invoke('save-and-open-pdf', buffer, filename),
    saveLoadSheetPDF: (buffer, filename) => ipcRenderer.invoke('save-load-sheet-pdf', buffer, filename),
    openLoadSheetsFolder: () => ipcRenderer.invoke('open-load-sheets-folder')
});

