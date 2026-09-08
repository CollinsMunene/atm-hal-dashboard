const { contextBridge, ipcRenderer } = require('electron');

// Loaded defensively: if `npm install` hasn't picked up this dependency yet,
// a hard `require('jsqr')` here would throw and take down preload.js
// entirely - which silently breaks window.hal for every peripheral, not
// just the QR scanner. Fail soft instead: only QR decoding is unavailable.
let jsQR = null;
try {
  jsQR = require('jsqr');
} catch (err) {
  console.error('[preload] jsqr not available (run `npm install`?):', err.message);
}

contextBridge.exposeInMainWorld('hal', {
  // Renderer has no Node access (contextIsolation/nodeIntegration off), so
  // the QR decode itself happens here in preload (which does have Node
  // access) - the renderer just hands over raw pixel data from a canvas.
  decodeQR: (pixels, width, height) => {
    if (!jsQR) throw new Error("jsqr not installed - run 'npm install' and restart");
    return jsQR(pixels, width, height);
  },
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
