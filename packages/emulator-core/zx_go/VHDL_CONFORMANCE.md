# VHDL → emulator conformance matrix

**Scope:** this matrix covers the Spectrum **Next** FPGA core
(`zxnext.vhd` + `video/zxula_timing.vhd`) only. The other machines zx_go
emulates (48K…+3, ZX80/ZX81, Pentagon 128) have no FPGA reference and are
tracked via their own tests, README and CHANGELOG, not here.

**Premise (the reason this file exists):** a truly hardware-accurate Spectrum
Next emulator MUST boot the firmware that runs on the real hardware. zx_go
cold-boots NextZXOS end-to-end (welcome → menu → Browser/NextBASIC; v1.2.0) —
which it reached by closing exactly the kind of inaccuracies this file
enumerates. Per-feature "validated against the VHDL" claims are **spot
checks**; they do not prove conformance of the whole surface. This matrix
replaces spot-checking with **enumeration**: list every aspect of
the FPGA core (`_tools/reference/tbblue-fpga/cores/zxnext/src/zxnext.vhd` +
`video/zxula_timing.vhd`), map each to our implementation and a test, and tick
it off only when a test pins it to the VHDL value. A green row = that aspect is
conformant. The boot is the integration test that the rows are *complete*.

Status legend: ✅ test pins it to VHDL · ⚠️ partial / value differs / untested ·
❌ gap (VHDL feature with no faithful impl) · ⚙️ architectural precision limit
(deliberate simplification; a faithful impl needs a render/timing rearchitecture,
not just a test — enumerated in Axis 10) · — n/a.

How a gap was already found by this method: `NR$6E/$6F` reset default. We had a
test for the bit-6 **write** mask (iter 205) but never for the **reset value**.
VHDL resets them to `$2C/$0C`; we defaulted to `$00`. The nrdiff vs the reference emulator at
`$3F1B` flagged it; the matrix would have flagged it without an oracle.

---

## Axis 1 — Initialization / reset defaults  (source: zxnext.vhd reset block ~4900-5111)

Every `nr_XX_* <= value` in the reset process. Read-back byte composed per the
`port_253b_dat` mux. Tests: `pkg/next/nextregs/dispatcher_test.go`
`TestNewDispatcherDefaults` (power-on) + `TestResetRestoresDefaults` (Reset()).

| NR | VHDL reset | ours | status | notes / VHDL line |
|----|-----------|------|--------|-------------------|
| $00 machine id | $0A issue-2 | $0A | ✅ | zxnext_top_issue2.vhd:35; $08 'emulator' made ROM1 $1E69 fork (D30f) — TestMachineID_MatchesFPGA |
| $01 core ver | (ver) | defaultCoreVersion | ✅ | |
| $02 reset | $01* | $01 | ✅ | *bit0 "last=soft"; matches the reference emulator |
| $05 periph1 | $01 | $01 | ✅ | 50 Hz |
| $06 periph2 | $A0 (hotkey en 7,5) | $A0 | ✅ | zxnext.vhd:5161-5165 — FIXED (was $00, untracked by the matrix) |
| $08 periph3 | $10 | $10 | ✅ | AY enable |
| $0B joy iomode | bit0=1 | ⚠️ | ⚠️ | read-back composition unverified |
| $10 core id | read $04 ('0' & coreid "00001" & buttons, vhd:1133+5923) | $04 | ✅ | FIXED (was $00): composed read seeded; MAME 0.282 concurs; bootrom AND $03 @ $017E reads the button bits, unaffected. Pinned by TestNexttestsNextRegDefaults ($10 cell red vs the 3.1.5-targeted expectation, by design) |
| $12 L2 bank | $08 | $08 | ✅ | |
| $13 L2 shadow | $0B | $0B | ✅ | |
| $14 transp rgb | $E3 | $E3 | ✅ | |
| $18-$1B clip | L2/spr/ULA {00,FF,00,BF}; tm {00,9F,00,FF} | WireClipWindows | ✅ | verified: reset coords + index match zxnext.vhd:4959-4982 (clipWindow.def, OnRead/OnWrite, onReset) |
| $42 ulanext fmt | **$07** | **$07** | ✅ | FIXED this session (was $0F) — zxnext.vhd:5002 |
| $4A fallback | **$E3** | **$E3** | ✅ | FIXED this session (was $00) — zxnext.vhd:5014 |
| $4B sprite transp | $E3 | $E3 | ✅ | |
| $4C tm transp | $0F | $0F | ✅ | |
| $6E tilemap base | **$2C** | **$2C** | ✅ | FIXED this session (was $00) — zxnext.vhd:5042 |
| $6F tilemap tiles | **$0C** | **$0C** | ✅ | FIXED this session (was $00) — zxnext.vhd:5045 |
| $68 ula control | reset ula_en=1; read bit7 = ¬ula_en = 0 | $00 | ✅ | NOT a gap (earlier misread): zxnext.vhd:5026/5445 invert bit7 on write (nr_68_ula_en ⇐ ¬wr(7)), so the reset read-back is $00 |
| $98 pi gpio o | $FF | $FF | ✅ | zxnext.vhd:5070 — FIXED (reset default) |
| $99 pi gpio o | $01 | $01 | ✅ | zxnext.vhd:5071 — FIXED |
| $A9 esp gpio0 | 1 | $00 | ⚠️ | composed; nrdiff showed ours $02 — verify read |
| i2c $103B/$113B | SCL/SDA latches, open-drain | rtc.Bus + ULA dispatch | ✅ | zxnext.vhd:2630/3234 — TestI2C_* + TestI2CPortRouting (D31ai) |
| $8C alt-rom | reset: 7:4←3:0 | promote in WireReset | ✅ | zxnext.vhd:2255 staged-nibble promote (both reset types) — TestWireResetPromotesAltROMStagedNibble (D31g) |
| (rom3 automap gate) | (altrom_en∧alt_128_n)∨(rom3∧¬altrom_en) | Memory.DivMMCRom3Gate | ✅ | zxnext.vhd:3138 full gate — TestDivMMCRom3Gate (D31g). Re-validated in-situ by #163: 24.11's ROM0 has real code at $3D96 (HALT/LD A,$07/CALL $0D6B) that the gate correctly leaves untrapped when ROM0 is paged — the #159 "DENY(3dxx) = divergence" reading was a misread of faithful behaviour |
| $7F user reg 0 | $FF | $FF | ✅ | FIXED (was $00) — zxnext.vhd:1216; NextReg_defaults grid |
| $82-$88 port-decode enables | $FF | $FF | ✅ | FIXED (were $00 except $82/$83) — zxnext.vhd:1226-1235 |
| $85/$89 decode+reset_type | read $8F (bit7 reset_type & "000" & 4 enables, vhd:6138/6150) | $8F | ✅ | FIXED — read-shape-composed seed |
| ULA first palette | classic 16-colour pattern ×16 (booted state; BRAM itself powers up zero, dpram2.vhd) | NewULAClassic | ✅ | FIXED (was RGB332 identity) — NextReg_defaults board ref pins NR$41@$70=$00, @$71=$02 |
| $B8 divmmc ep0 | $83 | $83 | ✅ | |
| $B9 divmmc ep_valid | $01 | $01 | ✅ | divmmc.New seeds epValid0=$01 (verified 2026-06-05); soft reset re-arms via WireReset |
| $BA divmmc ep_timing | $00 | $00 | ✅ | |
| $BB divmmc ep1 | $CD | $CD | ✅ | |
| $C4 int en 0 | bit expbus=1 → reads $81 | $81 | ✅ | FIXED (was $00): WireInterruptEnable0 seeds bit 7 (vhd:5096) and composes the read (vhd:6239 — see Axis 4 port $FF bit 6) |
| $C0 im2/nmi | $00 | $00 | ✅ | |
| (all others) | $00 | $00 | ✅ | clip/scroll/copper/dma-int reset to 0 |

**Axis 1 remaining gaps to close:** NR$0B/$A9 (composed). None are
boot-blocking. (NR$C4 closed: expbus default seeded AND the read composed
from the live int-enable state — the port $FF bit 6 work, Axis 4.) (NR$98/
$99 fixed earlier; NR$68 was a misread — already conformant; NR$10/$7F/$82-$89
and the ULA-first palette default fixed by the NextReg_defaults audit, which
now pins the whole default surface the upstream test reads.)
**Action:** extend the reset test to assert the FULL vhd reset vector incl.
composed read-backs.

---

## Axis 2 — NextReg write semantics (masks + side effects)
Source: zxnext.vhd `nr_wr_en` case (~5113+). Tests: `pkg/next/wire_specderived_test.go`,
`wire_*_test.go` (iters 186-250). Status: **broad ✅** (reserved-bit masks for
$0A,$22,$34,$1C,$12/$13,$2F,$6A,$6E/$6F,$70/$71,$4A-$4C,$CE/$D8/$DA; NR$8E paging;
$80-$8A bus enables; $C0/$C4/$C6; $CD; copper $60-$63 byte-granular cursor with
NR$63 atomic-pair staging, vhd:5417-5437; NR$8E bypasses the port_7ffd_locked
guard — the lock gates only the port_1ffd_wr branch, vhd:3650/3727). **Gap:** no
single test enumerates ALL 256 write-maskable bits vs the VHDL case — the
MrKWatkins NextReg_defaults grid (TestNexttestsNextRegDefaults) now
write+read-back-verifies every register its tables cover, closing most of the
distance.

## Axis 3 — NextReg read-back (port_253b_dat mux, zxnext.vhd ~5890-6250)
Tests: read-shape fixes for $07 (iter 223), $00 machine-id, $06, $41/$44 palette,
clip windows; copper $61/$62 = live byte address + mode (vhd:6083-6087, 3 address
bits); $85/$89 reset_type shape (vhd:6138/6150). Tool: `--next-nrdiff` (CAVEAT: the
reference emulator returns $00 for unimplemented read-backs — verify vs VHDL, never
blind-match). The NextReg_defaults grid pins the read-back of every register its
tables touch ($00-$B1 range). **Gap:** composed read-backs the grid skips
($68,$C0,$C6,$CC-$CE,$A9,$0B,...) still not individually pinned to the VHDL mux.
$22 and $C4 are now composed from the live int-enable state and pinned
(:5992/:6239 — the port $FF bit 6 shared latch, Axis 4).
$69 is now composed from its three live sources (:6096) and pinned
(`TestSpec_NR69_ComposedRead` + the Graphics NextReg0x69 runner); $123B
reads its composed control state (:3933, `TestLayer2PortReadback`) and
port $FF reads return the Timex register under NR$08 bit 2 (:2813).
$B0/$B1 (extended keys) and $B2 (MD-pad X Z Y MODE) are composed from
the live keyboard matrix + joystick vectors and pinned bit-for-bit to
the read mux (:6206-6215, i_JOY order :90-91, membrane fold
membrane.vhd:236-249) by `TestWireExtendedKeysB0B1Shuffle` /
`TestWireExtendedKeysB2Shuffle` / `TestWireExtendedKeysReadOnly` (wire
level), `TestExtendedKeys` (matrix derivation) and
`TestNextExtendedKeysFullStack` (keyboard+ULA through the production
wiring). Extended keys derive from the classic CAPS/SYM composites (the
membrane folds its dedicated keys into exactly those); the MD-only
buttons have no input source yet, so $B2 reads idle — known-gaps.md.

## Axis 4 — Ports / IO decode
Source: zxnext.vhd port decode (`port_*`). Tests: scattered. ✅ Port **$FF**
bit 6 = ULA-frame-INT disable (`port_ff_interrupt_disable`, vhd 3635) is
wired as the FPGA's ONE shared latch port_ff_reg(6) (:3609-3623 — written by
port $FF bit 6, NR$22 bit 2, NR$C4 bit 0 inverted; NR$69 leaves it alone),
gating INT GENERATION at the source (zxula_timing.vhd:551 via i_inten_ula_n,
:6750 — a mid-pulse disable withdraws the line) and composed back at NR$22
bit 2 (:5992), NR$C4 bit 0 (:6239 ula_int_en, reset default $81 :5096) and
the NR$08-gated port-$FF read; cleared by the shared reset block (:3611,
hard AND soft). Pinned by TestPortFFBit6FrameIntDisable /
TestFrameIntDisableSharedLatchWriters / TestFrameIntDisableResetClears
(pkg/ula, production wiring), TestSpec_NR22/NRC4 (wire level) and
TestFrameInt_NarrowPulse_DisableMidPulseWithdraws (pkg/z80).
✅ Joystick ports **$1F/$37**: both decode on the LOW address byte alone
(:2546-2547) and always answer — an unrouted port reads $00 from the
`port_XX_dat` mux (:2829-2830, :3499-3507), never the floating bus. The
read composes both sticks per the NR$05 routing (:3472-3494): Kempston
modes "001"/"100" pass i_JOY bits 5:0 on $1F/$37, MD modes "101"/"110"
additionally pass START/A in bits 7:6. `pkg/ula` nextJoyPortByte, pinned
by TestNextJoyPort37Idle / TestNextJoyPortRouting
(joyports_next_test.go); found via Atic Atac (Next), which ORs
IN($1F)|IN($37) every frame and read the old floating $FF as every
button held. The MD-only bits still READ idle for lack of a pad input
source (known-gaps.md).
⚠️ $FE,$7FFD,$1FFD,$243B/$253B,$E3/$E7/$EB,$6B,$DFFD,AY ports present
but no port-by-port VHDL decode conformance test.

## Axis 5 — Interrupts / timing  (zxula_timing.vhd + zxnext.vhd 2014-2033)
Tests: `pkg/z80/int_timing_test.go` (narrow pulse, DI-across-pulse, speed-scaled
frame boundary), `pkg/next/inttiming_test.go` (per-mode assert tstate + pulse).
Fixed earlier: **StepInstructionWithIRQ 28 MHz frame boundary not
SpeedMultiplier-scaled (8× over-fire)**; narrow-pulse default. Frame-ORIGIN
offset (CPU tstate=0 ↔ ULA hc0/vc0): **validated by instrument** (Timing group) —
Changing8kBank's border band (frame INT at t=291 → StartTiming at raster 4,
EndTiming at raster 191 after the derived 42.7k T of NEXTREG work) and
ScanlineReadingAndInterrupt's NR$1E/$1F marker rows (cvc 200 renders exactly
8 rows under the paper) pin INT→paper-top = 64 lines within a line for the
128K/+3 geometry the Next runs. ⚠️ Remaining: per-NR$03 display geometry is not
modelled (48K timing keeps the 228 T line — known-gaps.md), the sub-line hc
component of the INT origin is below the render's one-line floor; line-INT at
turbo; IM2 vector table; $C0/$C6 enable gates not all wired to the
INT generator (the NR$22/$C4/port-$FF ULA-frame + line enables ARE — the
Axis 4 shared latch, `ula_int_en` vhd:6711).
✅ CTC pulse-mode interrupts (r50, #169): channels 0-3 wired behind ports
$183B-$1F3B (decode a(15:11)="00011" + low $3B, sel = a(10:8),
zxnext.vhd:2690 + 4064-4093 — sel 4-7 hit no channel, reads 0), counting
CLK_28 (i_CLK => i_CLK_28); NR$C5 writes drive the channels' int-enable
control bits and reads compose them back (vhd:4078-4079/6242); a ZC/TO on
an int-enabled channel asserts the legacy pulse INT for 32 CPU cycles
(im2_peripheral.vhd:186 `o_pulse_en = (int_req and i_int_en) and not
im2-mode` → pulse_int_n, zxnext.vhd:2014-2043) via `z80.ExtIntFunc`.
`pkg/next/ctcblock.go`; O(1) batch channel advance pinned tick-exact vs
the golden channel model (`pkg/next/ctc/advance_test.go`);
`TestWireCTCPulseInterrupt` / `TestWireCTCIntLineReasserts`.
✅ Hardware-IM2 vectored interrupts (r54, #169): NR$C0 bit 0 switches the
maskable-INT scheme from pulse to the im2 daisy chain
(nr_c0_int_mode_pulse_0_im2_1) — `pkg/next/im2block.go` wires the
golden-tested chain (im2.go ⇄ device/peripherals.vhd/im2_peripheral.vhd/
im2_device.vhd) into the machine: line INT = vector 0, CTC 0-3 =
vectors 3-6, ULA frame INT = vector 11 (priority = vector number,
zxnext.vhd:1929-1944); requests latch per source until serviced; the
Z80's IM2 acknowledge takes `NR$C0[7:5] & vector & '0'` from the chain
(vhd:1870/1999, z80.CPU.IntAckFunc) instead of the open-bus $FF; the
exact pair ED 4D is the end-of-interrupt (im2_control.vhd:234,
z80.CPU.OnRETI); the ULA is the single EXCEPTION source that still
pulses when the Z80 is not in IM 2 (im2_peripheral.vhd:190-194,
vhd:1965); NR$20 injects unqualified requests (vhd:1946) and NR$C8/$C9
expose sticky status with write-1-to-clear (vhd:1953). Root-caused and
then verified against real silicon via the joy-port serial debugger
(hwdebug/): TX-1696's audio install arms CTC ch0 + hw-IM2 and is caught
mid-PUSH-slide — the game now loads and plays. TestWireIM2VectoredCTC-
CatchesSlide / TestWireIM2RetiReleasesInService / TestWireIM2ULA-
ExceptionWhenNotIM2 / TestWireIM2ULAVectoredWhenIM2 /
TestWireIM2PulseModeUnchanged.
⚠️ Not modelled: the counter-mode ZC/TO trigger cascade between channels
(vhd:4082), UART interrupt sources (vectors 1, 2, 12, 13 — the UART
generates no interrupts), NR$CC-$CE DMA-interrupt enables, pulse-mode
sticky status (the chain is held reset in pulse mode), and port reads of
a mid-count channel return the batch-advanced counter (exact at
observation points).

## Axis 6 — Z80 / Z80N operations  (FUSE + Sean Young + GHDL gate oracle)
Tests: canonical T-state tables (iter 266-270), per-op timing batches, flags
(SCF/CCF/CPL), WZ/MEMPTR for every group, R-register, IM/NEG/RETI mirrors, SLL,
INT atomicity, 28 MHz read waits. **GHDL gate-oracle: bit-exact over 363 bootrom
insns** ([[project_next_cpu_faithful]]). Status: **strongest axis (✅).**
✅ 28 MHz wait states (r50, #169): one extra CPU T-state on EVERY memory READ
cycle — opcode/prefix M1 fetches, operand bytes and data reads alike; writes
and IO unwaited (zxnext.vhd:3168-3181 `sram_wait_n` on `sram_req_t or
cpu_bank5_sched` with `cpu_rd_n='0'` at `cpu_speed="11"`; specnext wiki:
"NOP takes 5T"). Was M1-only, which ran multi-byte/multi-read instruction
streams up to ~15% fast at 28 MHz (`pkg/z80` readMem chokepoint;
`TestTurbo28MHzM1WaitState` still pins NOP=5T). ✅ REAL-HARDWARE VALIDATED (2026-07-15,
#169 `_tools/hw-probe` on an owner's Next): 12,000 NOPs span 33 raster
lines (exactly our 5T model), 6,000 PUSHes span 40 lines vs our 39
(~12.2T vs 12.0T — writes do NOT wait), ROM-window writes time identically
to RAM writes, and the frame INT is accepted at raster line 248 (exact).
The former "do writes wait?" open question is CLOSED: they don't, and
TX-1696's install geometry cannot close via instruction timing on real
silicon either — see compatibility.md (suspicion moved to the NextZXOS
version's effect on the game's slide-entry raster phase).

## Axis 7 — Memory / paging
MMU8 ($50-$57) defaults ✅ (this-session $DE/$DF fix), divMMC overlay, config-mode
RAMPAGE (NR$04), alt-ROM (NR$8C), 7FFD/1FFD. ⚠️ no end-to-end paging conformance
matrix vs the VHDL mux priority.

## Axis 8 — divMMC / SD
automap triggers (rom3/delayed variants, $3DXX gate), SPI, CSD v1/v2. The
`$2401` divMMC-RAM NOP-slide that once blocked the cold boot is **closed** — the
Next now boots NextZXOS end-to-end from the SD image (`TestNextRealROMBoot`).
✅ automap RETN page-out decode: divmmc_retn_seen (and the Multiface's
cpu_retn_seen_i) come from the im2_control decoder, which matches the EXACT
pair ED 45 only (im2_control.vhd:236) — NOT the T80N I_RETN (asserted for
RETI + every mirror, t80n_mcode.vhd:660/2432, consumed by nothing
memory-mapping). RETI (ED 4D) drives the separate reti_seen (IM2 daisy
chain); RETN mirrors ED 55/65/75 assert neither. Pinned by
`TestRETNHookFiresForExactED45Only` (pkg/z80). Firing the unmap on RETI was
the NextZXOS 24.11 five-title loader-class wreck (#163): a game IM2 ISR
returning mid-RST$08 unmapped the esxDOS overlay.
✅ SD block-read access time (r50, #169): CMD17/18 now hold DataOut high for
a variable 4-64 byte-times (SD spec Nac; real cards take tens-hundreds of
µs, spec ceiling 100 ms) before the $FE data token — a deterministic hash
of (LBA, read counter), so runs stay reproducible. Hosts must poll for the
token (TBBLUE.FW/NextZXOS do); register reads (CSD/CID) keep the fixed pad
their fixed-count readers require.
⚠️ Remaining: no port-by-port conformance test pins the automap trigger variants
or the SPI / CSD command set to the VHDL.

## Axis 9 — Video (ULA/L2/tilemap/sprite/lores/palette/copper)
Broad render edge tests (iters 204-217). Not boot-critical (boot stalls pre-render).
The ✅ rows below are green at LINE granularity; the sub-line copper/palette
detail they collapse is the ⚙️ row in Axis 10, not an omission here.

Pinned since (base/Copper + base/DMA conformance work):
- ✅ Wide-frame geometry (r51, #171): sprites, tilemap and wide Layer 2
  all render in the FPGA's ONE 320×256 frame — the same whc/wvc
  counters feed all three blocks (zxnext.vhd:4208/4337/4389 ←
  zxula_timing.vhd o_whc/o_wvc), (0,0) = border-ring top-left, paper at
  (32,32). Previously the render used THREE vertical origins on a
  320×240 canvas: tilemap 32 px low in the paper area (the inner pass
  applied the frame offset horizontally but not vertically) and torn
  24 px against itself at the paper/border seam; wide Layer 2 8 px low,
  bottom 16 rows cropped, and painted over sprites regardless of NR$15
  (the S-above-L modes now repaint sprites on top). Frame-anchored
  NR$1B tilemap clip rows now apply where the FPGA applies them.
  `TestNextWideFrameLayerAnchoring` + the re-derived
  nexttests/ext327 placement suites. Mid-frame tilemap scroll writes
  (NR$2F/$30/$31 — combinational into the pixel pipeline,
  tilemap.vhd:326) are raster-stamped and folded per line, applying in
  every tilemap pass incl. the wide-L2 overpaint
  (`TestScrollFoldAppliesMidFrameWrites`; the RAMS/Galaxian
  band-scrolled player ship).
  Wide-L2 overpaint order per mode (OverpaintWideL2Row): sprites
  (non-L-topmost), tilemap (U-above-L; SUL under sprites, USL/ULS
  over — RAMS's USL menu/HUD text, verified against its real ROM
  sets). Mid-frame tilemap scroll (combinational registers,
  tilemap.vhd:326) renders per raster line via a two-writer table:
  CPU writes beam-stamped + folded, copper render-time MOVEs captured
  per walk row (TestScrollFold*/TestScrollCapture* — RAMS's
  copper-banded Galaxian player ship, NR$62=$C0 restart-on-vblank).
  ⚠️ Residue: classic ULA pixels above wide L2 (SUL/USL/ULS)
  still approximate as covered (known-gaps.md).
- ✅ NR$1E/$1F active-video-line counter runs on the VIDEO clock, not the
  CPU clock (zxnext.vhd:5982-5986 port_253b_dat <= cvc; zxula_timing.vhd
  cvc/c_int_v): `ULA.BeamPosition` derives the beam on the 3.5 MHz-
  reference timeline from the CPU's per-frame origin
  (z80.FrameOriginRefTstates — the SAME origin the frame-INT assert
  offset scales from, zxula_timing.vhd c_int_v=1 → cvc 248 in 128K
  timing), so a 28 MHz guest's raster gate and the frame INT agree.
  Dividing raw CPU T-states by 228 swept NR$1F 8× per real frame and
  wedged TX-1696's raster-synced SP push-fill (work item #166, r49) —
  `TestBeamPositionTurbo`, TestNexttestsScanlineIRQ.
- ✅ ULA pixel/border palette-index composition per video/zxula.vhd:483-558
  (standard ink / 16+paper / border=paper path; ULANext ink mask + paper
  128|attr>>n + $FF/non-canonical → NR$4A background; flash standard-only)
  — the Next ULA renders through the live palette SRAM like the FPGA
  (`pkg/ula` renderNextULARow, TestNexttestsCopper).
- ✅ Copper cycle costs + WAIT release per device/copper.vhd (MOVE 2 /
  NOOP 1 cycles at 28MHz; vcount==Y && hcount>=(X<<3)+12; list-restart
  only on mode transition into 01/11; 10-bit address wrap) —
  `pkg/next/copper` RunToCycle unit tests + the GHDL golden.
- ✅ zxnDMA read-back state machine + status byte per dma.vhd:687-720/
  859-886/895-1133/902, auto-restart FINISH_DMA loop (:469-489), turbo-
  scaled prescaler timer (:250-255/424) — `pkg/next/dma` unit tests +
  the GHDL golden + TestNexttestsDMA.
- ✅ Zilog-DMA compatibility port $0B: both ports decode to the one
  controller on the low address byte (zxnext.vhd:2544/2558/2643), each
  access latches dma_mode from the port used (:1811-1819), and the mode
  seeds the byte counter 0 / -1 at LOAD/CONTINUE/auto-restart
  (dma.vhd:482-486/664-677 — length N moves N+1 bytes in Zilog mode).
  LOAD latches src/dst by the direction in force at LOAD (:646-663);
  per-byte stepping, memory-vs-IO cycle type and port A/B read-back all
  follow the live direction bit (:350-396/997-1030) — so a direction
  flip after LOAD transfers with the stale roles, exactly the FPGA's
  Misc/ZilogDMA border-text behaviour — TestNexttestsZilogDMA against
  the core-3.1.5 board photo.

Pinned since (Sprites group conformance work):
- ✅ Sprite transparency = raw pattern value vs NR$4B (8bpp full byte,
  4bpp low nibble) per sprites.vhd:971; reset $E3 (zxnext.vhd:5016) —
  `TestRenderScanlineTransparencyMatchesNR4B` + TestNexttestsSprites*.
- ✅ Dual sprite indexes: NR$34 mirror vs the $303B/$57 IO cursor, tied
  by NR$09 bit 4 per sprites.vhd:591-655 + zxnext.vhd:5187; NR$34 reads
  the live mirror (zxnext.vhd:6033) — `TestTwoSpriteIndexes` +
  TestNexttestsSpritesScanlineDelay's lockstep exercise.
- ✅ Per-line sprite render budget (one 448-count line of 28MHz FSM
  cycles; overtime latches $303B bit 1, clear-on-read) per
  sprites.vhd:831-864/977 + zxula_timing.vhd's whc window —
  `TestPerLineRenderBudget`.
- ✅ 9-bit sprite X wrap onto the left edge (the FSM's x-wrap exit term,
  sprites.vhd:855) — `TestNineBitXWrap`.
- ✅ NR$4A fallback colour projects onto the 9-bit bus with low blue =
  OR of the two blue bits (zxnext.vhd:7214) — `next.WireCompositor`
  expandRGB332, pinned by the sprite scenes' fallback-white paper.

Pinned since (ULA group conformance work):
- ✅ ULA hardware scroll NR$26/$27 (zxnext.vhd:5304-5307): source pixel =
  ((x + scrollX) mod 256, (y + scrollY) mod 192) for pixels AND
  attributes, per video/zxula.vhd:199 (px char sum, neighbour char mod
  32) and :192/:201-208 (py fold) — `next.WireULAControl` +
  `TestNextULARowHardwareScroll` + TestNexttestsULAScroll's read-back
  cross-check. NR$68 bit 2 fine-scroll-X (zxnext.vhd:5449) stored; the
  half-pixel shift is below the 7 MHz render resolution (known-gaps).
- ✅ ULA clip window NR$1A (zxula.vhd:562): inclusive display-space
  bounds, outside → transparent (fallback / lower layers), border
  exempt — `TestNextULARowClipWindow` + TestNexttestsULAScroll.
- ✅ Boot ULA palette bright magenta = %111'001'111 ($E7 projection —
  dodges NR$14=$E3; witnesses: DefaultTransparency board photo, MAME
  0.282, CSpect 2.11.1, ZEsarUX 8.0) —
  `TestULAClassicBrightMagentaDodgesTransparency` +
  TestNexttestsULADefaultTransparency.
- ✅ ULA transparency compares palette bits 8:1 vs NR$14 per
  zxnext.vhd:7100, incl. redefined entries and the ULANext border path
  (entry 128+border) vs classic (16+border) — the ChangePaletteTransparency
  trio + TestNexttestsULABorderTransparencyFallback.
- ✅ Displayed-ULA-palette select (NR$43 bit 1) honoured at raster-line
  granularity for mid-frame CPU flips (borderChange-style stamping) —
  `TestULAPaletteSelectMidFrameReplay` + TestNexttestsULAClassicPaletized.
- ✅ NR$69 write fan-out: bit 7 → Layer 2 enable (zxnext.vhd:3924),
  bit 6 → shadow display ($7FFD bit 3, :3658), bits 5:0 → Timex
  port-$FF mode (:3617) — `TestSpec_NR69_DisplayControlFanOut` +
  TestNexttestsULAScroll's M-mode bank-7 switch — and the composed
  read back from the live registers (:6096, `TestSpec_NR69_ComposedRead`
  + TestNexttestsGraphicsNextReg0x69's 10/10 port cross-checks).
- ✅ Timex display modes in the live ULA render: screen 1 / hi-colour
  vram addressing (zxula.vhd:235-251, `TestNextULARowTimexModes`),
  hi-res 512 half-pixel rows with the synthesized attribute
  ("01" & NOT(c) & c, :419) and its border rule (:425-427) —
  TestNexttestsGraphicsLayersMixingHiCol/HiRes.
- ✅ LoRes/Radastan as the ULA-layer content (zxnext.vhd:6980 pixel
  replace, :6795-6797 control, :6772 scroll, :6817 enable) —
  `TestNextULARowLoRes` + TestNexttestsGraphicsLayersMixingLoRes.
- ✅ Layer priority modes 6/7 (additive blends) through the golden
  mixer arithmetic per pixel (zxnext.vhd:7196-7355) with NR$68
  blend-operand bits (:5444-5450) — `TestComposeScanlineAdditiveBlend`
  + TestNexttestsGraphicsLightenDarken.
- ✅ Raster-stamped NR$15 (priority + LoRes enable) replay for CPU
  band rewrites — `TestLayerControlMidFrameRasterStamp` + the
  LayersMixing runners' six-band grids.
- ✅ NR$1E/$1F live raster line in the FPGA cvc convention (0 = top
  paper line, :5982-5986) — `TestSpec_NR1E_NR1F_VideoLineRead`.
- ✅ ZX48 personality pins ROM bank 3 semantics for 48K snapshots
  (zxnext.vhd:2983-2986 machine_type_48 → sram_rom3) — modelled as the
  .snx loader's launch state; NR$8E then reads the board's exact $0B.

Pinned since (work item #165, WOTEF palette bisect):
- ✅ NR$44 two-write sub-index resets on ANY write to NR$40 / NR$41 /
  NR$43 (nr_palette_sub_idx <= '0', zxnext.vhd:5376/5382/5395) — not
  only on reboot. WOTEF's palette-clear routine deliberately ends with
  NR$40=$80 + ONE NR$44 byte; the next upload's NR$40 write must start
  a fresh pair or all 256 entries commit one byte out of phase
  (entry = second<<1|first&1 → four shades of dark blue) —
  `TestNR44HalfPairResetByIndexSelectAnd8Bit`.

## Axis 10 — Cycle & sub-line timing faithfulness  (architectural)

The FPGA aspects the render/timing architecture models NON-faithfully by design.
On the matrix per its premise (enumerate EVERY aspect of the core), marked ⚙️:
closing each is a render/timing rearchitecture, not a test to write. These were
previously catalogued only in `known-gaps.md`, which let the per-axis tables
read greener than the hardware truth. They are the tier most likely to sit
between "matrix green" and a specific game running — so a game bisect that lands
here means real architectural work, not a quick pin.

| Aspect | VHDL / source | our model | status | notes |
|--------|---------------|-----------|--------|-------|
| Per-access memory contention (ULA holds the bus on $4000-$7FFF at 3.5 MHz) | ULA contention pattern | machine-wide OFF; lump T-state totals (`pkg/z80` MemContend) | ⚙️ | contention-timed multicolour / tape loaders diverge; Timing/Changing8kBank pins the ON/OFF-render-identical evidence — known-gaps "Per-access memory contention" |
| Sub-line copper / palette colour changes | copper MOVE + palette BRAM visible on the NEXT pixel (zxnext.vhd:4919-4930) | line-granular replay (borderChange-style); two writes inside one pixel collapse to one | ⚙️ | ✅ at LINE granularity (Axis 9); sub-line detail is below the 7 MHz render floor — known-gaps copper / palette rows |
| Turbo-speed video timing (> 3.5 MHz) | scanline / border advance scales with the speed multiplier | `pkg/ula` border/scanline tracking ignores SpeedMultiplier | ⚙️ | border effects wrong above 3.5 MHz — known-gaps "Turbo-speed video timing" |
| Per-NR$03/$05 display geometry (48K 312×224/448hc vs the 128K 311×228 the Next runs) | machine-timing select | fixed 128K/+3 geometry; NR$03/$05 do not retune the frame or INT position | ⚙️ | Timing/Changing8kBank ~2% band-length delta — known-gaps "Next raster geometry" |
| Mixed-frame Timex hi-res decimation + hi-res end-of-frame palette | per-pixel 512 half-pixel composite | native 512 only when hi-res is whole-frame-stable; mixed frames decimate; palette resolved at end-of-frame | ⚙️ | tracked as follow-up #154 — known-gaps ULA-modes row |

**Closing this axis is the render/timing rearchitecture, not the enumeration
punch-list.** Reaching ✅/⚠️-clear on Axes 1-9 is bounded work (composed
read-backs, port $FF bit 6, the per-axis conformance tests); Axis 10 is the tier
that a "matrix is green but the game still breaks" report cashes out on. Keep the
two visibly separate so green on 1-9 is not mistaken for the finish line.

---

## Method to complete the matrix
1. Per axis, extract the VHDL truth into a table (above).
2. For each row write/extend a test that pins our value to the VHDL value.
3. Tick ✅ only when green. Fix ❌/⚠️ rows (TDD).
4. Re-run the cold boot after each axis — when the last real gap closes, it boots.
This is parallelizable per axis (a fan-out audit) if scaled up.
