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
| Compositor blend modes 6/7 approximated as SLU in the scanline painter (the faithful mixer exists in `mixer.go` but the painter has not migrated onto it); tilemap `tm_below` per-pixel bit approximated | deferred | `pkg/next/compositor/compositor.go` |
| Hi-res Layer 2 shows visible rows 0..239; the bottom 16 of the 256-line modes are cropped (off-window overscan) | documented simplification | `pkg/ula/ula.go` (renderHiResLayer2), ROADMAP |
| ULA inner screen + border now render through the LIVE Next ULA palette per pixel — colour redefinition AND transparency, ULANext + standard decode per zxula.vhd:483-558 (closed by the base/Copper work), with mid-frame CPU flips of the DISPLAYED palette / ULANext state replayed per raster-stamped line (ULA/ClassicPaletized). Residue: Timex hi-res and the ULA-output-disabled fill keep the classic pre-render (live decode falls back to it), where transparency still relies on the legacy RGBA value-matching set | CLOSED for the standard screen mode incl. mid-frame palette flips (ULA group green); Timex residue deferred to the Graphics group | `pkg/ula/ula.go` (renderNextULARow, ulaVideoLine), `pkg/next/compositor/compositor.go` (ULARGBA) |
| ULA hardware scroll (NR$26/$27) + NR$1A clip apply in the standard live-palette render only: the Timex 512x192 / 8x1 modes keep the classic pre-render, which scrolls/clips nothing (the UlaScroll test's M-cycled Timex modes); the NR$68 bit 2 fine-scroll-X is stored but not rendered — it is a HALF-pixel shift on the FPGA's 14 MHz video bus, below the 7 MHz pixel resolution (same class as the copper half-pixel sampling) | precision limit + Timex residue (standard mode pinned by TestNexttestsULAScroll) | `pkg/ula/ula.go` (renderNextULARow), `pkg/next/wire.go` (WireULAControl) |
| Turbo-speed video timing: pkg/ula scanline/border tracking ignores the speed multiplier, so border effects are wrong above 3.5 MHz | deferred | `pkg/memory/memory.go` comment |

### NextReg / ports (see VHDL_CONFORMANCE.md for the full matrix)

| Gap | Status |
| --- | --- |
| NR$C0 programmable IM2 vector bits 7:5 unmodelled; IM status bits stored as 0 | deferred |
| NR$C4 reset default: expbus enable bit needs the composed read-back mux (flagged ❌ in the matrix) | deferred |
| ~30 composed read-backs ($68, $69, $C0, $C4, $C6, $CC-$CE, $A9, $0B...) not individually pinned to the VHDL mux | audit gap |
| Port $FF bit 6 (Timex/SCLD ULA-frame-INT disable) not implemented in WritePort | confirmed gap (matrix axis 4) |
| No exhaustive port-by-port VHDL decode conformance test; no single test enumerates all 256 write masks | audit gap |
| NR$02 iotrap read bit 4; NR$8C soft-reset latched low nibble; NR$0A DPI bits | deferred |
| NR$69 write now fans out live (bit 7 → Layer 2 enable, bit 6 → shadow display, bits 5:0 → Timex port-$FF mode, per zxnext.vhd:3617/3658/3924 — WireULAControl); read-back is the stored byte, not the FPGA's composed live mux (:6096) — diverges only if the guest writes the aliased ports ($FF/$7FFD/$123B) afterwards | wired (UlaScroll M-modes); composed read-back deferred with the other ~30 |
| Frame-origin offset (CPU tstate 0 vs ULA hc0/vc0) unvalidated; line-INT at turbo; IM2 vector table gates not all wired | audit gap (matrix axis 5) |

### DMA, buses, peripherals

| Gap | Status | Source |
| --- | --- | --- |
| zxnDMA: interrupt/match logic and DMA-vs-CPU bus contention not modelled; descriptor mode (port $DB) deferred. Read/write cycle-length costs are charged in CPU T-states (the FPGA FSM ticks at 28MHz) — a documented model convention; the prescaler delay IS turbo-exact (prescaler*4^turbo/2 T-states, dma.vhd:250-255/424) | deferred | `pkg/next/dma/dma.go` |
| UART/ESP: AT responder only, no real networking or socket emulation | out of scope | `pkg/next/uart/doc.go` |
| NR$0B joystick I/O mode: register exact, pin-repurposing behaviour (GPIO/UART on joystick pins) not modelled | out of scope | `pkg/next/wire.go` |
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
| Per-access memory contention (`MemContend`) off machine-wide; lump T-state totals are the shipping model | deferred, gated on turbo contention work | `pkg/z80/z80.go` |
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
