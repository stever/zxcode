# nexttests — vendored test builds

Prebuilt .sna test programs from
https://github.com/MrKWatkins/ZXSpectrumNextTests
(MIT — see LICENSE in this directory), vendored from the develop branch
on 2026-07-12. Run by `pkg/testharness/nexttests_test.go` and reported
on the conformance dashboard.

| File | Upstream test | What it checks |
| --- | --- | --- |
| z80bltst.sna | ZX48_ZX128/Z80BlockInstructionFlags | Flags of IM2-interrupted repeating block instructions (David Banks research). Real-hardware reference: z80_block_flags_test_v5_shrek_zx128.jpg upstream |
| int_skip.sna | ZX48_ZX128/Z80IntSkip | Interrupt-acceptance inhibition after EI and DD/FD prefixes; ISR entries per /INT pulse; IFF2 reads during int-ack |
| ccffrm.sna | ZX48_ZX128/Z80CcfScfOutcomeStability | SCF/CCF outcome determinism frame over frame |
| DIHalt.sna | Interrupts/HaltAfterDisable | DI + HALT must hang forever (border stays green) |
| ULAvsSJS.sna | ZX48_ZX128/ULAvsSJS | Keyboard/Sinclair-joystick port mixing: live readings of $00FE (whole 8x5 matrix) vs the $F7FE/$EFFE half-rows — every half-row zero bit must also read zero on the all-rows port, and the "difference detected" message (the grey +2 SJS quirk it hunts) must stay hidden. TestNexttestsULAvsSJS drives keys across rows and asserts the attribute cells + border (vendored 2026-07-13) |

The Next-side tests ship as `.snx` snapshots — in practice standard
49179-byte 48K SNA files whose extension signals "run on a Next"
(pkg/snapshot treats .snx as SNA). Wired so far:

| File | Upstream test | What it checks |
| --- | --- | --- |
| Z80N.snx | base/Z80N | All 23 Z80N instructions; interactive (turbo key 2, Go key 5); pass = every row OK + green border, per the real-hardware photo. First run caught the LDDX/LDDRX direction and LDWS flag bugs |
| Z80Nc2.snx | base/Z80Nc2 | The core-2 additions (barrel shifts, JP (C)); caught the JP (C) I/O-jump bug |
| NextReg.snx | base/NextReg_defaults | Per-register availability + default-value audit of all 256 NextRegs, painted as a colour-coded 16x16 attribute grid. TestNexttestsNextRegDefaults decodes every cell and asserts the full verdict map (deviations from the core-3.1.5 board photo documented in the test). Audit fixed the copper byte-granular cursor, NR$8E lock bypass, NR$7F/$82-$89 defaults and the ULA-first classic palette default |
| Copper.snx | base/Copper | Raster-timed copper palette rewrites: five Swedish flags (incl. over-left-border), the horizontal-wait >= probe, a Z80-animated line, and the self-reported 03F3/03F3 instruction counters (board core 3.01.5 + MAME captures). TestNexttestsCopper asserts the full visible surface; drove the cycle-paced copper + live-palette ULA render |
| dma.snx | base/DMA | zxnDMA transfer-mode matrix (24 A->B/B->A cells + IO endpoints yellow), short-init/CONTINUE reuse, the 16-byte read-back stream (adjudicated against dma.vhd), the auto-restart prescaler burst and IM2 speed stepping. TestNexttestsDMA asserts the full attribute verdict surface; fixed $BF/read-state/$83/auto-restart/turbo prescaler + the harness DMA IO bus |
| SpritTra.snx | Sprites/Transparency | Sprite transparency: NR$4B default-$E3 read + retarget to index 2 (checker squares vanish/show). Drove the faithful raw-pattern-vs-NR$4B transparency comparison in pkg/next/sprite (vendored 2026-07-12) |
| SpritRel.snx | Sprites/Relative | Composite relative sprites: anchor/relative positions, palette-offset relativity + wrap, relative pattern names, scales, invisibility propagation, over-border dot. Also the adjudicator that DISPROVED the "sprites 8 rows lower" gap row (sprite fill exactly inside its ULA-drawn outline) |
| SpritBig.snx | Sprites/BigSprite | Unified ("big sprite") relatives, 8bpp: eight anchor mirror/rotate combinations transforming a 10-sprite body rigidly; invisible ninth big sprite; violet over-border sprite. TestNexttestsSpritesBigSprite pins every arm's colour bounding box per group |
| SprBig4b.snx | Sprites/BigSprite4b | The 4bpp big-sprite variant: relative patterns crossing the N6 half boundary (4.5+0.5=5.0), palette-offset saturation, border pattern-display sprites + red square. Pixel-count/bbox/colour-set + sample pixels pinned per group |
| SprDelay.snx | Sprites/ScanlineDelay | Copper-raster-timed sprite attribute changes (core 3.0.7+ WAIT_H=48 build): visibility/rotate+move/NR$4B/palette effects each landing on exactly one scanline, plus the 4/5-byte attribute records ("ooo1"/"o1") and the NR$09 sprite-index lockstep exercise ("11") — drove the dual NR$34/IO sprite indexes + tie |
| DefTrans.snx | ULA/DefaultTransparency | Classic bright-magenta paper over Layer 2 must stay opaque — adjudicated the boot ULA palette's bright magenta to $E7 projection (%111'001'111), fixing classicRGB333 (vendored 2026-07-13, as the rest of the ULA group) |
| TFalBUla.snx | ULA/BorderTransparencyFallback | NR$4A fallback in border + paper across three key-driven phases (ULANext transparency, full-ink mask, Enhanced-ULA off). ZEsarUX capture is the good reference; upstream marks CSpect's BAD |
| CPalTran.snx | ULA/ChangePaletteTransparency | ULA paper-7 palette entry redefined to $E3 → paper transparent over Layer 2, border via the same entry, NR$4A fallback where Layer 2 is transparent too (column 227) |
| CPalTrV2.snx | ULA/ChangePaletteTransparency_v2 | Ink-mask 15 variant: paper 3 transparent, border entry redefined to green — border follows entry 128+border, not the paper |
| CPalTrV3.snx | ULA/ChangePaletteTransparency_v3 | ULANext OFF: entry 128+7 redefinition must not touch the classic decode; transparent INK-0 entry 0 gives rainbow text over Layer 2 |
| Ula_Pal.snx | ULA/ClassicPaletized | Classic screen through both Next ULA palettes with CPU raster timing: mid-screen NR$43 displayed-palette flip + border rainbows — drove the raster-stamped ULA-video state replay |
| UlaScrol.snx | ULA/UlaScroll | NR$26/$27 ULA hardware scroll + NR$1A clip window + NR$69 display modes (OPQA/H/R/M interactive) — drove the scroll/clip wiring and the NR$69 fan-out |
| L2Colour.snx | Graphics/Layer2Colours | All 24 sprite/L2/ULA state combinations in all six NR$15 orders, priority-bit palette entries, pink fallback, and the closing shadow-over-ROM write. Drove the port $123B shadow-PAGING fix (the bit wrongly flipped the ULA shadow display), the NR$1E/$1F raster-line counter (harness wiring + FPGA cvc convention) and the raster-stamped NR$15 replay (vendored 2026-07-13, as the rest of the Graphics group) |
| L2Port.snx | Graphics/Layer2Port | Port $123B write/read-over-ROM windows for visible + shadow banks, IM1-in-L2, and the core-3.0.7+ bank-offset form. Self-verdicting green blocks + green border; drove the composed $123B read-back |
| L2Scroll.snx | Graphics/Layer2Scroll | NR$16/$17 Layer 2 scroll animated to [196,133] + NR$18/NR$1A clips; the ULA-drawn ruler ticks pin the L2 dot alignment, the sheet self-reports the registers |
| LmxHiCol.snx | Graphics/LayersMixingHiCol | The mixing matrix with Timex HI-COLOUR as the ULA layer — drove the 8x1 attribute fetch (vram_a bit 13, zxula.vhd:238) |
| LmxHiRes.snx | Graphics/LayersMixingHiRes | The matrix with Timex HI-RES 512x192 — drove the native half-pixel composite (ComposeHiResScanline) and the synthesized hi-res attribute/border (index 130, the core-2.00.25+ behaviour the upstream ReadMe documents) |
| LmixLoRs.snx | Graphics/LayersMixingLoRes | The matrix with LORES as the ULA layer — drove wiring the orphaned pkg/next/lores (NR$15 bit 7, NR$6A, NR$32/$33) into the live ULA render |
| Lmix_LxU.snx | Graphics/LightenDarken_L2_ULA | The additive blend modes: NR$15 mode 6 (clamped L+U) and 7 (L+U-5) over LoRes — drove routing the scanline painter's blend orders through the FPGA-golden Mix |
| Chg8kBan.snx | Timing/Changing8kBank | MMU bank-switch timing: 2048 Z80N NEXTREG r,n writes (20T each) timed as a green border band off the frame INT; contention ON variant. No board photo upstream — pinned by instruction/frame-INT arithmetic + the MAME 0.282 capture's proportions (vendored 2026-07-13, as the rest of the Timing group) |
| Chg8kB_2.snx | Timing/Changing8kBank_NoContention | The NR$08-bit-6 contention-OFF variant; must render identically to the ON variant under the deferred machine-wide contention model (equality pinned — flip when contention lands) |
| linesIRQ.snx | Timing/ScanlineReadingAndInterrupt | Interactive raster instrument: NR$1E/$1F reads, NR$22/$23 line interrupt and copper WAITs each paint the ULA white-paper palette entry on the target raster line. Drove the raster-stamped palette-CONTENT replay (palette.Bank stamped-write log) |
| NReg0x69.snx | Graphics/NextReg0x69 | NR$69 as a composed live alias of $123B/$7FFD/port $FF (10 read/write cross-checks self-reported) + copper-driven per-scanline mode switching. Drove the composed NR$69/port-$FF reads, the NR$08 bit 2 port-$FF read gate and the 48K-personality ROM-3 launch state. Runner pokes NR$12=9 (the NextZXOS launch state the test assumes) |
