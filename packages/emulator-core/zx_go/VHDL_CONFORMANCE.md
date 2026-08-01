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
| $0B joy iomode | bit0=1 | mask $B1 | ✅ | read shape en & '0' & iomode & "000" & iomode_0 (vhd:5915) pinned by TestNRDecodeConformance + TestSpec_NR0B |
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
| $A9 esp gpio0 | out latch 1, pins pulled up → read $05 | $05 | ✅ | FIXED (#153): read composes the live pins ("00000" & GPIO2 & '0' & GPIO0, vhd:6201); the NR$A8 output enable gates the driven value (WireESPGPIO). The UART formerly squatting here moved to its real ports $133B-$163B |
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

**Axis 1 remaining gaps to close:** none — NR$0B and NR$A9 closed by #153
(the exhaustive decode test asserts the full 256-register surface, composed
read-backs included, on the fully wired machine). (NR$C4 closed earlier:
expbus default seeded AND the read composed from the live int-enable state
— the port $FF bit 6 work, Axis 4. NR$98/$99, NR$10/$7F/$82-$89 and the
ULA-first palette default fixed by the NextReg_defaults audit.)

---

## Axis 2 — NextReg write semantics (masks + side effects)
Source: zxnext.vhd `nr_wr_en` case (~5113+). Tests: `pkg/next/wire_specderived_test.go`,
`wire_*_test.go` (iters 186-250). Status: **broad ✅** (reserved-bit masks for
$0A,$22,$34,$1C,$12/$13,$2F,$6A,$6E/$6F,$70/$71,$4A-$4C,$CE/$D8/$DA; NR$8E paging;
$80-$8A bus enables; $C0/$C4/$C6; $CD; copper $60-$63 byte-granular cursor with
NR$63 atomic-pair staging, vhd:5417-5437; NR$8E bypasses the port_7ffd_locked
guard — the lock gates only the port_1ffd_wr branch, vhd:3650/3727).
**CLOSED (#153):** `TestNRDecodeConformance` (pkg/next/wire_nrdecode_test.go)
enumerates ALL 256 registers' write masks + fixed bits against the VHDL case
on the fully wired machine, four probe patterns each; the MrKWatkins
NextReg_defaults grid independently write+read-back-verifies the registers
its tables cover. New masks landed with the audit: $8F (2 bits), $90
(GPIO 1:0 forced off, vhd:5537), $93/$9B (4 bits), $A0 ($39 shape), $A2
(bit 5 zero, bit 1 hard one), $A8 (1 bit), $05 bits 2/0 store
(vhd:5837/5849).

## Axis 3 — NextReg read-back (port_253b_dat mux, zxnext.vhd ~5890-6250)
Tests: read-shape fixes for $07 (iter 223), $00 machine-id, $06, $41/$44 palette,
clip windows; copper $61/$62 = live byte address + mode (vhd:6083-6087, 3 address
bits); $85/$89 reset_type shape (vhd:6138/6150). Tool: `--next-nrdiff` (CAVEAT: the
reference emulator returns $00 for unimplemented read-backs — verify vs VHDL, never
blind-match). The NextReg_defaults grid pins the read-back of every register its
tables touch ($00-$B1 range). **CLOSED (#153):** `TestNRDecodeConformance`
pins the WHOLE mux — every composed read-back the grid skipped
($68/$C0/$C6/$CC-$CE/$A9/$0B/$10/$20/$28/$8E/$03-bit-7...), and the
`others => '0'` floor: registers outside the mux read $00 on hardware, now
enforced by `WireZeroReads` (pkg/next/nrdecode.go, the transcribed mux
table). Two deliberate divergences remain, encoded in the test with
rationale: NR$00/$0F writable (game hardware-probes), $98-$9A GPIO
stored-byte-as-pin-state. New live compositions from the audit: NR$03
bit 7 = the live NR$44 half-pair latch (vhd:5894, chained from the palette
bank), NR$10 = coreid+buttons (vhd:5924), NR$20 = live INT status
(vhd:5989), NR$28 = staged palette byte (vhd:6004, split read/write
ownership with the keymap), NR$A9 = live ESP GPIO pins (vhd:6201).
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
✅ UART ports **$133B/$143B/$153B/$163B** (#153): the decode is the
FPGA's (a(15:11)="00010", a10 xor (a9 and a8) = '1', low $3B, :2639;
register select = a(9:8) per uart.vhd:44 — Rx/select/frame/Tx-status),
routed via ULA.SetNextUART; $133B status bits per ports.txt:392-401,
$153B select bit 6 + bit-4-gated prescaler MSB, $163B framing (reset
$18) per uart.vhd:279-299. The AT responder serves UART 0 (ESP); UART 1
(Pi) reads empty. NR$A8/$A9 are the ESP GPIO registers (read mux
:6197-6201), not the UART — the old NR-mapped UART was an invention,
removed. `pkg/next/uart` port-face tests + TestNRDecodeConformance.
✅ ULA+ ports **$BF3B/$FF3B** (#158): register port groups + 6-bit
palette index (:4528-4536), data port palette writes through the
NextReg stream into ULA-palette entries 192-255 with the GGGRRRBB ↔
RRRGGGBB swizzle + or-blue (:4741/:4746/:4919), targeting the ULA
half NR$43's write-select bit 2 picks (:6958); read-back swizzles the
entry back (:4563); the mode group's bit 0 drives the LIVE ULA+
enable — the same latch every NR$68 write's bit 3 sets (:4548-4551)
and NR$68 bit 3 reads (:6093), reset-cleared (:4529/:4547). The ULA+
RENDER decodes per zxula.vhd:531-541 ("11" & attr(7:6) & paper &
colour, flash disabled :470, border $C8+colour, ULANext wins) —
`pkg/ula/ulaplus_next_test.go` + the render branch in
renderNextULARow.
✅ Port-decode sweep (#158): `TestNextPortDecode_*` (pkg/ula) pins the
implemented decode surface to the FPGA predicates (zxnext.vhd:
2540-2700) — canonical addresses, partial-decode aliases
($4001→$7FFD, $1001→$1FFD, $D001→$DFFD, $C005→$FFFD alias,
low-byte-only $57/$5B/$6B/$0B/$1F/$37, $E0F7-$EFF7), near-miss
rejections ($263B/$173B/$203B/$2001/$C001), and the port-$FF NR$08
gate. FIXED by the sweep: the Next's AY decode gained its A2=1 term
(:2646-2647 — $C001/$8001 are NOT AY ports on the Next; the classics
keep their loose partial decode).
✅ Former enumerated deferrals — ALL CLOSED (2026-08 close-out; each
pinned in `TestNextPortDecode_*`, pkg/ula):
- **internal/bus port-enable GATING** (NR$82-$89, :2392-2443): the
  live internal_port_enable vector (NR$85..$82, ANDed with NR$89..$86
  under NR$80 bit 7) gates EVERY internal decode — a cleared bit
  removes the port; the access falls through as if the device were
  absent. Pushed into the ULA dispatch by next.WirePortEnableSink;
  the DAC personalities (bits 17-23, :2437-2443 incl. the $FB
  sd2-over-monoAD precedence) and the NR$08 bit-3 dac_hw_en (:2461)
  gate the DAC decode via next.WireDACGates (pkg/next/dac
  TestDecodeGates). `_InternalPortEnableGating`.
- **Kempston mouse $FADF/$FBDF/$FFDF** (:2668-2670, data :3541-3560):
  pkg/next/mouse — X/Y wrapping counters with the NR$0A DPI scaling
  (ps2_mouse.v xydelta: ×2/×1/÷2/÷4; NR$0A resets to $01 = ×1, the
  nr_0a_mouse_dpi power-on init, zxnext.vhd:1128), wheel nibble,
  active-low buttons with the NR$0A bit-3 left/right reverse.
  Desktop mouse + the wasm `zxMouse` export feed it. The port_1f $DF
  joystick alias (:2674 — DAC-DF on, mouse decode OFF) is emergent
  from the same gates (`_DFJoystickAlias`). `_KempstonMouse`.
- **+3 float** (:2589, data :4517 + zxula.vhd:307-345/:573): a(15:12)
  =0000 + the $FD pattern, live only under +3 machine timing; returns
  the ULA fetch byte with bit 0 forced (the o_ula_floating_bus
  +3-timing OR), $FF while 7FFD paging is locked, on the classic-
  validated slot grid anchored to the live geometry (known-gaps note:
  idle slots approximate the last-contended-bus-byte latch as $FF).
  `_P3FloatingBus`.
- **FDC iotrap $2FFD/$3FFD** (:2601-2602, machinery :3835-3895):
  NR$D8-gated decode; reads/3FFD-writes fire a Multiface-class NMI
  through the same NR$06/no-NMI-in-flight gates as the NR$02 bit-3
  pulse, latch the cause into NR$DA (no software write arm; NR$02
  bit 4 composes it live, write-0 clears) and the trapped byte into
  NR$D9. next.WireIOTraps. `_FDCIOTrap`.
- **MF enable/disable port pair** (:2612-2616, read data :4305-4320):
  the GHDL-golden pkg/multiface.Core (device/multiface.vhd) drives
  the pair via next.MFBlock — per-personality low-byte roles
  ($3F/$BF, $BF/$3F, $9F/$1F by NR$0A mf_type), enable-read paging-in
  when visible with the +3 paging-shadow / MF128 bit-7 read-back,
  disable-read page-out, write-driven invisible/NMI-release, RETN and
  NR$02/iotrap NMIs feeding the same state machine, and the port
  strobes firing alongside co-decoded devices (the MF48 $1F is also
  soundrive-1 A / the joystick). `_MultifacePorts` + pkg/next
  TestMFPortRolesPerPersonality.

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
128K/+3 geometry the Next runs. Per-NR$03/$05 geometry retune landed with #182
(FrameGeometryFor: 48K/Pentagon/60 Hz frame length + INT position live, vsync-latched
at the frame origin — Axis 10 row).
✅ Sub-line hc INT-origin component: the model carries it exactly —
c_int_h enters `FrameGeometry.IntAssertTstate()` directly
((c_int_v·(c_max_hc+1)+c_int_h)/2; +3 boot timing = (1·456+126)/2 =
291 T, i.e. one line + 63 T) and the per-mode values are pinned to the
zxula_timing.vhd:155-298 constants by `TestFrameGeometryFor` +
`inttiming_test.go`. What sits at one-line granularity is only the
BOARD-instrument validation floor (the Timing-group instruments read
raster rows) and the render's border-sweep representation — the
existing known-gaps row, not a CPU-timing gap.
✅ NR$CC-$CE DMA-interrupt enables are LIVE (this close-out — see the
CTC/IM2 axis below for the row). The CTC counter-mode ZC/TO cascade and
the UART INT sources listed here previously both landed with #158
(✅ rows in the CTC/IM2 axis below). (Line-INT at turbo IS pinned —
`TestWireLineInterruptScalesWithSpeed`, NR$07-chained recompute; the IM2
vector table + $C0 mode landed with r54's hw-IM2 chain.)
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
✅ CTC channel-to-channel ZC/TO cascade (#158): ch N's CLK/TRG input is
ch (N-1) mod 4's ZC/TO pulse (vhd:4082 i_clk_trg <= zc_to(2:0) &
zc_to(3)) — a COUNTER-mode channel divides its upstream neighbour and
a wait-on-trigger timer starts on the upstream's pulse, fed through
the golden-pinned channel's own trigger path (ctc.Channel.PulseTrigger)
in CTCBlock.catchUp, ring-iterated so multi-stage divider chains settle.
`TestCTCCascade*` (÷3 divider residual count, running-timer immunity,
waiting-timer start). Granularity: pulses land at the block's lazy
observation points (per instruction in practice).
✅ UART interrupt sources (#158): vectors 1/2/12/13 feed the chain as
LEVELS per zxnext.vhd:1941-1949 — uart0 RX = the live rx-avail level
(near-full OR (avail AND NOT the near-full-only NR$C6 bit), our FIFO
never reports near-full), TX-empty = constant true (instant transmit;
an idle real UART's TX is empty too), uart1 RX never requests (no Pi);
enables NR$C6 bits 1|0 / 5|4 / 2 / 6. NR$CA now composes the sticky
UART source states ('0' & st13 & st2 & st2 & '0' & st12 & st1 & st1,
:6254) with write-1-to-clear (:1953-1956). `TestWireUART*Interrupt` +
`TestWireUARTNearFullOnlyBitGatesRxAvail`.
✅ Pulse-mode sticky status re-classified as CONFORMANT: the FPGA holds
the chain reset in pulse mode too (im2_reset_n = mode & not reset,
im2_peripheral.vhd:105), so NR$C8/$C9/$CA recording only in hw mode IS
the hardware behaviour.
✅ NR$CC-$CE DMA-interrupt enables (this close-out): they are NOT "the
DMA generates interrupts" — the FPGA's dma.vhd has the Zilog
interrupt-control machinery commented OUT (:94-96/:836-856), so the
zxnDMA generates no interrupts on real hardware either and our no-op
interrupt commands were already conformant. What the registers gate is
the DMA-DELAY condition (zxnext.vhd:1957-1958 im2_dma_int_en →
im2_device.vhd:151 o_dma_int = state /= S_0 and dma_int_en →
:2005-2008 im2_dma_delay; dma.vhd:269/427 test dma_delay_i between
byte transfers): a chain device outside idle whose NR$CC/$CD/$CE bit
is set — from request latch through the whole in-service window until
the RETI release — holds the DMA off the bus, as does an outstanding
NMI with NR$CC bit 7. LIVE: dma.DMA.SetPauseFunc (chunked continuous
transfers that split at the pause instant and charge only the bytes
moved; burst schedules restart at the unpause instant) composed by
next.WireDMAPause from IM2Block.DMAPause + the machine's nmi_activated
equivalent. In pulse mode the chain is held reset so only the NMI arm
applies — emergent from the same chain state. Pinned by
TestWireDMAPauseChainSourceHeldThroughISR / TestWireDMAPauseNMIArm /
TestWireDMAPausePulseModeChainInert (pkg/next) + TestPausePark/Splits/
HoldsBurstSchedule (pkg/next/dma); the FPGA-golden replay and the
Zilog board goldens are unchanged (all NR$CC-$CE zero — the reset
default — takes the byte-identical fast path). Port reads of a
mid-count channel return the batch-advanced counter — exact at
observation points, the block's documented granularity, not a gap.

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
RAMPAGE (NR$04), alt-ROM (NR$8C), 7FFD/1FFD.
✅ End-to-end priority walk (#158): `TestNextPagingReadPriority` +
`TestNextPagingBootromWritesFallThrough` (pkg/memory) canary-walk every
$0000-$3FFF layer up and back down against the FPGA mux — bootrom read
mask (vhd:1856) > divMMC (:3084-3130) > Multiface > config-mode RAMPAGE
> Alt-ROM redirect > MMU8 > classic dispatch, with the
sram_pre_override(0) kills (:3037-3050/:3078) for MMU-RAM and config
mode. FIXED by the walk: config mode now outranks the Alt-ROM redirect
on BOTH read and write paths (the emulator had them inverted — two
routing_matrix tests pinned the inversion without a citation and were
corrected), and the Alt-ROM WRITE redirect gained the MMU-RAM
pre-override skip the read path already had.

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
✅ Trigger + command enumeration (re-audited under #158 — the "no
conformance test" claim was stale): the automap trigger variants ARE
enumerated per PC with the full B8/B9/BA gate matrix
(pkg/next/divmmc TestGate_PC0000/0008/0038/0066/04C6/04D7/0562/056A/
3DXXRange + boundary/disabled/delayed-ROM3 variants, ~92 tests) and
pinned to the VHDL by the GHDL golden replay of divmmc.vhd
(TestDivMMCMatchesFPGAGolden). The SPI/CSD side enumerates the whole
command set the firmware uses (CMD0/8/9/10/12/13/17/18/24/25/55/58/
ACMD41, CSD v1/v2, CID, CRC16, erase, Nac timing — ~98 tests in
pkg/next/sdcard) with the SPI master pinned by its own GHDL golden
(TestSPIMasterMatchesFPGAGolden). Port $E3 semantics carry their own
suite (TestE3_*).

## Axis 9 — Video (ULA/L2/tilemap/sprite/lores/palette/copper)
Broad render edge tests (iters 204-217). Not boot-critical (boot stalls pre-render).
Since #183 (r59) the render resolves at the FPGA's 14 MHz half-pixel grain
(Axis 10 rows 2/5 ✅): the ✅ rows below no longer collapse sub-line detail.

Pinned since (base/Copper + base/DMA conformance work):
- ✅ Tilemap tm_below PER PIXEL (#154): each pixel's below bit is the
  FPGA line buffer's bit 8 — (attr_bit0 OR mode_512) AND NOT tm_on_top
  (tilemap.vhd:388) — and the ULA arbitration follows zxnext.vhd:7116
  (a below pixel yields to an OPAQUE ULA pixel only). Replaces the
  global on-top/nibble-0 approximation, which was INVERTED for
  attr0=0 tiles with on_top off (the FPGA puts those above the ULA);
  opacity is the NR$4C nibble alone (tilemap.vhd:427 — nibble 0 is
  opaque). `TestTMBelowPerTileAttrBit` / `TestTMBelowOnTopOverrides` /
  `TestTMBelow512ModeForcesBelow` (pkg/next/compositor), all pinned
  goldens unchanged. Residue: the wide overlay/80-col passes skip
  below pixels (no ULA pixel to arbitrate against there) —
  known-gaps blend/wide rows.
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
  ✅ Classic ULA pixels above wide L2 (SUL/USL/ULS): the repaint
  landed with r94 (#204, CaptureULABase + composeULAOverlayRow —
  Space Invaders' USL arcade overlay; this row was stale) and the
  2026-08 close-out retired its three residues: the captured base's
  paper rows are now the LIVE walk's output (CaptureULALiveRow —
  ULANext palettes, NR$26/$27 scroll, LoRes/Timex content, per-pixel
  alpha-0 transparency and the NR$1A clip, zxula.vhd:562 →
  zxnext.vhd:7100), the below-tile arbitration in the wide overlay is
  per-pixel against that base (ulatm mux, zxnext.vhd:7116 —
  capturedULATransparent), and the overpaint's mode read shares
  resolveMode with the capture. TestULAAboveWideL2* (USL/SUL/ULS/
  live-row) + TestTMBelowWideOverlayPerPixelULA.
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
  NOOP 1 cycles at 28MHz; vcount==Y STRICT && hcount>=(X<<3)+12 —
  a passed line parks to the next frame; list-restart only on mode
  transition into 01/11; 10-bit address wrap) — `pkg/next/copper`
  RunToCycle unit tests + the GHDL golden.
- ✅ Copper engine EQUIVALENCE (#179): the per-scanline Step engine
  (non-live render flow) and the cycle-paced RunToCycle engine
  (live-ULA flow) are pinned to each other — identical per-line MOVE
  sequences over directed shapes (Atic wrap, WAIT ladders incl. the
  passed-line park, HALT + VBL restart) and 60 seeded random programs
  × 3 frames (`equivalence_test.go`). Found + fixed: Step's late WAIT
  release (strict equality per copper.vhd:94), Step's post-release
  budget floor, and the line geometry — 456 hcounts/line (c_max_hc =
  455, zxula_timing.vhd:196), so WAIT X ≥ 56 (threshold > 455) never
  releases, like the hardware.
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
  cross-check. NR$68 bit 2 fine-scroll-X (zxnext.vhd:5449) is LIVE
  (#183): the LSB of the 14 MHz barrel-shift amount (zxula.vhd:199/
  :353/:395), a +1 half-pixel source shift —
  `TestULAFineScrollXHalfPixelShift`.
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
  hi-res as the NATIVE 512-half-pixel stream (both files interleaved,
  zxula.vhd:389) with the synthesized attribute ("01" & NOT(c) & c,
  :419) and its border rule (:425-427), the mode re-latched per
  character cell (:191-214) so copper NR$69 bands go native mid-frame
  and mid-row (#183) — TestNexttestsGraphicsLayersMixingHiCol/HiRes +
  `TestCopperMidRowNR69HiResBand`.
- ✅ LoRes/Radastan as the ULA-layer content (zxnext.vhd:6980 pixel
  replace, :6795-6797 control, :6772 scroll, :6817 enable) —
  `TestNextULARowLoRes` + TestNexttestsGraphicsLayersMixingLoRes.
- ✅ Layer priority modes 6/7 (additive blends) through the golden
  mixer arithmetic per pixel (zxnext.vhd:7196-7355) with NR$68
  blend-operand bits (:5444-5450) — `TestComposeScanlineAdditiveBlend`
  + TestNexttestsGraphicsLightenDarken.
- ✅ NR$68 bit 7 ULA-output disable forces the whole ULA/LoRes slot
  transparent in the mixer (`ula_transparent <= ula_mix_transparent or
  ula_en_2 = '0'`, zxnext.vhd:7103), so every NR$15 ordering shows the
  lower layers: the ladders' U-repaint consumes the disable term and
  the blend path drives Mix's ULAEn (blend operands keep the mix-level
  signal, :7144) — `TestULADisabledLUSShowsSprites`/`USL` + enabled
  control (#205: TX-1696's sprite-drawn LUS title menu rendered black).
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
| Per-access memory contention | i_contention_en = ¬NR$08-bit6 ∧ ¬Pentagon ∧ 3.5 MHz (zxnext.vhd:4481); page set by NR$03 timing (:4490-4494); +3-timing wait arm memory-only (zxula.vhd:604) | LIVE on ModelNext (#181): cycle-helper contention with the FPGA's gates + timing-selected page-follows rule; ports contend only under 48K/128K timing | ✅ | TestNextContention* / TestNextPortContentionTimingGate; hold shape = the canonical 8-slot pattern (a GHDL per-cycle trace of the wait arm would sharpen it further); classic-line models remain lump-total — known-gaps row |
| Sub-line copper / palette colour changes | copper MOVE = one write per 14 MHz half-pixel (copper.vhd:87-109); palette BRAM lookup per half-pixel, write visible on the next lookup (zxnext.vhd:6969-6981/:7033); mixer state sampled per i_CLK_14 slot (:6799-6832/:7092) | CLOSED (#183, r59): 2-cycle RunToCycle targets + the fused per-half-pixel compose (live palettes/mixer state inside the interleave) + event-gated half-pixel border rows + (line,hpos) CPU palette stamps; event-free rows coalesce provably-identically (CanRetireOnLine). Layer INDEX buffers stay per-row — the hardware's own grain (sprites line-buffer build-ahead sprites.vhd:537-540; L2 ~1 px, tilemap 1-2 chars) | ✅ | TestNexttestsCopper (native half-width flags), TestCopperMoveLandsOnHalfPixel, TestCopperMidRow* pins; residue: mid-row LAYER ENABLE flips land next row — known-gaps copper row |
| Turbo-speed video timing (> 3.5 MHz) | the raster runs on its own clock regardless of CPU speed (zxula_timing.vhd) | mid-frame raster stamps ride the speed-independent reference timeline (#180: currentScanline → BeamPosition; palette/tilemap sources already did) | ✅ | CLOSED — TestBorderStampSpeedIndependent / TestVideoStateStampSpeedIndependent |
| Per-NR$03/$05 display geometry (48K 312×224/448hc, Pentagon 320×224, 60 Hz 264-line vs the boot 311×228) | zxula_timing.vhd:146-311 constant table; vsync eff-latch zxnext.vhd:6693-6706; Pentagon-forces-50Hz :5834-5836; copper hcount = hc_ula (ULA-anchored, reset at c_min_hactive-12, :423-424 → zxnext.vhd:6737/:3949), vcount = cvc (paper-anchored, :458-468) | LIVE end-to-end. TIMING (#182): NR$03/NR$05 writes retune frame length, T/line, frame-INT assert+pulse, the contention paper anchor, NR$1E/$1F wrap and the NR$22/$23 line-INT via FrameGeometryFor (pkg/next/geometry.go), applied at the next frame origin; audio window + samples/frame follow. RENDER (this close-out): the copper interleave's line clock is hcounts×4 cycles from the live mirror (Step hcMax + RunToCycle's SetLineCycles — the WAIT wrap boundary X≥56/X≥55 is emergent), the left-border tail anchors at hcounts−28 (the BOARD-pinned 428 on boot timing; the 8-hc lead over the raw whc preload is fixed video-pipeline depth, length-independent), and the raster-stamp row map (border/ULA-video folds, palette replay, scroll captures, sweep top/bottom mapping) anchors at the live c_min_vactive (64/40/80); scroll tables sized for Pentagon's 320 lines. The hc_ula anchoring makes the paper/WAIT +12 mapping timing-INDEPENDENT — only line length and tail move | ✅ | TestCopperInterleaveAnchorTimingIndependent / TestCopperWaitWrapFollowsLineLength / TestBorderFoldFollowsPaperTop (pkg/ula), TestCopperEngineEquivalence448 / TestWaitWrapThresholdPerLineLength (pkg/next/copper), TestFrameGeometryFor / TestWireFrameGeometry*; nexttests board goldens unchanged. Residue: border sweep rows stay line-granular and NR$64 is stored-raw — existing known-gaps rows |
| Mixed-frame Timex hi-res decimation + hi-res end-of-frame palette | the FPGA resolves display mode per character cell (zxula.vhd:191-214) and palette per 14 MHz half-pixel | CLOSED (#183, r59): the mode re-latches per character cell inside the one row walk and hi-res renders the native 512 stream in stable AND copper-banded mixed frames; the decimation branch, the stable/mixed split and the dedicated wide pass (end-of-frame palette) are deleted — hi-res rows resolve palette through the same paced per-row replay as every row | ✅ | TestCopperMidRowNR69HiResBand (mid-row native band), LayersMixingHiRes now pins the unified path |

**The matrix is ALL GREEN** (2026-08 close-out). The geometry render
close-out retired this axis's last ⚙️ row; the scope-deferral tier
that followed — the Axis 4 enumerated port deferrals (Kempston mouse,
MF enable/disable pair, +3 float, FDC iotraps, NR$82-$89 decode
gating), the Axis 5 NR$CC-$CE DMA-interrupt enables (resolved as the
FPGA's DMA-DELAY condition — the zxnDMA generates no interrupts on
hardware either, its Zilog interrupt machinery is commented out of
dma.vhd) and sub-line hc INT-origin note (the model always carried
c_int_h; the one-line floor was the board-instrument validation
grain), and the Axis 9 ULA-above-wide-L2 residues (live-row capture +
per-pixel below-tile arbitration) — closed with it. What remains
catalogued anywhere is sub-row-grain or environment scope in
known-gaps.md (border sweep rows line-granular, mid-row layer-ENABLE
flips landing next row, NR$64 stored-raw, the +3 float's idle-slot
last-bus-byte latch approximated as $FF, UART networking, zxnDMA
match logic / descriptor mode) — a "matrix is green but the game
still breaks" bisect should look there first.

---

## Method to complete the matrix
1. Per axis, extract the VHDL truth into a table (above).
2. For each row write/extend a test that pins our value to the VHDL value.
3. Tick ✅ only when green. Fix ❌/⚠️ rows (TDD).
4. Re-run the cold boot after each axis — when the last real gap closes, it boots.
This is parallelizable per axis (a fan-out audit) if scaled up.
