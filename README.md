# ATM HAL Dashboard

A small bring-up tool: run it, and it shows live status for every peripheral the
ATM platform needs to control - cash recycler, receipt printer, camera, QR code
scanner, and touch input - before any of that logic is buried inside the real
kiosk app.

## Architecture

This dashboard no longer talks to the recycler over eSSP directly. Instead:

- **Recycler** - `main.js` spawns [`nv200-smart-payout`](../nv200-smart-payout)'s
  `server.py` as a local sidecar process (one per Connect click) and talks to it
  over HTTP + SSE (`http://127.0.0.1:8787` by default). That service owns the
  serial connection, the eSSP encryption handshake, and denomination routing.
- **K80 printer (raw USB only)** - [`custom-k80-printer`](../custom-k80-printer) has
  no HTTP layer of its own (it's a library, not a service), so the dashboard shells
  out to its staged CLI, `test_k80.py`, per diagnostic action instead. The K80 is
  a native-USB device (VID 0x0DD4/PID 0x0237) - there's deliberately no Windows
  spooler check or COM-port ESC/POS path here, since neither applies to it.
- **QR code scanner** - decodes via `jsQR`, vendored directly as `vendor/jsQR.js`
  and loaded as a plain `<script>` (see `index.html`) rather than an npm
  dependency - it's pure JS with no Node/native requirements, so there's nothing
  to `npm install` for this one and no preload/IPC bridge involved.
- **Everything else** - the camera preview and touch input are unchanged and talk
  to the OS/hardware directly, same as before.

This means two sibling Python repos are required at runtime, expected as sibling
directories next to this one:

```
yiksi-shanga/
  atm-hal-dashboard/     (this repo)
  nv200-smart-payout/
  custom-k80-printer/
```

If your checkout doesn't match that layout, or you use something other than
`python3` on `PATH`, override with env vars before `npm start`:

| Env var             | Default                        | Purpose                                  |
| -------------------- | ------------------------------- | ----------------------------------------- |
| `NV200_SERVICE_DIR`  | `../nv200-smart-payout`         | Where `server.py` lives                   |
| `NV200_PYTHON`       | auto-detected (see below)       | Interpreter used to launch it             |
| `NV200_HTTP_PORT`    | `8787`                          | Port the recycler service listens on      |
| `K80_SERVICE_DIR`    | `../custom-k80-printer`         | Where `test_k80.py` lives                 |
| `K80_PYTHON`         | auto-detected (see below)       | Interpreter used to run it                |

If `NV200_PYTHON`/`K80_PYTHON` aren't set, `main.js` probes candidates in order
until one actually runs (`py`, `python`, `python3` on Windows;
`python3`, `python` elsewhere) and caches whichever works. This exists because
Windows' `python`/`python3` commands are often just Microsoft Store
app-execution-alias stubs that print "Python was not found..." and exit
instead of running anything, even when a real interpreter (e.g. installed via
python.org, or the `py` launcher) is present under a different name. If every
candidate fails, set the env var explicitly to the interpreter's actual path.

## Setup (Windows)

```
npm install
```

If `serialport` fails to install with a `node-gyp`/`MSBUILD`/Python error, it's
trying to compile a native module and can't find a build toolchain. Fix:

1. Install **Visual Studio Build Tools** (select "Desktop development with C++").
2. Install **Python 3.x**.
3. Re-run `npm install`.

You also need both sidecar repos' own Python dependencies installed once, in
each repo:

```
cd ../nv200-smart-payout && pip install -r requirements.txt
cd ../custom-k80-printer && pip install -r requirements.txt
```

For the K80, also do the one-time Zadig/WinUSB driver binding described in
`custom-k80-printer`'s own README before expecting `test_k80.py --list`/`--init`
to see the device.

## Run

```
npm start
```

## Using it

- **Recycler** - pick the COM port from the dropdown (Refresh if it's not listed
  yet) and click Connect. This spawns the `nv200-smart-payout` service pointed at
  that port; watch the log for `[recycler-svc]` lines (the sidecar's own stdout/
  stderr) followed by `[recycler]` lines once the dashboard's HTTP client takes
  over. On success you'll see the protocol version and unit type, not a serial
  number - the service's REST API has no endpoint for that. Encryption is always
  on (the sidecar's startup sequence does the eSSP key exchange unconditionally;
  there's no plain-SSP mode to pick anymore). Feed a note through and watch the
  log for `CREDIT_NOTE`. Disconnect calls `/disable` on the service, then kills
  the sidecar process - if the app quits or crashes without disconnecting first,
  it kills the sidecar too, but check for an orphaned `python server.py` process
  if something went wrong. If the sidecar process dies on its own (crashes,
  the device gets unplugged, etc.) the dashboard now detects it and flips to
  "Disconnected unexpectedly: ..." with the log auto-shown - it used to stay
  silently stuck showing "Connected" until some later button click failed with
  a bare "not connected", which looked like a random failure rather than what
  it was. If you see that, check the auto-shown log for the `[recycler-svc]`
  line just before the disconnect - that's the sidecar's own stderr explaining
  why it exited.
  - **Denominations** - "Refresh denominations" calls the service's
    `GET /denominations` (wraps `SSPClient.denominations()`) and shows known
    denominations with current stock count and cashbox/payout routing, in real
    currency units.
  - **Check balance** - sums `value * count` across the denominations response
    and shows a total. This total also caps what "Payout" below will let you
    request - re-check it after a deposit or a payout to keep it current.
  - **Cash deposit** - deposits happen automatically (note acceptance is
    enabled right after Connect); this section just makes them visible. Every
    `CREDIT_NOTE` event's `channel` is looked up against `channel_value` (from
    `/status`, already real currency per `SETUP_REQUEST`'s
    `expanded_channel_value`) and added to a running "session deposits" total.
    "Reset session total" zeroes the display only - it doesn't touch the device.
  - **Payout / Float / Smart empty / Halt** - the amount fields take **real
    currency** (e.g. `500` meaning 500 of whatever `/status`'s `country_code`
    reports, KES on the units tested so far); the dashboard converts to the
    wire units the service's `/payout` and `/float` endpoints actually expect
    using `real_value_multiplier` from `/status`, the same conversion
    `test_nv200.py`'s CLI does. Payout requires "Check balance" to have been run
    at least once and rejects any amount above that balance client-side, on top
    of whatever the device itself decides once the command reaches it. Payout
    defaults to "test only" (confirms feasibility, dispenses nothing) - untick
    it to move real cash, and you'll get a confirmation prompt first. Float,
    smart-empty, and halt also confirm before sending, since all three act on
    real cash-handling hardware.
  - **Cancel / return** - two genuinely different capabilities, since the SSP
    protocol only allows one of them:
    - **"Reject & return current note"** sends `REJECT_BANKNOTE`, which only
      works on a note still held in escrow - the brief window between it being
      read and `CREDIT_NOTE`/`NOTE_STACKED` firing for it. The button is only
      enabled while the dashboard has seen a `READ_NOTE` with no resolving
      event yet ("No note currently held in escrow." otherwise). If you're too
      slow, the device answers `COMMAND_CANNOT_BE_PROCESSED` and the dashboard
      shows that as an error - it's not a bug, the note is just already
      stacked.
    - **"Refund session deposits"** is for that already-stacked case: once
      credited, a note is physically inside the unit and cannot be un-stacked
      by any command, so refunding a cancelled transaction means paying out an
      equivalent amount from the recycler's stock instead (same
      balance-capped, confirmed `/payout` call as above, pre-filled with the
      session deposit total) - **not necessarily the same physical notes** the
      customer inserted. Say that plainly to whoever's using this if you wire
      it into a real cancel flow.
- **Printer (K80 raw USB)** - "List USB devices" shells out to
  `test_k80.py --list` and reports whether VID 0x0DD4/PID 0x0237 shows up.
  "Connectivity test" runs `test_k80.py --init` (sends `ESC @` over the native
  USB interface, bypassing the OS spooler/COM port entirely) - the printer
  should visibly react (buzzer/motor) even though nothing prints. "Selftest"
  runs `test_k80.py --selftest`, a pure command/raster sanity check that needs
  no hardware at all. "Text test", "Barcode", "QR code", "Sample receipt", and
  "Cut (total/partial)" each shell out to the matching `test_k80.py` stage and
  should visibly print on real hardware. "Print image..." opens a file picker
  and runs `test_k80.py --image <path>` against whatever you pick (requires
  Pillow, per `custom-k80-printer`'s own requirements). All of this needs the
  Zadig WinUSB binding done first (see Setup above).
- **Camera** - "Start preview" just calls `getUserMedia()` - if you see a live
  picture, Electron has full access to the camera, same as the kiosk app will.
- **QR Code Scanner** - has its own device dropdown (Refresh to (re)enumerate,
  labels only populate once camera permission has been granted once) since a
  dedicated QR-scanning camera is often a separate UVC device from the general
  preview camera above. "Start scanning" opens that camera and decodes frames
  roughly 5x/second using the vendored `jsQR` (see Architecture above); a live
  decode shows the payload text, logs it, and adds it to the "Decode history"
  list below (capped to the last 20 distinct scans - the same code held in
  frame doesn't spam repeat entries, only re-appears if it leaves and re-enters
  view). "Clear" wipes that history.
- **Touch** - tap the tile; it should flash and count up immediately. Confirms
  the touchscreen behaves as ordinary pointer input, which is all Electron needs.

The log panel at the bottom is off by default - tick "Show live log" to watch
activity as it happens (useful while debugging the recycler handshake or a
sidecar that fails to start), or leave it off and just read each card's own
result text. Lines are still captured into a capped buffer either way, so
turning it on shows recent history, not just what happens from then on;
"Clear log" empties that buffer.

## Known open items

- Fixed (not open anymore, noted for context): reconnecting to the recycler
  (or double-clicking Connect) could spawn a new `server.py` before the old
  one had actually released the COM port - `.kill()` returns as soon as the
  signal/`TerminateProcess` call is issued, not once the OS (and, through a
  USB-serial bridge, its driver) has actually finished releasing the port
  handle. This showed up as "Access is denied" on the new open. Fixed by
  waiting for the old process to actually exit (plus a short grace delay)
  before spawning the new one, and guarding against two overlapping connects
  entirely (both server-side in `main.js` and by disabling the Connect button
  while one's in flight).
- Fixed (not open anymore, noted for context): `nv200-smart-payout`'s
  `client.command()` used to raise on any failure with nothing catching it in
  `server.py`, so Flask returned an HTML 500 page that the dashboard's
  `res.json()` couldn't parse - every payout rejection surfaced as an opaque
  `Unexpected token '<'` instead of the real reason. There was also a real
  race: the command lock was non-blocking, so a `/payout` (or any on-demand
  command) arriving while the background poll loop held it failed instantly
  with "Already processing another command" instead of just waiting its turn.
  Both are fixed in `nv200-smart-payout` (a global JSON error handler, and a
  bounded-wait lock instead of instant-fail) - if payout still fails, the
  error text should now be the actual device-reported reason.
- `nv200-smart-payout`'s `/payout` and `/float` endpoints still take raw wire
  units, not real currency - the dashboard now converts using
  `real_value_multiplier` from `/status` (added there alongside
  `GET /denominations` specifically to support this), the same conversion the
  CLI tool does.
- The `real_value_multiplier` scaling assumption behind that conversion is
  itself unconfirmed against the primary ITL protocol spec (one empirical data
  point only) - don't trust real-money payout amounts until that's verified.
- Neither sidecar service has authentication. Fine on a closed local machine,
  not fine if either ever listens on more than `127.0.0.1`.
- `fixedKey` isn't configurable - `nv200-smart-payout` always uses the library's
  default eSSP key. If the deployed unit was ever reconfigured off ITL's factory
  default, the encryption handshake will fail and there's currently no dashboard
  knob to fix that; it would need a code change in `nv200-smart-payout` itself.
- Whether the K80 exposes a separate Prolific-bridge serial interface
  *simultaneously* with its native 0x0DD4/0x0237 USB interface is unconfirmed -
  `custom-k80-printer`'s README only says it's a different entry *if* the unit
  exposes one. Don't be surprised either way when running "List USB devices".
- "Check balance" and the payout cap only account for stock reported by
  `GET_ALL_LEVELS` (i.e. notes routed to the payout store) - they don't
  independently verify feasibility beyond that; the device's own response to
  `/payout` (or a test-only payout) is still the authoritative check.
