const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { exec } = require('child_process');
const { SerialPort } = require('serialport');
const sspLib = require('encrypted-smiley-secure-protocol');

let mainWindow;
let eSSP = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 750,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile('index.html');
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// ---------- List available serial ports (so the UI can offer a dropdown, not a guess) ----------
ipcMain.handle('ports:list', async () => {
  const ports = await SerialPort.list();
  return ports.map(p => ({ path: p.path, manufacturer: p.manufacturer || 'unknown' }));
});

// ---------- Recycler (SSP/eSSP) ----------
ipcMain.handle('recycler:connect', async (event, { port, useEncryption, fixedKey }) => {
  return new Promise((resolve) => {
    try {
      if (eSSP) { try { eSSP.close(); } catch (_) {} }

      eSSP = new sspLib({ id: 0x00, debug: false, timeout: 3000, fixedKey: fixedKey || '0123456701234567' });

      eSSP.on('OPEN', async () => {
        send('log', `[recycler] port ${port} open, starting handshake`);
        try {
          await eSSP.command('SYNC');
          await eSSP.command('HOST_PROTOCOL_VERSION', { version: 6 });
          if (useEncryption) {
            await eSSP.initEncryption();
            send('log', '[recycler] encryption handshake OK (eSSP)');
          }
          const serial = await eSSP.command('GET_SERIAL_NUMBER');
          await eSSP.enable();
          send('recycler:status', { connected: true, serialNumber: serial.info.serial_number, enabled: true });
          send('log', `[recycler] connected - serial ${serial.info.serial_number}`);
          resolve({ ok: true, serialNumber: serial.info.serial_number });
        } catch (err) {
          send('recycler:status', { connected: false, error: err.message });
          send('log', `[recycler] handshake failed: ${err.message}`);
          resolve({ ok: false, error: err.message });
        }
      });

      // Event stream - these fire continuously once enabled; forward all of them to the dashboard log + status
      const forward = (name) => eSSP.on(name, (result) => {
        send('log', `[recycler] ${name} ${result ? JSON.stringify(result) : ''}`);
        send('recycler:event', { name, result });
      });
      ['READ_NOTE', 'CREDIT_NOTE', 'NOTE_REJECTED', 'NOTE_REJECTING', 'SAFE_NOTE_JAM',
       'UNSAFE_NOTE_JAM', 'DISABLED', 'STACKER_FULL', 'FRAUD_ATTEMPT'].forEach(forward);

      eSSP.on('CLOSE', () => send('recycler:status', { connected: false }));

      eSSP.open(port);
    } catch (err) {
      resolve({ ok: false, error: err.message });
    }
  });
});

ipcMain.handle('recycler:disconnect', async () => {
  if (eSSP) { try { eSSP.close(); } catch (_) {} eSSP = null; }
  return { ok: true };
});

// ---------- Printer: Windows spooler status ----------
ipcMain.handle('printer:listWindows', async () => {
  return new Promise((resolve) => {
    // PowerShell Get-Printer avoids adding another native-module dependency on top of serialport
    exec('powershell -Command "Get-Printer | Select-Object Name,PrinterStatus,WorkOffline | ConvertTo-Json"',
      { windowsHide: true }, (err, stdout) => {
        if (err) { resolve({ ok: false, error: err.message }); return; }
        try {
          let parsed = JSON.parse(stdout || '[]');
          if (!Array.isArray(parsed)) parsed = [parsed];
          resolve({ ok: true, printers: parsed });
        } catch (e) {
          resolve({ ok: false, error: 'Could not parse printer list: ' + e.message });
        }
      });
  });
});

// ---------- Printer: raw ESC/POS test print over a serial/USB-serial port ----------
ipcMain.handle('printer:rawTestPrint', async (event, { port }) => {
  return new Promise((resolve) => {
    try {
      const sp = new SerialPort({ path: port, baudRate: 9600 }, (err) => {
        if (err) { resolve({ ok: false, error: err.message }); return; }

        const ESC_INIT = Buffer.from([0x1B, 0x40]);               // ESC @ — initialize
        const TEXT = Buffer.from('ATM HAL Dashboard\nTest print OK\n\n\n', 'ascii');
        const CUT = Buffer.from([0x1D, 0x56, 0x00]);               // GS V 0 — full cut (adjust if your model differs)

        sp.write(Buffer.concat([ESC_INIT, TEXT, CUT]), (writeErr) => {
          if (writeErr) { resolve({ ok: false, error: writeErr.message }); sp.close(); return; }
          send('log', `[printer] raw ESC/POS test sent to ${port}`);
          sp.close(() => resolve({ ok: true }));
        });
      });
    } catch (err) {
      resolve({ ok: false, error: err.message });
    }
  });
});
