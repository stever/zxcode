# ext327 — vendored test builds

Test programs from
https://github.com/Threetwosevensixseven/ZXSpectrumNextTests
(MIT — see LICENSE in this directory), upstream commit `d0e14d38b821`
(2020-02-19). Run by `pkg/testharness/ext327_test.go` and reported on
the conformance dashboard.

Two kinds of fixture:

- The four `DMA*/LDIR*` .nex files are the upstream's own prebuilt
  binaries, vendored as-is (md5sums below).
- Everything else is built from the sjasmplus ports in `src/`
  (upstream ships those tests as Zeus sources only; Zeus is a
  Windows-only assembler, so the ports keep the builds reproducible —
  `src/build.sh` regenerates all of them). Each port documents its
  deviations in its header; none touch the behaviour under test.

| File | Test | What it checks |
| --- | --- | --- |
| DMAFill/DMACopy/LDIRFill/LDIRCopy.nex | DMACopy (4 modes, upstream builds) | zxnDMA fill/copy byte-identical to LDIR ground truth |
| MMUPaging7FFD.nex, MMUPagingMMU.nex | MMUPaging (2 variants) | Bank markers via $7FFD vs MMU paging; the MMU variant also pins the FPGA's MMU0/1-reset-on-$7FFD rule |
| DFFDPaging.nex | DFFDPaging | $DFFD metabanks composing with $7FFD and the MMU, plus NR$56/$57 read-backs |
| Level2Order_0..5.nex | Level2Order (6 orderings) | The NR$15 layer priority orders over a ULA/Layer 2/sprite scene with per-layer transparency |
| ULAScreenR520/0123/4567.nex | ULAScreenPaging (3 modes) | Main/shadow ULA screen via $7FFD bit 3, on 128K paging and inside both +3 special all-RAM configs |

`src/main.scr`, `src/shadow.scr` are the upstream's screen assets,
used by the ULAScreenPaging builds.

Upstream prebuilt md5sums at vendor time:

    d793228c47ff047acc429e02a9c66cd5  DMACopy.nex
    8611aa2ebcdfc40f0381db8c8603c571  DMAFill.nex
    86e3e3cd5c398aa1aede4292c15d3545  LDIRCopy.nex
    bcb1a3615685e11f24701eaadca6095f  LDIRFill.nex
