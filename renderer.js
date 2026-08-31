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
  if (ports.length === 0) log('[ports] no serial ports found — check connections');
}
document.getElementById('refreshPorts').onclick = refreshPortLists;
refreshPortLists();

// ---------- Recycler ----------
document.getElementById('connectRecycler').onclick = async () => {
  const port = document.getElementById('recyclerPort').value;
  const useEncryption = document.getElementById('useEncryption').checked;
  if (!port) { log('[recycler] no port selected'); return; }
  setDot('recyclerDot', 'pending');
  log(`[recycler] connecting on ${port}...`);
  const result = await window.hal.connectRecycler({ port, useEncryption });
  if (result.ok) {
    setDot('recyclerDot', 'ok');
    document.getElementById('recyclerValue').textContent = `Connected — serial ${result.serialNumber}`;
  } else {
    setDot('recyclerDot', 'err');
    document.getElementById('recyclerValue').textContent = `Failed: ${result.error}`;
  }
};
document.getElementById('disconnectRecycler').onclick = async () => {
  await window.hal.disconnectRecycler();
  setDot('recyclerDot', 'pending');
  document.getElementById('recyclerValue').textContent = 'Disconnected.';
};
window.hal.onRecyclerEvent(({ name, result }) => {
  document.getElementById('recyclerValue').textContent = `Last event: ${name}`;
});

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
  const lines = result.printers.map(p => `${p.Name} — status ${p.PrinterStatus} — offline: ${p.WorkOffline}`);
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
  el.textContent = result.ok ? 'Raw ESC/POS test sent — check the physical printout.' : `Failed: ${result.error}`;
};

// ---------- Camera ----------
document.getElementById('startCamera').onclick = async () => {
  setDot('cameraDot', 'pending');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    document.getElementById('cameraPreview').srcObject = stream;
    setDot('cameraDot', 'ok');
    log('[camera] preview started — UVC access confirmed from Electron');
  } catch (err) {
    setDot('cameraDot', 'err');
    log(`[camera] failed: ${err.message}`);
  }
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
