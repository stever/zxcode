# Implementation patterns

The same handful of patterns repeat across the codebase. Learn these and
most files read themselves.

## 1. Oracle-cited, hardware-faithful transcription

The dominant style for anything with a hardware reference. Code is
written against a named oracle and the oracle citation lives in the
comment, usually with a file and line:

- Spectrum Next: the FPGA VHDL. `zxnext.vhd` is cited over 200 times in
  non-test code; per-device modules (`sprites.vhd`, `layer2.vhd`,
  `lores.vhd`, `copper.vhd`, `ctc_chan.vhd`, `dma.vhd`, `multiface.vhd`,
  `im2_*.vhd`, `ym2149.vhd`, `zxula_timing.vhd`) are transcribed
  line-by-line where practical. Some functions are verbatim ports (for
  example `layer2.fpgaFrameAddr` or the whole of `lores.go`).
- Classics: FUSE (vendored under `fuse/` for cross-reference), Sean
  Young's undocumented-Z80 paper, and chip datasheets.
- Comments record the bug a line fixed, often with an issue number.
  This is deliberate: the comment answers "why is this exact value
  here", never "what does this line do".

Rule of thumb when changing such code: find the oracle first. If the
VHDL disagrees with a reference emulator, the VHDL wins (reference
emulators return $00 for unimplemented read-backs; never blind-match
them).

## 2. Golden-vector conformance tests

Where a VHDL module exists, a `fpga_golden_test.go` replays input
vectors through the Go model and asserts bit-identical outputs against a
capture from a GHDL simulation of the actual VHDL. The testbenches and
capture tooling live in `_tools/<subsystem>-vhdl-test/`; goldens are
checked in under `testdata/`.

Covered this way: copper, ctc, im2 daisy-chain, lores, the video mixer,
divmmc, sprites, uart, dac, keyboard (keymap), AY, SD SPI, and the Z80N
itself (gate-level, bit-exact over hundreds of bootrom instructions).

Beyond goldens, the layered conformance approach is:

1. Unit and table-driven tests pin single behaviours (timing tables,
   routing matrices, reset defaults).
2. `pkg/testharness` integration tests exercise ROM code end-to-end and
   assert on rendered pixels or OCR'd screen text.
3. The Next cold boot is the whole-system integration test.
4. `VHDL_CONFORMANCE.md` enumerates the FPGA surface per axis so gaps are
   found by enumeration, not luck.

## 3. Consumer-site interfaces + SetXxx(nil) injection

`pkg/ula` needs to talk to a dozen Next subsystems without importing
`pkg/next` (import cycles, and the classics must build without the Next).
The ULA therefore declares the interfaces it consumes (`NextCompositor`,
`NextSpritePort`, `NextDMA`, `NextI2C`, `NextCopper`, `NextDAC`,
`SpeccyDAC`, `BetaDisk`, `NextDivMMC`, `NextRegAccess`, `PortTracer`)
and exposes a `SetXxx` injector for each. Passing nil unhooks. Wiring
happens in `cmd/zx_go/next.go` for production and in
`pkg/testharness/next.go` for tests.

## 4. Optional-interface opt-in wiring

Constructors probe their dependencies for optional capabilities via type
assertion instead of widening the required interface:

- `z80.New` probes `mem.(contentionWirer)` to share the T-state counter
  pointer and `mem.(memContender)` for per-access contention. A test
  mock that omits them simply gets no contention.
- `pkg/memory` reaches divMMC RAM through a small `DivMMCAccessor`
  interface, wired from outside.

The effect: minimal interfaces at package boundaries, zero-cost when a
capability is absent, and `pkg/z80`/`pkg/memory` never import Next
packages.

## 5. Hook registries on the hot path

The CPU exposes named hook registries: `AddPreFetchHook` /
`AddPostFetchHook` (same-name add replaces, nil removes), plus single
slots that predate them (`M1FetchHook`, `BreakpointCheck`, `TrapCheck`,
`SetRETNHook`, `OnSPLoad`, `NMICallback`). Users: divMMC automap, IF1
shadow-ROM traps, Multiface, Beta Disk $3Dxx paging, esxDOS RST 8, the
ZX8x video generator, tape fast-load traps, and every debugger surface.
Memory has the matching observer set (`WriteObserver`,
`SetRAMWriteHook`, paging/bank tracers). All hooks are nil-checked, so
the cost when unset is one branch.

Debugger-facing state that crosses goroutines uses atomics
(`IRQPending`, `PendingNMI`, the RZX hooks as `atomic.Pointer`, the
`BreakpointSet` as a copy-on-write map behind `atomic.Pointer`).

## 6. The NextReg dispatcher + centralised wiring

All 256 NextRegs live in one `nextregs.Dispatcher`: a 256-byte backing
store plus optional per-register `onWrite`/`onRead` handlers and
`onReset` hooks. The contract: an `onWrite` handler replaces default
storage and must call `Store()` itself if the byte should read back;
`onRead` returns live state for registers with side-effect semantics.
Reset defaults are the FPGA's cold-reset values, applied through the
handlers in three phases so subsystems observe the transition.

Every connection between a register and a subsystem goes through a
`WireXxx` function in `pkg/next/wire.go`, applied by the `Wire(opts)`
umbrella. Production and the test harness call the same functions, so a
register's behaviour cannot drift between the two. When you add a
NextReg handler, follow CONTRIBUTING.md: handler in wire.go, subsystem
test in the subsystem package, cross-subsystem test in the harness.

## 7. Timing models

Three coexisting levels, from coarse to fine:

- Lump accounting: most opcodes add a literal T-state total
  (`c.tstates += 11`). The dominant CPU model.
- FUSE-style per-cycle helpers (`m1`, `rd`, `wr`, `exec`) for opcodes
  converted to per-access contention. Gated by `MemContend`, currently
  enabled per-test rather than machine-wide (see known-gaps.md).
- Shared clock, derived views: the raw T-state counter is shared by
  pointer across CPU/memory/ULA. The Next adds a 3.5 MHz reference clock
  (`RefTstates`, kept in eighths) so audio and tape events land correctly
  across mid-frame turbo changes, and `BeamPosition()` derives the raster
  position from the same counter.

Contention is a property of the memory system, not the CPU: the classic
pattern {6,5,4,3,2,1,0,0} applies to $4000-$7FFF inside the display
window, is disabled on Pentagon, and returns zero at any turbo speed
(the FPGA only asserts contention at 3.5 MHz).

## 8. Record events, reconstruct at frame end

The renderer and mixer run once per frame, so anything that changes
mid-frame is recorded with a position and reconstructed later:

- Border writes append `{scanline, colour}`; `Render` replays them into
  per-line border colours.
- Beeper/tape/DAC level changes append `{tstateOffset, state}`; at frame
  end each output sample becomes the average level over its T-state
  window (a box filter). This turns sub-sample jitter into amplitude,
  which is what the real capacitor-coupled output does. A one-pole DC
  blocker models the output capacitor.
- The AY is the exception: it is synthesised at pull time from its own
  counters (it has no sub-sample edges worth recording).

## 9. Scanline quantisation on the Next

The Next compositor composes per scanline, and the Copper executes with
scanline + horizontal-threshold precision (WAIT releases at the correct
line and hpos; MOVEs for a row land before that row composites). This is
the stated precision limit of a per-scanline renderer; per-pixel beam
chasing was evaluated and documented as unnecessary for the ULA layer
because no Copper MOVE can change classic ULA state mid-line.

## 10. I/O-advanced device models

All four floppy controllers (WD1793, both WD1772s, µPD765A) and the
microdrive advance state per register access rather than per
microsecond: a command completes on the command write, each data-register
access moves one byte, seeks are instant, and error bits (lost data,
record-not-found) are synthesised from access patterns. The DOS ROMs
poll status in tight loops, so this is exactly as accurate as the
software can observe, at a fraction of the complexity. The deliberate
exceptions that DO model time: the ZX Printer drum (the ROM measures it)
and the microdrive GAP/SYNC pulse pattern (the IF1 ROM counts pulses).

## 11. Build-tag surface split

The wasm port is a set of `//go:build js` / `!js` file pairs, never
in-function conditionals: `entry_desktop.go`/`entry_js.go`,
`gui_desktop.go`/`gui_js.go`, `tracedb.go`/`tracedb_js.go`,
`pkg/audio` ready-wait split, `pkg/debugger` GUI gated `!js`. The
desktop build must always keep compiling; wasm-only behaviour differences
(no oto player, ROM injection instead of disk, no config persistence)
live behind the same tags.

## 12. Allocation and concurrency discipline

- Frame-rate code reuses buffers across frames (compositor scratch rows,
  wide-mode images, audio scratch). No per-frame heap churn.
- The emulation runs on one goroutine; UI and debugger surfaces touch it
  through atomics, mutexes on cold paths, or the pause handshake
  (`WaitIfPaused` + resume/ack channels). oto's audio callback pulls from
  a mutex-guarded ring.
- Package-level singletons are avoided except where a library demands it
  (one process-wide oto context behind `sync.Once`).

## 13. Comment and test conventions

From CONTRIBUTING.md, enforced in review:

- Comments explain why (hidden constraint, oracle citation, the bug this
  guards), never what, and never reference the current task or PR.
- Hardware behaviour gets integration tests through the harness; pure
  functions get unit tests. Long or ROM-dependent tests gate behind
  `-short` or skip when assets are missing.
- Tests must never write to the real install dir
  (`installtest.RedirectConfig` / `ZX_GO_NEXT_ROM_DIR=t.TempDir()`), and
  deterministic menu tests freeze the RTC (`ZX_GO_RTC_FIXED`).
