# ext327 — vendored test builds

Prebuilt .nex test programs from
https://github.com/Threetwosevensixseven/ZXSpectrumNextTests
(MIT — see LICENSE in this directory), vendored at upstream commit
`d0e14d38b821` (2020-02-19). All four are builds of `DMACopy.asm` in its
four modes; run by `pkg/testharness/ext327_test.go` and reported on the
conformance dashboard.

| File | Mode | Signature |
| --- | --- | --- |
| DMAFill.nex | zxnDMA fill of the ULA screen | border black, attrs $46 |
| LDIRFill.nex | LDIR fill (ground truth) | border blue, attrs $42 |
| DMACopy.nex | zxnDMA copy $C000 → $4000 | border black |
| LDIRCopy.nex | LDIR copy (ground truth) | border blue |

md5sums at vendor time:

    d793228c47ff047acc429e02a9c66cd5  DMACopy.nex
    8611aa2ebcdfc40f0381db8c8603c571  DMAFill.nex
    86e3e3cd5c398aa1aede4292c15d3545  LDIRCopy.nex
    bcb1a3615685e11f24701eaadca6095f  LDIRFill.nex

The other tests in the upstream repo (MMUPaging, DFFDPaging,
ULAScreenPaging, Level2Order) ship as Zeus assembly sources with no
prebuilt binaries; integrating them is tracked on the ZX Play board
(work item #140).
