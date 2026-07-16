# Known gaps and simplifications

What the emulator knowingly does differently from real hardware, with
sources. Read this before "fixing" behaviour: most entries carry a
decision (deferred, out of scope, or precision limit), and several are
catalogued with rationale in `ROADMAP.md` and `VHDL_CONFORMANCE.md`.

Status vocabulary:

- deferred — real gap, acceptable for now, would be implemented given a
  motivating title or test.
- out of scope — decided against (usually external-world hardware).
- precision limit — consequence of the chosen rendering/timing
  architecture; closing it means changing the architecture.
- pragmatic model — a documented non-literal emulation of something the
  hardware does differently.

## Spectrum Next vs real hardware

### Video

| Gap | Status | Source |
| --- | --- | --- |
| Copper palette effects sample once per 7MHz pixel: the copper is cycle-paced (RunToCycle: MOVE=2 / NOOP=1 cycles at 28MHz) and interleaves per pixel with the live-palette ULA row render, but half-pixel colour detail (two MOVEs inside one pixel) collapses to one sample, top/bottom border rows resolve once per raster line (end-of-line palette state — colours are live, sub-line copper detail is not), and NON-ULA layers (L2/sprites/tilemap) still see copper state at whole-line granularity | precision limit (per-pixel sampling; surface pinned by TestNexttestsCopper) | `pkg/next/copper/copper.go`, `pkg/ula/ula.go` (applyNextCompositor) |
| Compositor blend modes 6/7 (additive L+U / L+U-5) now route the scanline painter through the FPGA-golden `Mix` per pixel, with the NR$68 blend-operand bits wired — pinned by TestNexttestsGraphicsLightenDarken + TestComposeScanlineAdditiveBlend. Residue: the tilemap `tm_below` per-pixel bit stays approximated in the non-blend paint orders | CLOSED for the blend modes (Graphics group green); tm_below residue deferred | `pkg/next/compositor/compositor.go` |
| Next wide-frame geometry (r51, #171): the Next renders the FPGA's full 320×256 wide frame (paper at 32,32) — sprites, tilemap and wide Layer 2 share ONE vertical origin (the whc/wvc counters, zxnext.vhd:4208/4337/4389), all 256 hi-res Layer 2 rows show, and sprites repaint above wide Layer 2 in the non-L-first NR$15 modes. The overlay repaints the layers each NR$15 mode places above L2 from their sources (OverpaintWideL2Row): sprites in the non-L-topmost modes, the tilemap in the U-above-L modes (SUL below sprites, USL/ULS above — the RAMS/Galaxian menu-text fix, NR$15=$33 USL + NR$68 ULA-off). Residue: classic ULA PIXELS above wide L2 in SUL/USL/ULS are still covered (needs per-pixel ULA data at that point in the pipeline; content that disables the ULA via NR$68 bit 7 — RAMS — has none), and the tilemap's per-tile below/priority attribute is approximated by the on-top/nibble rules | CLOSED (geometry); U-above-hi-res-L2 order is a documented simplification | `pkg/ula/ula.go` (SetNextCompositor geometry, renderHiResLayer2), `pkg/next/compositor` (SpritesAboveLayer2, ComposeSpriteOverlayRow), `TestNextWideFrameLayerAnchoring` |
| ULA inner screen + border now render through the LIVE Next ULA palette per pixel — colour redefinition AND transparency, ULANext + standard decode per zxula.vhd:483-558 (closed by the base/Copper work), with mid-frame CPU flips of the DISPLAYED palette / ULANext state replayed per raster-stamped line (ULA/ClassicPaletized). The Timex screen-1 / hi-colour / hi-res modes and the LoRes layer now render through the same live path (Graphics group): hi-res composites at its native 512 half-pixels when the mode is stable for the whole frame (renderWideTimexHiRes), and decimates to file-1 pixels per row inside MIXED-mode frames (a copper switching NR$69 per band — NReg0x69's hi-res text bands render half-sampled). Residue: the ULA-output-disabled fill keeps the classic pre-render, and the hi-res re-composite resolves the palette at end-of-frame state (sub-line copper palette detail in hi-res is not covered) | CLOSED for all ULA display modes (ULA + Graphics groups green); disabled-fill + mixed-frame hi-res decimation are documented simplifications | `pkg/ula/ula.go` (renderNextULARow, renderNextTimexHiResRow, ulaVideoLine), `pkg/next/compositor/compositor.go` (ULARGBA, ComposeHiResScanline) |
| ULA hardware scroll (NR$26/$27) + NR$1A clip now apply in every live ULA mode, Timex screen-1/hi-colour/hi-res included (hi-res shifts by classic pixels = two half-pixels, zxula.vhd:199); the NR$68 bit 2 fine-scroll-X is stored but not rendered — it is a HALF-pixel shift on the FPGA's 14 MHz video bus, below the 7 MHz pixel resolution of the 256-wide render (same class as the copper half-pixel sampling) | precision limit (fine-scroll-X only; standard mode pinned by TestNexttestsULAScroll, Timex modes by the Graphics group) | `pkg/ula/ula.go` (renderNextULARow, renderNextTimexHiResRow), `pkg/next/wire.go` (WireULAControl) |
| Turbo-speed video timing: pkg/ula scanline/border tracking ignores the speed multiplier, so border effects are wrong above 3.5 MHz | deferred | `pkg/memory/memory.go` comment |
| Next raster geometry is fixed at the 128K/+3 flavour (311 lines × 228 T, frame INT at t=291 per FrameIntTiming): guest writes to the NR$03 machine-timing bits or NR$05 50/60 Hz after boot do not retune the frame geometry or INT position, and the 48K display timing (312 lines × 224 T, 448 hc) is not modelled — the Timing/Changing8kBank raster band runs ~2% shorter than the FPGA's 48K-timing frame would show (both our row and MAME 0.282's proportion are pinned by the runner) | deferred (frame length 70908 is baked into audio pacing + boot goldens) | `pkg/ula/ula.go` (TStatesPerLine), `pkg/next/inttiming.go`, `cmd/zx_go/next.go` (configureClassicIntTiming) |
| Mid-frame CPU palette CONTENT writes (NR$41/$44) raster-stamp into palette.Bank's per-frame write log and replay row by row through the 320 walk + border sweep (FPGA truth: a palette BRAM write is visible to the video fetch on the next pixel, zxnext.vhd:4919-4930). Granularity is one raster line — a write landing mid-line renders from that write's line or the next (the ScanlineReadingAndInterrupt READ marker sits on target or target+1, matching the upstream ReadMe's "starts somewhat midway" caveat) — and the hi-res/wide re-composites still resolve palette content at end-of-frame state | CLOSED at line granularity (Timing group); sub-line start + hi-res are precision limits (same class as the endorsed copper residuals) | `pkg/next/palette/palette.go` (stamped-write log), `pkg/ula/ula.go` (applyNextCompositor replay) |
| NR$64 video line offset (core 3.1.5+) is stored raw with no effect on NR$1E/$1F reads, the line interrupt or the copper (ScanlineReadingAndInterrupt's O/K/P/L keys would show it) | deferred | `pkg/next/wire.go` |

### NextReg / ports (see VHDL_CONFORMANCE.md for the full matrix)

| Gap | Status |
| --- | --- |
| NR$C0 is live (r54, #169): bit 0 selects the hardware-IM2 vectored interrupt mode (see the CTC/IM2 row below), bits 7:5 form the generated vector's upper bits (zxnext.vhd:1999), bit 3 stackless NMI, and the read composes the LIVE Z80 IM mode into bits 2:1 (vhd:6230). Pinned by TestWireIM2* | CLOSED |
| NR$C4 is composed on read (zxnext.vhd:6239: expbus-enable bit 7 & "00000" & ula_int_en — bit 1 the NR$22 line enable, bit 0 the INVERTED frame-INT disable latch), writes alias BOTH low bits into the shared NR$22 path (bit 1 → line enable vhd:5610, bit 0 → port_ff_reg(6) inverted vhd:3621), and the reset default seeds the expbus enable (vhd:5096 → reads $81). Pinned by TestSpec_NRC4_InterruptEnable0 + TestFrameIntDisableSharedLatchWriters | CLOSED |
| ~30 composed read-backs ($68, $C0, $C4, $C6, $CC-$CE, $A9, $0B...) not individually pinned to the VHDL mux ($69 closed by the Graphics group) | audit gap |
| Port $FF bit 6 (Timex/SCLD ULA-frame-INT disable) is wired: the ULA's port-$FF byte IS the FPGA's shared port_ff_reg (zxnext.vhd:3609-3635), written by port $FF bit 6 / NR$22 bit 2 / NR$C4 bit 0 (inverted), pushed into cpu.FrameIntDisabled (gates INT generation at the source, zxula_timing.vhd:551, mid-pulse disable withdraws the line) and composed back at NR$22 bit 2, NR$C4 bit 0 and the NR$08-gated port-$FF read. Cleared on NR$02 hard/soft reset + machine reset. Pinned by TestPortFFBit6FrameIntDisable / TestFrameIntDisableSharedLatchWriters / TestFrameIntDisableResetClears / TestFrameInt_NarrowPulse_DisableMidPulseWithdraws. Residue: only classic-model port $FF writes never gate the INT (a plain 48K/128K has no SCLD — correct for the machines zx_go models, but a real Timex TS2068 would) | CLOSED (matrix axis 4) |
| No exhaustive port-by-port VHDL decode conformance test; no single test enumerates all 256 write masks | audit gap |
| NR$02 iotrap read bit 4; NR$8C soft-reset latched low nibble; NR$0A DPI bits | deferred |
| NR$69 is now a fully live alias: writes fan out (bit 7 → Layer 2 enable, bit 6 → shadow display, bits 5:0 → Timex port-$FF mode, zxnext.vhd:3617/3658/3924) AND the read composes the three live registers back (:6096), so guest writes to $FF/$7FFD/$123B are reflected. Port $123B likewise reads its composed control state (:3933), and port $FF reads return the Timex register when NR$08 bit 2 is set (:2813). Pinned by TestNexttestsGraphicsNextReg0x69 ("Tests OK: 10/10") + TestSpec_NR69_ComposedRead | CLOSED (removed from the ~30-composed-read-backs audit row) |
| Frame-origin offset (CPU tstate 0 vs ULA hc0/vc0) unvalidated; line-INT at turbo; IM2 vector table gates not all wired | audit gap (matrix axis 5) |

### DMA, buses, peripherals

| Gap | Status | Source |
| --- | --- | --- |
| Port $0B (the legacy Zilog-DMA port — the zxnDMA's "Z80 DMA compatibility mode" decode) is wired: both ports reach the one controller, the accessed port latches dma_mode (zxnext.vhd:1811-1819), and the mode seeds the byte counter -1 at LOAD/CONTINUE/auto-restart so a Zilog-mode block moves length+1 bytes (dma.vhd:482-486). LOAD also latches the source/destination pointers by the direction in force at LOAD, surviving a later direction flip, exactly like the FPGA. Pinned by TestNexttestsZilogDMA against the Misc/ZilogDMA core-3.1.5 board photo | CLOSED (found by a manual run of Misc/DmaInteractive, whose default port is $0B) | `pkg/ula/ula.go` (dmaClaims), `pkg/next/dma/dma.go` |
| zxnDMA: interrupt/match logic and DMA-vs-CPU bus contention not modelled; descriptor mode (port $DB) deferred. Read/write cycle-length costs are charged in CPU T-states (the FPGA FSM ticks at 28MHz) — a documented model convention; the prescaler delay IS turbo-exact (prescaler*4^turbo/2 T-states, dma.vhd:250-255/424). Continuous-mode transfers run synchronously and charge their duration afterwards, so their port writes all raster-stamp at one instant: a transfer streaming VARYING bytes to the border collapses to its final value on screen (Misc/ZilogDMA's top-border noise band), while fixed-value streams (the flashing timing blocks) render their band geometry exactly | deferred | `pkg/next/dma/dma.go` |
| CTC (r50) + hardware-IM2 vectored interrupts (r54, #169): channels 0-3 live behind ports $183B-$1F3B with NR$C5 int-enables; pulse mode as before, and with NR$C0 bit 0 set the im2.go daisy chain is WIRED end-to-end — line INT (vector 0), CTC 0-3 (vectors 3-6) and the ULA frame INT (vector 11) latch as level requests, the winning source supplies `NR$C0[7:5] & vector & 0` at the Z80's IM2 acknowledge (z80.CPU.IntAckFunc), exact ED 4D releases the in-service device, the ULA still pulses when the Z80 is not in IM 2 (the one EXCEPTION source), and NR$20/$C8/$C9 give software-generated requests + sticky status with write-1-to-clear (`pkg/next/im2block.go`, TestWireIM2*). This closed TX-1696 (#169) — its audio install is caught by CTC ch0 in hw-IM2 mode, measured on real silicon first. Remaining: counter-mode ZC/TO trigger cascade between channels (zxnext.vhd:4082), UART rx/tx interrupt sources (1, 2, 12, 13 — the UART generates no interrupts), NR$CC-$CE DMA-interrupt enables, and pulse-mode sticky status (the chain is held reset in pulse mode, so NR$C8/$C9 only record in hw mode) | partial (both interrupt modes live) | `pkg/next/ctcblock.go`, `pkg/next/im2block.go`, `pkg/next/im2.go` |
| 28 MHz timing: REAL-HARDWARE VALIDATED (#169, `_tools/hw-probe`, 2026-07-15). NOPs 33 lines/12k (5T exact), pushes 40 lines/6k (~12.2T — writes do NOT wait, ROM-window writes = RAM writes), frame INT at raster 248 (exact). Residual: real pushes read ~0.2T/insn slower than the model (40 vs 39 lines per 6,000) — below one raster line per 4,632-push slide, not worth modelling. TX-1696's geometry is impossible on real silicon too; suspicion moved to the NextZXOS version (2.07k/2.08 tested-working vs our 2.09 card) shifting the slide-entry phase | closed (validated) | `pkg/z80/z80.go` (readMem), `_tools/hw-probe/`, docs/compatibility.md TX-1696 row |
| UART/ESP: AT responder only, no real networking or socket emulation | out of scope | `pkg/next/uart/doc.go` |
| NR$0B joystick I/O mode: register exact, pin-repurposing behaviour (GPIO/UART on joystick pins) not modelled | out of scope | `pkg/next/wire.go` |
| NR$B0/$B1/$B2 (extended keys / MD pad) are wired: composed on every read from the live input state, pinned bit-for-bit to the read mux (zxnext.vhd:6206-6215) by TestWireExtendedKeys*. Remaining: the Megadrive-only buttons (X Z Y MODE START A C) have no emulator-side input source — no frontend maps a gamepad — so NR$B2 always reads idle; the Kempston byte covers directions + one fire. The port $1F/$37 side is now composed (r53): both ports decode on the low address byte and idle at $00 (zxnext.vhd:2546-2547/:2829-2830), with the NR$05 routing incl. the MD-mode START/A bits 7:6 (:3472-3494) wired through `pkg/ula` nextJoyPortByte — the MD bits just read 0 until a pad source exists | CLOSED (read-back + $1F/$37 decode); MD-pad button source deferred | `pkg/next/wire.go` (WireExtendedKeys), `pkg/keyboard` (ExtendedKeys), `pkg/ula` (MDJoyLeft/Right) |
| RTC: clock-register writes discarded (host time is truth); only NVRAM persists; 1 Hz output disabled | pragmatic model | `pkg/next/rtc/rtc.go` |
| divMMC $2009 FRAMES-bump stub and bank-1 stub write-protect emulate firmware-installed handlers non-literally | pragmatic model | `pkg/next/divmmc/divmmc.go` |
| esxDOS F_READDIR entry layout simplified; F_FSTAT fills size + dir bit only; no success-with-carry contract | deferred | `pkg/next/esxdos/file_handlers.go` |
| .NEX loader: `Copper` field exists but is never populated (code states standard V1.2 carries no copper section, package doc says otherwise) — doc/implementation inconsistency to resolve | needs resolution | `pkg/next/nex/nex.go` vs `doc.go` |
| ROM SHA-256 digests reported but not enforced as a boot gate | planned | `pkg/next/install/install.go` |
| Audio event placement above 3.5 MHz is approximate (sample-exact placement is a known limit); Next DAC granularity notes in docs/spectrum-next.md | deferred | docs/spectrum-next.md |

### Compatibility

Arbitrary `.NEX` game compatibility is the youngest area of the whole
project: a growing set of titles are playable, several render with bugs,
many are unverified. The per-title manifest is `docs/compatibility.md`.
This is a body of work, not a single gap.

## Classic line scope limits

| Item | Status | Source |
| --- | --- | --- |
| IF1 RS-232 and SinclairNET: stubbed as "no peripheral connected"; CTR WAT CPU-stall not modelled | out of scope | `pkg/if1/ula.go` |
| Floppy controllers are I/O-advanced: no rotational/seek timing (weak sectors and Speedlock are modelled on the +3) | pragmatic model | fdc package docs |
| Beta density bit not modelled (TR-DOS always MFM) | pragmatic model | `pkg/betadisk/interface.go` |
| Pentagon-1024 mapping mode ($EFF7 reg 2) latched but not modelled | deferred | `pkg/memory/memory.go` |
| TZX blocks 0x12/0x13/0x15 (pure tone / pulse sequence / direct recording) parsed but skipped | deferred | `pkg/ula/tzx.go` |
| Floating bus returns $FF on +2A/+3/Next (correct) — noted here because it surprises people | correct behaviour | `pkg/ula/ula.go` |
| Multiface paging readback models $7F3F/$1F3F only | deferred | `pkg/ula/ula.go` |
| MEMPTR implemented to the depth zexall observes; some exotic update sites may be missing (only visible via F3/F5) — passes z80test v1.2a's memptr variant outright | documented depth | `pkg/z80/z80.go`; `pkg/testharness/z80test_test.go` |
| Per-access memory contention (`MemContend`) off machine-wide; lump T-state totals are the shipping model. Instrumented by Timing/Changing8kBank: the contention-ON and NR$08-bit-6-OFF variants render identical raster bands (equality pinned by the runner, matching MAME 0.282's captures); on the FPGA contention-ON at 3.5 MHz (zxnext.vhd:4481) would lengthen the ON band | deferred, gated on turbo contention work | `pkg/z80/z80.go` |
| SAM: MIDI, clock port, SD/IDE ports ignored | out of scope | `pkg/sam/io.go` |
| SAA1099 is datasheet-modelled (no hardware-verified reference core exists) | best available | `pkg/saa1099/saa1099.go` |

## Tooling and port gaps

| Item | Status | Source |
| --- | --- | --- |
| Time-travel ring captures CPU + visible 64K + ports + border only; upper RAM banks, divMMC RAM, NextRegs, MMU slots not captured/restored (phases 2a/2b catalogued) | deferred | `cmd/zx_go/timetravel.go` |
| wasm binary ~31 MB (Fyne linked as dead code); shrinking requires splitting the core out of `package main` | later optimisation | `wasm/STATUS.md` |
| Desktop run loop does not use the fastboot fast-forward (browser only) | deferred | `cmd/zx_go/fastboot.go` |
| The Next cannot tape-load in the browser player; .tap on the Next falls back to the 128K | deferred | `GoEmulator.js` |
| Browser direct-boot seed table and the nexload menu-index are coupled to the SD distro version; re-verification procedure documented | maintenance coupling | `packages/emulator-core/README.md` |
| Warm-boot path (`--warm-boot`) uses captured reference dumps; non-faithful by design, default off | dev tool | `cmd/zx_go/next.go` |

## How gaps get closed

The working method, proven on the 128K-BASIC and NextGuide campaigns:

1. Check the catalogue first: `ROADMAP.md` (hardware-feature catalogue
   with [⊘] decisions) and `VHDL_CONFORMANCE.md` (per-axis matrix).
2. Extract the VHDL truth for the row (file + lines), write or extend a
   test that pins the emulator to the VHDL value, then fix TDD-style.
3. For behavioural mysteries, use the divergence tooling: shared-clock
   lockstep/nrdiff/memdiff against a reference emulator, then
   first-divergence bisect. Symptoms are usually downstream; find the
   first divergence.
4. Re-run the cold boot and the full suite. Update this file, the
   matrix, and the roadmap entry.

When you close a gap listed here, delete its row and note the fix in
`ROADMAP.md`. When you accept a new simplification, add a row with a
status and a source. Keeping this file honest is part of the definition
of done (see [README.md](README.md)).

Note: this file's tables render verbatim onto the PUBLIC conformance
dashboard (`conformance/`, published to GitHub Pages), so it stays the
single source for gap rows. Write rows accordingly.
