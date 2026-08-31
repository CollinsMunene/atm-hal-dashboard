const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { exec, spawn, execFile } = require('child_process');
const { SerialPort } = require('serialport');
const EventSource = require('eventsource');

// ---------- Sidecar service locations ----------
// ASSUMPTION: nv200-smart-payout and custom-k80-printer are checked out as
// sibling directories next to this repo (confirmed true in this workspace).
// Override via env vars if that's not the case on a given machine.
const NV200_SERVICE_DIR = process.env.NV200_SERVICE_DIR || path.join(__dirname, '..', 'nv200-smart-payout');
const NV200_PYTHON = process.env.NV200_PYTHON || 'python3';
const NV200_HTTP_HOST = '127.0.0.1';
const NV200_HTTP_PORT = process.env.NV200_HTTP_PORT || '8787'; // server.py's own default
const NV200_BASE_URL = `http://${NV200_HTTP_HOST}:${NV200_HTTP_PORT}`;

const K80_SERVICE_DIR = process.env.K80_SERVICE_DIR || path.join(__dirname, '..', 'custom-k80-printer');
const K80_PYTHON = process.env.K80_PYTHON || 'python3';

let mainWindow;
let recyclerProc = null;
let recyclerEventSource = null;

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
app.on('window-all-closed', () => {
  killRecyclerProcess();
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', killRecyclerProcess);

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// ---------- List available serial ports (so the UI can offer a dropdown, not a guess) ----------
ipcMain.handle('ports:list', async () => {
  const ports = await SerialPort.list();
  return ports.map(p => ({ path: p.path, manufacturer: p.manufacturer || 'unknown' }));
});

// ---------- Recycler (nv200-smart-payout sidecar: REST + SSE over eSSP) ----------
// main.js no longer speaks eSSP directly. It spawns server.py (which owns the
// serial connection + encryption handshake + payout routing), waits for it to
// come up, then talks to it over HTTP/SSE. See the integration summary for
// what this deliberately does NOT do (no serial-number endpoint exists on the
// service; encryption is always-on in server.py's startup(), so there's no
// "useEncryption" toggle anymore).

function killRecyclerProcess() {
  if (recyclerEventSource) {
    try { recyclerEventSource.close(); } catch (_) {}
    recyclerEventSource = null;
  }
  if (recyclerProc) {
    try { recyclerProc.kill(); } catch (_) {}
    recyclerProc = null;
  }
}

async function waitForRecyclerUp(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (recyclerProc && recyclerProc.exitCode !== null) {
      throw new Error('recycler service process exited during startup - see log for its stderr');
    }
    try {
      const res = await fetch(`${NV200_BASE_URL}/status`);
      if (res.ok) return await res.json();
    } catch (_) {
      // service not listening yet - keep polling
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('timed out waiting for recycler service to become ready');
}

ipcMain.handle('recycler:connect', async (event, { port }) => {
  killRecyclerProcess();
  let stderrTail = '';

  try {
    recyclerProc = spawn(NV200_PYTHON, ['server.py'], {
      cwd: NV200_SERVICE_DIR,
      env: {
        ...process.env,
        NV200_SERIAL_PORT: port,
        HTTP_HOST: NV200_HTTP_HOST,
        HTTP_PORT: String(NV200_HTTP_PORT),
      },
    });

    recyclerProc.stdout.on('data', (d) => send('log', `[recycler-svc] ${d.toString().trim()}`));
    recyclerProc.stderr.on('data', (d) => {
      stderrTail = d.toString();
      send('log', `[recycler-svc] ${d.toString().trim()}`);
    });
    recyclerProc.on('exit', (code) => {
      send('log', `[recycler-svc] process exited (${code})`);
      if (recyclerProc) {
        recyclerProc = null;
        send('recycler:status', { connected: false, error: code !== 0 ? stderrTail.trim() || `exited (${code})` : undefined });
      }
    });
    recyclerProc.on('error', (err) => {
      send('log', `[recycler-svc] failed to start: ${err.message}`);
    });

    const status = await waitForRecyclerUp();
    send('log', `[recycler] service up - protocol v${status.protocol_version}, unit ${status.unit_type}`);

    const enableRes = await fetch(`${NV200_BASE_URL}/enable`, { method: 'POST' });
    const enableBody = await enableRes.json();
    if (!enableRes.ok || enableBody.success === false) {
      throw new Error(enableBody.error || 'enable failed');
    }
    send('log', '[recycler] note acceptance enabled, polling started');

    recyclerEventSource = new EventSource(`${NV200_BASE_URL}/events`);
    recyclerEventSource.onmessage = (msg) => {
      try {
        const parsedEvent = JSON.parse(msg.data);
        send('log', `[recycler] ${parsedEvent.name} ${JSON.stringify(parsedEvent)}`);
        send('recycler:event', { name: parsedEvent.name, result: parsedEvent });
      } catch (e) {
        send('log', `[recycler] unparseable SSE payload: ${msg.data}`);
      }
    };
    recyclerEventSource.onerror = () => {
      send('log', '[recycler] SSE stream error (auto-reconnecting)');
    };

    send('recycler:status', {
      connected: true,
      protocolVersion: status.protocol_version,
      unitType: status.unit_type,
      encrypted: status.encrypted,
    });
    return { ok: true, protocolVersion: status.protocol_version, unitType: status.unit_type };
  } catch (err) {
    killRecyclerProcess();
    send('recycler:status', { connected: false, error: err.message });
    send('log', `[recycler] connect failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('recycler:disconnect', async () => {
  if (recyclerProc) {
    try { await fetch(`${NV200_BASE_URL}/disable`, { method: 'POST' }); } catch (_) {}
  }
  killRecyclerProcess();
  send('recycler:status', { connected: false });
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

// ---------- Printer: K80 raw-USB diagnostics (new - shells out to custom-k80-printer's
// staged CLI, test_k80.py, since that package has no HTTP layer of its own; see the
// integration summary for why this wasn't built as an HTTP client instead) ----------
function runK80Test(args) {
  return new Promise((resolve) => {
    execFile(K80_PYTHON, ['test_k80.py', ...args], { cwd: K80_SERVICE_DIR, timeout: 15000 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, error: (stderr || err.message).trim(), output: (stdout || '').trim() });
        return;
      }
      resolve({ ok: true, output: stdout.trim() });
    });
  });
}

ipcMain.handle('printer:k80ListDevices', async () => {
  const result = await runK80Test(['--list']);
  if (result.ok) {
    result.foundTarget = result.output.includes('<-- default K80 target');
    send('log', `[k80] ${result.output.replace(/\n/g, ' | ')}`);
  } else {
    send('log', `[k80] --list failed: ${result.error}`);
  }
  return result;
});

ipcMain.handle('printer:k80Init', async () => {
  const result = await runK80Test(['--init']);
  send('log', result.ok ? '[k80] init OK (ESC @ sent)' : `[k80] init failed: ${result.error}`);
  return result;
});
