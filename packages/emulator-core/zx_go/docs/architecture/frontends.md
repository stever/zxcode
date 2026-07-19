# Frontends, wasm port, debugger, harness

The emulator core is one Go module. This document covers everything that
drives it: the desktop GUI, the headless CLI, the browser wasm surface,
the debugger backend and its three surfaces, the test harness, and the
builds.

Diagrams:
[frame-loop.drawio](diagrams/frame-loop.drawio),
[wasm-integration.drawio](diagrams/wasm-integration.drawio),
[debugger-surfaces.drawio](diagrams/debugger-surfaces.drawio).

## Entry points

- `cmd/zx_go/entry_desktop.go` (`//go:build !js`): `main()` calls
  `desktopMain()` in `gui_desktop.go`, which parses flags, handles the
  dev diff modes, branches to headless, or builds the Fyne app.
- `cmd/zx_go/entry_js.go` (`//go:build js && wasm`): registers the wasm
  exports and parks forever. A sleeping timer goroutine keeps the Go
  scheduler alive so exported callbacks stay serviceable.

The `emulator` struct in `main.go` is the machine assembly used by every
surface: CPU + memory + ULA + keyboard + audio + peripherals, plus the
Next stack when `ModelNext` (wired in `next.go`).

## Desktop loop

`(*emulator).run()` drives a 20 ms wall-clock ticker (50 Hz). Each tick:
debugger pause gate, then one frame (or several: RZX playback/record,
ZX8x and SAM take their own paths, and fast-tape turbo runs multiple
frames per tick while a loader is actively polling port $FE, with audio
muted). Rendering is separately gated to ~50 Hz and posted to the Fyne
canvas. Audio is pulled by oto on its own callback; the ring buffer
absorbs the rate mismatch.

## Headless

`--headless` runs the same machine with no UI: run N `--frames`, drive
the guest with `--press-key "KEY@FRAME,..."` (matrix key names plus the
Kempston joystick buttons `kfire`/`kup`/`kdown`/`kleft`/`kright` — some
game menus only accept joystick fire), save `--save-screen`
PNGs, `--dump-state`, watchpoints, memory dumps, uninitialised-read
detection, crash-detect heuristics, time-travel, snapshot-every, and
trace channels. Env hooks reproduce browser behaviours headlessly
(`ZX_GO_RUN_BAS_FILE` runs the same importAndRunBas path the Play page
uses; `ZX_GO_RUN_NEX_FILE=path[@frame]` runs the same importAndRunNex
path the browser's game-zip open uses, staging the file under its parent
directory's name for the Browser launch — the runner behind the Next
game-compatibility triage in docs/compatibility.md). This is the CI surface: the boot tests,
screenshot oracles and soak tests all run through it.

## The wasm surface

Build: `GOOS=js GOARCH=wasm go build ./cmd/zx_go` via
`scripts/build-wasm.sh` → `dist/zx.wasm` + `wasm_exec.js`. The Go wasm
module runs on the browser MAIN thread. There is no Go-side loop: the
CPU advances only inside `zxFrame()` calls from the page.

Exports (`wasm_js.go`, all globals; `zxReady` is set last):

| Group | Exports |
| --- | --- |
| Boot / machine | `zxRegisterROM(name, bytes)`, `zxBootNext(sd)`, `zxBoot48()`, `zxBoot128()`, `zxBoot(model)`, `zxReset()`, `zxModel()` |
| Frame / audio | `zxFrame(dst?) → {w,h,debug,paused,pc}`, `zxPullAudio(dst) → n`, `zxFastBoot()`, `zxMacroActive()`, `zxMacroProgress() → 0..1 \| -1` |
| Input | `zxMatrixKey(row, mask, down)`, `zxType(rune)`, `zxKeyName(name, down, shift)` |
| Tape | `zxLoadTap`, `zxTapeInsert`, `zxTapePlay`, `zxTapeStop`, `zxTapeStatus`, `zxTapeTraps` |
| Programs / files | `zxLoadSnapshot(bytes, ext)`, `zxRunNex(name, bytes)`, `zxRunBas(name, bytes)`, `zxPutFile(path, bytes)` |
| Debug | `zxDebugAttach/Detach`, `zxDebugCmd(line)`, `zxDebugState`, `zxDebugMem`, `zxDebugDisasm`, `zxDebugPaging`, `zxDebugStepFrame` |
| Diagnostics | `zxAudioDebug`, `zxAudioLevel`, `zxPerfSplit() → {execMs, renderMs, frames}` (drains the zxFrame execute-vs-render wall-time accumulators; GoEmulator.js polls it once a second for the `window.__zxgoExecMs` / `__zxgoRenderMs` readouts, #187) |

Boot calls run in goroutines (audio setup blocks until the JS loop
turns), so the page polls `zxModel()` for completion. `zxPutFile` stages
files onto the SD image before `zxRunBas`/`zxRunNex` (their reboot
re-reads the card). `zxRunNex` picks its launch route from the name: a
FOLDER-QUALIFIED name ("TX-1696/main.nex", the game-zip flow) stages
the file under that folder and drives the NextZXOS BROWSER to launch
it — cursor rows computed from the card's real sorted listings
(`sdcard.ListDir`) — because some games only run as
`<original folder>/<original name>` (TX-1696) or F_OPEN their own
filename; a ROOT-ANCHORED name ("/program.nex", the IDE compile flow)
stages at the card root and drives the typed `.nexload` command line
so the program's directory stays the root its `zxPutFile`-staged
assets resolve against; a BARE name (a .nex opened directly) is
imported as the fixed root `/zx.nex` and takes the same typed launch
(#184 — the fixed 8.3 name sidesteps the `~N` aliases the typing
macro cannot produce). On js builds
`pkg/next/install` disables disk access and takes ROMs via `InjectROM`.

The consumer, `packages/emulator/src/zxgo/GoEmulator.js`, is a drop-in
replacement for the JSSpeccy3 Emulator class:

- Pacing: requestAnimationFrame, audio-clock paced against
  `AudioContext.currentTime` at 44.1 kHz with a self-widening ~60 ms
  cushion, wall-clock fallback while the context is suspended, and the
  fastboot fast-forward during Next boots.
- Audio: `zxPullAudio` drains mono int16 into an AudioWorklet served as
  a real static file (CSP `script-src 'self'` blocks blob/data worklet
  modules).
- Keyboard: a worker-shaped shim feeds the JSSpeccy3 KeyboardHandler's
  `{row, mask}` messages into `zxMatrixKey`.
- Assets: the PRIMARY source (r60) is the official SpecNext distro zip
  (`sn-emulator-24.11.zip`: the two NextZXOS ROMs + the full 1 GB
  `cspect-next-1gb.img`), fetched through the same-origin `/specnext/`
  Caddy proxy route (specnext.com sends no CORS headers; the CSP pins
  `connect-src 'self'`) and kept in the browser Cache API so the ~52 MB
  downloads once. Staged `/next/` assets (ROMs + zipped trimmed image)
  are the automatic fallback — offline dev, and the only source
  gif-service's Node harness uses. Either way the image is STREAMED
  into a sparse card (r55): JSZip's `internalStream` feeds chunks to
  `zxSdIngestBegin/Chunk` and `zxBootNext()` mounts the result — the
  flat image is never materialised; only its real content is resident
  (~136 MB for the full official card, ~5 MB for the staged trimmed
  one). On the distro path `zxSdPrepDistro()` runs between ingest and
  boot: it deletes the pristine card's `/nextzxos/autoexec.1st`
  (first-boot welcome pager, re-shown every boot until disabled — it
  stalls the menu macros) and seeds `machines/next/config.ini` when
  absent (`cmd/zx_go/distro_prep.go`); staged/user images mount
  untouched. The zipped bytes are kept and re-inflated per boot so a
  machine switch gets a fresh card — and every game load does too
  (#186): `openNexGameZip`/`openNEXFile` call `bootNext()`
  unconditionally, so a previous load's staged folders and in-game
  writes never leak into the next one (a boot already in flight is
  joined, not duplicated). Fallbacks: a zip without size
  metadata inflates flat; deployments with only the raw `tbblue.mmc`
  mount it flat via `zxBootNext(bytes)`. The boot drives the UI's
  loading pill through its stages with byte-accurate fractions
  (Downloading NextZXOS → Preparing SD card → Starting NextZXOS, r61);
  a boot that opened the pill closes it, one running under a
  game-launch overlay leaves closing to that flow.
- `ENGINE_REV` is logged at boot; bump it on engine or translator
  changes (webpack-dev-server does not reliably rebuild workspace
  package edits).

## The debugger: three surfaces, one backend

`remoteDebugger` (`cmd/zx_go/debugger.go`) is the shared backend.
`newDebuggerCore` installs the CPU hooks with no listener;
`handleCommand(line)` is the single command dispatch used by all
surfaces, ~130 commands across the `*_cmd.go` files.

- GUI: the Fyne visual debugger (`pkg/debugger`, `!js`): registers,
  Z80+Z80N disassembly, hex view, paging diagram, backtrace, M1 history
  and heatmap, NextReg panel, time-travel, and the Next inspectors
  (palette, sprites, Layer 2, tilemap).
- Telnet: `--debugger-port=N`, one command per line, scriptable.
- wasm: `zxDebugCmd` reuses `handleCommand` unchanged; a stand-in
  goroutine supplies the pause handshake, and pause transitions are
  reported through `zxFrame`'s return fields so the page can stop its
  loop and emit `debugpause`.

Shared state that makes this work: one `BreakpointSet`
(`pkg/debugger/bpset.go`, atomic copy-on-write map, lock-free on the M1
hot path) handed to every surface, shared register watches, the M1
history ring, tracepoints, and the pause handshake
(`WaitIfPaused` + resume/step/ack channels).

Source-level breakpoints for the zxcode IDE:

- Interpreted BASICs (`basicbp_cmd.go`): a RAM-write hook watches the
  PPC system variable ($5C45, bank 5), edge-triggered on the assembled
  16-bit line value, halting when an armed line is entered. Machine
  independent (no ROM addresses).
- Compiled Boriel BASIC (`linecallbp_cmd.go`): anchors on the program's
  CHECK_BREAK runtime call PC with the line number in HL
  (`linecall-anchor`, re-sent per build), checked from
  `BreakpointCheck`.

Other notable tooling: time-travel ring (CPU + visible 64K per snap;
Next upper state is a catalogued phase-2 gap), provenance/xref/callgraph
analysis, crash-detect heuristics, `bisectFirstDivergence` for
ours-vs-reference hunts, and the SD/NextReg/paging tracers.

## Test harness (`pkg/testharness`)

A deterministic, goroutine-free scripted machine for integration tests:
construct per model, poke programs, `RunFrames`/`RunUntil`, press keys,
read memory, capture the screen, and OCR it (`ScreenText`,
`RunUntilText`). `next.go` assembles a full Next (dispatcher, palette,
layers, compositor, Copper, DMA, divMMC, esxDOS, sdcard) so register-
level tests can assert on rendered RGBA. This is the canonical way to
test hardware behaviour; see CONTRIBUTING.md for the pattern.

## Support packages

- `pkg/trace`: typed events (CPU fetch, NextReg, ports, bank switches)
  to a pluggable emitter; `--trace` installs a JSON-lines emitter.
- `pkg/zxlog`: slog handler + startup banner.
- `pkg/config`: persisted desktop settings (model, scale, joystick,
  recent files, SD locations). Not used on wasm.

## Build notes

- Desktop needs cgo (Fyne/GLFW/OpenGL). `go test ./...` runs the full
  suite (~3-4 min); `-short` skips conformance and real-ROM boots.
- The wasm binary is ~31 MB (Fyne linked as dead code; shrinking it
  means splitting the core out of `package main`, catalogued as a later
  optimisation).
- The prebuilt `dist/` fallback lets npm builds succeed without a Go
  toolchain; Docker builds compile the wasm in a golang stage.
- Port design notes and the wasm-safe edit list:
  `packages/emulator-core/wasm/STATUS.md`.
