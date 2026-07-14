# Compatibility manifest

What runs in zx_go. This is a working document — every entry has a
status, the model it was tested on, and (if "Issue") a brief note.
The list isn't exhaustive; it's the titles a contributor has
specifically loaded and run to a point of confident "works" or
"broken here". To add an entry, follow the protocol at the bottom.

Status legend:
- **Works** — boots to title screen, accepts input, plays.
- **Works (caveat)** — playable but with a known emulator-side
  imperfection. Caveat documented in the Notes column.
- **Parses cleanly** — file-format parser accepts the image
  without error. No gameplay verification.
- **Known issue** — loads partway, crashes, or visibly wrong.
  Filed as a GitHub issue (linked).
- **Untested** — no contributor has run this through yet.

Confidence note: every title below sits on top of the same Z80 core
that passes both Cringle exerciser suites
([zexdoc and zexall](../pkg/z80/testdata/conformance/README.md)).
"Works" therefore means CPU correctness is not under suspicion when
something does go wrong — it's almost always a peripheral or timing
issue. See "Foundation tests" for what blanket-cover tests do and
don't buy you.

## Foundation tests

These integration tests under `pkg/testharness` (and one in
`pkg/plus3fdc`) prove the *foundation* for each category works.
They do **not** prove arbitrary programs in the category run
correctly — they prove the boot path and primary API surface are
sound, which narrows the debug area when a specific title misbehaves.

| Test | What it proves |
|---|---|
| `TestNewBoots48K` (testharness) | The 48K ROM boots and writes screen attribute state — any failure here would indicate a broken core, not a broken title. |
| `TestIF1CATCommand` (testharness) | Interface 1 + Microdrive paging, ROM hooks, and `CAT 1` execution work. Doesn't prove arbitrary IF1 software runs. |
| `TestDiscipleColdBootAndKeypress` (testharness) | DISCiPLE pages in, boots GDOS, and accepts keypresses. Doesn't prove arbitrary GDOS programs run. |
| `TestSaveDSKRoundTrip` (plus3fdc) | +3 disk image parser / writer is symmetric. Doesn't prove arbitrary +3 disk titles boot. |
| `TestNextRealROMBoot` (testharness) | NextZXOS boots through ~10K instructions without crashing. Doesn't prove it reaches the BASIC prompt or any specific Next title runs. |
| `TestModelNextLayer2VisibleEndToEnd` (testharness) | The NextReg → palette → Layer 2 → compositor pipeline produces correct RGBA pixels. Doesn't prove arbitrary Layer 2 demos look right (timing, sprite layering, Copper sync). |
| `TestLoadNEXAgainstRealSample` (testharness) | The .NEX V1.2 parser correctly reads banks 0–7 from a real distro file. Banks ≥8 are silently skipped — `.nex` files using extended banks won't load fully. |
| `TestZexdoc`, `TestZexall` (z80) | Every documented Z80 instruction passes Cringle's exerciser; every undocumented behaviour (F3/F5, MEMPTR/WZ partial, DDCB register-copy) passes too. |

If a title in a covered category fails, the bug is almost certainly
in a peripheral driver, timing, or untested undocumented behaviour —
not the core CPU.

## 48K titles

Canonical 48K titles. None have been individually verified through
zx_go yet; foundation tests confirm the 48K boot path works.

| Title | Status | Notes |
|---|---|---|
| Manic Miner | Untested | |
| Jet Set Willy | Untested | |
| Knight Lore | Untested | Filled 3D — exercises attribute clash handling |
| Atic Atac | Untested | |
| Sabre Wulf | Untested | |
| Skool Daze | Untested | |
| The Hobbit | Untested | |
| Lords of Midnight | Untested | |
| Elite (Spectrum port) | Untested | |
| Chuckie Egg | Untested | |
| Horace Goes Skiing | Untested | |
| Jet Pac (Interface 2 cartridge) | Untested | IF2 cartridge slot wired and tested in `if2_test.go` |
| Pssst (Interface 2 cartridge) | Untested | Same IF2 path as Jet Pac |

## 128K / +2 titles

Titles that use the AY-3-8912 sound chip and/or the extended 128K
memory map. Foundation tests confirm 128K paging works.

| Title | Status | Notes |
|---|---|---|
| Robocop (Ocean) | Untested | AY soundtrack |
| Renegade | Untested | |
| Target: Renegade | Untested | |
| R-Type (Spectrum port) | Untested | |
| Lemmings (Spectrum port) | Untested | |
| Where Time Stood Still | Untested | |
| Head over Heels | Untested | |
| Last Ninja 2 | Untested | |
| Match Day II | Untested | |
| The Way of the Tiger | Untested | |

## +3 / +2A disk titles

Titles distributed on +3 floppy disk. Foundation: `plus3fdc`
DSK / EDSK / UDI round-trip tests prove the disk container code is
symmetric, but no individual +3 title has been loaded and run.

| Title | Status | Notes |
|---|---|---|
| Cobra (Ocean, 1986) — +3 disk | Parses cleanly | 194816-byte CPCEMU DSK, 40 tracks, 1 side. Round-trips through `plus3fdc.ParseDiskImage` without errors. Not yet run to gameplay end-to-end. |
| Lemmings (+3 disk reissue) | Untested | |
| Where Time Stood Still (+3 disk reissue) | Untested | |
| Driller (+3 disk reissue) | Untested | |
| Total Eclipse (+3 disk reissue) | Untested | |

If you have a +3 DSK image that isn't listed and you want to add it,
follow the protocol at the bottom of this document.

## Demoscene

Demoscene productions exercise timing-sensitive features —
mid-frame border palette switches, AY register tricks, contention
patterns, multi-loader tape rituals — that the test harness doesn't
cover. Visual + audio inspection is the only verification.

A general note rather than specific titles: zx_go's mid-frame border
tracking (per-scanline, see `pkg/ula`) and AY-3-8912 register
semantics should handle typical demo techniques, but no specific
demo has been run through the full pipeline yet. Spectrum demos worth
trying as stress tests are anything that uses a multicolour technique
(8×1 attribute blocks via raster-synced palette writes), or anything
labelled "intro" or "megademo" from a known group (Triebkraft, Raww
Arse, Mayhem, Lyra) — these are the productions most likely to
expose timing imperfections.

## Spectrum Next titles

The Next cold-boots NextZXOS end-to-end — splash → firmware → welcome
→ menu/Browser/NextBASIC — see [docs/spectrum-next.md](spectrum-next.md).
The individual hardware blocks (Layer 2 incl. hi-res, the sprite
engine, tilemap, Copper, the NextReg file, the 8K MMU) are tested
against the FPGA VHDL.

**Running arbitrary `.NEX` games is the newest and least-finished
part of zx_go, and the most likely place to hit a bug.** `.nex`
titles are launched through NextZXOS's own loader, so OS-dependent
games run as on hardware — but per-title behaviour varies widely.

The table below is the July 2026 headless triage sweep: every title
was launched through the genuine `.nexload` path on the current SD
distro (`ZX_GO_RUN_NEX_FILE`, see the headless notes in
docs/architecture/frontends.md), run 12000–18000 frames with
screenshots and crash heuristics, and the failures were state-dumped
to a first observed divergence signature. "Works (title)" means the
title screen/menu renders and the game was not driven further
headless — not a full playability verdict.

| Title | Status | Notes |
|---|---|---|
| Sonic the Hedgehog | Works (caveat) | Renders level/scroll/sprite/HUD and is controllable (arrows + Right-Alt/Ctrl). Residual: a few HUD icons in the top-right diverge from hardware (a game-loop/interrupt-timing detail, not a render bug). Not re-run in the 2026-07 sweep (file not present). |
| Celeste | Works | Menu and in-game verified headless: ENTER starts the game, level + player render, gameplay frames advance. |
| Nextoid | Works (caveat) | Boots to its input menu; drivable ('S' then SPACE). Note for headless driving: the menu's key poll only starts a few hundred frames after the menu is visible (intro loops run first), so fixed-frame key schedules are easy to mistime. |
| Quantum Storm | Works (menu) | Options menu renders. Default controls are a pad ("8BitDo M30"); NR $B0-$B2 read-back is now live-composed, but the MD-only pad buttons still have no input source in any frontend (known-gaps.md), so pad-default titles need their control options switched to keyboard/Kempston. Input not verified. |
| Head Over Heels (Next) | Works (title) | Title logo renders. |
| Lords of Midnight (Next) | Works (title) | Title screen renders. |
| Scramble (Next) | Works (title) | Title screen renders. |
| Space Invaders (Next) | Works (title) | Title screen renders. |
| Tyvarian | Works (title) | Title screen renders. |
| Warhawk | Works | Verified headless end-to-end: starts, plays (ship, scrolling level, enemies, scoring) and reaches GAME OVER. The menu wants a fire EDGE twice — the first brings up "PRESS FIRE TO PLAY", the second starts — from keyboard SPACE (`--press-key "space@N"` repeated every ~90 frames) or Kempston fire (`kfire@N`). The earlier "unstartable, NR $B0-$B2" verdict was a harness artifact: the timed key schedule never landed the two-edge sequence and `--press-key` had no joystick names (it does now). An A/B run with `WireExtendedKeys` disabled starts identically — the game reads NR $B2 each input poll (masked $0E = left-pad X/Z/Y) but $00-idle satisfies it. |
| NextBASIC Invaders | Known issue (loader class) | On the shipped 24.11 distro: draws the first wave then freezes with IM 2 + DI and SP=$20B6 in the ROM window. **Runs to its menu on the 2020/NextZXOS 2.06 stack** (2026-07-14 A/B, see the loader-class note below) — the freeze signature is 24.11 dot-dispatch wreckage, not game code. The separately reported `Integer out of range` DEFPROC divergence ([janko-jj](https://github.com/conorarmstrong/zx_go/issues)) is still its own issue. |
| Baggers in Space (Stonechat Games) | Known issue (loader class) | On 24.11: black screen; CPU ends up executing ROM 3 floating-point code at $315x-$31xx with SP=$2098 inside the ROM window (wreckage, not game code — the "MMU6/7 paging helper" reading was a mis-attribution; those bytes are the 48K ROM FP calculator). The `.nex` entry PC ($5C50) is never reached: the wreck happens **before the dot command's first instruction**. **Loads and plays on the 2020/2.06 stack** (title + high-scores verified). |
| Crowley World Tour | Known issue (loader class) | On 24.11: black screen, SP=$20AE ROM-window wreckage. **Renders its title on the 2020/2.06 stack.** |
| Bomb Jack (Next) | Known issue (loader class) | On 24.11: alive-but-black (line IRQ fires, Kempston polled, Layer 2 palette never lands). **Full title screen renders on the 2020/2.06 stack** — so this too is the 24.11 loader-path divergence, not a display-path bug. |
| Saboteur (Next) | Known issue (loader class) | On 24.11: DI busy-spin polling NR read-back via $253B. **Title screen + "press any key" renders on the 2020/2.06 stack.** |
| Aliens Neoplasma | Known issue | On 24.11: DI busy-spin after launch. On the 2020/2.06 stack the game code RUNS (game banks mapped, 1.2G insns) but the screen shows only sparse red horizontal lines — likely the 24.11 loader-class failure stacked on an own display/NextReg issue. |
| Way of the Exploding Fist (Next) | Known issue | HALT with IFF1=0 in IM 2 shortly after launch — **reproduces identically on the 2020/2.06 stack** (10.4M insns in), so this is NOT the 24.11 loader class; the divergence is in game-era code. Own bisect target. |
| TX-1696 | Known issue | On 24.11: launch falls back to NextZXOS. On the 2020/2.06 stack it launches and executes game code (1.2G insns), but ends with SP=$0000 and a black screen — different failure per stack; needs its own triage. |
| RAMS | Known issue | First screen renders corrupt (one broken character block). The hardware build leans on cycle-exact tricks — its own distribution ships a separate emulator-specific `.nex` variant — so this title sits in the architectural-timing class (conformance Axis 10), not the quick-fix list. |
| Atic Atac (Next) | Untested | The local `ATICATAC.NEX` is 111 MB — not a valid `.nex`; needs a clean download before it can be triaged. |

### Next failure classes and the ranked gap list (2026-07 triage; reranked 2026-07-14)

The failures cluster into classes; ranked by how many titles each
blocks (the conformance prioritizer — see work item #159):

1. **24.11 dot-command dispatch: divMMC automap DENY at $3Dxx —
   5 titles confirmed** (Baggers in Space, Crowley World Tour,
   NextBASIC Invaders, Saboteur, Bomb Jack; Aliens Neoplasma
   partially — see class 2). Established by a same-emulator A/B
   (2026-07-14): every one of these titles loads/renders when
   launched through NextZXOS 2.06 (the 2020 distro on FAT16), and
   fails identically on the 24.11 distro regardless of filesystem
   (FAT32 original AND a FAT16 rebuild) and regardless of the
   NEXLOAD dot binary (24.11's dot works fine on the 2.06 kernel).
   First divergence found by divMMC page-event trace
   (`ZX_GO_DIVMMC_PAGE_TRACE=1`): during the 24.11 OS's
   dot-command dispatch — BEFORE the dot's first instruction —
   M1 fetches at $3D96-$3D9E are **DENIED divMMC automap by the
   rom3 gate** (10 denials in the failing run, zero in the entire
   working 2.06 load; $3D00 maps IN moments earlier, so the gate
   inputs flip mid-dispatch). The dispatch then executes ROM 3
   bytes where esxDOS overlay code should be and collapses into
   the ROM 3 FP-calculator region with SP inside $2000-$3FFF —
   the previously recorded "SP-in-ROM-window" signatures are all
   this wreckage. VHDL cross-ref: $3Dxx instant automap is
   rom3-class and NR $BB bit 7-gated (zxnext.vhd 2898-2899 + the
   line-3138 rom3 gate); NR $BB=$F2 at the wreck, so the enable
   bit is set — the suspect is the rom3 gate evaluation or our
   AltROM/ROM-bank state tracking across the 24.11 dispatch's ROM
   switching. **Fixing this one gate decision likely unblocks all
   five titles on the shipped distro.** Not yet arbitrated against
   a reference (ZEsarUX does boot the 24.11 image but takes ~12
   minutes through its loader's RAM test; a lockstep anchored at
   the first $3Dxx denial is the follow-up).
2. **Game-era failures surviving the 2.06 stack — 2-3 titles**
   (Way of the Exploding Fist dead-HALTs identically on both
   stacks; Aliens Neoplasma runs but renders only partial red
   lines on 2.06 — its 24.11 DI-spin may be class 1 stacked on an
   own display/NR issue; TX-1696 launches on 2.06 but ends with
   SP=$0000). Each needs its own bisect.
3. **NR $B0/$B1/$B2 extended-keys / MD-pad registers — CLOSED
   (work item #160), and the original blame was wrong.** The
   registers are now live-composed and VHDL-pinned
   (VHDL_CONFORMANCE.md Axis 3), but the A/B run showed Warhawk
   never needed them: its "unstartable" verdict was a triage
   harness artifact (the menu needs two fire edges, and
   `--press-key` couldn't press joystick buttons — it now accepts
   `kfire`/`kup`/`kdown`/`kleft`/`kright`). Warhawk is verified
   playing headless. Residual, tracked in known-gaps.md: the
   MD-only pad buttons (X Z Y MODE START A C) have no input
   source, so pad-default titles (Quantum Storm) still need their
   keyboard/Kempston control options.
4. **Architectural timing (Axis 10) — 1 title** (RAMS). Its authors
   ship a per-emulator build; do not chase before the contention /
   sub-line timing items land.

(The former "alive-but-black display path" (Bomb Jack) and
"`.nexload` falls back to OS" (TX-1696) classes are absorbed above:
Bomb Jack is class 1; TX-1696 moved to class 2 with a
distro-dependent signature.)

#### The loader-class A/B method (2026-07-14)

The class-1 finding came from a symmetric-launch harness that both
zx_go and a reference emulator can boot: stage the game's files plus
a fixed-name `/zx.nex` copy and an auto-running
`c:/nextzxos/autoexec.bas` (`10 .nexload /zx.nex`, autostart 10)
onto an SD image; every cold boot then launches the game with no
typed input (autoexec.bas with an autostart line DOES run on
headless boots). The 2020/NextZXOS 2.06 FAT16 image boots on both
zx_go and ZEsarUX in seconds (ZEsarUX reached Baggers' `.nex` entry
PC in 11.6 s from reset); the 24.11 distro image also boots in
ZEsarUX but takes ~12 minutes through that loader build's RAM test.
Local-only staging tools: `_tools/stage-oracle-sd` (FAT32 distro
images), mtools `mcopy` for FAT16 ones, `_tools/build-fat16-sd`
(rebuild a distro tree as FAT16). Useful probes:
`ZX_GO_DIVMMC_PAGE_TRACE=1` (automap grant/DENY events with PC +
instruction number) and `--trace pc --trace-pc-range $2000-$3FFF`
(dot-window PC streams for A/B diffing).

Class 2 is why the reference-emulator lockstep harness still
matters: those dumps show where each game DIED, not where it
DIVERGED. The `--next-bisect` / `--next-lockstep` / `--next-nrdiff` /
`--next-memdiff` drivers exist for exactly this walk-back; they
compile under the development-only `oracle` build tag with a local
reference-emulator driver (ZEsarUX ZRCP since work item #162), and
the sd-image spec accepts `img.mmc!nexload=/zx.nex` to have the
local side type the launch when an autoexec can't be staged.

If a Next game fails for you, **that is expected at this stage** —
please file it (with what you see vs. real hardware / a stable
emulator) so it can be fixed. The Next title scene is small enough
that any contributor running public `.nex` releases from specnext.com
or itch.io should add their own rows above as they verify them.
**No fabrications** — only list titles you've actually run, and
mark anything unverified as Untested.

## Tape format edge cases

The `pkg/ula` tape pipeline supports both TAP (load + save) and TZX
(load + save, blocks 0x10 / 0x11 / 0x14). Edge cases worth verifying
manually:

- **Speedlock / Alkatraz loaders**: turbo blocks with non-standard pilot
  lengths. Format support is present; correct decoding of every
  variant is not exhaustively tested.
- **Multi-side tapes**: side-A side-B "flip the tape" sequences in
  adventure games (Lords of Midnight Vol 1, etc.). Stop Tape from the
  menu and load the next side.
- **Multi-load games (lots of action games)**: ensure the fast tape
  trap doesn't interfere with multi-block loaders; turn it off if so.

## Joystick configurations

Verified by the keymap unit tests (`pkg/keyboard/keyboard_test.go`).
Picking the right joystick for a given game is essential:

- **Kempston** (port 0x1F) — most arcade games of the late 80s
- **Sinclair 1** (keys 1-5) — Sinclair Interface 2 left side; games
  with explicit "Sinclair joystick" support
- **Sinclair 2** (keys 6-0) — right side
- **Cursor / Protek** (keys 5/6/7/8/0) — fewer games; check title
  documentation

## How class evidence works

When a title isn't on the list, you can still predict whether it'll
run by figuring out which class it belongs to:

1. Is it pure 48K BASIC? → `TestNewBoots48K` covers it.
2. Does it use the AY sound chip? → Multi-AY tests cover register
   semantics; if your title uses AY through standard ports, the
   sound will play.
3. Does it use IF1 / Microdrive? → `TestIF1CATWorks` covers the boot
   path.
4. Does it use DISCiPLE / +D? → `TestDISCiPLEBootsIntoGDOS` covers
   the boot path.
5. Does it use +3 disks? → `TestPlus3FDCDiskRoundtrip` covers disk
   I/O.
6. Does it depend on cycle-exact contention (e.g. multicolour
   scanline tricks)? → Open in a hex editor, check whether it does
   raster waiting via T-state loops; if yes, expect potential
   wobble.
7. Is it a Next .NEX file? → Banks 0-7 fully supported; 8-111
   silently skipped today.

## How to add a title

When you load a title and want to record the result:

1. Try the title on the appropriate model (most 48K games stay on
   48K; +3 disk games need +3; etc.).
2. Note any peripheral state required (DISCiPLE on/off, joystick
   selection).
3. Run far enough to confirm the title is functional — not just
   "shows the loading screen" but "playable".
4. Add a row to the appropriate table:
   - **Works** for clean runs.
   - **Works (caveat)** for visible-but-cosmetic issues (audio
     pitch slightly off, etc.).
   - **Known issue** for crashes / corruption / freezes — file a
     GitHub issue first and link it.
5. Submit a PR.

This manifest is the cheapest credibility lever in the project: a
title list with verified statuses is more useful than any number
of internal benchmarks for telling a prospective user "yes, this
works for what you want to do".

## Automated compatibility corpus

`TestCompatibilityCorpus` (in `cmd/zx_go`) turns this manifest into an
automated regression guard: it loads a real title headless, drives it to
its title/menu screen, and asserts the rendered screen matches a recorded
golden hash over a settle window. This catches "a real game silently
stopped loading" — the class of bug a mechanism-level unit test passes
straight through (e.g. the Renegade-128K tape failure).

Game files are copyrighted and **not** committed. Point the corpus at a
folder holding them (titles whose files are absent skip, so CI stays
green):

```bash
# Run the corpus against your own game folder
ZX_GO_CORPUS=/path/to/games go test ./cmd/zx_go/ -run TestCompatibilityCorpus -v

# Record/refresh a title's golden screen hash (new title, or intended
# rendering change)
ZX_GO_CORPUS_UPDATE=1 ZX_GO_CORPUS=/path/to/games \
  go test ./cmd/zx_go/ -run TestCompatibilityCorpus -v
```

To add a title, append a `corpusTitle` to the table in `corpus_test.go`
(file, model, load type, key schedule, frame count) and record its golden.

## Loader fuzzing

The file parsers are fuzzed (Go native fuzzing) so corrupt or hostile
input is rejected, never crashes:

```bash
go test ./pkg/snapshot/ -run x -fuzz FuzzLoadBytes -fuzztime 60s   # .sna/.z80/.szx
go test ./pkg/betadisk/ -run x -fuzz FuzzLoadImage -fuzztime 60s   # .trd
go test ./pkg/ula/      -run x -fuzz FuzzLoadTAP  -fuzztime 60s    # .tap (+ FuzzLoadTZX)
```

The seed corpora run as part of the normal `go test ./...`.
