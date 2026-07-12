# zx_go — architecture overview

zx_go is a hardware-faithful emulator for the Sinclair 8-bit line, written
in Go. One codebase runs the ZX80, ZX81, every classic Spectrum (48K, 128K,
+2, +2A, +3), the Pentagon 128, the SAM Coupé, and a from-the-silicon-up
ZX Spectrum Next. In this repository (zxcode) it is vendored under
`packages/emulator-core/zx_go` with a WebAssembly port applied in-tree, and
it powers the browser emulator behind `@zxplay/emulator`.

Diagram: [diagrams/system-overview.drawio](diagrams/system-overview.drawio).

## One core, three surfaces

The whole emulator is a single Go module. Three surfaces share it, selected
by build tags and CLI flags:

- Desktop GUI. Fyne window, menus, visual debugger. Entry:
  `cmd/zx_go/entry_desktop.go` → `desktopMain()` in `gui_desktop.go`.
- Headless CLI. No UI. Frames, traces, screenshots, scripted keys, state
  dumps, a telnet debugger. Entry: `--headless` in `cmd/zx_go/headless.go`.
  This is the CI and diagnostics path.
- Browser (wasm). `//go:build js` files export a JavaScript API
  (`cmd/zx_go/wasm_js.go`). The page (`GoEmulator.js` in
  `packages/emulator`) owns the loop and calls `zxFrame()`; the Go side
  never runs a loop of its own in the browser.

The surface split is thin by design. `main()` is one line per build tag,
and the `emulator` struct in `cmd/zx_go/main.go` is the same machine
assembly everywhere. See [frontends.md](frontends.md).

## The core pillars

Five packages carry every machine:

- `pkg/z80` — the Z80 and Z80N CPU. Hand-written switch dispatch,
  per-opcode T-state accounting, undocumented flags and MEMPTR, IM0/1/2 and
  NMI, hook registries for peripherals and debuggers, turbo speed scaling
  for the Next. Conformance: zexdoc/zexall pass, plus a GHDL gate-level
  golden replay of the FPGA's own t80n core.
- `pkg/memory` — banks and decode. Classic 16K paging ($7FFD/$1FFD, plus
  the Next's $DFFD/$EFF7 extensions), ULA contention, and the Next's 8K
  MMU with a strict overlay priority chain (FPGA bootrom, divMMC,
  Multiface, Alt-ROM, config mode, Layer 2 paging, MMU, classic maps). See
  [diagrams/memory-decode.drawio](diagrams/memory-decode.drawio).
- `pkg/ula` — the I/O hub. Port dispatch for every device, the classic
  video render, border and audio event recording, tape edge stream, and
  the interface seams the Next stack plugs into. The ULA deliberately
  defines the interfaces it consumes (`NextCompositor`, `NextDMA`,
  `BetaDisk`...) so it never imports `pkg/next`.
- `pkg/keyboard` and `pkg/audio`/`pkg/ay` — the 8x5 active-low key matrix
  with host mapping, and the 44.1 kHz audio pipeline (event-timed beeper
  and DACs, an FPGA-faithful AY core, one shared ring buffer).
- `pkg/roms` — embedded ROM images and per-model timing constants
  (`FrameTStates`: 48K 69888, 128K family and Next 70908, Pentagon 71680).

On top of those sit the machine stacks: `pkg/next/*` (the Next's FPGA
hardware, by far the largest area), `pkg/peripherals` plus the classic
device packages, `pkg/zx8x` (ZX80/81), and `pkg/sam` (SAM Coupé).

## The frame loop

Diagram: [diagrams/frame-loop.drawio](diagrams/frame-loop.drawio).

Everything advances in units of one 50 Hz video frame:

1. The pacer fires. Desktop: a 20 ms wall-clock ticker. Browser: a
   requestAnimationFrame loop paced by the audio clock (produce frames
   until ~60 ms of samples are in flight). Headless: as fast as possible.
2. `cpu.ExecuteFrame(budget)` runs instructions until the frame's T-state
   budget is spent (`FrameTStates × SpeedMultiplier`). Each instruction
   passes through pre-fetch hooks (divMMC, IF1, Multiface, Beta, esxDOS),
   the M1 fetch, the opcode switch, memory contention, and port dispatch
   through the ULA. The frame interrupt is a narrow T-state pulse on the
   Next (VHDL-derived assert point and width) and a frame-start assert on
   the classics.
3. End of frame: `peripherals.Frame()`, `kbd.Tick()`, boot bookkeeping.
4. `ULA.Render()` builds the frame once: it first flushes the audio events
   recorded during the frame into the ring buffer (event-timed box-filter
   reconstruction), then paints border and screen from recorded mid-frame
   changes, then, on the Next, runs the per-scanline compositor with the
   Copper stepping ahead of each row.
5. Output. The RGBA frame goes to the Fyne canvas or is copied out by
   `zxFrame`; audio is pulled by oto (desktop) or `zxPullAudio` into an
   AudioWorklet (browser).

Timing subtleties worth knowing early:

- The T-state counter is shared by pointer between CPU, memory, and ULA
  (`SetTStatePtr`), so contention and beam position read the same clock.
- The Next's turbo (NR$07: 3.5/7/14/28 MHz) scales the frame budget. A
  3.5 MHz reference clock (`RefTstates`) keeps audio and tape event
  placement stable across mid-frame speed changes.
- Rendering is per-frame, not beam-chasing. Mid-frame effects that matter
  (border stripes, beeper edges, DAC writes) are recorded with T-state
  positions during execution and reconstructed at render time. The Next
  compositor and Copper run per-scanline. `BeamPosition()` answers raster
  queries (NR$1E/$1F) from the T-state count, so raster-polling code works
  without a per-pixel renderer.

## Fidelity philosophy

The project's stated invariant (ROADMAP.md): no hacks. Every hardware
question has a designated oracle, and code comments cite the oracle inline:

- Spectrum Next: the FPGA source itself (`zxnext.vhd`, the `t80n` CPU, and
  the per-device VHDL modules) is the truth. A reference emulator is used
  as a behavioural oracle for whole-boot comparisons, never as a register
  read-back oracle. `VHDL_CONFORMANCE.md` tracks conformance as an
  enumerated matrix rather than spot checks.
- Classic machines: FUSE (vendored for cross-reference), Sean Young's
  undocumented-Z80 documentation, and datasheets.
- Proof by replay: subsystems carry `fpga_golden_test.go` tests that replay
  vectors captured from GHDL simulations of the real VHDL (copper, ctc,
  im2 daisy-chain, lores, mixer, divmmc, sprites, uart, dac, keyboard, AY,
  and the Z80N gate-level oracle).

The cold boot is the integration test: the Next boots real NextZXOS
end-to-end through the FPGA bootrom → TBBLUE firmware → NextZXOS chain,
with no captured-state replay. See
[diagrams/next-boot-chain.drawio](diagrams/next-boot-chain.drawio) and
[next-fpga.md](next-fpga.md).

Honest status (mirrors the README): the classic line is mature and stable.
The Next boots faithfully and its hardware blocks are extensively tested,
but arbitrary `.NEX` game compatibility is the youngest area.

## Styles of emulation

Different hardware earns different styles. The catalogue is in
[emulation-patterns.md](emulation-patterns.md) and per-chip detail in
[chips.md](chips.md); the short version:

- Cycle-faithful transcription: the Next FPGA blocks, the AY core, the
  Multiface state machine, ULA/memory contention, the ZX Printer drum.
- Event-timed reconstruction: beeper, tape sound, all DACs. Toggles are
  recorded with T-state offsets and integrated into samples at frame end.
- Scanline-quantised: the Next video compositor and the Copper (accurate
  to scanline + horizontal threshold, not per pixel).
- I/O-advanced device models: all four floppy controllers (WD1793, two
  WD1772s, µPD765A). Commands complete on write, data advances per
  register access. DOS ROMs poll status, so microsecond timing is not
  needed.
- CPU-generated video: the ZX80/81 build the picture from the Z80's own
  fetch stream (NOP substitution), the most timing-coupled model in the
  codebase.
- Deliberate stubs: the ESP UART answers AT commands but never networks;
  IF1's RS-232 and SinclairNET report no peripheral connected.

## Where the Next fits

`pkg/next/*` is roughly half the emulator. Its shape:

- A `nextregs.Dispatcher` models the 256-register NextReg file with
  per-register read/write handlers and VHDL-derived reset defaults.
- `pkg/next/wire.go` centralises every register-to-subsystem connection
  so production and tests wire identically.
- Video: layer2, tilemap, sprite, lores, palette feed a per-scanline
  compositor; the Copper mutates NextRegs ahead of each row.
- System: 8K MMU, divMMC + esxDOS + SD card (SPI level), zxnDMA, CTC,
  IM2 daisy-chain, RTC over bit-banged i2c, Turbosound, DACs, UART.
- Boot: the genuine FPGA bootrom chain, machine personalities (NR$03),
  typed soft-reset semantics (NR$02).

All of it is documented in [next-fpga.md](next-fpga.md).

## This repository's context (zxcode)

Upstream zx_go is a desktop emulator. This repo vendors it and adds:

- The wasm port (`//go:build js` files, `scripts/build-wasm.sh`,
  `dist/zx.wasm`). Design notes: `packages/emulator-core/wasm/STATUS.md`.
- The browser consumer `packages/emulator/src/zxgo/GoEmulator.js`, which
  keeps the JSSpeccy3-era page API while driving this core.
- Browser-only boot accelerators (direct-core boot env opt-outs plus the
  `zxFastBoot` fast-forward). The core default stays the faithful path.
- IDE debugger integration (source-line breakpoints for the zxcode web
  IDE) over the same shared debugger backend.

The maintenance gotchas for the browser boot path are documented in
`packages/emulator-core/README.md` (seed-table and menu-index coupling to
the SD distro version).
