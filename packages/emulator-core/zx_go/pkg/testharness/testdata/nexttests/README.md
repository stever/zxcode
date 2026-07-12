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

The classic `ULAvsSJS.sna` (visual ULA timing) is also not yet wired;
it needs screenshot comparison rather than screen-text OCR.
