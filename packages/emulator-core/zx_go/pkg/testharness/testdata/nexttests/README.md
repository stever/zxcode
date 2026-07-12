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

The suite's Next-side tests ship as `.snx` snapshots, which zx_go does
not load yet — integrating them is tracked on the ZX Play board (work
item #139). The classic `ULAvsSJS.sna` (visual ULA timing) is also not
yet wired; it needs screenshot comparison rather than screen-text OCR.
