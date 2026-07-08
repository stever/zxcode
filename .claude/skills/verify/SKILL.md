---
name: verify
description: Drive the zxcode web IDE / play app in a headless browser to verify emulator-facing changes at runtime.
---

# Verifying emulator/app changes in the browser

## Handles

- The IDE (apps/web) is normally already running: `http://localhost:8080/`
  (Caddy proxy, CSP-accurate) proxying the webpack dev server on :8000.
- The play app is NOT part of `npm run dev`. Start it when needed:
  `npm run dev:play` (port 8001, up in ~60s). Kill it afterwards if you
  started it.
- Before trusting any engine-level result, confirm the served bundle carries
  your `ENGINE_REV`: fetch `/` for the bundle URL, then
  `curl -s .../dist/bundle.<hash>.js | grep -o "r[0-9]*-[a-z-]*"`.
  webpack-dev-server usually DOES pick up packages/emulator edits, but check.

## Browser harness

No playwright in the repo. `npm i playwright-core` in the scratchpad and
launch the cached headless shell:

```js
const { chromium } = require('playwright-core');
const browser = await chromium.launch({ executablePath:
  process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-1200/chrome-headless-shell-linux64/chrome-headless-shell' });
```

## Driving the emulator

- Wait for readiness: `#jsspeccy-screen canvas` exists AND
  `globalThis.zxMatrixKey` is set (Go wasm runs on the main thread, so
  `page.evaluate` can call zx* exports directly).
- The emulator boots paused. The start overlay is one of ~20 buttons inside
  `#jsspeccy-screen` (menu/toolbar/dialog buttons are hidden):
  `page.locator('#jsspeccy-screen button').locator('visible=true').first().click()`.
  The overlay button is the one with `style.width === '192px'`.
- 48K boot to "(c) 1982" takes ~3-4s wall clock after start.
- **Key presses must be held**: the ROM scans the matrix once per frame, so
  `keyboard.press()` / instant `mouse.click()` on a virtual key can land
  down+up inside one frame and be missed. Use down / sleep(150ms) / up.
- Screen assertions: compare `canvas.toDataURL()` before/after.
- "Is the machine running?" — don't trust a static screen; check
  `window.__zxgoAudio().pulledPerSec` (~44100 when running, audio works in
  the headless shell) or press a key and look for pixel change.
- Keyboard capture is focus-scoped (r22+): the emulator canvas is focusable
  and only swallows keys while `document.activeElement` is the canvas; the
  apps show a cyan ring via `:focus-within` (`.emulator-frame` in web,
  `#jsspeccy-screen` in play). `GoEmulator.start()` auto-focuses the canvas.
  Virtual keys (`#virtkeys`) dispatch synthetic key events AT the canvas and
  work without focus.
- Matrix-level key introspection (r24+): GoEmulator broadcasts every matrix
  transition as a `zx-matrix-key` CustomEvent on document
  (`detail: {row, mask, down}`) — the apps' on-screen keyboards mirror it.
  Canvas blur releases all held matrix keys in the core.

## Gotchas

- The dev IDE home page loads a demo BASIC project; clicks into the editor
  area will type into CodeMirror — fine for "keyboard released" checks.
- Console log line `[zxplay] emulator engine: zxgo ... rNN-...` is the
  ENGINE_REV ground truth for what the page actually runs.
