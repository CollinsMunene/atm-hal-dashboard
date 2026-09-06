# ATM HAL Dashboard

A small bring-up tool: run it, and it shows live status for every peripheral the
ATM platform needs to control - cash recycler, receipt printer, camera, and touch
input - before any of that logic is buried inside the real kiosk app.

## Architecture

This dashboard no longer talks to the recycler over eSSP directly. Instead:

- **Recycler** - `main.js` spawns [`nv200-smart-payout`](../nv200-smart-payout)'s
  `server.py` as a local sidecar process (one per Connect click) and talks to it
  over HTTP + SSE (`http://127.0.0.1:8787` by default). That service owns the
  serial connection, the eSSP encryption handshake, and denomination routing.
- **K80 printer (raw USB)** - [`custom-k80-printer`](../custom-k80-printer) has no
  HTTP layer of its own (it's a library, not a service), so the dashboard shells
  out to its staged CLI, `test_k80.py`, per diagnostic action instead.
- **Everything else** - the Windows-spooler check, the raw-ESC/POS-over-COM test
  print, the camera preview, and touch input are unchanged and talk to the OS/
  hardware directly, same as before.

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
  if something went wrong.
- **Printer (Windows spooler / raw ESC/POS)** - "Check Windows spooler" shows
  what Windows itself thinks (installed, online/offline). "Raw ESC/POS test
  print" bypasses the spooler entirely and sends print commands directly over
  the port - pick whichever COM port the printer enumerates as. The cut command
  in `main.js` (`0x1D 0x56 0x00`) is a common default - if your specific printer
  doesn't cut, check its ESC/POS command reference for the right sequence.
- **Printer (K80 raw USB)** - "List USB devices" shells out to
  `test_k80.py --list` and reports whether VID 0x0DD4/PID 0x0237 shows up.
  "Connectivity test" runs `test_k80.py --init` (sends `ESC @` over the native
  USB interface, bypassing the OS spooler/COM port entirely) - the printer
  should visibly react (buzzer/motor) even though nothing prints. Needs the
  Zadig WinUSB binding done first (see Setup above).
- **Camera** - "Start preview" just calls `getUserMedia()` - if you see a live
  picture, Electron has full access to the camera, same as the kiosk app will.
- **Touch** - tap the tile; it should flash and count up immediately. Confirms
  the touchscreen behaves as ordinary pointer input, which is all Electron needs.

The log panel at the bottom captures everything - keep an eye on it, especially
while debugging the recycler handshake or a sidecar that fails to start.

## Known open items

- `nv200-smart-payout`'s `/payout` and `/float` endpoints take **raw wire
  units**, not KES - the dashboard doesn't currently expose a payout control, but
  if one gets added, it must apply the service's `real_value_multiplier`
  conversion itself (the CLI tool does this; the REST API doesn't).
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
- Confirm the printer's actual cut command if the default doesn't work.
