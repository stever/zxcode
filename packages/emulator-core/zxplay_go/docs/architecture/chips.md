# Emulated chips and hardware blocks

What real silicon (or silicon-equivalent logic) zxplay_go models, where each
model lives, which style it uses, and what its oracle is. Styles are
defined in [emulation-patterns.md](emulation-patterns.md); Next-specific
FPGA blocks are summarised here and detailed in
[next-fpga.md](next-fpga.md).

## Summary table

| Chip / block | Real part | Package | Style | Oracle |
| --- | --- | --- | --- | --- |
| CPU | Zilog Z80A / Z80N (FPGA) | `pkg/z80` | cycle-accurate, per-opcode T-states | zexdoc/zexall, Sean Young, FUSE, GHDL t80n gate golden |
| ULA (48K/128K/+2A/+3) | Ferranti ULA / Amstrad gate array | `pkg/ula` + `pkg/memory` | frame render + recorded events; cycle-accurate contention | FUSE, zxula_timing.vhd, Ramsoft floating-bus paper |
| PSG | AY-3-8912 / YM2149 | `pkg/ay` | cycle-faithful FPGA port, sample-rate synthesis | audio/ym2149.vhd + golden test, measured volume curves |
| Turbosound | 3 × AY (Next) | `pkg/ay` (`Engine`) | chip-select bank over the AY core | $FFFD select protocol, NR$06 |
| Beeper / tape out | ULA bit 4/3 | `pkg/ula` | event-timed box filter + DC blocker | hardware behaviour (capacitor coupling) |
| DACs | SpecDrum, Covox, Next 4-ch, Soundrive | `pkg/audiodac`, `pkg/next/dac` | event-timed box filter | dac golden test |
| SAA1099 | Philips SAA1099 (SAM) | `pkg/saa1099` | datasheet-modelled, float phase accumulators | datasheet only (no open reference core) |
| FDC (+3) | NEC µPD765A | `pkg/plus3fdc` | I/O-advanced 3-phase command machine | datasheet; weak sectors + Speedlock heuristic |
| FDC (Beta/TR-DOS) | WD1793 | `pkg/betadisk` | I/O-advanced | datasheet tests |
| FDC (DISCiPLE) | WD1772 | `pkg/disciple` | I/O-advanced | datasheet; WD1772-vs-1793 differences modelled |
| FDC (SAM) | WD1772 | `pkg/sam` | I/O-advanced | modelled on betadisk structure |
| Microdrive + IF1 ULA | Sinclair IF1 | `pkg/if1`, `pkg/microdrive` | tape-loop with pulse-accurate GAP/SYNC | FUSE if1.c (near line-for-line), libspectrum .mdr |
| Multiface | Romantic Robot MF1/128/3 | `pkg/multiface` | two models: integration model + clock-exact FPGA core (the Next's port pair drives the FPGA core via `pkg/next/mf.go`) | multiface.vhd + GHDL golden |
| RTC | DS1307 on i2c | `pkg/next/rtc` | register-accurate; host clock; NVRAM persisted | DS1307 datasheet; NextZXOS bit-bang traffic |
| SD card | SPI-mode SD/SDHC | `pkg/next/sdcard` | protocol-accurate SPI state machine, CSD v1/v2, CRC16 | SD spec + SPI golden test + boot behaviour |
| ESP Wi-Fi | ESP8266 AT firmware | `pkg/next/uart` (ports $133B-$163B via ULA.SetNextUART) | deliberate stub (AT responder, no networking; NR$A8/$A9 are the ESP GPIO regs, not the UART) | scope decision |
| Kempston joystick | — | `pkg/ula` | port $1F bitmap | classic behaviour |
| Megadrive pad (Next) | 3/6-button MD controller | `pkg/ula` (MDJoyLeft/MDExtraState), `pkg/next` (NR$B2) | left pad only: 12-bit i_JOY vector fed by the host gamepad; ports $1F/$37 per NR$05 routing. The pad's own 3-state select/multiplex protocol is not modelled — the FPGA presents the decoded vector, so there is nothing to multiplex | zxnext.vhd:90, :3472-3507, :6206-6215 |
| Kempston mouse | — | `pkg/kempmouse` (classic), `pkg/next/mouse` (Next $FADF/$FBDF/$FFDF, NR$0A DPI/reverse) | free-running 8-bit counters | port decode masks; ps2_mouse.v + zxnext.vhd:3541-3560 |
| ZX Printer | — | `pkg/zxprinter` | cycle-accurate drum timing | ROM polling behaviour |
| SAM ASIC | MGT ASIC | `pkg/sam` | line-accurate lazy renderer + contention tables | SAM technical docs; spec tests |
| ZX80/81 "ULA" | discrete logic + Z80 tricks | `pkg/zx8x` | CPU-generated display (NOP substitution) | hardware documentation; spec tests |
| Next FPGA blocks | TBBlue Xilinx core | `pkg/next/*` | VHDL transcription + goldens | zxnext.vhd et al. (see next-fpga.md) |

## CPU — Z80 and Z80N (`pkg/z80`)

One monolithic `CPU` struct: main/alternate registers, IX/IY/SP/PC, I/R,
IFF1/IFF2, IM, `WZ` (MEMPTR), flag lookup tables, and the timing state.
Decode is hand-written nested switches (base, CB, ED, DD, FD, DDCB,
FDCB), no code generation and no jump tables. Each case adds its own
T-state total; converted opcodes use FUSE-style per-cycle helpers
instead.

Faithfulness points:

- Undocumented flags F3/F5 everywhere, MEMPTR to the level zexall
  observes (BIT n,(HL)), R bumped on M1/INTA (bit 7 preserved), DD/FD
  NONI handling per Sean Young, SLL, IM/NEG/RETI mirrors, IFF2 semantics
  for LD A,I / NMI.
- Interrupts: IM0/1/2 with correct T-states, EI delay, `interrupt()`
  clears both IFFs (Zilog behaviour NextZXOS relies on), NMI leaves IFF2
  alone (FUSE-matched), stackless NMI (NR$C0 bit 3, Next): acceptance
  writes the return PC to NR$C2/$C3 with the push's memory writes
  SUPPRESSED (RAM untouched, SP still -2 — zxnext.vhd:1828/:2052 force
  MREQ off during the NMIACK cycles), and the one armed RETN-family
  return (`StacklessRETNArmed`, z80_stackless_retn_en) takes PC from
  NR$C2/$C3 with its pop reads suppressed (SP still +2). Atic Atac's
  SP-cursor object sorter under its ~20 kHz NMI pacer depends on the
  suppression (#187).
- Frame interrupts: whole-frame assert for classics, VHDL-derived narrow
  pulse (`IntAssertTstate`/`IntPulseTstates`) plus line interrupt for
  the Next.
- Z80N: ~30 extended ED opcodes in `z80n.go`, gated on
  `Variant == VariantZ80N`, T-states from the Next wiki, NEXTREG opcodes
  through the `NextRegSink` interface. Verified bit-exact against a GHDL
  simulation of the FPGA's t80n core (`z80n_golden_test.go`).
- Turbo: NR$07 speed select scales the frame budget, adds the 28 MHz M1
  wait state, and feeds the 3.5 MHz reference clock for audio/tape.

Conformance: `TestZexdoc`/`TestZexall` (Cringle exercisers under a flat
64K + BDOS trap), MEMPTR/timing/interrupt test batteries, the gate-level
golden.

## ULA — video, ports, tape (`pkg/ula`)

The ULA type is the I/O hub for every machine and the classic video
renderer. Video: once-per-frame render of the 256×192 bitmap
(Spectrum address interleave, attributes, FLASH every 16 frames) inside
a 320×240 border (320×256 on the Next — the FPGA's wide frame, paper at
32,32), with mid-frame border changes replayed per scanline. On classic
models the PAPER renders from beam-time scanline captures: the CPU's
ExecuteFrame polls ula.CaptureScanlines as the counter crosses each
line's fetch window, so a rendered row holds what the ULA fetched when
the beam passed — not end-of-frame memory. Beam-racers need this:
Arkanoid XOR-erases its bat in the vblank and redraws it next frame
just ahead of the beam, so the bat exists on the CRT every frame while
being absent from memory at the frame boundary (#194). Uncaptured
lines (single-step paths, first frame, ModelNext) fall back to live
memory.
Timex hi-res (port $FF) and the Next paths hang off the same render.

Port $FE: keyboard scan AND-plane, EAR from the tape edge stream, MIC
and speaker bits recorded as audio events, border writes recorded with
scanline positions. The floating bus is the canonical Ramsoft/FUSE
algorithm (returns $FF on +2A/+3/Next): the fetch window is the FIRST
128 T of each paper line from the top-left-pixel time — 48K 14336,
128K/+2 14362 (libspectrum timings.c) — with bitmap/attr pairs on
slots 2..5 of each 8, computed on the RAW frame-relative T counter
(the same grid contention anchors on; never on the audio flush's
frameStartTstate, whose per-frame overshoot jitter desyncs the two). Frame timing: 224 T/line on 48K, 228 on
everything later, per-model totals from `pkg/roms`.

Tape: `.tap`/`.tzx` as a pulse stream (pilot/sync/bit timings, turbo
blocks), advanced per port read so edge-timed loaders work; a ROM
LD-BYTES trap provides fast loading; the $FE-read rate detects active
loading for the tape-turbo mode. Tape time rides the MONOTONIC
reference clock (`SetTapeRefClock` → `cpu.RefTstates`, not the
frame-wrapping raw counter), so the lazy per-read catch-up never drops
the inter-frame gap for sparse-polling loaders; inter-block pause
chunks consume time WITHOUT toggling EAR (silence has no edges); and
the loader-activity auto-pause (`tapeFrameHook`, shared by desktop /
wasm / headless loops) parks an unpolled deck within 1.5 s — wider
than the 48 ROM's 1 s read-free LD-START settle delay — and resumes it
losslessly when a loader polls again (#192, Hewson custom loaders).
A second fast trap at LD-EDGE-1 ($05E7, which also covers the $05E3
LD-EDGE-2 entry via its fall-through) emulates the ROM's edge-sampling
loop in O(1) for custom loaders the block trap can never serve: it
advances the CPU clock by exactly the T-states the loop would burn and
computes B on the same 59 T sample grid, so bit discrimination (the B
count) and loader timing checks are preserved — the emulated timeline
is unchanged, only the host cost collapses (`tapeTrapLDEdge`,
byte-exactness + timeline-neutrality pinned by TestLDEdgeTrapByteExact
and the corpus goldens). Loaders that copy the routine into RAM
(Speedlock class) still interpret at real time under the turbo.

Contention lives in `pkg/memory` (pattern {6,5,4,3,2,1,0,0}, display
window only, per-model enables/anchors: 48K 14335 on 224 T lines,
128K/+2 14361 on 228 — one T before the matching floating-bus window,
so the two grids stay in phase). Port I/O is cycle-exact: the CPU's
`ioIn`/`ioOut` helpers charge the 4 T I/O machine cycle and call
`ContendPortEarly`/`ContendPortLate` (holds ONLY, FUSE's
ula_contend_port_early/late shapes per Sean Young §4.2, including the
+2A/+3 no-port-contention rule) — the port READ samples the bus at the
cycle's 4th T-state (IN r,(C): instruction T+11) and the port WRITE
lands after its 1st. Beam-racers need all three grids to agree:
Arkanoid paces its 50Hz game loop by phase-locking floating-bus polls
via a contended screen write, and any grid mismatch made it misread
"raster left the paper" mid-frame and run 2-3 game updates per frame
(#194, TestArkanoidBallSpeed).

## Sound

- AY-3-8912 (`pkg/ay`): a port of the FPGA's ym2149.vhd. Tone/noise
  (17-bit LFSR at half rate)/envelope (5-bit, primed-step) exactly as
  the VHDL, with both the FPGA volume tables (YM 32-entry, AY 16-entry)
  and a measured real-chip table for the mixer. Turbosound is a 3-chip
  bank selected by writing $FF/$FE/$FD to $FFFD.
- Beeper, tape sound, SpecDrum/Covox, Next DACs: all event-timed box
  filters (see patterns doc), mixed with saturation and passed through
  the DC blocker. Tape sound only mixes while a loader is actively
  polling (500+ $FE reads/frame) to avoid aliasing buzz.
- SAA1099 (`pkg/saa1099`, SAM only): 6 tone channels, 2 noise, 2
  envelope generators, synthesised from the datasheet with float phase
  accumulators. Explicitly the one sound chip without a
  hardware-verified reference.

## Floppy controllers and storage

All four FDCs are I/O-advanced (see patterns doc):

- µPD765A (+3): full command set including scans, format, weak/copy-
  protected sectors, optional Speedlock heuristic. All disk image
  parsers live here and are shared.
- WD1793 (Beta Disk): the TR-DOS contract, four drives, Type IV force
  interrupt per datasheet. TR-DOS ROM pages in via the $3Dxx M1 trap in
  `pkg/memory`.
- WD1772 (DISCiPLE and SAM): WD1772-specific differences modelled
  (Motor On bit, Spin-Up status, no ready input). DISCiPLE adds the
  GDOS ROM/RAM overlay with port-driven plus PC-trap paging.
- Microdrive: a byte-loop tape with head position, preamble tracking and
  pulse-accurate GAP/SYNC status, mirroring FUSE's if1.c. Eight drives
  with the motor daisy-chain.

The Next storage stack (divMMC, SPI SD card, FAT32 builder, esxDOS) is
covered in [next-fpga.md](next-fpga.md).

## Multiface 1/128/3 (`pkg/multiface`)

Two models coexist: `multiface.go` is the integration model the
peripheral manager uses (NMI button, ROM/RAM overlay, session-scoped
paging freeze so MF port pokes cannot corrupt host paging, A7-based
page-in/out with the MF3 inversion, invisibility). `core.go` is a
clock-exact transcription of the Next FPGA's multiface.vhd, golden-
tested, used where FPGA-exact behaviour matters (paging read-back ports
$7F3F/$1F3F on the Next).

## Input and printer

- Keyboard: 8×5 active-low matrix, host mapping with layout-independent
  symbol injection (`TypeRune` pulses SYMBOL SHIFT + key for 2 frames),
  ZX8x layout variant, persisted overrides.
- Kempston mouse: three decoded ports, free-running counters, atomics
  for lock-free access.
- ZX Printer: stylus/motor bits with a drum position derived from
  absolute T-states; reads advance the drum too, because the ROM polls
  during line sync. PNG export.

## Machines with their own display logic

- ZX80/ZX81 (`pkg/zx8x`): no framebuffer chip exists, so none is
  emulated. The M1 fetch hook implements the hardware trick: fetches
  with A15 set return NOP to the CPU while the fetched byte is decoded
  through I-register character addressing onto the screen. The maskable
  INT follows R bit 6 (counting through HALT), the ZX81 SLOW mode NMI
  generator is port-controlled, and `.P`/`.O` files load at the ROM
  resume addresses.
- SAM Coupé (`pkg/sam`): the ASIC's four screen modes (ZX-like mode 1,
  linear mode 2, 512-wide mode 3, 16-colour mode 4), a 128-colour
  master palette, line interrupts, LMPR/HMPR/VMPR paging over up to
  4.5 MB, ASIC contention tables, and a lazy line renderer that flushes
  rendered lines before any display-affecting write, making mid-frame
  palette/mode splits correct.

## Formats as "virtual hardware"

- Snapshots (`pkg/snapshot`): .sna (48K/128K), .z80 (v1/v2/v3 with RLE
  and paged blocks), .szx (chunked, including peripheral chunks).
- RZX (`pkg/rzx`): determinism by construction. Each frame stores the
  instruction count and the exact IN byte stream; playback feeds those
  bytes back, so no peripheral needs to be re-modelled. Includes
  autosave tiers, rollback, competition mode, and the format-mandated
  DSA/SHA-1 signing.
