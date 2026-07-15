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

The table below is the July 2026 headless triage, re-baselined
2026-07-14 against the r47 core (post #163 RETI/RETN fix). Method:
each title's WHOLE release folder (data subfolders included) is
staged onto a copy of the shipped SD image with an auto-running
`.nexload` autoexec (`_tools/stage-oracle-sd`, recursive staging),
cold-booted headless 16000–40000 frames with screenshots,
`--press-key` schedules where a menu blocks progress, and
`--dump-state` signatures. "Works (title)" means the title
screen/menu renders and the game was not driven further headless —
not a full playability verdict.

Method lesson from the re-baseline: the original sweep launched each
title through `ZX_GO_RUN_NEX_FILE`, which stages only the lone
`.nex`. Titles that LOAD separate data files at runtime then failed
for the wrong reason — two of the three previously recorded
"game-era" failures (WOTEF's dead HALT, Aliens Neoplasma's sparse
red lines) were exactly this staging artifact and cleared once their
data folders were staged. Full-folder staging is now the sweep
method.

| Title | Status | Notes |
|---|---|---|
| Sonic the Hedgehog | Works (caveat) | Renders level/scroll/sprite/HUD and is controllable (arrows + Right-Alt/Ctrl). Residual: a few HUD icons in the top-right diverge from hardware (a game-loop/interrupt-timing detail, not a render bug). Not re-run in either 2026-07 sweep (file not present). |
| Celeste | Works | Re-verified in-game on the r47 re-baseline: ENTER starts the game, level + player render, gameplay frames advance. |
| Nextoid | Works (caveat) | Menu renders (r47 re-baseline). Headless start scheduling remains fiddly — the menu's key poll only starts a few hundred frames after the menu is visible, and neither `1`+`o` nor earlier schedules landed this sweep; drivability itself was verified in the #159 sweep ('S' then SPACE). |
| Quantum Storm | Works (menu) | r47 re-baseline: intro art renders (circuit-board screen, magenta border — border colour 3, faithful). Keyboard/Kempston presses don't advance it headless; default controls are an MD pad and the MD-only pad buttons still have no input source (known-gaps.md), so menu navigation stays unverified. |
| Head Over Heels (Next) | Works (title) | Title logo renders (re-verified r47). |
| Lords of Midnight (Next) | Works (title) | Intro screen art renders (re-verified r47; runs IM 1). |
| Scramble (Next) | Works (title) | Attract screen renders — score header, "© KONAMI 1981" (re-verified r47). |
| Space Invaders (Next) | Works (title) | Attract/planet artwork renders (re-verified r47). |
| Tyvarian | Works (title) | Attract text renders ("Rise of the Crystal Thief", options prompt) (re-verified r47). The noisy-looking header/footer rows haven't been compared against a reference. |
| Warhawk | Works | Verified headless end-to-end: starts, plays and reaches GAME OVER (#160). r47 re-baseline: kfire edges register and the score header ticks. The menu wants a fire EDGE twice; `--press-key` accepts `kfire`/`kup`/... joystick names. The earlier "unstartable, NR $B0-$B2" verdict was a harness artifact. An A/B run with `WireExtendedKeys` disabled starts identically — the game reads NR $B2 each input poll but $00-idle satisfies it. |
| NextBASIC Invaders | Works (in-game) | Plays on the shipped 24.11 distro headless: first wave, score header, shots (#163; was the loader-class freeze). r47 re-baseline: attract renders. The separately reported `Integer out of range` DEFPROC divergence ([janko-jj](https://github.com/conorarmstrong/zx_go/issues)) is still its own issue. |
| Baggers in Space (Stonechat Games) | Works (title) | Title + high-score board render (re-verified r47; unblocked by #163). |
| Crowley World Tour | Works (menu) | Title + frame art render (unblocked by #163). The formerly-empty central panel now shows the full ENDLESS MODE high-score table (#165: the panel content is runtime-loaded, and the staging tool's FAT32 append was detaching LFN chains in grown directories — the game's long-name F_OPENs failed). |
| Bomb Jack (Next) | Works (title) | Full title screen (Layer 2) renders (re-verified r47; unblocked by #163). |
| Saboteur (Next) | Works (menu) | r47 re-baseline: title renders, and a keypress advances to the night intro scene, which renders correctly. |
| Aliens Neoplasma | Works (menu) | FIXED by #165 (the class-1 staging repair): the post-title black-screen idle HALT was the game silently failing its runtime data F_OPENs on a corrupted staged directory. A keypress now advances title → the ACHILLES NAVIGATION SYSTEM menu (Play game / Redefine keys / About), rendered correctly. |
| Way of the Exploding Fist (Next) | Works (menu) | FIXED by #165 — TWO stacked bugs. (1) The staging tool's FAT32 `appendDirent` extended a full directory without zeroing the new cluster; on the distro image's dirty free space, stale bytes interleaved with new entries and detached `Palettes/HighscoreTable.npl`'s LFN chain from its 8.3 entry, so the game's F_OPEN failed — and the game's own error path then uploaded a stale palette buffer from `$B000+1` (an esxDOS error CARRY rippling through its `RL E` address math). (2) With staging fixed, every post-keypress screen rendered in four shades of dark blue: our NR$44 half-pair latch wasn't reset by NR$40/$41/$43 writes (zxnext.vhd:5376/5382/5395) — the game's clear routine leaves a dangling half-pair and relies on the reset. High-score table (TOP 10 FIGHTERS) and menu (1 PLAYER / 2 PLAYERS / OPTIONS over Mt. Fuji) both render correctly now. |
| TX-1696 | Known issue | #169 pinned the r49 residual to the LINE: the game's audio-install runs a raster-phased stack blast — poll NR$1F ≥ 192 ($B168: `LD A,$1F`/NR read/`CP $C0`), ~18 lines of setup, then CALL $EDE8 = a 4,632-byte `PUSH HL` slide (SP from $4CFE down through the $2000-$3FFF ROM window, writes past $4000 discarded on purpose). The frame INT (cvc 248, zxula_timing.vhd c_int_v=1) must land mid-slide with SP in the window: the discarded interrupt pushes make the IM1 exit's final `RET` (ROM3 $0050 path) pop a ROM3 data word, PC lands in the game's `$E5` flood covering high RAM, surfs the pushes to a collector, and the game resumes — verified end-to-end in-emulator by staging SP/PC/beam at the designed geometry (the #166 FW `JP (IX)` hook-dispatch theory is retired: bank1 $2009 does drivers+keyboard+FRAMES only). Two real conformance gaps found and FIXED en route (r50): the 28 MHz wait state applied to M1 fetches only instead of EVERY memory read (zxnext.vhd:3168-3181 — opcode, prefix, operand AND data reads wait; specnext wiki confirms NOP=5T), and the CTC block not being wired at all (ports $183B-$1F3B, NR$C5, pulse-mode INT — the game's install hook arms CTC ch0 at 250 kHz as its IM2 heartbeat; zxnext.vhd:4064-4093/2014-2043). REMAINING BLOCKER (open): with every constant measured and VHDL-verified (entry cvc ~210.5, slide 30.5 lines at 12T/push, wrap-1 at 241 hits ROM3 $0000 = `DI`, INT at 248.3 arrives ~1.3 lines after the second wrap, dead every retry, ~3.98M-insn retry period), the design only closes if real-hardware 28 MHz `PUSH` costs ≥ 15.1T (i.e. writes ALSO wait, which neither the vendored 3.02.03 VHDL nor community docs show) or the INT fires ≥ 7.3 lines earlier. The raster poll re-locks the phase every retry so no upstream jitter (SD Nac variance was added — faithful in itself — but is absorbed by the poll). HARDWARE-MEASURED (2026-07-15, `_tools/hw-probe` on a real Next): NOPs 33 lines/12k (5T exact = our model), pushes 40 lines/6k (~12.2T — writes do NOT wait; ROM-window writes = RAM writes), frame INT at raster 248 (exact). Instruction timing is exonerated on silicon — the install geometry cannot close on real hardware either as measured, so the working-on-hardware reports (NextZXOS 2.07k/2.08) most plausibly differ via the OS build's code-path lengths shifting the slide-entry raster phase; our card runs 2.09 (24.11 distro). Next step: run the game on a real Next from a 2.09/24.11-era card — failure there closes this as a game/OS-version incompatibility with the emulator faithful. Loader is also FAT-geometry sensitive (512 B-cluster cards abort earlier; BuildFAT32 2 KB clusters get furthest). |
| RAMS | Known issue | r47 re-run with its arcade ROM sets staged: still boots to a corrupt first screen (fragments of the game-select UI; parked in a normal IM 2 HALT wait). The hardware build leans on cycle-exact tricks — its own distribution ships a separate emulator-specific `.nex` variant — so this stays in the architectural-timing class (conformance Axis 10), not the quick-fix list. |
| Atic Atac (Next) | Untested | The local `ATICATAC.NEX` is 111 MB — not a valid `.nex`; needs a clean download before it can be triaged. |

### Next failure classes and the ranked gap list (re-baselined 2026-07-14 against r47, work item #164)

The failures cluster into classes; ranked by how many titles each
blocks (the conformance prioritizer — see work items #159/#164):

1. **PARTIAL (work items #166/#169, 2026-07-14): TX-1696's install
   geometry — two more real gaps FIXED (r50), one blocker still
   open.** The #166 story (r49): `ULA.BeamPosition` divided raw CPU
   T-states by 228, but the FPGA's cvc counter (NR$1E/$1F, copper
   WAITs, palette raster stamping) runs on the VIDEO clock
   (zxnext.vhd:5982-5986, zxula_timing.vhd) — fixed by deriving the
   beam from the 3.5 MHz-reference timeline against the CPU's own
   frame origin (`z80.FrameOriginRefTstates`); pinned by
   `TestBeamPositionTurbo`. #169 (r50) then pinned and fixed two
   more: (a) the 28 MHz wait state was charged on M1 fetches only —
   the FPGA waits EVERY memory READ cycle (opcode, prefix, operand,
   data; writes unwaited — zxnext.vhd:3168-3181; `pkg/z80` readMem
   chokepoint); (b) the CTC was modelled (`pkg/next/ctc`, golden-
   tested) but never WIRED — channels 0-3 now sit behind ports
   $183B-$1F3B (decode a(15:11)="00011" + $3B, channel = a(10:8),
   zxnext.vhd:2690/4064-4093), NR$C5 int-enables write through to
   the channel control bits and read back live (vhd:4078/6242), and
   a ZC/TO on an int-enabled channel drives the legacy pulse-mode
   INT for 32 CPU cycles (im2_peripheral.vhd:186, zxnext.vhd:
   2014-2043) via the new `z80.ExtIntFunc` hook (`pkg/next/
   ctcblock.go`, `TestWireCTCPulseInterrupt`). SD block reads also
   gained a spec-faithful variable access time (Nac) before the
   data token. TX-1696 itself remains blocked on a measured ~1.3-
   line interrupt-vs-slide geometry shortfall that every VHDL and
   community source contradicts — see its row for the full map and
   the two candidate resolutions (real 28 MHz write waits, or an
   earlier INT).
2. **CLOSED (work item #165, 2026-07-14): runtime data-load failures
   — WOTEF, Aliens Neoplasma and Crowley's panel all unblocked by
   TWO stacked fixes.** (a) `fat32.go appendDirent` extended a full
   directory without zeroing the freshly allocated cluster; on the
   shipped 24.11 image's dirty free space the free-slot scan then
   wove new entries around stale bytes, detaching VFAT LFN chains
   from their 8.3 entries — the guest's long-name F_OPENs failed
   for whichever files landed in an extension cluster. This is the
   shared machinery under `stage-oracle-sd`, `zxPutFile` (browser
   game-folder staging + project files) and .NEX import, so it was
   a REAL product bug, but a card-content bug, not core-emulation:
   any faithful emulator shows the same wreck on such a card.
   Which title failed which way was luck of directory layout —
   that's why Saboteur/Baggers sailed through and why the class
   resisted a single-emulator-cause story. (b) Under it, one real
   FPGA-conformance bug: the NR$44 palette half-pair latch must
   reset on NR$40/$41/$43 writes (zxnext.vhd:5376/5382/5395, Axis
   9); WOTEF leaves a deliberate dangling half-pair, and without
   the reset every palette upload landed one byte out of phase
   (four shades of dark blue). The diagnosis account (SD-command
   ground truth → Layer 2 bank diff → NR write-stream phase
   analysis → game-code disassembly → F_OPEN carry) is in work
   item #165. TX-1696 did NOT move — see its row (its verdict is
   blocked on staging its 53 MB audio, not on this class).
3. **CLOSED (work item #163, 2026-07-14): RETI mistreated as RETN
   unmapped the esxDOS overlay — 5 titles unblocked** (Baggers in
   Space, Crowley World Tour, NextBASIC Invaders, Saboteur, Bomb
   Jack all load/render on the SHIPPED 24.11 distro now). Root
   cause: the Z80 core fired the RETN hook (divMMC automap unmap +
   Multiface unmap) for RETI and every RETN/RETI mirror, but
   zxnext.vhd's `divmmc_retn_seen` comes from the im2_control
   decoder which matches the EXACT pair ED 45 only
   (im2_control.vhd:236); RETI feeds the separate `reti_seen`
   (IM2 daisy chain). Failure mechanism: a game IM2 interrupt
   fires while an esxDOS RST $08 file call has the overlay paged
   in (interrupts are enabled during SD waits); the game ISR ends
   in `EI / RETI` ($74CF in Baggers), our RETI unmapped the
   overlay, and the ISR returned to a divMMC-ROM return address
   ($1F42) that now showed ROM 3 bytes — collapsing with SP still
   on the overlay's private $20xx stack. Every previously recorded
   "SP-in-ROM-window" signature was this wreckage. Pinned by
   `TestRETNHookFiresForExactED45Only`; VHDL_CONFORMANCE.md Axis 8.
   Two #159 readings corrected along the way: (a) the $3D96-$3D9E
   "DENY(3dxx)" events are FAITHFUL — 24.11's ROM0 has real code
   at $3D96 (HALT/LD A,$07/CALL $0D6B) that the rom3 gate
   correctly leaves untrapped when ROM0 is paged (the gate itself
   verified right, Axis 1); (b) the `.nex` entry PC IS reached on
   24.11 — the wreck happened in-game during the first RST $08
   data load, not "before the dot's first instruction".
   The #164 re-baseline retired the rest of the old class-2 list:
   WOTEF's dead-HALT and Aliens' sparse-red-lines verdicts were
   single-file-staging harness artifacts (their runtime data files
   were never on the card), and TX-1696's two distro-dependent
   signatures collapsed into the class-1 stall above once its
   folder was staged.
4. **NR $B0/$B1/$B2 extended-keys / MD-pad registers — CLOSED
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
5. **Architectural timing (Axis 10) — 1 title** (RAMS). Its authors
   ship a per-emulator build; do not chase before the contention /
   sub-line timing items land.

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
images; stages the game folder recursively since #164, so data
subfolders land at their relative card paths), mtools `mcopy` for
FAT16 ones, `_tools/build-fat16-sd` (rebuild a distro tree as
FAT16). The 64 MB card budget is looser than it looks: the distro uses
only ~3 MB (59.5 MB free), and TX-1696's 53 MB `audio/` + game
data fit with 1.2 MB spare once its 43 MB `Art/` (DVD-case PDFs,
not game data) is excluded. For bigger payloads,
`_tools/build-base-sd` rebuilds the distro (extracted from the
shipped image via `mcopy -s`) onto a BuildFAT32 card of any size
(256 MB default; ZEsarUX only boots 64 MB-geometry images though
— it sat in its RAM-test loop indefinitely on a 256 MB one). Useful probes:
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
