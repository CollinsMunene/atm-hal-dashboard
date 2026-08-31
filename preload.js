const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hal', {
  listPorts: () => ipcRenderer.invoke('ports:list'),

  connectRecycler: (opts) => ipcRenderer.invoke('recycler:connect', opts),
  disconnectRecycler: () => ipcRenderer.invoke('recycler:disconnect'),
  onRecyclerStatus: (cb) => ipcRenderer.on('recycler:status', (_e, data) => cb(data)),
  onRecyclerEvent: (cb) => ipcRenderer.on('recycler:event', (_e, data) => cb(data)),

  listWindowsPrinters: () => ipcRenderer.invoke('printer:listWindows'),
  rawTestPrint: (opts) => ipcRenderer.invoke('printer:rawTestPrint', opts),

  k80ListDevices: () => ipcRenderer.invoke('printer:k80ListDevices'),
  k80Init: () => ipcRenderer.invoke('printer:k80Init'),

  onLog: (cb) => ipcRenderer.on('log', (_e, line) => cb(line)),
});
