# ATM HAL Dashboard

A small bring-up tool: run it, and it shows live status for every peripheral the
ATM platform needs to control - cash recycler, receipt printer, camera, and touch
input - before any of that logic is buried inside the real kiosk app.

## Setup (Windows)

```
npm install
```

If `serialport` fails to install with a `node-gyp`/`MSBUILD`/Python error, it's
trying to compile a native module and can't find a build toolchain. Fix:

1. Install **Visual Studio Build Tools** (select "Desktop development with C++").
2. Install **Python 3.x**.
3. Re-run `npm install`.

## Run

```
npm start
```

## Using it

- **Recycler** - pick the COM port from the dropdown (Refresh if it's not listed
  yet), check "eSSP" only if the unit is confirmed to be running encrypted SSP
  (leave unchecked for plain SSP - checking it against a plain-SSP unit will make
  the handshake fail). Connect, and you should see a serial number appear. Feed a
  note through and watch the log for `CREDIT_NOTE`.
- **Printer** - "Check Windows spooler" shows what Windows itself thinks
  (installed, online/offline). "Raw ESC/POS test print" bypasses the spooler
  entirely and sends print commands directly over the port - pick whichever COM
  port the printer enumerates as. This is the path your real kiosk code will use,
  so it's worth proving independently even if the Windows-driver path already
  works. The cut command in `main.js` (`0x1D 0x56 0x00`) is a common default -
  if your specific printer doesn't cut, check its ESC/POS command reference for
  the right sequence.
- **Camera** - "Start preview" just calls `getUserMedia()` - if you see a live
  picture, Electron has full access to the camera, same as the kiosk app will.
- **Touch** - tap the tile; it should flash and count up immediately. Confirms
  the touchscreen behaves as ordinary pointer input, which is all Electron needs.

The log panel at the bottom captures everything - keep an eye on it, especially
while debugging the recycler handshake.

## Known open items (carried from the PRD)

- Confirm SSP vs eSSP mode on the actual deployed unit (Section 4.3) - determines
  whether the "eSSP" checkbox should be on.
- If eSSP: confirm the real `fixedKey` - this dashboard defaults to the library's
  public demo key, which will only work if the unit was never reconfigured off
  ITL's factory default.
- Confirm the printer's actual cut command if the default doesn't work.
