const { contextBridge, ipcRenderer } = require('electron');
const jsQR = require('jsqr');

contextBridge.exposeInMainWorld('hal', {
  // Renderer has no Node access (contextIsolation/nodeIntegration off), so
  // the QR decode itself happens here in preload (which does have Node
  // access) - the renderer just hands over raw pixel data from a canvas.
  decodeQR: (pixels, width, height) => jsQR(pixels, width, height),
  listPorts: () => ipcRenderer.invoke('ports:list'),

  connectRecycler: (opts) => ipcRenderer.invoke('recycler:connect', opts),
  disconnectRecycler: () => ipcRenderer.invoke('recycler:disconnect'),
  onRecyclerStatus: (cb) => ipcRenderer.on('recycler:status', (_e, data) => cb(data)),
  onRecyclerEvent: (cb) => ipcRenderer.on('recycler:event', (_e, data) => cb(data)),

  getDenominations: () => ipcRenderer.invoke('recycler:denominations'),
  payout: (opts) => ipcRenderer.invoke('recycler:payout', opts),
  floatAmount: (opts) => ipcRenderer.invoke('recycler:float', opts),
  smartEmpty: () => ipcRenderer.invoke('recycler:smartEmpty'),
  haltPayout: () => ipcRenderer.invoke('recycler:halt'),

  listWindowsPrinters: () => ipcRenderer.invoke('printer:listWindows'),
  rawTestPrint: (opts) => ipcRenderer.invoke('printer:rawTestPrint', opts),

  k80ListDevices: () => ipcRenderer.invoke('printer:k80ListDevices'),
  k80Init: () => ipcRenderer.invoke('printer:k80Init'),
  k80Selftest: () => ipcRenderer.invoke('printer:k80Selftest'),
  k80Text: () => ipcRenderer.invoke('printer:k80Text'),
  k80Barcode: () => ipcRenderer.invoke('printer:k80Barcode'),
  k80Qrcode: () => ipcRenderer.invoke('printer:k80Qrcode'),
  k80Cut: (opts) => ipcRenderer.invoke('printer:k80Cut', opts),
  k80Receipt: () => ipcRenderer.invoke('printer:k80Receipt'),
  k80Image: () => ipcRenderer.invoke('printer:k80Image'),

  onLog: (cb) => ipcRenderer.on('log', (_e, line) => cb(line)),
});
