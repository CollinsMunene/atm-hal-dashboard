// Logging is opt-in: lines are always captured into a capped in-memory
// buffer (so nothing's lost), but only rendered into the DOM while "Show
// live log" is ticked - the panel doesn't grow/scroll continuously unless
// asked to. Per-action results (recyclerValue, k80Value, etc.) still show
// immediately regardless of this toggle; this only affects the bottom trace.
let loggingEnabled = false;
let logBuffer = [];
const LOG_BUFFER_MAX = 500;

function appendLogLine(entry) {
  const el = document.getElementById('log');
  const div = document.createElement('div');
  div.textContent = entry;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}
function log(line) {
  const entry = `[${new Date().toLocaleTimeString()}] ${line}`;
  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
  if (loggingEnabled) appendLogLine(entry);
}
document.getElementById('logToggle').onchange = (e) => {
  loggingEnabled = e.target.checked;
  const el = document.getElementById('log');
  el.innerHTML = '';
  if (loggingEnabled) {
    logBuffer.forEach(appendLogLine);
  } else {
    el.textContent = 'Logging is off - tick "Show live log" above to view activity as it happens.';
  }
};
document.getElementById('logClear').onclick = () => {
  logBuffer = [];
  document.getElementById('log').innerHTML = '';
};
function forceShowLog() {
  if (loggingEnabled) return;
  document.getElementById('logToggle').checked = true;
  document.getElementById('logToggle').dispatchEvent(new Event('change'));
}

function setDot(id, state) { // state: 'ok' | 'err' | 'pending'
  const el = document.getElementById(id);
  el.className = 'dot ' + state;
}

// window.hal comes from preload.js via contextBridge - if preload throws for
// any reason (missing dependency, syntax error, etc.) this is undefined, and
// since this is the first top-level statement in the file, a bare
// `window.hal.onLog(...)` here would throw synchronously and abort the rest
// of this script - meaning NOT ONE button below gets its onclick attached,
// including ones like Touch/Camera that don't even use window.hal. Guard it
// and surface the failure visibly instead of failing silently/totally.
if (!window.hal) {
  document.body.insertAdjacentHTML('afterbegin',
    '<div style="background:#C62828;color:#fff;padding:10px 16px;font-family:sans-serif;font-size:13px;">' +
    '<strong>preload.js failed to load - window.hal is undefined.</strong> Every button in this app depends on it, ' +
    'so nothing will respond. Open DevTools (Ctrl+Shift+I / Cmd+Opt+I) and check the Console for the actual error - ' +
    'a missing dependency (try <code>npm install</code> and restart) is the most common cause.' +
    '</div>');
}
window.hal?.onLog((line) => log(line));

// ---------- Port lists ----------
// Only the recycler needs a COM port now - the K80 talks raw USB, not serial.
async function refreshPortLists() {
  if (!window.hal) { log('[ports] window.hal unavailable - preload.js failed to load'); return; }
  const ports = await window.hal.listPorts();
  const recyclerSelect = document.getElementById('recyclerPort');
  recyclerSelect.innerHTML = '';
  ports.forEach(p => {
    const label = `${p.path} (${p.manufacturer})`;
    recyclerSelect.appendChild(new Option(label, p.path));
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
let recyclerChannelValue = null; // real-currency value per note channel, from /status
let recyclerBalance = null;      // real-currency total, from the last "Check balance"
let sessionDeposits = 0;         // running total of CREDIT_NOTE values this session
let noteInEscrow = false;        // true only between READ_NOTE and its resolution (credited/stacked/rejected)

function updateDepositDisplay() {
  document.getElementById('depositValue').textContent =
    `Session deposits: ${sessionDeposits} ${recyclerCountryCode}`;
}
document.getElementById('resetDepositBtn').onclick = () => {
  sessionDeposits = 0;
  updateDepositDisplay();
};

function setEscrowState(inEscrow) {
  noteInEscrow = inEscrow;
  document.getElementById('rejectNoteBtn').disabled = !inEscrow;
  document.getElementById('escrowValue').textContent = inEscrow
    ? 'Note detected, not yet stacked - "Reject & return" will hand it back now.'
    : 'No note currently held in escrow.';
}

document.getElementById('rejectNoteBtn').onclick = async () => {
  const el = document.getElementById('cancelReturnValue');
  if (!recyclerConnected) { el.textContent = 'Not connected.'; return; }
  el.textContent = 'Rejecting...';
  const result = await window.hal.rejectNote();
  el.textContent = result.ok
    ? 'Rejected - note should be returning to the customer now.'
    : `Error: ${result.error} (if the note already stacked, this always fails - refund the deposit total instead)`;
};

document.getElementById('refundDepositsBtn').onclick = async () => {
  const el = document.getElementById('cancelReturnValue');
  if (!recyclerConnected) { el.textContent = 'Not connected.'; return; }
  if (sessionDeposits <= 0) { el.textContent = 'No session deposits to refund.'; return; }
  if (recyclerBalance == null) { el.textContent = 'Click "Check balance" first, so this can be capped to what\'s actually available.'; return; }
  if (sessionDeposits > recyclerBalance) { el.textContent = `Refund amount exceeds available balance (max ${recyclerBalance} ${recyclerCountryCode}).`; return; }
  if (!confirm(`Refund ${sessionDeposits} ${recyclerCountryCode} for real? This pays out an equivalent amount from the recycler's stock - not necessarily the same physical notes deposited.`)) return;
  el.textContent = 'Refunding...';
  const result = await window.hal.payout({ amount: sessionDeposits, currency: recyclerCountryCode, test: false });
  if (result.ok) {
    el.textContent = `Refund OK: ${JSON.stringify(result.result)}`;
    sessionDeposits = 0;
    updateDepositDisplay();
  } else {
    el.textContent = `Error: ${result.error}`;
  }
};

// Disabled while connecting/connected so a double-click (or clicking Connect
// again without disconnecting first) can't fire two overlapping connects -
// main.js also guards against this server-side, but doing it here too means
// a normal user never sees the resulting "already in progress" error at all.
document.getElementById('connectRecycler').onclick = async () => {
  const port = document.getElementById('recyclerPort').value;
  if (!port) { log('[recycler] no port selected'); return; }
  const connectBtn = document.getElementById('connectRecycler');
  connectBtn.disabled = true;
  setDot('recyclerDot', 'pending');
  log(`[recycler] starting recycler service on ${port}...`);
  try {
    const result = await window.hal.connectRecycler({ port });
    if (result.ok) {
      setDot('recyclerDot', 'ok');
      document.getElementById('recyclerValue').textContent =
        `Connected - protocol v${result.protocolVersion}, unit "${result.unitType}"`;
      recyclerConnected = true;
      sessionDeposits = 0;
      recyclerBalance = null;
      document.getElementById('balanceValue').textContent = '';
      document.getElementById('cancelReturnValue').textContent = '';
      setEscrowState(false);
      updateDepositDisplay();
    } else {
      setDot('recyclerDot', 'err');
      document.getElementById('recyclerValue').textContent = `Failed: ${result.error}`;
      recyclerConnected = false;
    }
  } finally {
    connectBtn.disabled = false;
  }
};
document.getElementById('disconnectRecycler').onclick = async () => {
  await window.hal.disconnectRecycler();
  setDot('recyclerDot', 'pending');
  document.getElementById('recyclerValue').textContent = 'Disconnected.';
  document.getElementById('denominationsValue').textContent = '';
  document.getElementById('balanceValue').textContent = '';
  recyclerConnected = false;
  recyclerBalance = null;
  setEscrowState(false);
};
window.hal.onRecyclerEvent(({ name, result }) => {
  document.getElementById('recyclerValue').textContent = `Last event: ${name}`;

  // Escrow tracking, for "Reject & return current note": READ_NOTE opens
  // the window (the device holds the note, undecided); any of these close
  // it - CREDIT_NOTE/NOTE_STACKED because it's now stacked and can't be
  // un-stacked, NOTE_REJECTED/NOTE_REJECTING/NOTE_CLEARED_FROM_FRONT because
  // it's already on its way back out (via the device's own validation
  // logic, or our own REJECT_BANKNOTE call).
  if (name === 'READ_NOTE') {
    setEscrowState(true);
  } else if (['CREDIT_NOTE', 'NOTE_STACKED', 'NOTE_REJECTED', 'NOTE_REJECTING', 'NOTE_CLEARED_FROM_FRONT'].includes(name)) {
    setEscrowState(false);
  }

  // Cash deposit tracking: CREDIT_NOTE carries a channel number, not a
  // currency value directly - look its real value up in channel_value
  // (from /status, already real-currency per SETUP_REQUEST's
  // expanded_channel_value - see nv200-smart-payout's client.py).
  if (name === 'CREDIT_NOTE' && recyclerChannelValue && result.channel) {
    const value = recyclerChannelValue[result.channel - 1];
    if (value != null) {
      sessionDeposits += value;
      updateDepositDisplay();
      log(`[recycler] deposit credited: ${value} ${recyclerCountryCode} (channel ${result.channel})`);
    }
  }
});
window.hal.onRecyclerStatus((status) => {
  if (status.connected) {
    if (status.countryCode) {
      recyclerCountryCode = status.countryCode;
      const currencyInput = document.getElementById('payoutCurrency');
      if (!currencyInput.value) currencyInput.value = recyclerCountryCode;
      updateDepositDisplay();
    }
    if (status.channelValue) recyclerChannelValue = status.channelValue;
  } else if (recyclerConnected) {
    // The sidecar process died on its own (crash, unplugged device, etc.) -
    // main.js detects the exit and sends this unprompted; previously this
    // branch didn't exist at all, so the UI just kept showing "Connected"
    // (recyclerConnected stayed stale true) until a button was clicked and
    // failed with a bare "not connected" - confusing, and looked like a
    // random failure rather than what it was: the service actually died.
    recyclerConnected = false;
    setDot('recyclerDot', 'err');
    document.getElementById('recyclerValue').textContent =
      status.error ? `Disconnected unexpectedly: ${status.error}` : 'Disconnected unexpectedly.';
    setEscrowState(false);
    log(`[recycler] connection lost${status.error ? `: ${status.error}` : ''} - check the log above for [recycler-svc] lines explaining why it exited`);
    forceShowLog(); // this is exactly the moment you need to see why - don't make it opt-in here
  }
});

// ---------- Recycler: denominations + balance ----------
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

document.getElementById('checkBalanceBtn').onclick = async () => {
  const el = document.getElementById('balanceValue');
  if (!recyclerConnected) { el.textContent = 'Not connected.'; return; }
  el.textContent = 'Checking...';
  const result = await window.hal.getDenominations();
  if (!result.ok) { el.textContent = `Error: ${result.error}`; return; }
  const total = result.denominations.reduce((sum, d) => sum + (d.value || 0) * (d.count || 0), 0);
  recyclerBalance = total;
  const country = result.denominations[0]?.country_code || recyclerCountryCode;
  el.textContent = `Balance: ${total} ${country} (available for payout - caps withdrawals below)`;
};

// ---------- Recycler: cash-moving commands ----------
// PAYOUT and FLOAT move real cash - confirm before sending unless it's a
// test-only payout (which the device confirms feasibility for without
// dispensing anything). Payout is additionally capped to the last-checked
// balance so you can't request more than the denominations currently held
// even before the device's own feasibility check runs.
document.getElementById('payoutBtn').onclick = async () => {
  const el = document.getElementById('payoutValue');
  const amount = Number(document.getElementById('payoutAmount').value);
  const currency = document.getElementById('payoutCurrency').value || recyclerCountryCode;
  const test = document.getElementById('payoutTest').checked;
  if (!recyclerConnected) { el.textContent = 'Not connected.'; return; }
  if (!amount) { el.textContent = 'Enter an amount.'; return; }
  if (recyclerBalance == null) { el.textContent = 'Click "Check balance" first, so this can be capped to what\'s actually available.'; return; }
  if (amount > recyclerBalance) { el.textContent = `Amount exceeds available balance (max ${recyclerBalance} ${currency}).`; return; }
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

// ---------- Printer: K80 raw-USB diagnostics (via custom-k80-printer's CLI) ----------
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
// device from the general preview camera. Decoding uses jsQR, vendored as
// vendor/jsQR.js and loaded as a plain <script> before this file (see
// index.html) - it's pure JS with no Node dependency, so no need to route
// it through preload.js/npm at all, which removes an entire class of
// "did you run npm install" failures for this one feature.
let qrStream = null;
let qrScanTimer = null;
let qrLastDecodeAt = 0;
let qrLastValue = null;
const QR_DECODE_INTERVAL_MS = 200;
const QR_HISTORY_MAX = 20;
let qrHistoryEntries = [];

function addQrHistory(data) {
  qrHistoryEntries.unshift({ time: new Date().toLocaleTimeString(), data });
  if (qrHistoryEntries.length > QR_HISTORY_MAX) qrHistoryEntries.length = QR_HISTORY_MAX;
  renderQrHistory();
}
function renderQrHistory() {
  const el = document.getElementById('qrHistory');
  el.innerHTML = '';
  qrHistoryEntries.forEach(entry => {
    const div = document.createElement('div');
    div.textContent = `[${entry.time}] ${entry.data}`; // textContent, not innerHTML - decoded content is untrusted
    el.appendChild(div);
  });
}
document.getElementById('qrHistoryClear').onclick = () => {
  qrHistoryEntries = [];
  renderQrHistory();
};

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
  if (typeof jsQR !== 'function') {
    setDot('qrDot', 'err');
    document.getElementById('qrValue').textContent = 'jsQR failed to load (vendor/jsQR.js missing or blocked) - see DevTools console.';
    log('[qr] jsQR is not available - check that vendor/jsQR.js exists and loaded before renderer.js');
    return;
  }
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
    qrLastValue = null;

    const canvas = document.getElementById('qrCanvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const tick = (timestamp) => {
      if (!qrStream) return;
      if (video.videoWidth && timestamp - qrLastDecodeAt >= QR_DECODE_INTERVAL_MS) {
        qrLastDecodeAt = timestamp;
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        try {
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const result = jsQR(imageData.data, canvas.width, canvas.height);
          if (result) {
            setDot('qrDot', 'ok');
            document.getElementById('qrValue').textContent = `Decoded: ${result.data}`;
            if (result.data !== qrLastValue) {
              qrLastValue = result.data;
              addQrHistory(result.data);
              log(`[qr] decoded: ${result.data}`);
            }
          } else {
            setDot('qrDot', 'pending');
            qrLastValue = null; // code left the frame - allow re-logging it if it reappears
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
