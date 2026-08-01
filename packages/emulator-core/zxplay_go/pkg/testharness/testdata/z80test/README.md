# z80test — vendored test builds

Patrik Rak's Zilog Z80 CPU test suite, release v1.2a, from
https://github.com/raxoft/z80test (MIT — see license.txt in this
directory). Each variant computes exhaustive per-instruction CRCs and
compares against captures from a real Zilog Z80 in a 48K Spectrum.
Run by `pkg/testharness/z80test_test.go` (direct CODE-block injection,
entry $8000) and reported on the conformance dashboard.

| Tap | Tests | zxplay_go status at vendor time (2026-07-12) |
| --- | --- | --- |
| z80doc.tap | all registers, documented flags | 160/160 pass |
| z80docflags.tap | documented flags only | 160/160 pass |
| z80flags.tap | all flags | 12/160 fail — documented gaps, ZX Play #141 |
| z80full.tap | all flags and registers | same 12/160 |
| z80ccf.tap | flags after CCF following every instruction | 67/160 fail — Q register, #141 |
| z80memptr.tap | flags after BIT n,(HL) following every instruction | 160/160 pass |
| z80ccfscr.tap | visualises random CCF behaviour | manual/visual only, not wired |
