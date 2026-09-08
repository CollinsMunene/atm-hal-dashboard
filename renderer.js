function log(line) {
  const el = document.getElementById('log');
  const div = document.createElement('div');
  const time = new Date().toLocaleTimeString();
  div.textContent = `[${time}] ${line}`;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}
function setDot(id, state) { // state: 'ok' | 'err' | 'pending'
  const el = document.getElementById(id);
  el.className = 'dot ' + state;
}

window.hal.onLog((line) => log(line));

// ---------- Port lists ----------
async function refreshPortLists() {
  const ports = await window.hal.listPorts();
  const recyclerSelect = document.getElementById('recyclerPort');
  const printerSelect = document.getElementById('printerPort');
  recyclerSelect.innerHTML = '';
  printerSelect.innerHTML = '';
  ports.forEach(p => {
    const label = `${p.path} (${p.manufacturer})`;
    recyclerSelect.appendChild(new Option(label, p.path));
    printerSelect.appendChild(new Option(label, p.path));
  });
  if (ports.length === 0) log('[ports] no serial ports found - check connections');
}
document.getElementById('refreshPorts').onclick = refreshPortLists;
refreshPortLists();

// ---------- Recycler ----------
// Connects via the nv200-smart-payout sidecar service (spawned in main.js),
// not directly - see integration summary. Encryption is always-on in that
// service's startup(), so there's no encryption toggle here anymore.
let recyclerCountryCode = 'USD';
let recyclerConnected = false;

document.getElementById('connectRecycler').onclick = async () => {
  const port = document.getElementById('recyclerPort').value;
  if (!port) { log('[recycler] no port selected'); return; }
  setDot('recyclerDot', 'pending');
  log(`[recycler] starting recycler service on ${port}...`);
  const result = await window.hal.connectRecycler({ port });
  if (result.ok) {
    setDot('recyclerDot', 'ok');
    document.getElementById('recyclerValue').textContent =
      `Connected - protocol v${result.protocolVersion}, unit "${result.unitType}"`;
    recyclerConnected = true;
  } else {
    setDot('recyclerDot', 'err');
    document.getElementById('recyclerValue').textContent = `Failed: ${result.error}`;
    recyclerConnected = false;
  }
};
document.getElementById('disconnectRecycler').onclick = async () => {
  await window.hal.disconnectRecycler();
  setDot('recyclerDot', 'pending');
  document.getElementById('recyclerValue').textContent = 'Disconnected.';
  document.getElementById('denominationsValue').textContent = '';
  recyclerConnected = false;
};
window.hal.onRecyclerEvent(({ name, result }) => {
  document.getElementById('recyclerValue').textContent = `Last event: ${name}`;
});
window.hal.onRecyclerStatus((status) => {
  if (status.connected && status.countryCode) {
    recyclerCountryCode = status.countryCode;
    const currencyInput = document.getElementById('payoutCurrency');
    if (!currencyInput.value) currencyInput.value = recyclerCountryCode;
  }
});

// ---------- Recycler: denominations ----------
document.getElementById('refreshDenominations').onclick = async () => {
  const el = document.getElementById('denominationsValue');
  if (!recyclerConnected) { el.textContent = 'Not connected.'; return; }
  el.textContent = 'Loading...';
  const result = await window.hal.getDenominations();
  if (!result.ok) { el.textContent = `Error: ${result.error}`; return; }
  if (!result.denominations.length) { el.textContent = 'No denominations reported.'; return; }
  el.textContent = result.denominations
    .map(d => `${d.value}${d.country_code} x${d.count ?? '?'} (${d.route ?? 'route unknown'})`)
    .join(' | ');
};

// ---------- Recycler: cash-moving commands ----------
// PAYOUT and FLOAT move real cash - confirm before sending unless it's a
// test-only payout (which the device confirms feasibility for without
// dispensing anything).
document.getElementById('payoutBtn').onclick = async () => {
  const el = document.getElementById('payoutValue');
  const amount = Number(document.getElementById('payoutAmount').value);
  const currency = document.getElementById('payoutCurrency').value || recyclerCountryCode;
  const test = document.getElementById('payoutTest').checked;
  if (!recyclerConnected) { el.textContent = 'Not connected.'; return; }
  if (!amount) { el.textContent = 'Enter an amount.'; return; }
  if (!test && !confirm(`Pay out ${amount} ${currency} for real? This dispenses actual cash.`)) return;
  el.textContent = 'Sending...';
  const result = await window.hal.payout({ amount, currency, test });
  el.textContent = result.ok ? `Payout ${test ? '(test) ' : ''}OK: ${JSON.stringify(result.result)}` : `Error: ${result.error}`;
};
document.getElementById('floatBtn').onclick = async () => {
  const el = document.getElementById('payoutValue');
  const amount = Number(document.getElementById('floatAmount').value);
  if (!recyclerConnected) { el.textContent = 'Not connected.'; return; }
  if (!amount) { el.textContent = 'Enter a float amount.'; return; }
  if (!confirm(`Float ${amount} ${recyclerCountryCode} in the unit?`)) return;
  el.textContent = 'Sending...';
  const result = await window.hal.floatAmount({ amount, currency: recyclerCountryCode });
  el.textContent = result.ok ? `Float OK: ${JSON.stringify(result.result)}` : `Error: ${result.error}`;
};
document.getElementById('smartEmptyBtn').onclick = async () => {
  const el = document.getElementById('payoutValue');
  if (!recyclerConnected) { el.textContent = 'Not connected.'; return; }
  if (!confirm('Empty the payout store to the cashbox? This moves all stored cash.')) return;
  el.textContent = 'Sending...';
  const result = await window.hal.smartEmpty();
  el.textContent = result.ok ? `Smart empty OK: ${JSON.stringify(result.result)}` : `Error: ${result.error}`;
};
document.getElementById('haltBtn').onclick = async () => {
  const el = document.getElementById('payoutValue');
  if (!recyclerConnected) { el.textContent = 'Not connected.'; return; }
  el.textContent = 'Sending...';
  const result = await window.hal.haltPayout();
  el.textContent = result.ok ? `Halt OK: ${JSON.stringify(result.result)}` : `Error: ${result.error}`;
};

// ---------- Printer: Windows spooler ----------
document.getElementById('checkWindowsPrinter').onclick = async () => {
  setDot('printerDot', 'pending');
  const result = await window.hal.listWindowsPrinters();
  const el = document.getElementById('printerWinValue');
  if (!result.ok) {
    setDot('printerDot', 'err');
    el.textContent = `Error: ${result.error}`;
    return;
  }
  if (!result.printers.length) {
    setDot('printerDot', 'err');
    el.textContent = 'No printers found in Windows.';
    return;
  }
  const lines = result.printers.map(p => `${p.Name} - status ${p.PrinterStatus} - offline: ${p.WorkOffline}`);
  el.textContent = lines.join(' | ');
  const anyOffline = result.printers.some(p => p.WorkOffline);
  setDot('printerDot', anyOffline ? 'err' : 'ok');
};

// ---------- Printer: raw ESC/POS ----------
document.getElementById('rawTestPrint').onclick = async () => {
  const port = document.getElementById('printerPort').value;
  if (!port) { log('[printer] no port selected for raw test'); return; }
  const el = document.getElementById('printerRawValue');
  el.textContent = 'Sending...';
  const result = await window.hal.rawTestPrint({ port });
  el.textContent = result.ok ? 'Raw ESC/POS test sent - check the physical printout.' : `Failed: ${result.error}`;
};

// ---------- Printer: K80 raw-USB diagnostics (new, via custom-k80-printer's CLI) ----------
document.getElementById('k80List').onclick = async () => {
  const el = document.getElementById('k80Value');
  setDot('k80Dot', 'pending');
  el.textContent = 'Listing USB devices...';
  const result = await window.hal.k80ListDevices();
  if (!result.ok) {
    setDot('k80Dot', 'err');
    el.textContent = `Error: ${result.error}`;
    return;
  }
  setDot('k80Dot', result.foundTarget ? 'ok' : 'err');
  el.textContent = result.foundTarget
    ? 'K80 found on USB (VID 0x0DD4 / PID 0x0237).'
    : 'K80 not found among visible USB devices.';
};
document.getElementById('k80Init').onclick = async () => {
  const el = document.getElementById('k80Value');
  setDot('k80Dot', 'pending');
  el.textContent = 'Sending ESC @...';
  const result = await window.hal.k80Init();
  setDot('k80Dot', result.ok ? 'ok' : 'err');
  el.textContent = result.ok ? 'ESC @ sent OK.' : `Error: ${result.error}`;
};

function runK80Action(button, fn, pendingText, okText) {
  document.getElementById(button).onclick = async () => {
    const el = document.getElementById('k80Value');
    setDot('k80Dot', 'pending');
    el.textContent = pendingText;
    const result = await fn();
    setDot('k80Dot', result.ok ? 'ok' : 'err');
    el.textContent = result.ok ? okText : `Error: ${result.error}`;
  };
}

runK80Action('k80Selftest', () => window.hal.k80Selftest(), 'Running selftest (no hardware needed)...', 'Selftest passed.');
runK80Action('k80Text', () => window.hal.k80Text(), 'Printing text formatting block...', 'Text block sent.');
runK80Action('k80Barcode', () => window.hal.k80Barcode(), 'Printing CODE128 barcode...', 'Barcode sent.');
runK80Action('k80Qrcode', () => window.hal.k80Qrcode(), 'Printing QR code...', 'QR code sent.');
runK80Action('k80Receipt', () => window.hal.k80Receipt(), 'Printing sample deposit receipt...', 'Sample receipt sent.');
runK80Action('k80CutTotal', () => window.hal.k80Cut({ mode: 'total' }), 'Sending total cut...', 'Total cut sent.');
runK80Action('k80CutPartial', () => window.hal.k80Cut({ mode: 'partial' }), 'Sending partial cut...', 'Partial cut sent.');
runK80Action('k80Image', () => window.hal.k80Image(), 'Waiting for file selection...', 'Image sent.');

// ---------- Camera ----------
document.getElementById('startCamera').onclick = async () => {
  setDot('cameraDot', 'pending');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    document.getElementById('cameraPreview').srcObject = stream;
    setDot('cameraDot', 'ok');
    log('[camera] preview started - UVC access confirmed from Electron');
  } catch (err) {
    setDot('cameraDot', 'err');
    log(`[camera] failed: ${err.message}`);
  }
};

// ---------- QR Code Scanner ----------
// Reuses getUserMedia (same as the Camera card) but with its own device
// picker, since a dedicated QR-scanning camera is often a separate UVC
// device from the general preview camera. Decoding itself happens in
// preload.js via jsQR (renderer has no Node access to require it directly).
let qrStream = null;
let qrScanTimer = null;
let qrLastDecodeAt = 0;
const QR_DECODE_INTERVAL_MS = 200;

async function refreshQrDevices() {
  const select = document.getElementById('qrDeviceSelect');
  const previous = select.value;
  select.innerHTML = '';
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter(d => d.kind === 'videoinput');
    cameras.forEach((d, i) => {
      select.appendChild(new Option(d.label || `Camera ${i + 1}`, d.deviceId));
    });
    if (cameras.length === 0) log('[qr] no video input devices found');
    if (previous) select.value = previous;
  } catch (err) {
    log(`[qr] could not enumerate devices: ${err.message}`);
  }
}
document.getElementById('qrRefreshDevices').onclick = refreshQrDevices;
refreshQrDevices();

function stopQrScan() {
  if (qrScanTimer) { cancelAnimationFrame(qrScanTimer); qrScanTimer = null; }
  if (qrStream) { qrStream.getTracks().forEach(t => t.stop()); qrStream = null; }
  document.getElementById('qrPreview').srcObject = null;
}

document.getElementById('qrStart').onclick = async () => {
  stopQrScan();
  setDot('qrDot', 'pending');
  document.getElementById('qrValue').textContent = 'Starting camera...';
  const deviceId = document.getElementById('qrDeviceSelect').value;
  try {
    qrStream = await navigator.mediaDevices.getUserMedia({
      video: deviceId ? { deviceId: { exact: deviceId } } : true,
    });
    const video = document.getElementById('qrPreview');
    video.srcObject = qrStream;
    await refreshQrDevices(); // labels are only populated once permission is granted
    document.getElementById('qrValue').textContent = 'Scanning for QR codes...';
    log('[qr] scan started');

    const canvas = document.getElementById('qrCanvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const tick = async (timestamp) => {
      if (!qrStream) return;
      if (video.videoWidth && timestamp - qrLastDecodeAt >= QR_DECODE_INTERVAL_MS) {
        qrLastDecodeAt = timestamp;
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        try {
          const result = await window.hal.decodeQR(imageData.data, canvas.width, canvas.height);
          if (result) {
            setDot('qrDot', 'ok');
            document.getElementById('qrValue').textContent = `Decoded: ${result.data}`;
            log(`[qr] decoded: ${result.data}`);
          } else {
            setDot('qrDot', 'pending');
          }
        } catch (err) {
          log(`[qr] decode error: ${err.message}`);
        }
      }
      qrScanTimer = requestAnimationFrame(tick);
    };
    qrScanTimer = requestAnimationFrame(tick);
  } catch (err) {
    setDot('qrDot', 'err');
    document.getElementById('qrValue').textContent = `Failed: ${err.message}`;
    log(`[qr] failed to start: ${err.message}`);
  }
};

document.getElementById('qrStop').onclick = () => {
  stopQrScan();
  setDot('qrDot', 'pending');
  document.getElementById('qrValue').textContent = 'Stopped.';
  log('[qr] scan stopped');
};

// ---------- Touch / input ----------
let taps = 0;
const tile = document.getElementById('touchTile');
['click', 'touchstart'].forEach(evt => {
  tile.addEventListener(evt, () => {
    taps++;
    document.getElementById('touchValue').textContent = `Taps registered: ${taps}`;
    setDot('touchDot', 'ok');
    tile.classList.add('hit');
    setTimeout(() => tile.classList.remove('hit'), 150);
    log(`[touch] input event #${taps} (${evt})`);
  });
});
