# ZX Play

A mobile-friendly ZX Spectrum emulator for the browser.

## Fresh Start

```bash
npm install
npm run dev
```

Launch the URL for the web server on port 8000 (http://localhost:8000).

## Emulation engine

The emulator core is [zx_go](https://github.com/conorarmstrong/zx_go) — a
ZX Spectrum 48K/128K and Spectrum Next emulator written in Go — compiled to
WebAssembly. It is vendored (with the wasm-port changes applied in-tree) at
packages/emulator-core, and consumed through the JSSpeccy(container, opts)
handle in packages/emulator, whose UI chrome and keyboard handling descend
from [JSSpeccy3](https://github.com/gasman/jsspeccy3) (GPLv3) — the engine
this project used before the zx_go migration.

Engine highlights:

- 48K and 128K boot from ROMs embedded in zx.wasm; the Spectrum Next boots
  real NextZXOS from the official SpecNext distro, relayed byte-for-byte
  through a same-origin proxy route — this project distributes no NextZXOS
  content itself. Locally staged ROMs + SD image are the offline dev/CI
  fallback, never committed (policy and self-hosting conditions:
  packages/emulator-core/LICENSES.md).
- Audio streams from the core into an AudioWorklet (served as
  /dist/zx-feeder.worklet.js: CSP script-src 'self' compatible); the machine
  is paced off the audio clock, so producer and consumer cannot drift.
- Every machine and video mode composites into a fixed 640x512 canvas.
- .nex files run via NextZXOS's own .nexload; the IDE's compiled TAPs are
  translated for the Next (packages/emulator/src/zxgo/tapToNext.js).

## Acknowledgements

This software uses code from the following open source projects:

* JSSpeccy3 & JSSpeccy3-mobile. These are licensed under terms of the GPL version 3.
* Pasmo by Julián Albo García, alias "NotFound". Licensed under terms of the GPL version 3.
* Boriel ZX BASIC by Jose Rodriguez. Licensed under terms of the GPL version 3.
* zmakebas by Russell Marks. This tool is public domain.
