# Code organisation

Where things live, what each package owns, and how the pieces build.
Module path: `github.com/conorarmstrong/zx_go`. Roughly 145k lines of Go
across `cmd/` and `pkg/` (tests included; test code is close to half of
it by volume).

## Top level

```
cmd/zx_go/        all three surfaces + machine assembly + debugger backend
pkg/              the emulator proper (see below)
docs/             user docs + this architecture documentation
fuse/             vendored FUSE 1.6.0 source, cross-reference only
_tools/           GHDL testbenches and diff tooling (golden-vector capture)
roms/next/        user-installed licensed Next ROMs + SD content (gitignored)
LICENSES/         GPLv3 text + notice for the embedded tbblue_loader.rom
```

Key top-level documents: `README.md`, `ROADMAP.md` (state + backlog +
invariants), `VHDL_CONFORMANCE.md`, `DEBUGGER.md`, `CONTRIBUTING.md`,
`COMPARISON.md`, `CHANGELOG.md`.

## cmd/zx_go

One `package main` holding the machine assembly and every surface.

| Area | Files | Notes |
| --- | --- | --- |
| Entry points | `entry_desktop.go`, `entry_js.go`, `gui_js.go` | Build-tag split. `main()` is one line per tag. |
| Desktop GUI | `gui_desktop.go`, `main.go` | `emulator` struct (the machine assembly), `run()` frame loop (20 ms ticker), Fyne menus, CRT filter. |
| Headless | `headless.go`, `flags.go`, `debug.go` | `runHeadless`, all `--headless` instrumentation, press-key scheduling, watchpoints, crash detect. |
| wasm | `wasm_js.go`, `wasm_debug_js.go` | Every `js.FuncOf` export; the debug bridge. |
| Next assembly | `next.go`, `next_directboot.go`, `fastboot.go`, `nexload_macro.go`, `warmboot.go` | Wires `pkg/next/*` into the machine, boot paths, menu-typing macros. |
| Debugger backend | `debugger.go` + `*_cmd.go` files | `remoteDebugger`, `handleCommand` (single dispatch for GUI/telnet/wasm), time-travel, provenance, bisect, crash detect. |
| Dev diff modes | `bisect.go`, lockstep/nrdiff/memdiff code paths | Ours-vs-reference divergence hunting. |

## pkg — core execution

| Package | Owns | Key symbols |
| --- | --- | --- |
| `pkg/z80` | Z80/Z80N CPU | `CPU` (z80.go), `executeBaseInstruction` and the prefix switches, `z80n.go` (Z80N ops), `ExecuteFrame`, `StepInstructionWithIRQ`, hook registries (`AddPreFetchHook`...), `Variant`, `NextRegSink`. |
| `pkg/memory` | banks, paging, contention, overlays | `Memory`, `PageMemory` ($7FFD), `PageMemoryPlus3` ($1FFD), `SetMMU`/`syncMMUFromPage`, `readValue`/`Write` (the priority mux), `ContendMemory`/`ContendPort`, `next.go` (bootrom, config mode, Alt-ROM, Layer 2 paging, divMMC accessor). |
| `pkg/ula` | I/O hub, classic video, tape, audio events | `ULA`, `ReadPort`/`WritePort` (dispatch chains), `Render`, `TapePlayer` (tape.go, tzx.go), `BeamPosition`/`ActiveVideoLine`, the consumer-site Next interfaces (`NextCompositor`, `NextDMA`, `NextDAC`, `BetaDisk`, ...), `dcblock.go`. |
| `pkg/keyboard` | key matrix | `Keyboard`, `Scan`, `HandleKeyWithModifiers`, `TypeRune` (layout-independent symbols), `UseZX8xLayout`, JSON overrides. |
| `pkg/audio` | output pipeline | `AudioSystem`, ring buffer (882 samples/frame), oto reader (desktop), `PullMono` (wasm), WAV recording, keep-alive. |
| `pkg/ay` | AY-3-8912 / YM2149 | `AY` (FPGA ym2149.vhd port), `Engine` (3-chip Turbosound bank), measured volume tables. |
| `pkg/audiodac` | SpecDrum/Covox | `DAC`, event-timed `GenerateFrame`. |
| `pkg/roms` | embedded ROMs + model constants | `//go:embed data/*`, `ROMManager`, `SpectrumModel`, `FrameTStates()`. |

## pkg — machine stacks

| Package | Owns |
| --- | --- |
| `pkg/next/*` | The Spectrum Next. Children: `nextregs` (dispatcher), `layer2`, `tilemap`, `sprite`, `lores`, `palette`, `compositor`, `copper`, `dma`, `ctc`, `divmmc`, `esxdos`, `sdcard`, `nex`, `rtc`, `uart`, `dac`, `keymap`, `install`. Umbrella files: `wire.go` (all NextReg wiring), `nrdecode.go` (the FPGA read-mux table + zero-reads for undecoded registers), `im2.go` (IM2 daisy-chain), `im2block.go` (hardware-IM2 vectored mode, NR$C0 bit 0: routes frame/line/CTC sources into the chain, supplies the generated vector at IM 2 acknowledge, ED 4D end-of-interrupt), `inttiming.go` (frame INT timing), `ctcblock.go` (the four live CTC channels: port decode, NR$C5, pulse-mode INT line via `z80.CPU.ExtIntFunc`). See [next-fpga.md](next-fpga.md). |
| `pkg/peripherals` | `PeripheralManager`: one optional instance of each classic device, port-claim priority chain, the $0000-$3FFF overlay precedence (IF2 → Multiface → DISCiPLE → IF1). |
| `pkg/plus3fdc` | µPD765A FDC + all disk image parsers (DSK/EDSK/UDI/MGT/IMG/SAD/TRD/D40/D80 readers live here and are reused by other controllers). |
| `pkg/betadisk` | WD1793 + Beta interface + .TRD images. TR-DOS ROM auto-paging itself lives in `pkg/memory` (`BetaPreFetch`). |
| `pkg/disciple` | MGT DISCiPLE: WD1772, GDOS ROM/RAM overlay, format-stream parsing. |
| `pkg/if1`, `pkg/microdrive` | Interface 1 shadow-ROM traps + microdrive tape-loop model; `.mdr` cartridge format. |
| `pkg/if2` | 16K ROM cartridge slot. |
| `pkg/multiface` | MF1/128/3: `multiface.go` (integration model) and `core.go` (clock-exact FPGA multiface.vhd transcription). |
| `pkg/kempmouse`, `pkg/zxprinter` | Kempston mouse; ZX Printer with cycle-accurate drum timing. |
| `pkg/zx8x` | ZX80/ZX81: CPU-generated display, R-bit-6 INT, SLOW-mode NMI, `.P`/`.O` loading. |
| `pkg/sam`, `pkg/saa1099` | SAM Coupé ASIC (4 modes, line-accurate lazy renderer, ASIC contention tables, WD1772) and the SAA1099 sound chip. |

## pkg — formats and support

| Package | Owns |
| --- | --- |
| `pkg/snapshot` | `.sna`/`.z80`/`.szx` load and save, in-memory codecs for RZX embedding. |
| `pkg/rzx` | RZX recording/playback (instruction counts + IN byte stream = determinism), autosave tiers, competition mode, DSA/SHA-1 signing (format-mandated). |
| `pkg/debugger` | Visual debugger widgets (`//go:build !js`) plus fyne-free core types: `BreakpointSet` (lock-free copy-on-write map), provider interfaces, bank access. |
| `pkg/testharness` | Deterministic scripted machine for integration tests: `New(model)`, `RunFrames`, `PressKey`, `ScreenText()` (screen OCR), `RunUntilText`; `next.go` builds a full Next. |
| `pkg/trace` | Structured event emitter behind `--trace` (JSON lines; no-op when disabled). |
| `pkg/zxlog` | slog-based console formatting + banner. |
| `pkg/config` | Persisted user settings (desktop only). |
| `pkg/version` | Build metadata. |

## Test layout conventions

- Tests sit beside the code, one focused `*_test.go` per behaviour, and
  large table-driven suites for timing and routing matrices.
- Hardware behaviour is tested end-to-end through `pkg/testharness`
  (poke a program, run frames, assert pixels or screen text), not by
  mocking buses. See CONTRIBUTING.md for the canonical shapes.
- Golden-vector tests (`fpga_golden_test.go` + `testdata/*_golden.txt`)
  replay GHDL simulations of the real VHDL. The capture tooling lives in
  `_tools/<subsystem>-vhdl-test/`.
- Gating: `go test -short` skips zexdoc/zexall and real-ROM boots. Tests
  that need licensed ROMs skip when the ROMs are absent, and must never
  write to the real install dir (`installtest.RedirectConfig`).

## Build system

- Desktop: `go build ./cmd/zx_go` (cgo: Fyne needs a C toolchain and
  OpenGL). `Makefile` adds convenience targets and version stamping.
- wasm: `scripts/build-wasm.sh` in the parent package runs
  `GOOS=js GOARCH=wasm go build ./cmd/zx_go` → `dist/zx.wasm` plus
  `wasm_exec.js`. When no Go toolchain is present it falls back to a
  prebuilt `dist/` (the app Dockerfiles build one in a golang stage).
  The wasm binary is ~31 MB because Fyne links in as dead code.
- The `//go:build js` / `!js` tag split is the whole port. The desktop
  build must keep working after any wasm-side change (repo invariant).
- npm surface (`packages/emulator-core/package.json`): `npm run build`,
  `npm run test` (runs the Go suite).
