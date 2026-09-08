const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { exec, spawn, execFile } = require('child_process');
const { SerialPort } = require('serialport');
const EventSource = require('eventsource');

// ---------- Sidecar service locations ----------
// ASSUMPTION: nv200-smart-payout and custom-k80-printer are checked out as
// sibling directories next to this repo (confirmed true in this workspace).
// Override via env vars if that's not the case on a given machine.
const NV200_SERVICE_DIR = process.env.NV200_SERVICE_DIR || path.join(__dirname, '..', 'nv200-smart-payout');
const NV200_HTTP_HOST = '127.0.0.1';
const NV200_HTTP_PORT = process.env.NV200_HTTP_PORT || '8787'; // server.py's own default
const NV200_BASE_URL = `http://${NV200_HTTP_HOST}:${NV200_HTTP_PORT}`;

const K80_SERVICE_DIR = process.env.K80_SERVICE_DIR || path.join(__dirname, '..', 'custom-k80-printer');

// ---------- Python interpreter resolution ----------
// 'python3' is the right default on macOS/Linux, but on Windows it's frequently
// just the Microsoft Store app-execution-alias stub (which exits immediately
// with "Python was not found..." instead of running anything) even when a real
// Python is installed under a different name. Probe a platform-appropriate list
// of candidates and cache whichever one actually runs, so both sidecars work
// without every machine needing NV200_PYTHON/K80_PYTHON set by hand. An
// explicit env var override always wins and is never probed.
const PYTHON_CANDIDATES = process.platform === 'win32'
  ? ['py', 'python', 'python3']
  : ['python3', 'python'];
const resolvedPythonCache = {};

function canRunPython(cmd) {
  return new Promise((resolve) => {
    execFile(cmd, ['--version'], { windowsHide: true, timeout: 5000 }, (err) => resolve(!err));
  });
}

async function resolvePython(envVarName) {
  if (resolvedPythonCache[envVarName]) return resolvedPythonCache[envVarName];

  const override = process.env[envVarName];
  if (override) {
    resolvedPythonCache[envVarName] = override;
    return override;
  }

  for (const candidate of PYTHON_CANDIDATES) {
    if (await canRunPython(candidate)) {
      resolvedPythonCache[envVarName] = candidate;
      return candidate;
    }
  }

  // Nothing on PATH actually runs - fall back to the first candidate so the
  // resulting ENOENT/stub error at least names what was tried.
  resolvedPythonCache[envVarName] = PYTHON_CANDIDATES[0];
  return PYTHON_CANDIDATES[0];
}

let mainWindow;
let recyclerProc = null;
let recyclerEventSource = null;
// Denomination metadata from /status (real_value_multiplier, country_code,
// channel_value, number_of_channels) - needed to convert real currency
// amounts into the wire units /payout and /float expect. Refreshed on
// every connect and every /status-backed response.
let recyclerInfo = null;

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
  recyclerInfo = null;
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
    const nv200Python = await resolvePython('NV200_PYTHON');
    send('log', `[recycler-svc] using python interpreter: ${nv200Python}`);
    recyclerProc = spawn(nv200Python, ['server.py'], {
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
    recyclerInfo = status;
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
      countryCode: status.country_code,
      realValueMultiplier: status.real_value_multiplier,
      channelValue: status.channel_value,
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

// ---------- Recycler: denominations (stock + routing, in real currency units) ----------
ipcMain.handle('recycler:denominations', async () => {
  if (!recyclerProc) return { ok: false, error: 'not connected' };
  try {
    const res = await fetch(`${NV200_BASE_URL}/denominations`);
    const body = await res.json();
    if (!res.ok || body.success === false) throw new Error(body.error || 'denominations request failed');
    return { ok: true, denominations: body.denominations };
  } catch (err) {
    send('log', `[recycler] denominations failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
});

// ---------- Recycler: cash-moving commands ----------
// /payout and /float on the sidecar take raw wire units, not real currency
// (see server.py's docstring) - convert here using real_value_multiplier
// from /status, the same conversion test_nv200.py's CLI does client-side.
function toWireAmount(realAmount) {
  const mult = (recyclerInfo && recyclerInfo.real_value_multiplier) || 1;
  return Math.round(Number(realAmount) * mult);
}

async function postRecycler(path, body) {
  if (!recyclerProc) return { ok: false, error: 'not connected' };
  try {
    const res = await fetch(`${NV200_BASE_URL}${path}`, {
      method: 'POST',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const result = await res.json();
    if (!res.ok || result.success === false) {
      throw new Error(result.error || `${path} failed`);
    }
    send('log', `[recycler] ${path} -> ${JSON.stringify(result)}`);
    return { ok: true, result };
  } catch (err) {
    send('log', `[recycler] ${path} failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

ipcMain.handle('recycler:payout', async (event, { amount, currency, test }) => {
  const wireAmount = toWireAmount(amount);
  const countryCode = currency || (recyclerInfo && recyclerInfo.country_code) || 'USD';
  send('log', `[recycler] payout ${amount} ${countryCode} -> wire amount ${wireAmount}${test ? ' (test)' : ''}`);
  return postRecycler('/payout', { amount: wireAmount, country_code: countryCode, test: !!test });
});

ipcMain.handle('recycler:float', async (event, { amount, minPossiblePayout, currency, test }) => {
  const wireAmount = toWireAmount(amount);
  const wireMin = minPossiblePayout ? toWireAmount(minPossiblePayout) : 0;
  const countryCode = currency || (recyclerInfo && recyclerInfo.country_code) || 'USD';
  send('log', `[recycler] float ${amount} ${countryCode} -> wire amount ${wireAmount}${test ? ' (test)' : ''}`);
  return postRecycler('/float', { amount: wireAmount, min_possible_payout: wireMin, country_code: countryCode, test: !!test });
});

ipcMain.handle('recycler:smartEmpty', async () => postRecycler('/smart-empty'));

ipcMain.handle('recycler:halt', async () => postRecycler('/halt'));

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
async function runK80Test(args) {
  const k80Python = await resolvePython('K80_PYTHON');
  return new Promise((resolve) => {
    execFile(k80Python, ['test_k80.py', ...args], { cwd: K80_SERVICE_DIR, timeout: 15000 }, (err, stdout, stderr) => {
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

ipcMain.handle('printer:k80Selftest', async () => {
  const result = await runK80Test(['--selftest']);
  send('log', result.ok ? '[k80] selftest passed (no hardware needed)' : `[k80] selftest failed: ${result.error}`);
  return result;
});

ipcMain.handle('printer:k80Text', async () => {
  const result = await runK80Test(['--text']);
  send('log', result.ok ? '[k80] text formatting block sent' : `[k80] text test failed: ${result.error}`);
  return result;
});

ipcMain.handle('printer:k80Barcode', async () => {
  const result = await runK80Test(['--barcode']);
  send('log', result.ok ? '[k80] CODE128 barcode sent' : `[k80] barcode test failed: ${result.error}`);
  return result;
});

ipcMain.handle('printer:k80Qrcode', async () => {
  const result = await runK80Test(['--qrcode']);
  send('log', result.ok ? '[k80] QR code sent' : `[k80] QR code test failed: ${result.error}`);
  return result;
});

ipcMain.handle('printer:k80Cut', async (event, { mode }) => {
  const cutMode = mode === 'partial' ? 'partial' : 'total';
  const result = await runK80Test(['--cut', cutMode]);
  send('log', result.ok ? `[k80] ${cutMode} cut sent` : `[k80] cut failed: ${result.error}`);
  return result;
});

ipcMain.handle('printer:k80Receipt', async () => {
  const result = await runK80Test(['--receipt']);
  send('log', result.ok ? '[k80] sample deposit receipt sent' : `[k80] receipt test failed: ${result.error}`);
  return result;
});

ipcMain.handle('printer:k80Image', async () => {
  if (!mainWindow) return { ok: false, error: 'no window' };
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Select an image to print on the K80',
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'gif'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths.length) return { ok: false, error: 'cancelled' };
  const result = await runK80Test(['--image', filePaths[0]]);
  send('log', result.ok ? `[k80] image ${filePaths[0]} sent` : `[k80] image test failed: ${result.error}`);
  return result;
});
