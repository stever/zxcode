# ZX Play

A mobile-friendly ZX Spectrum emulator for the browser.

## Fresh Start

```bash
npm install
npm run dev
```

Launch the URL for the web server on port 8000 (http://localhost:8000).

## Emulation engine

The emulator core is zxplay_go — this repository's fork of
[zx_go](https://github.com/conorarmstrong/zx_go) by Conor Armstrong — a
ZX Spectrum emulator written in Go — compiled to WebAssembly. It is
vendored (with the wasm-port changes applied in-tree) at packages/emulator-core, and consumed through the JSSpeccy(container, opts)
handle in packages/emulator, whose UI chrome and keyboard handling descend
from [JSSpeccy3](https://github.com/gasman/jsspeccy3) (GPLv3) — the engine
this project used before the zxplay_go migration.

Engine highlights:

- The websites run the 48K and 128K, booting from ROMs embedded in zx.wasm.
  They do not support the ZX Spectrum Next and serve or proxy no NextZXOS
  content. The engine's Next support (NextZXOS boot, .nex loading, the
  IDE's TAP-to-Next translation in packages/emulator/src/zxgo/tapToNext.js)
  stays in the code behind `opts.nextEnabled`, which neither app sets: Next
  programs are refused with "ZX Spectrum Next programs are not supported."
  Local staging tooling and policy: packages/emulator-core/LICENSES.md.
- Audio streams from the core into an AudioWorklet (served as
  /dist/zx-feeder.worklet.js: CSP script-src 'self' compatible); the machine
  is paced off the audio clock, so producer and consumer cannot drift.
- Every machine and video mode composites into a fixed 640x512 canvas.

## Acknowledgements

This software uses code from the following open source projects:

* JSSpeccy3 & JSSpeccy3-mobile. These are licensed under terms of the GPL version 3.
* Pasmo by Julián Albo García, alias "NotFound". Licensed under terms of the GPL version 3.
* Boriel ZX BASIC by Jose Rodriguez. Licensed under terms of the GPL version 3.
* zmakebas by Russell Marks. This tool is public domain.
