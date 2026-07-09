# zx_go → WebAssembly: WORKING

A `zx.wasm` built from your zx_go source that boots the ZX Spectrum Next in the
browser, renders at 60 fps, runs `.nex` builds, AND produces real emulator audio
through oto's Web Audio backend. Deployed into the web host in `../web/`
(serve on :8080).

## Verified

- Compiles: `GOOS=js GOARCH=wasm go build -o zx.wasm ./cmd/zx_go` (31 MB).
- Desktop build still works (`go build ./cmd/zx_go`) — changes are wasm-safe.
- Boots NextZXOS (TBBlue splash, Core v3.02.03) at 61 fps in headless Chrome.
- Audio: a hand-assembled beeper `.nex` drives `PushBeeperSamples` to a measured
  peak of 16000 (full-scale square). The emulator generates sound and feeds oto.
  (oto's *output* can't be measured in headless — no audio device — but the
  source is confirmed; on a real machine oto plays it after a click unlocks the
  AudioContext.)

## Build + deploy

    cd zx_go
    GOOS=js GOARCH=wasm go build -o ../web/res/zxnext/zx.wasm ./cmd/zx_go
    cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" ../web/res/zxnext/wasm_exec.js

## Source

These changes are applied in-tree in the vendored [`../zx_go`](../zx_go); there
is no separate patch to apply. Pull upstream with
`git subtree pull --prefix=zx_go zx_go-upstream main --squash`.

## What each change does

New files:
- `cmd/zx_go/wasm_js.go` — js exports (zxBootNext / zxBoot48 / zxBoot128, zxFrame,
  zxRunNex, zxRunBas, zxLoadTap, zxReset, zxKeyName, zxType, zxRegisterROM,
  zxReady, zxAudioLevel, zxPullAudio). Boot runs in a goroutine so the js
  callback returns promptly. 48K/128K use zx_go's embedded ROMs (no SD).
- `cmd/zx_go/tape_macro.go` — mount a `.tap` from bytes and auto-run it: reboot,
  then drive LOAD"" (48K) or the 128 Tape Loader; the LD-BYTES trap fast-loads it.
- `cmd/zx_go/entry_js.go` / `entry_desktop.go` — build-tagged `main()` (js keeps
  the runtime alive with a timer goroutine to dodge the wasm deadlock detector).
- `cmd/zx_go/tracedb_js.go` — sqlite-free trace ring for wasm.
- `pkg/next/install/inject.go` — in-memory ROM injection (+ DiskDisabled) so the
  browser-supplied NextZXOS ROMs are used and absent optional ROMs don't error on
  os.Getwd.
- `pkg/audio/ready_js.go` / `ready_other.go` — don't block on oto's ready channel
  on wasm (it only resolves once the JS event loop turns). Since the AudioWorklet
  switch, oto isn't constructed on js at all: audio.New skips the oto player
  (GOOS check), and PullMono drains the mixed mono stream for zxPullAudio —
  the page's worklet owns buffering on the audio render thread. This replaced
  oto's main-thread ScriptProcessor + 0.5s pre-read (~800ms latency, crackle
  under load) with ~60-80ms.
- `pkg/audio/peakmeter.go` — diagnostic beeper peak meter (LastPeak).

In-place edits:
- `cmd/zx_go/main.go` — `main()` → `desktopMain()`.
- `cmd/zx_go/tracedb.go` — `//go:build !js`.
- `pkg/next/install/install.go` — LoadROM checks injected ROMs / DiskDisabled first.
- `pkg/audio/audio.go` — `<-ready` → `waitAudioReady(ready)`; peak meter in
  PushBeeperSamples.

## Debug bridge (port-owned surface)

- `cmd/zx_go/wasm_debug_js.go` — browser debugger over the upstream command
  layer: zxDebugAttach/Detach, zxDebugCmd (the full `handleCommand` dispatch,
  so upstream command additions work unmodified), zxDebugState/Mem/Disasm
  (structured reads for the UI panels), zxDebugStepFrame. A stand-in goroutine
  parked in `WaitIfPaused` supplies the pause-ack/single-step cooperation the
  desktop headless loop normally provides; `step-over` is rerouted to a
  non-blocking variant because on wasm the CPU only advances when JS calls
  zxFrame (see the file comment for the threading model).
- `cmd/zx_go/debugger.go` — two in-place edits for the above: (1) the
  constructor is split into `newDebuggerCore` (hooks, no listener; used by
  the bridge) and `newRemoteDebugger` (adds the TCP listener; desktop
  unchanged); (2) the instruction-history setup is extracted from the
  constructor into `armHistory(size, wide)` and exposed as runtime commands
  `history-on [SIZE] [wide]` / `history-off` (in `commandsNeedingPause`),
  because the bridge constructs with history off — the browser UI arms the
  ring on demand from its History panel. Re-apply both if an upstream pull
  rewrites the constructor or the command dispatch.
- `cmd/zx_go/wasm_js.go` — `zxFrame` skips execution while the debugger holds
  the machine paused (render-only, so the page can repaint after pokes) and
  reports `{debug, paused, pc}` so the JS frame loop can observe breakpoint
  hits. Adds ~0.9 MB to zx.wasm (the command layer stops being dead code).

## Notes

- 31 MB because Fyne compiles in as dead code. To shrink, split the emulator core
  out of `package main` so the wasm build excludes the GUI. Later optimisation.
- Keyboard: `zxType` (printable runes) and `zxKeyName` (named keys) are wired.
- `run_bas` writes the tokenised program to `nextzxos/autoexec.bas` and reboots
  so NextZXOS auto-runs it (needs the PLUS3DOS autostart line the page sets).
