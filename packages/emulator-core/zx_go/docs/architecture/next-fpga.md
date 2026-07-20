# Spectrum Next FPGA emulation

The ZX Spectrum Next is not a chip: it is a machine implemented as an
FPGA core (TBBlue). zx_go therefore emulates the Next by treating the
FPGA source itself as the schematic. `zxnext.vhd` plus the per-device
VHDL modules under the TBBlue core are the oracle for every hardware
question; a reference emulator serves only as a behavioural oracle for
whole-boot comparisons. This document describes how that plays out in
code.

Diagrams:
[memory-decode.drawio](diagrams/memory-decode.drawio),
[next-video-pipeline.drawio](diagrams/next-video-pipeline.drawio),
[next-boot-chain.drawio](diagrams/next-boot-chain.drawio).

## The conformance method

Per-feature "validated against the VHDL" claims are spot checks, so the
project replaces spot-checking with enumeration:

1. `VHDL_CONFORMANCE.md` lists the FPGA surface in nine axes (reset
   defaults, write semantics, read-back mux, port decode, interrupts,
   CPU ops, paging, divMMC/SD, video) and maps every row to an
   implementation and a test.
2. Each subsystem carries a `fpga_golden_test.go` replaying GHDL
   simulations of the real VHDL (testbenches in
   `_tools/<subsystem>-vhdl-test/`).
3. The cold boot of real NextZXOS is the integration test that the rows
   are complete.
4. Divergence hunting against a reference emulator uses the dev modes in
   `cmd/zx_go` (`--next-lockstep`, `--next-nrdiff`, `--next-memdiff`,
   `--next-bisect`) keyed on a shared guest clock (FRAMES sysvar).

Source comments cite exact VHDL lines. When you change any of this code,
carry the citation with it.

External validation material (not yet integrated; tracked on the ZX Play
roadmap initiative for this documentation):

- Specifications: the official FPGA core source on GitLab
  (SpecNext/ZX_Spectrum_Next_FPGA) and wiki.specnext.dev (NextReg
  registry, the Z80N extended instruction set, the .NEX V1.2 format).
- Test suites: MrKWatkins/ZXSpectrumNextTests (.nex/.tap programs for
  Z80N, sprites, Layer 2, mixing, Copper, DMA, ULA, interrupts, timing,
  with real-hardware reference screenshots),
  raxoft/z80test (stricter classic-CPU suite than zexall), and
  Threetwosevensixseven/ZXSpectrumNextTests (paging/DMA/layer order).
  All map onto the headless harness (screen OCR or screenshot
  comparison).

## The NextReg file (`pkg/next/nextregs`)

`Dispatcher` models the register file behind ports $243B (select) and
$253B (data) and the Z80N NEXTREG opcodes:

- A 256-byte backing store plus optional per-register `onWrite` /
  `onRead` handlers and `onReset` hooks.
- Contract: an `onWrite` handler replaces default storage and calls
  `Store()` itself if the value should read back; `onRead` returns live
  state where reads have side-effect semantics. `Raw()`/`Store()` bypass
  handlers.
- Reset applies the FPGA's cold-reset values (each cited to the
  zxnext.vhd reset block) in three phases: zero every register through
  the handlers, re-apply non-zero defaults through the handlers, then
  run `onReset` hooks for state outside the byte array (clip-window
  indices and the like).
- NR$01/NR$0E (core version) reject guest writes; NR$00/NR$0F stay
  writable because games poke them as probes.

## Wiring (`pkg/next/wire.go`)

Every register-to-subsystem connection is a `WireXxx` function, applied
together by `Wire(opts)`. Centralising the wiring means the production
bus and the test harness are configured by the same code and cannot
drift. Highlights:

- Machine identity and boot: `WireMachineType` (NR$03: personality,
  timing, config-mode transitions, bootrom un-mask), `WireReset` (NR$02:
  typed soft/hard reset, see boot chain below), `applyTBBLUEFWBootDefaults`
  (the register state the real firmware leaves behind).
- Memory: `WireMMU` (NR$50-$57), `WireROMBank` (NR$8E), `WireAltROM`
  (NR$8C), `WireConfigModeRAMPage` (NR$04).
- CPU: `WireCPUSpeed` (NR$07 turbo), `WireContentionDisable` (NR$08).
- Interrupts: `WireInterruptControl` (NR$C0 incl. stackless NMI),
  `WireInterruptEnable0/2` (NR$C4/$C6), `WireLineInterrupt` (NR$22/$23).
- Video: `WireLayer2`, `WireSprites` (NR$34-$39/$75-$79 + NR$4B),
  `WireLayerPriority` (NR$15), `WirePalette` (NR$40-$44), `WireTilemap`,
  `WireClipWindows` (NR$18-$1C), `WireCopper` (NR$60-$63), and
  `WireCompositor` (NR$14/$4A/$4C — called by both the production
  machine and the test harness so their compositor wiring cannot
  drift).
- Peripherals: `WirePeripheral1/2/3` (NR$0A/$06/$09), `WireJoystickMode`,
  `WireCoreID` (NR$10 composed read), `WireESPGPIO` (NR$A8/$A9 — the
  ESP GPIO registers; the UART itself is port-mapped, see below),
  `WireKeymap`, plus reserved-bit masks.
- Decode floor: `WireZeroReads` (nrdecode.go) installs `read = $00` on
  every register the FPGA read mux does not decode (`others => '0'`,
  zxnext.vhd:6287) — runs last in `Wire`. The `nrReadMux` table there
  transcribes the mux case list; `TestNRDecodeConformance`
  (wire_nrdecode_test.go) probes all 256 registers against it.
- Input read-back: `WireExtendedKeys` (NR$B0/$B1 extended keys, NR$B2
  MD-pad extra buttons) — read-only registers composed on every read
  from the live ULA input state (keyboard-matrix composites + the
  joystick vector), the same live-source pattern as NR$69. That vector
  is split across two ULA fields: `KempstonState` holds bits 4..0
  (B U D L R — bit-identical to the Kempston port byte, zxnext.vhd:3479)
  and `MDExtraState` bits 11..5 (MODE X Z Y START A C), with
  `MDJoyLeft()` composing them. A host gamepad drives both halves
  (r77, #161); `MDJoyRight()` is still constant 0, so NR$B2's high
  nibble reads idle. The joystick ports $1F/$37 themselves are composed in
  `pkg/ula` (`nextJoyPortByte`): low-address-byte decode, idle $00
  (never floating bus), NR$05 routing incl. the MD-mode START/A bits
  (zxnext.vhd:2546-2547, :3472-3507).
- Membrane key-joystick injection (r98, #202): pads NR$05 routes to a
  keyboard mode press membrane keys, per the FPGA's membrane_stick
  module (input/membrane/membrane_stick.vhd, keymap ROM
  ram/init/keyjoy_64_6.coe; keyb_col is ANDed with the joystick
  columns, zxnext_top_issue4.vhd:1843). `pkg/ula` joymembrane.go
  composes the injected active-low column bits into every Next port
  $FE read: Sinclair 1 (mode 011) = keys 67890, Sinclair 2 (000) =
  12345, Cursor (010) = 5678+0, User Defined (111) + the Kempston/MD
  excess-button slots from the NR$28/$29/$2B joymap RAM
  (`Wire` passes `Keymap.JoyMap` to `ULA.SetJoyKeymap`); parked in
  NR$0B I/O mode. Official naming per nextreg.txt — Sinclair 1 IS
  67890 (the zxnext.vhd mode comment has the parentheticals swapped).
  The frontend joystick selection on the Next writes NR$05 joy0
  (`applyNextJoystickMode`; Kempston→MD-1 "101" superset) rather than
  injecting keys, so guest-visible state and routing live in the
  machine, exactly like hardware.
- Deliberately not wired here: the zxnDMA (ports $6B/$0B, wired via
  `ULA.SetNextDMA`) and the Pi accelerator registers (default storage).

## Memory: MMU and the overlay mux (`pkg/memory`)

Diagram: [memory-decode.drawio](diagrams/memory-decode.drawio).

The Next view of memory is 8 slots of 8K over a 2 MB RAM array (banks
0..111 allocated for ModelNext), with classic 16K paging still live
underneath. Read dispatch mirrors the FPGA's final memory mux, highest
priority first: FPGA bootrom, divMMC overlay, Multiface overlay, Alt-ROM
redirect, config-mode RAM window, Layer 2 read paging, 8K MMU override,
then the classic path (Beta ROM override, 16K page maps). Writes mirror
the order with documented differences (the bootrom only masks reads
while config mode is active; Alt-ROM bit 6 splits read/write redirect).

Coexistence rule: classic port writes ($7FFD/$1FFD/$DFFD) re-sync the 8K
slot table for the pages they touch and clear those slots' MMU override;
`SetMMU` sets the override. Last writer wins, exactly as on hardware.
Cold RAM zero-fills (matching SDRAM and the reference), with an optional
pseudo-random fill behind an env var for the uninitialised-read
detector.

Contention: the classic pattern applies at 3.5 MHz only. At any turbo
speed the FPGA does not assert contention, and neither does the
emulator. NR$08 bit 1 disables RAM contention outright.

Hot-path caches (#187, wasm exec cost): `Read`/`Write` first consult
per-8K-slot fast tables (`readFast`/`writeFast` in `pkg/memory`) that
point straight into the backing RAM half-bank whenever a slot's
dispatch provably reduces to a plain RAM access — no hooks/observers,
no uninit tracking, Layer 2 $123B paging off, and (bottom 16K) none of
the overlay cascade active. The bottom two slots are included because
games run whole engines from MMU RAM there (Atic Atac, banks 16/17):
the divMMC pager reports its effective decode through the memory's
`bottomOverlayProbe` and calls `InvalidateBottomFast` (O(1)) from every
transition choke point — automap page-in (all variants incl. the
delayed next-M1 conversion), $1FFx off-area page-out, RETN unmap, port
$E3 (CONMEM/bank/MAPRAM), enable, NR$09 MAPRAM escape — at the pacer's
NMI cadence. Multiface/bootrom/config/Alt-ROM/EFF7/beta and the classic
peripheral enables invalidate from their setters; paging/MMU/model/hook
mutations invalidate the whole table. Timing is untouched: waits and
contention are charged in the CPU cycle helpers, not in Read/Write.
Value identity is pinned by `pkg/memory/fastpath_xcheck_test.go`
(randomized churn vs a slow-path reference, plus the divMMC transition
shapes).

## Boot chain

Diagram: [next-boot-chain.drawio](diagrams/next-boot-chain.drawio).

The faithful path (default, and the only desktop path):

1. Power-on arms the FPGA bootrom (`tbblue_loader.rom`, GPLv3,
   embedded) mirrored over $0000-$3FFF, and sets config mode.
2. The bootrom reads `TBBLUE.FW` from the SD card over SPI, copies it to
   $6000, and jumps. SPACE during the splash opens the firmware config
   menu, which can boot any machine personality.
3. The firmware streams personality ROMs through the config-mode RAM
   window (NR$04 selects the target page; bootrom masks reads but writes
   pass through), seeds NR$05-$09/$80-$83, then writes NR$03. The first
   NR$03 write clears the bootrom mask and sets the machine type.
4. A soft reset (NR$02 bit 0) lands in NextZXOS. NR$02's reset_type is a
   3-bit shift-history register, so reads return $00 → $02 → $01 across
   the boot; NextZXOS uses that to distinguish its staging pass.
   Soft reset preserves NR$03, resets paging and the MMU, re-arms the
   divMMC entry points, and re-arms the bootrom only when config mode is
   active (that is what makes the config-menu machine selection work).

Licensing shape: only the GPLv3 loader is embedded. `enNextZX.rom`,
`enNxtmmc.rom` and the SD content are user-installed
(`pkg/next/install`, with an official-distro downloader) or injected in
the browser (`InjectROM` via `zxRegisterROM`).

Browser accelerators (opt-in via `go.env` in GoEmulator.js, never core
defaults):

- Direct-core boot (`ZX_GO_NO_FPGA_BOOTROM=1` +
  `ZX_GO_NEXT_DIRECT_BOOT=1`): resets the CPU straight into the NextZXOS
  ROM with the post-firmware NextReg personality seeded from
  `cmd/zx_go/next_directboot.go`. The seed table was captured from a
  live boot and is coupled to the SD distro version; the re-verification
  procedure lives in `packages/emulator-core/README.md`.
- Fastboot (`cmd/zx_go/fastboot.go`, `zxFastBoot()` export): pure time
  compression. Every instruction still executes; the page just runs many
  frames per displayed frame and discards the audio until PC reaches the
  NextZXOS menu wait loop.

## Video pipeline

Diagram: [next-video-pipeline.drawio](diagrams/next-video-pipeline.drawio).

Per frame the ULA renders its classic base image, then for each active
scanline re-renders the ULA row through the live Next ULA palette with
the Copper interleaved per 14 MHz HALF-pixel and composes it — on rows
whose state can change mid-row, through the FUSED per-half-pixel pass
(#183, r59: every layer's palette lookup and the mixer state read live
inside the interleave); event-free rows take a provably-identical
pair-coalescing stride. The live Next output frame is always 640×256
(two output pixels per frame pixel — the FPGA's own 14 MHz pixel bus
shape, zxnext.vhd:6543-6552). The pieces:

- Frame geometry (r51, #171): the Next composites into the FPGA's
  320×256 wide frame — sprites, the tilemap and Layer 2's wide modes
  all consume the SAME whc/wvc counters (zxnext.vhd:4208/4337/4389 ←
  zxula_timing.vhd o_whc/o_wvc), one coordinate system with (0,0) at
  the top-left of the 32-px border ring and the classic paper at
  (32,32). `ULA.SetNextCompositor` switches the ULA's canvas to this
  geometry (image row r IS frame row r, no bias arithmetic; classics
  keep 320×240). Since #183 the output canvas is 640×256 — the frame at
  its native half-pixel width, doubling to exactly the browser's fixed
  640×512 display box. Pinned by `TestNextWideFrameLayerAnchoring`.

- Layer 2 (`pkg/next/layer2`): framebuffer over three consecutive 16K
  banks. 256×192 8bpp row-major, 320×256 8bpp and 640×256 4bpp
  column-major (NR$70), 9-bit X scroll, palette offset added per the
  VHDL, clip window. The address generation and pixel fetch are verbatim
  ports of layer2.vhd. Port $123B additionally maps Layer 2 banks into
  CPU space for writing. Mid-frame scroll changes (NR$16/$17/$71)
  apply from their raster row via the same raster-stamped per-line
  fold as the tilemap below (FoldScrollStamps / CaptureRowScroll,
  bracketed by the compositor's FoldLayerScrolls): the FPGA re-latches
  the scroll registers every 7 MHz pixel clock and feeds them into the
  address generator combinationally (layer2.vhd:105-116 "capture
  settings for pixel period", :152/:156), so a CPU raster-waiting on
  NR$1E/$1F and rewriting NR$16/$71 splits the screen — Atic Atac's
  cinematic scroll-text band and menu logo (#187). The NR$70 palette
  offset rides the SAME per-line fold (also inside the per-pixel
  "capture settings" latch, layer2.vhd:105-116): Atic Atac's
  moon/character-select screen band-fades its credits text by cycling
  the offset per raster band (7 outside, stepped to 0 inside raster
  128-253) — a per-frame offset rendered the whole band through the
  black group-7 palette in BOTH boot modes. RenderScanline swaps the
  row's folded values into the address path and pixel mapping; the 256
  mode's raster anchor is the paper (row 0 = raster 64), the wide
  modes' the 320×256 frame (row 0 = raster 32). Pinned by
  `TestLayer2MidFrameScrollFold` / `TestLayer2WideModeScrollFoldAnchor`
  / `TestLayer2MidFramePaletteOffsetFold`. Mid-frame NR$70 RESOLUTION
  changes stay per-frame-latched (no known consumer; a mid-frame
  res switch also changes the row layout, which the per-row swap
  cannot express).
- Tilemap (`pkg/next/tilemap`): 40/80×32 tiles, 4bpp, optional per-tile
  attributes (palette offset, mirror X/Y, rotate, priority), 1bpp text
  mode, 512-tile mode, pixel scroll with torus wrap, clip. Bases from
  NR$6E/$6F select bank 5 or 7. Mid-frame scroll changes apply from
  their raster row in every tilemap pass, wide-L2 overpaint included
  (the FPGA's scroll registers are combinational into the pixel
  pipeline, tilemap.vhd:326), via a per-raster-line scroll table with
  two writers: CPU writes are stamped with the beam line and folded at
  render start (FoldScrollStamps), and the COPPER's render-time MOVEs
  are captured per row as the compositor walk announces each raster
  line (CaptureRowScroll, bracketed by Render — logScroll suppresses
  CPU stamping inside the bracket). RAMS band-scrolls the Galaxian
  player ship with per-line copper MOVEs to NR$30. Wired by
  WireTilemap (shared with the harness).
- Sprites (`pkg/next/sprite`): 128 slots, 16×16 in 4bpp or 8bpp over a
  16K shared pattern RAM, mirror/rotate/scale 1-8×, relative sprites in
  composite and unified anchor groups, the $303B status port (collision
  + max-per-line bits, clear-on-read), attribute streaming via ports
  $57/$5B and the auto-increment NextRegs $75-$79. The engine keeps the
  FPGA's TWO sprite indexes (sprites.vhd:591-655): the NR$34 mirror
  (target of NextReg attribute writes; NR$34 reads it live) and the
  IO-port cursor (ports $303B/$57), tied together by NR$09 bit 4
  ("lockstep"). Transparency compares each pixel's RAW pattern value
  against the NR$4B colour (full byte in 8bpp, low nibble in 4bpp,
  sprites.vhd:971) — palette index 0 is drawable, so the compositor
  reads per-pixel coverage (`LineCoverage`) rather than sentinel
  values. Rendering models the FPGA's per-line budget (one 448-count
  raster line of 28MHz FSM cycles: 1 per sprite qualified + 1 per pixel
  column) — sprites past the budget drop off the line and $303B bit 1
  latches — and the 9-bit X wrap that shows high-X sprites on the left
  edge (sprites.vhd:855).
- LoRes/Radastan (`pkg/next/lores`): 128×96 in 8-bit or 4-bit, a
  line-by-line transcription of lores.vhd. Wired as the ULA-layer
  content: while NR$15 bit 7 is set, the LoRes pixel replaces the
  classic ULA pixel wherever the shared NR$1A clip admits it
  (zxnext.vhd:6980), resolved through the live ULA palette with NR$14
  transparency; NR$6A supplies mode/dfile-xor/palette-offset and
  NR$32/$33 its own scroll pair.
- Palettes (`pkg/next/palette`): 9-bit RGB333 entries, 256 × 8 banks
  (first/second per layer), the two-byte NR$44 protocol — a write to
  NR$40/$41/$43 resets the pending half-pair (zxnext.vhd:5376/5382/5395);
  guests deliberately leave dangling first bytes and rely on the next
  index write to re-sync (#165) — per-entry Layer 2 priority bit,
  ULANext format (NR$42).
- Compositor (`pkg/next/compositor`): per-scanline composition in the
  NR$15 priority order (SLU/LSU/SUL/LUS/USL/ULS plus two additive blend
  modes), global transparency NR$14 (sprite transparency NR$4B lives in
  the sprite ENGINE — see above), tilemap
  transparency nibble NR$4C, the SUL per-pixel stencil, Layer 2
  priority-bit promotion — an opaque priority-bit L2 pixel outranks
  EVERYTHING, sprites included, in every mode whose FPGA ladder tests
  layer2_priority (all but LSU/LUS; #195 Head Over Heels' isometric
  door frames over the player sprite) — ULA+tilemap combine, and the
  NR$4A fallback colour where every layer is transparent. `mixer.go` is a fully
  faithful port of the FPGA video mixer, golden-tested; the scanline
  painter is the fast path, and its additive blend orders (modes 6/7)
  call `Mix` per pixel with the NR$68 blend-operand bits. The paint
  chain is ONE per-pixel resolver (composePixel) shared by the row pass
  and the fused live pass (BeginLiveRow/ComposeLiveHalfPixel — #183):
  on paced rows every half-pixel reads the LIVE palettes, palette
  selects, NR$14/$68 state and the NR$15 mode at its own copper time
  (the FPGA's per-i_CLK_14-slot mixer inputs, zxnext.vhd:6799-6832),
  while the layer INDEX buffers stay per-row — the hardware's own grain
  (sprites build line N+1 into a line buffer while N displays,
  sprites.vhd:537-540; do not "fix" this). The NR$15 priority mode is
  raster-stamped: CPU rewrites per raster band replay per composed row
  (SetPriorityModeOverride), and the first render-time (copper) NR$15
  write hands selection back to the live register from its half-pixel
  (the LayerPriority write generation). Timex hi-res is UNIFIED into
  the main row walk (native 512 stream, stable and mixed frames alike);
  hi-res Layer 2 and 80-column tilemap keep dedicated wide overlay
  paths (in place on the 640-wide frame), and border passes
  composite tilemap and sprites over the border area — all in the one
  320×256 frame coordinate system (see "Frame geometry" above). The
  hi-res Layer 2 overlay repaints the layers the NR$15 mode places
  above L2 from their sources (OverpaintWideL2Row): sprites in the
  non-L-topmost modes, the ULA+TM slot in the U-above-L modes (SUL
  below sprites, USL/ULS above — classic ULA pixels repaint from the
  CaptureULABase pure-ULA frame snapshot with per-pixel NR$14
  transparency, r94/#204 Space Invaders, then the tilemap over them),
  then priority-bit L2 pixels back on top (composeL2PriorityOverlayRow,
  #195). Residues: the ULA repaint ignores the NR$1A clip window and
  the ULA-vs-below-tile per-pixel arbitration (known-gaps).
- Copper (`pkg/next/copper`): 1024 × 16-bit instruction store, MOVE /
  WAIT / NOOP / HALT, four start modes (NR$62, list restart only on a
  mode TRANSITION into 01/11 per copper.vhd's edge detect), and the
  FPGA's 11-bit byte-granular write address (every NR$60/$63 byte
  advances it; NR$63 stages the even byte and commits the pair
  atomically, NR$61/$62 read it back live). Execution is cycle-paced
  (`RunToCycle`): MOVE costs 2 and NOOP 1 cycle of the 28MHz copper
  clock (4 cycles per 7MHz pixel), WAIT releases only when vcount
  equals its line and hcount reaches (X<<3)+12, and the list address
  wraps at 1024. The ULA's compositor pass interleaves it per 14 MHz
  HALF-pixel (2-cycle RunToCycle targets — one MOVE write per
  half-pixel, the base/Copper flags render their native half-width
  cells), gated per row by `CanRetireOnLine` (event-free rows coalesce
  and skip the per-slot calls), sweeps lines 192..311 after the visible
  rows (per half-pixel on lines with retirable instructions), and
  restarts StartOnVBL lists at the frame wrap. The border-line sweep runs even when the live-ULA render is
  off (NR$68 bit 7 ULA-disabled content — RAMS): the copper's
  192..311 WAITs must release on their lines regardless, via the
  per-row Step fallback. The per-scanline `Step` engine (golden replay
  and non-live fallback paths) shares RunToCycle's semantics: a
  1792-cycle-per-line budget at the same MOVE=2/NOOP=1 costs, the
  10-bit list address WRAPPING at 1024 in every running mode, and
  HALT parking (not stopping — the StartOnVBL frame reset un-parks
  it). The wrap is load-bearing: a free-running mode-01 list that
  ends without HALT loops forever — Atic Atac's sample pacer is a
  1024-entry looped list whose last entry is MOVE NR$02,$04, one
  divMMC NMI per wrap (~20 kHz).
- Copper NR$02 NMI delivery (#187): the render passes run AFTER the
  frame's CPU has executed, so NR$02 MOVEs fired there would collapse
  into one PendingNMI edge per frame (the pacer above ran at 50 Hz —
  one sample per frame, the guest's whole music timeline ~400× slow).
  The render RegWriter therefore FILTERS NR$02 (cmd/zx_go
  copperVideoWriter), and a per-frame schedule delivers those writes
  on the CPU timeline instead: `copper.FrameMoveInstants` simulates
  one frame on a throwaway copy of the copper (Step's exact costs;
  the real state still advances only at render), and the CPU's
  `ExtNMIFunc` poll (cmd/zx_go copperNMIPacer — live during HALT,
  which a prefetch hook is not; guests `DI;HALT` awaiting the first
  pulse) fires each instant through the dispatcher's one NR$02
  handler. Instants are 28 MHz copper-cycle granular (compared against
  the CPU's Ref8Tstates — the old /8 refT truncation fired up to 7
  cycles early), offset +5 from the MOVE's first cycle for the full
  FPGA pipeline: write pulse on the MOVE's SECOND cycle
  (copper.vhd:87-96), copper_req edge-detect register
  (zxnext.vhd:4709-4737), arbiter nmi_divmmc latch → NMI_n
  (zxnext.vhd:2096-2116), T80N NMI_s synchronizer
  (t80n.vhd:1650-1670), and the same-edge sampling rule at the final
  T_Res (t80n.vhd:1765). A stopped→running NR$62 transition
  anchors the list to its WRITE INSTANT: the FPGA copper begins
  executing on the next 28 MHz cycle after the enable edge
  (copper.vhd:70-83) — the model banks the frame's already-elapsed
  cycles as a start debt (`Copper.SetStartPhaseSource`/`startDebt`,
  wired from the CPU reference clock in cmd/zx_go) that Step,
  RunToCycle and FrameMoveInstants all consume before executing, so a
  mid-frame start is not silently re-anchored to the frame top. The
  debt is rebased into the COPPER's frame origin before it is banked
  (`copperStartPhase`): the render walk drives copper vcount in PAPER
  rows, and guest WAIT lines follow that convention, but the CPU's
  frame origin is the frame INT — MinVActive lines earlier. A restart
  at or before paper top therefore carries NO debt. Charging the raw
  CPU-origin offset starved the copper for the first (write − paper
  top) paper lines, which is long enough to miss an early WAIT; because
  a WAIT releases on strict line EQUALITY the copper then parked for
  the whole frame. Quantum Storm re-arms its list from the ISR inside
  the top border and lost its per-band tilemap scroll on alternate
  frames, shaking the menu rows (#197). Pinned by
  TestCopperStartPhaseRebasesToPaperTop. A
  free-running pacer wrap (Atic's 1361 cycles, frame-incommensurate)
  keeps that phase for its whole life, so the anchor decides where
  every later raster-slaved guest sequence sits inside the NMI period.
  Pinned by TestStartPhaseAnchor. Any NR$60-$63 write bumps the
  copper's Generation and clears the schedule immediately (a
  stopped/reprogrammed pacer must fall silent at once), rebuilding
  after a quiet gap; the rebuild's fast-forward cuts at the BUMP
  instant, not the rebuild instant, so instants elapsing during the
  quiet gap deliver late instead of dropping (a just-started pacer's
  first pulse may be DI;HALT-awaited). The dispatcher
  handler enforces the FPGA's NMI gates (zxnext.vhd:2091-2116): the
  NR$06 button-NMI enables (bit 3 MF / bit 4 divMMC — boot firmware
  config defaults $A8, applyTBBLUEFWBootDefaults) and the arbiter's
  no-nesting envelope (a new divMMC pulse is DROPPED from assertion
  until the handler's RETN — divmmc.Pager.NMIInFlight). The envelope
  reopens MID-RETN on the FPGA, ~6 CPU cycles before the instruction
  ends (retn_seen pulses at T3 of the $45 M1 fetch,
  im2_control.vhd:236; divmmc button_nmi/automap clear,
  divmmc.vhd:108,126; S_NMI_HOLD→S_NMI_END→S_NMI_IDLE,
  zxnext.vhd:2118-2166): the RETN hook passes that reopen instant to
  the pacer (`noteEnvelopeReopen`), which drops pure-$04 pulses that
  elapsed before it — otherwise the end-of-RETN poll (after the hook
  cleared the envelope) would deliver pulses the FPGA never saw.
  Pinned by TestCopperNMIPacerDeliversAtHardwareRate,
  TestNR02NMIGatedOnNR06, TestNR02DivMMCNMINeverNests,
  TestFrameMoveInstantsAticPacer, TestCopperNMIPacerEnvelopeReopen.
  Performance shape (#187, browser 28 MHz): the ExtNMIFunc dispatch is
  DEADLINE-GATED — after each poll the pacer converts its next
  instant to the exact raw T-state it crosses (`CPU.ArmExtNMIDeadline`;
  self-clearing on speed changes/frame origins, voided by the copper's
  generation hook on any NR$60-$63 write) so the per-instruction and
  per-HALT-T-state closure calls collapse to one integer compare
  between instants, with delivery points bit-identical. The ExtIntFunc
  poll (the CTC pulse INT line) is gated the same way (#187 wave 3 —
  IM2Block/CTCBlock `IntLine` + `Ref8Tstates` were ~half the native
  28 MHz exec profile, dominated by Atic's per-HALT-T-state polls):
  `CPU.ExtIntDeadlineFunc` (CTCBlock.NextAssertRef8 — the block's
  `nextZC28`, before which every IntLine call provably returns false
  without side effects; parked when no int-enabled channel is armed)
  arms `extIntDeadline` after each false poll, every CTC
  reschedule/reset kicks the gate (`SetRescheduleNotify` →
  `CPU.KickExtIntDeadline`), a true poll holds the gate open so
  level-triggered re-raise keeps sampling, and hw-IM2 mode declines to
  predict (polls every sample point, the pre-gate behaviour). The
  simulation and render engines batch runs: `FrameMoveInstants`
  precomputes uniform observation-free runs (NOOPs / MOVEs to other
  regs) and advances them arithmetically; Step/RunToCycle batch NOOP
  runs via a gen-cached run table and skip consecutive-identical
  `MOVE NR$7F` pad writes (inert user register, last write always
  lands) — the write-SKIPPED prefix of such a run (all but its last
  MOVE) is itself batched arithmetically via a second gen-cached run
  table (`dupRun`), so a 245-entry pad run costs two loop iterations
  per pass instead of 245; and rows are half-pixel-paced only when the
  program CAN affect video (`Copper.HasVideoMoves` — MOVEs solely to
  NR$02/NR$7F keep the coalesced stride, the pacer list's case).
  Render-side (#187 wave 2, all pixel-identical — Atic probe
  screenshots byte-equal pre/post): the compositor keeps per-render
  ROW CACHES for the tilemap and sprite layers (one
  RenderScanline(WithBelow) per frame row per render bracket instead
  of one per compositing pass — inner, border and wide-overpaint
  passes share it; validity = (per-bracket epoch, layer mutation
  counter `Gen()`), so render-time copper register writes invalidate
  exactly), `composePixel`'s per-pixel closures are flattened into
  method calls with the mode/palette resolution hoisted per row on the
  non-live path (per half-pixel resolution retained on the fused live
  path), the tilemap scanline walk runs per TILE-run (map entry,
  attribute and textmode byte fetched once per run), Layer 2's
  faithful scanline path caches the bank page across columns, and the
  ULA's border/disabled-fill loops paint by row segment instead of
  per-pixel putPix.
- Live-palette ULA render (`pkg/ula` renderNextULARow +
  `Compositor.ULARGBA`): on the Next, ULA inner-screen and border
  pixels resolve through the LIVE ULA palette exactly like the FPGA's
  palette SRAM lookup (zxula.vhd:483-558): standard decode
  ink/16+paper (+8 bright, flash swap), ULANext decode (NR$42 ink mask,
  paper 128|attr>>n, non-canonical masks and format $FF show the NR$4A
  background), border via the paper entry. Transparency (entry ==
  NR$14) travels to the compositor as alpha 0. Coverage: paper rows
  (and their L/R borders) per half-pixel on event/stamp rows and per
  coalesced pixel otherwise; the top/bottom border sweep rows per
  half-pixel when the copper can retire on their line, else once per
  line — everything on screen resolves through the same palette (one
  palette, one DAC; border white == paper white). The Timex display
  mode re-latches per character cell inside the row (zxula.vhd:191-214)
  and hi-res renders the native interleaved-files 512 stream
  (zxula.vhd:389). The ULA-disabled fill keeps the classic pre-render.
  The row render also applies the ULA hardware scroll (NR$26/$27:
  source pixel+attr = ((x+sx) mod 256, (y+sy) mod 192), zxula.vhd:199 /
  :192-208) and the NR$1A clip window (outside the inclusive
  display-space window → transparent; border exempt; zxula.vhd:562),
  both pushed by `next.WireULAControl` / `WireClipWindows`. The NR$68
  bit 2 fine-scroll-X is live: the LSB of the 14 MHz barrel-shift
  amount (zxula.vhd:199/:353/:395), a +1 half-pixel term in the source
  map.
- Raster-stamped ULA-video state (`pkg/ula` ulaVideoLine): mid-frame
  CPU writes to the ULANext decode state and the DISPLAYED ULA palette
  select (NR$43 bit 1) are stamped with their raster line
  (borderChanges-style) and replayed per row by the compositor pass —
  the ULA/ClassicPaletized flip of the displayed palette at mid-screen
  renders each half through its own palette, borders included. A
  back-to-back Render with no CPU execution (the harness screenshot
  path) keeps the executed frame's maps instead of rebuilding uniform
  live state (the `stale` check on the monotonic reference clock).
- Raster-stamped palette CONTENT (`pkg/next/palette` Bank stamped-write
  log): mid-frame CPU writes of palette VALUES (NR$41/$44 — on the FPGA
  a palette BRAM write is visible to the video fetch on the next pixel,
  zxnext.vhd:4919-4930) are logged with their FULL (line, hpos) beam
  position; the compositor pass rewinds the bank to frame-start state
  and re-applies the log in raster order — lines before each paper row
  up front, the row's OWN stamps per half-pixel at their hcount inside
  the row interleave (#183 stage 5), the bottom-border sweep per line,
  then a rewind for the top-border rows, which scanned before the
  paper — suspending logging for the walk so the copper interleave's
  render-time writes are never logged. EndReplay restores the live
  state and RETAINS the consumed log for stale re-renders.
  Granularity is one raster line; hi-res/wide re-composites stay at
  end-of-frame palette state (known-gaps.md). Driven by the
  Timing/ScanlineReadingAndInterrupt one-line palette flashes.
- NR$69 (Display Control) fans out like the FPGA: bit 7 → Layer 2
  enable, bit 6 → shadow display, bits 5:0 → the Timex port-$FF mode
  (zxnext.vhd:3924/:3658/:3617; `next.WireULAControl`).

Raster feedback: `ULA.BeamPosition()` derives (line, hpos) on the
3.5 MHz-REFERENCE timeline measured from the CPU's per-frame origin
(`z80.FrameOriginRefTstates`, re-recorded at every frame boundary and
shared with the frame-INT assert offset), wired to NR$1E/$1F, so DI'd
raster-polling code (NextGuide) works and raster reads can never drift
from interrupt placement. The FPGA's cvc counter runs on the VIDEO
clock (zxnext.vhd:5982-5986), so the beam must NOT advance with raw
CPU T-states: at 28 MHz that swept the frame 8× per real frame — the
r49 TX-1696 finding (work item #166), where the game's NR$1F ≥ 192
raster gate read garbage and its SP push-fill collided with the frame
INT. Pinned by `TestBeamPositionTurbo`.

## Interrupts

- Frame INT: narrow pulse with VHDL-derived assert T-state and width per
  machine timing and 50/60 Hz (`pkg/next/inttiming.go`), scaled with the
  turbo multiplier.
- Frame-INT disable: the FPGA's shared `port_ff_reg(6)` latch
  (zxnext.vhd:3609-3635) lives in the ULA's port-$FF byte, written by
  port $FF bit 6, NR$22 bit 2 and NR$C4 bit 0 (inverted); a sink wired
  by `next.Wire` mirrors it into `cpu.FrameIntDisabled`, which gates
  pulse GENERATION (a mid-pulse disable withdraws the line). NR$22
  bit 2 and NR$C4 bit 0 read composed from the latch; reset (NR$02
  hard/soft and machine reset) clears it.
- Line INT: NR$22/$23 program a 9-bit scanline; the wire layer converts
  it to a T-state offset for the CPU.
- IM2 daisy-chain (`pkg/next/im2.go`): a port of the FPGA's
  peripherals.vhd chain of 14 devices (line, UART RX/TX, 8 CTC channels,
  ULA frame INT), priority = vector index, golden-tested.
- Hardware-IM2 vectored mode (`pkg/next/im2block.go`, r54, #169):
  NR$C0 bit 0 routes the sources through the daisy chain instead of the
  pulse paths — frame/line pulse edges arrive via `z80.CPU.RouteIntFunc`
  (the ULA is the single EXCEPTION that still pulses when the Z80 is
  not in IM 2, zxnext.vhd:1965), CTC ZC/TO pulses via
  `CTCBlock.ConsumeZC`; requests latch per source until serviced. The
  Z80's IM2 acknowledge takes the generated vector
  `NR$C0[7:5] & vector & '0'` from `z80.CPU.IntAckFunc`
  (zxnext.vhd:1870/1999) and the exact pair ED 4D (`z80.CPU.OnRETI`)
  releases the in-service device. NR$20 injects software-generated
  requests; NR$C8/$C9 read the sticky status with write-1-to-clear;
  NR$C0 reads compose the live Z80 IM mode into bits 2:1 (vhd:6230).
  Found and verified against real silicon (hwdebug/) for TX-1696's
  CTC-caught audio install. UART sources (vectors 1, 2, 12, 13) never
  request — the UART generates no interrupts (known-gaps.md).
- CTC (`pkg/next/ctc` + `pkg/next/ctcblock.go`, r50): four
  cycle-accurate ctc_chan.vhd channels wired live — ports $183B-$1F3B
  (decode a(15:11)="00011" + low byte $3B, channel = a(10:8);
  zxnext.vhd:2690, 4064-4093) route through the ULA's port dispatch
  (`ULA.SetNextCTC`); NR$C5 writes set/clear the channels'
  interrupt-enable control bits and reads compose them back live. The
  channels count CLK_28 lazily: they batch-advance from
  `z80.Ref8Tstates` at observation points (port access, NR$C5, the
  per-instruction INT poll) with an O(1) timer fast path pinned
  tick-exact against the golden model. A ZC/TO on an int-enabled
  channel asserts the legacy pulse-mode INT for 32 CPU cycles
  (im2_peripheral.vhd:186 → pulse_int_n, zxnext.vhd:2014-2043) through
  `z80.CPU.ExtIntFunc`, the CPU's external-INT-line hook — in
  hardware-IM2 mode the IM2Block wraps that hook, suppresses the pulse
  and feeds the chain instead (see above). Gap: no counter-mode ZC/TO
  cascade between channels.
- Stackless NMI (NR$C0 bit 3 + NR$C2/$C3 return address) is wired into
  the CPU.

## DMA (`pkg/next/dma`)

The zxnDMA on ports $6B (zxnDMA mode) and $0B (Z80-DMA compatibility,
the legacy MB-02/Datagear decode) speaks the Z80-DMA WR-group protocol:
variable length register groups decoded by a pending-follow-byte state
machine, WR6 commands (RESET/LOAD/CONTINUE/ENABLE/DISABLE/READ
MASK/INITIATE READ SEQUENCE/READ STATUS/REINIT STATUS), the read-back
state machine mirroring dma.vhd's reg_rd_seq_s (each read returns the
aimed register and advances to the next masked one; $A7/$BB aim at the
first masked register, $BF at status), and the status byte
"00"&endofblock_n&"1101"&atleastone. Both ports reach the one
controller (ULA.dmaClaims); each access latches dma_mode from the port
used (zxnext.vhd:1811-1819), and the mode seeds the byte counter 0 / -1
at LOAD/CONTINUE/auto-restart — so a Zilog-mode block of length N moves
N+1 bytes, the genuine Zilog convention. LOAD latches the
source/destination pointers by the direction in force at LOAD
(dma.vhd:646-663) and a later direction flip transfers with the stale
roles (per-byte stepping, memory-vs-IO cycle type and port A/B
read-back follow the live direction bit) — the Misc/ZilogDMA
border-text behaviour. The prescaler delay is turbo-scaled per
dma.vhd's timer (prescaler*4^turbo/2 CPU T-states per byte). Continuous
mode stalls the CPU by charging cycles; burst+ prescaler mode
interleaves with CPU execution via a per-instruction Step paced on the
MONOTONIC reference clock (the raw per-frame T-state counter wraps),
and an auto-restart block reloads and repeats until DISABLE. Not
modelled: interrupt/match logic and DMA-vs-CPU bus contention;
read/write cycle lengths are charged in CPU T-states as a model
convention, and a continuous transfer's port writes all land at one
raster instant (known-gaps.md).

## Storage: divMMC, SD, esxDOS, .NEX

- divMMC (`pkg/next/divmmc`): the automap state machine with all trigger
  variants (instant/delayed, ROM3-gated), entry-point registers
  NR$B8-$BB, the $3Dxx trap, $1FF8-$1FFF page-out after fetch, CONMEM
  and sticky MAPRAM via port $E3, 128K divMMC RAM, RETN page-out (the
  exact ED 45 pair only, per im2_control.vhd's retn_seen — RETI and the
  RETN mirrors leave the automap latch alone; work item #163). SPI to
  the card through ports $E7/$EB. Includes two documented pragmatic
  emulations of firmware-installed stubs (the $2009 FRAMES bump and the
  bank-1 stub write-protect).
- SD card (`pkg/next/sdcard`): a protocol-accurate SPI-mode card:
  command framing, CMD0/8/9/10/12/13/16/17/18/24/25/32/33/38/55/58/59,
  ACMD41/13/51, CSD v1 (SDSC) and v2 (SDHC) paired with the OCR CCS bit,
  real CRC16 over data blocks, multi-block streams that survive CS
  toggles, and slot-0-only CS decode. Backing sources: an in-memory
  image (`ImageSource`, with `--sd-writeback` persistence), a
  file-streamed image for cards too big to slurp (`FileSource` —
  ReadAt-backed with guest writes captured in a RAM overlay, the file
  never modified; auto-selected by the desktop/headless loader for
  `ZX_GO_NEXT_SD_IMG` files over 1 GiB, e.g. a dd of a real card;
  the .nex import path needs a writable store so it is unavailable in
  this mode), a SPARSE image (`SparseSource`, r55 — only touched
  16 KiB pages are resident, absent pages read as zeros and all-zero
  writes allocate nothing, so a large-geometry card costs only its
  real content in RAM; this is the browser's card: the wasm
  `zxSdIngestBegin/Chunk` exports stream the zip-inflated image in
  without ever materialising it flat — the official distro's 1 GB /
  32 KB-cluster card mounts at ~136 MB resident, the staged trimmed
  512 MB / 4 KB-cluster fallback at ~5 MB; on the distro path the
  `zxSdPrepDistro` export then normalises the pristine card before
  boot — `cmd/zx_go/distro_prep.go` deletes the first-boot welcome
  `nextzxos/autoexec.1st` and seeds `machines/next/config.ini` when
  absent), or a FAT32 image built
  from a host directory tree (`BuildFAT32`, VFAT long names with ~N
  aliasing, the format NextZXOS actually boots). The FAT staging
  machinery (`WriteFileToImage`/`AddFileToImage`, used by .nex/.bas
  import and `zxPutFile`) runs against any of these through the
  `sdcard.Image` interface (ReadAt/WriteAt/Size); the historical
  []byte entry points wrap it.
  `AddFileToFAT32`/`WriteFileToFAT32` insert or replace files in an
  existing image (this is what `zxPutFile` and .NEX import use);
  `DeleteFileFromImage`/`FileExistsInImage` (r60) tombstone a file —
  dir entry plus its VFAT LFN chain, data chain returned to the FAT —
  or probe for one, which is what the distro-card prep uses. A
  directory grown past its first cluster gets its extension cluster
  zeroed — on a real card's dirty free space, stale bytes would
  otherwise interleave with new entries and detach LFN chains from
  their 8.3 entries, breaking the guest's long-name F_OPEN (#165).
- esxDOS (`pkg/next/esxdos`): the RST 8 API implemented as a pre-fetch
  hook at PC $0008, gated on the divMMC overlay being paged in. Handlers
  for the file API (F_OPEN...F_READDIR), M_GETHANDLE, M_DRVAPI,
  M_GETDATE, backed by a host-directory mount or the card.
- .NEX loader (`pkg/next/nex`): parses the V1.2 container (header,
  palette, loading screens, banks in the canonical load order).
  Bank/SP/PC application is the caller's job; in production the file is
  written onto the SD card and NextZXOS's own loader runs it via a typed
  menu macro (`nexload_macro.go`), which keeps loading faithful. The
  macro's final step meters the loader's SD reads (the card's
  `DataBlocksRead` counter) against the header-derived loader-visible
  size (`nexLoadableSize` — self-streaming games append payload
  `.nexload` never reads), feeding `zxMacroProgress()`.

## Peripheral blocks

- RTC: a DS1307 on a bit-banged i2c bus (ports $103B/$113B), clock
  registers derived from host time, 56-byte NVRAM persisted across runs.
- UART: at its real ports $133B (Tx/status) / $143B (Rx/prescaler) /
  $153B (select) / $163B (frame) — decode zxnext.vhd:2639, register
  select by address bits 9:8 (uart.vhd:44) — routed via
  `ULA.SetNextUART`, with FIFOs and an AT-command responder on the
  ESP side (UART 0) and an always-empty Pi side (UART 1). Real
  networking is out of scope by decision. NR$A8/$A9 are NOT the UART:
  they are the ESP GPIO output-enable / pin registers (`WireESPGPIO`;
  $A9 idles $05 — both pins pulled up).
- DACs: four 8-bit channels on the classic DAC ports, event-timed into
  the mixer. Turbosound: three AY chips (see chips.md).
- Keymap (NR$28/$29/$2B) and the joystick I/O-mode register (NR$0B,
  register modelled, pin-repurposing behaviour out of scope).

## Working on this area

- Adding a NextReg: follow CONTRIBUTING.md (handler through the
  dispatcher, wiring in wire.go, subsystem test, harness test when
  cross-subsystem). Find the VHDL lines first and cite them.
- Never trust a reference emulator for read-back shapes; verify against
  the VHDL (`--next-nrdiff` has a documented caveat about this).
- After changing engine behaviour consumed by the browser, bump
  `ENGINE_REV` in GoEmulator.js (repo convention, see the zxcode
  CLAUDE.md) and re-run the boot tests listed in
  `packages/emulator-core/README.md` if the SD distro or boot path is
  involved.
- The do-not-regress invariants live at the bottom of `ROADMAP.md`. Read
  them before touching boot, SD, or reset code.
