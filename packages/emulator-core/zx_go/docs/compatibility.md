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
| Tyvarian | Works (gameplay) | The r47 note's "noisy-looking header/footer rows" were the #171 wide-frame geometry bug (the game draws tilemap/wide-L2 content into the border ring, which our render tore 24 px against itself at the paper/border seam) — fixed r51, and the user-reported gameplay sprite-vs-backdrop drift + matching collision feel was the same class. Browser re-test 2026-07-15 (r53 bundle, play app `?u=` game zip): attract pages (Rogues Gallery / Wall of Dishonour) render with clean header/footer rows, and arena 01-01 gameplay verified — ship, crystal ring and enemies sit aligned on the grid backdrop, shots register score. |
| Warhawk | Works | Verified headless end-to-end: starts, plays and reaches GAME OVER (#160). r47 re-baseline: kfire edges register and the score header ticks. The menu wants a fire EDGE twice; `--press-key` accepts `kfire`/`kup`/... joystick names. The earlier "unstartable, NR $B0-$B2" verdict was a harness artifact. An A/B run with `WireExtendedKeys` disabled starts identically — the game reads NR $B2 each input poll but $00-idle satisfies it. |
| NextBASIC Invaders | Works (in-game) | Plays on the shipped 24.11 distro headless: first wave, score header, shots (#163; was the loader-class freeze). r47 re-baseline: attract renders. The separately reported `Integer out of range` DEFPROC divergence ([janko-jj](https://github.com/conorarmstrong/zx_go/issues)) is still its own issue. |
| Baggers in Space (Stonechat Games) | Works (title) | Title + high-score board render (re-verified r47; unblocked by #163). |
| Crowley World Tour | Works (gameplay) | Title + frame art render (unblocked by #163); central panel content unblocked by #165 (staging FAT32 LFN repair). The user-reported start-screen text sitting below its box and gameplay shapes landing below the playfield were the #171 wide-frame geometry bug (mixed tilemap/Layer 2 vertical origins) — fixed r51. Browser re-test 2026-07-15 (r53 bundle, `?u=` zip with the .pfs staged alongside the .nex): the playmode menu text sits inside its ornate box, and Moscow-level gameplay verified — pieces fall, show their ghost marker and stack flush on the well floor inside the playfield frame. |
| Bomb Jack (Next) | Works (title) | Full title screen (Layer 2) renders (re-verified r47; unblocked by #163). |
| Saboteur (Next) | Works (menu) | r47 re-baseline: title renders, and a keypress advances to the night intro scene, which renders correctly. |
| Aliens Neoplasma | Works (menu) | FIXED by #165 (the class-1 staging repair): the post-title black-screen idle HALT was the game silently failing its runtime data F_OPENs on a corrupted staged directory. A keypress now advances title → the ACHILLES NAVIGATION SYSTEM menu (Play game / Redefine keys / About), rendered correctly. |
| Way of the Exploding Fist (Next) | Works (menu) | FIXED by #165 — TWO stacked bugs. (1) The staging tool's FAT32 `appendDirent` extended a full directory without zeroing the new cluster; on the distro image's dirty free space, stale bytes interleaved with new entries and detached `Palettes/HighscoreTable.npl`'s LFN chain from its 8.3 entry, so the game's F_OPEN failed — and the game's own error path then uploaded a stale palette buffer from `$B000+1` (an esxDOS error CARRY rippling through its `RL E` address math). (2) With staging fixed, every post-keypress screen rendered in four shades of dark blue: our NR$44 half-pair latch wasn't reset by NR$40/$41/$43 writes (zxnext.vhd:5376/5382/5395) — the game's clear routine leaves a dangling half-pair and relies on the reset. High-score table (TOP 10 FIGHTERS) and menu (1 PLAYER / 2 PLAYERS / OPTIONS over Mt. Fuji) both render correctly now. |
| TX-1696 | Works (gameplay) | FIXED r54 (#169, three-session saga — full history in work items #166/#169). The game's audio install masks the ULA frame INT (NR$22=$06) and arms **CTC ch0 in the Next's hardware-IM2 vectored mode** (NR$C0=$AD bit 0, NR$C5=$01, IM2 table at $5Exx with every even hardware vector reading handler $8001), then CALLs a 4,632-byte `PUSH HL` slide through the write-discarded $2000-$3FFF ROM window; the CTC interrupt catches it within microseconds and the recovery returns inline. The emulator wedged because it wired only the CTC's legacy pulse INT (r50): the slide WAS caught, but IM2 acceptance used the classic open-bus $FF vector whose table word ($5EFF = $0080) is garbage by design — hardware supplies the even generated vector `NR$C0[7:5] & source & 0` = $A6 → $8001. Root cause was measured ON REAL SILICON with the joy-port serial debugger (`hwdebug/`): breakpoints on the owner's Next showed the slide returning inline (bp $AE0B, SP restored to $4D00) and the paused NextReg state exposed the hw-IM2 configuration. Fixed by wiring the golden im2 daisy chain end-to-end (`pkg/next/im2block.go`, VHDL_CONFORMANCE.md Axis 5, TestWireIM2*). Verified on the owner-image oracle (`FileSource`-streamed 29 GB card dd + Browser-driven launch): install completes (~100 vectored interrupts/frame), title menu (PLAY/CREDITS/SETTINGS), level select, and gameplay (HUD scoring, enemies) all run. En route the investigation also landed r50's 28 MHz every-read wait states + CTC wiring, the hw-probe hardware timing validation, and killed the OS-version, launch-path and card-image hypotheses one by one (each eliminated variable is logged in #169). The long-standing "FAT-geometry sensitivity" was RE-CHARACTERISED 2026-07-16 (work item #178) and retired: it was a LAUNCH-IDENTITY artifact, not a card property. The game runs when launched from the NextZXOS Browser as `<its original folder>/main.nex` (any depth; "TX-1696" as the folder name) — that combination loads fast on EVERY card tried, including our staged BuildFAT32 images. Break any part of the identity and it fails: renamed (`0.nex`, root `main.nex`) or re-foldered (`/0/main.nex`) Browser launches exit to the menu in ~2 s (the old browser zip flow's root `.nexload` failure, finally explained); a boot autoexec `.nexload` instead retries a NextZXOS personality/mode switch forever (per-attempt card re-init + /MACHINES//NEXTZXOS re-walks + a full ENNEXTZX.ROM stream — billions of instructions), on every card INCLUDING the owner's own image. FIXED IN THE BROWSER by r56 (#178): the .nex import now stages the zip's whole game folder under its original name and drives the Browser to launch `<folder>/<original name>` (`newBrowserLaunchMacro` + `sdcard.ListDir` computed cursor rows); verified headless (title + CTC heartbeat) and in the play app (story crawl + title). REGRESSED then re-fixed (#205, r87/r88): "doesn't start and no music". Music: the whole soundtrack streams through port $DF (SpecDrum mono, 3.35M writes/probe run — the game's ONLY DAC port), silent until r87's mono-port decode (#207). "Doesn't start": after the sprite-drawn story crawl the game switches NR$15 to L>U>S (with LoRes enabled) for the sprite-drawn title menu, ULA output still disabled ($68=$80) — composePixelResolved's ladder repainted the opaque disabled-fill over the sprites (ula_transparent must include the ula_en term, zxnext.vhd:7103), so the menu rendered pure black and there was nothing to start. Fixed in the mixer ladders + Mix ULAEn; pinned by TestULADisabledLUSShowsSprites. Probe tx1696_205_probe_test.go (ZX_GO_TX_PROBE=1) stages the real game folder + Browser launch headless; verified: crawl → title menu → PLAY starts gameplay. ROUND 2 (#205, r89): gameplay itself was GARBLED (banded playfield, debris tiles) at 28-45 fps with audio underruns. The garble was a live-render copper drop-out, masked headless because harness screenshots re-render (the stale pass runs the copper; the live pass had lost it): the game stops/re-uploads/restarts its per-band copper list EVERY frame mid-raster, and the #197 start-only debt parked the whole program — see the known-gaps copper stop→start row for the fix (playfield now renders correctly live). OPEN: the HUD band (LoRes-slot score strip) renders white/green post-fix; and gameplay costs ~17 ms exec + ~18.6 ms render per frame in wasm (28 fps, audio jitter) — a performance round is owed. |
| RAMS | Partial (browser) | Re-triaged 2026-07-15 (work item #175) — the old "architectural timing (Axis 10), do not chase" verdict is RETIRED. Post-r51 the BROWSER plays Donkey Kong, Galaxian and Pacman correctly; Frogger sticks on its self-test tile screen with looping audio. ZRCP tracing pinned Frogger's wedge to original arcade code spinning in its wait-for-start loop with its virtualized 8255 input bytes ($E000-$E007) static forever — RAMS's per-frame input pump never runs — which is a driver/heartbeat divergence, not cycle timing. One conformance fix kept en route: AY IO-port reads (regs 14/15) honour the direction bits, INPUT mode reads the pins as $FF pullups (ym2149.vhd:241-249). The HEADLESS harness wedges ALL RAMS games identically at wait-for-start (it lacks whatever drives the pump in the browser); characterizing that browser-vs-headless delta is part of #175. The earlier r47 "corrupt first screen" note predates r51's wide-frame geometry fix. |
| Atic Atac (Next) | Working (title→fire-skip→menu→select→doors→GAMEPLAY: Knight in the Entrance Hall with live monsters and a running game clock, engine healthy through frame 26000) | **2026-07-19 (#187, intro-story text band): the moon/castle intro screen's story-text crawl rendered black (reported against direct boot, but boot-mode-independent — a controlled A/B at the same game phase gave pixel-identical screens in both boot modes; the only NextReg diffs were non-video NR$06/$08/$11). Mechanism: a raster-waited mid-frame NR$70 palette-offset program (offset 7 outside the crawl band, stepped to 0 inside raster 128-253) selects per-band palette groups — group 7 blacks the Layer 2 text plane, 1-6 are the fade ramp; our renderer applied one per-frame offset. Fixed by folding the NR$70 offset into the Layer 2 raster-stamped per-line machinery (`stampPalOff`, `TestLayer2MidFramePaletteOffsetFold`); the crawl now renders with its band-edge fades in both boot modes, menu/doors/gameplay unaffected.** Previous: **2026-07-19 (#187): RESOLVED — the doors-era object-sort death (and the whole NMI-push corruption class behind every earlier wedge) was our stackless-NMI model. Atic Atac sets NR$C0 bit 3 (NEXTREG $C0,$09/$08); on the FPGA that makes NMI acceptance memory-silent — both push writes MREQ-suppressed (zxnext.vhd:1828/:2052; SP still -2; return PC captured in NR$C2/$C3) and the armed RETN's pops suppressed (zxnext.vhd:1850, one-shot z80_stackless_retn_en :2073-2083) — so the game's SP-cursor walks (object sorter $B064, $2674 walks, POP DE;DEC SP queues, menu raster walk) are NMI-safe by hardware design. Our core performed the real push/pop and only redirected RETN's PC; fixed in pkg/z80 CPU.NMI/RETN + StacklessRETNArmed (wired in WireInterruptControl), pinned by pkg/z80/stackless_nmi_test.go. See known-gaps.md for the full chain of evidence; hardware-verification harness: campaign11.py (doors-era $B064 anchor; NR$C2/$C3 shows NMIs landing mid-sorter harmlessly on silicon).** Previous state: **2026-07-18 late (#187): copper start-anchor + cycle-granular pacer landed; the game now survives its fire-skip, renders a live colour menu, accepts menu-select and enters the doors era with new music tracks.** The NR$62 stopped→running transition anchors the pacer list to its write instant (copper.vhd:70-83 enable edge; `SetStartPhaseSource`, `TestStartPhaseAnchor`) instead of the frame top, and NR$02 instants are 28 MHz-cycle-granular. The old "walk collides with the lattice" death class is now understood as the game's design: walks normally run inside the NMI handler (arbiter holds further NMIs to RETN — measured sinceNMI=7-8 refT on every healthy walk); the mainline's rare raster-slaved walks carry 1-instruction-wide hazard windows that the free-running lattice's precession (five phase classes drifting ~0.5 refT/5 frames) inevitably hits after ~100-350 frames of an IDLE menu — arithmetic that applies to real silicon equally (untested prediction: hardware's menu should die after ~10+ s idle). With a prompt menu-select the probe passes the old frame-5116/5126 death entirely, renders the doors-era room with animated sprites, and wedges ONE frame after the doors track starts — deterministically at any select timing — in a doors-era byte-queue pass consuming bytes scribbled by an earlier `POP DE; DEC SP` pop-boundary NMI push (track seed $B6B6, stream tick stops; the NMI/DAC engine stays alive behind the frozen doors screen through frame 26000). **2026-07-18 night (#187): the wedge is fully reconstructed — the doors handoff pass pops slot 0 of a static page-4 event-record block ($8870, 6-byte slots) that NOTHING ever posts a real record into (whole-run write forensics with MMU attribution; the transition's $88xx writes go to rotating stream-buffer pages, not the queue page); the leftover NMI-push scribble it reads instead either looks empty (doors engine state stays zeroed, tick dies) or dispatches garbage (seed $B6B6). The scribbling walks are silicon-identical and design-tolerated; the missing producer (likely a stream-script opcode in the select-transition's paced interpreter) is the remaining divergence. Two more FPGA conformance fixes landed en route — copper NR$02 assert pipeline +5 cycles (was +1) and the arbiter's mid-RETN NMI-gate reopen (pre-reopen pulses dropped like hardware) — both VHDL-cited and test-pinned; neither moves the wedge off doors-track+1.** See known-gaps.md for the full mechanism. **2026-07-18 late night (#187): the "missing record producer" premise is REFUTED — the $8870 scene-record table is legitimately empty at the doors handoff (consumer empty-path and OR-scan idle branch fall through; the doors loop's unconditional $D83F stream tick runs; both CMD18 music streams flow for ~9 frames). The real, select-timing-invariant death (always ≈doors+8; verified at four select frames) is in the doors era's object system: the per-frame bubble-sort of the 4-byte object-list entries at $F800 walks the list with SP as cursor, and a pacer-NMI acceptance push in its pre-swap window leaves the interrupted-PC bytes where the following EX (SP),HL reads them, corrupting entry 0's object pointer (captured: push of $B0AF → pointer $AFB0 → fake proc $EF10 in the DAC buffers → data-execution death). Exposure arithmetic says silicon sweeps the same fatal window within ~10 frames (identical 1361-cycle lattice and 1088-cycle/frame precession on the conformant 567,264-cycle frame), so either an unknown FPGA gate protects these windows, the real attract advances first via its door-record events, or hardware takes the same rare crashes — a DZRP doors-era $F800 capture on real hardware is the decisive next instrument.** Earlier same day (r64): the game's entire timeline ran ~400× slow — fixed.** Its ~20 kHz copper-paced divMMC NMI sample clock (the pacer list below) was delivered as ONE NMI per frame: the copper executes at RENDER time, after the frame's CPU, so a frame's ~416 MOVE NR$02,$04 pulses coalesced into a single PendingNMI edge. Every scene gated on a music position froze for minutes (the "doors" screen after character select waits for position word $F9E3 to cross a threshold before posting scene event $16 to $F996 — at 1 sample/frame that took 9,200 frames instead of ~0.5 s). Fixed by the copper NMI pacer (see next-fpga.md): render-side NR$02 filtered, a throwaway-clone frame simulation schedules the pulses, and the CPU's ExtNMIFunc poll delivers them at the hardware wrap rate (~416/frame, verified). Three hardware NMI gates landed with it (VHDL-cited, see next-fpga.md): NR$06 button-NMI enables, arbiter no-nesting (pulse dropped from assertion to RETN — without it the pulses nested at the handler's RETN and filled RAM with the return address), and the RETN-bounded in-flight envelope. NOW: title + 3-min tune play at real speed and self-advance, cinematic self-advances at track end, menus render and respond, doors music plays with events posting. REMAINING (mechanism captured + CPU audit closed, 2026-07-18): probe46 caught the death live — the game's SP-repointed descriptor walks (the $D107 stream-descriptor writer, the $D141-$D160 CMD18-arg reader) budget exactly ONE NMI push of slack, and when a walk drifts under the 170.125-refT copper-NMI lattice the pushed return address poisons a stream sector number (CMD18 arg $D11351B6 captured) and the $7Fxx stream interpreter drains garbage forever. Silicon survives because on FPGA-exact timing every walk lands in a collision-free lattice slot BY CONSTRUCTION (hardware-stall experiments kill it identically — no protective mechanism exists, only timing). The T80N 28 MHz cycle-cost conformance audit then closed every CPU-side discrepancy found (all VHDL-cited, pinned by pkg/z80/z80n_28mhz_conformance_test.go incl. the dumped handler-stub/walk sequences vs hand-computed FPGA totals): NMI acceptance is 12 cycles at 28 MHz not 11 (the discarded M1 fetch is a waited bus read); NEXTREG r,n — the stub's per-sample ack — and NEXTREG r,A cost +2 (their trailing microcode cycles are dummy bus reads, t80n_mcode.vhd X"91"/X"92"); Z80N PUSH nn +1; external-NMI instants are now sampled at the instruction's END (FPGA samples NMI_s at the final T_Res — delivery was one instruction late); HALT wakes quantize onto the halt-NOP T_Res grid (4T, 5T at 28 MHz). Both audit follow-ups then landed (2026-07-18 evening): the bank-7 BRAM no-wait quirk (8K page 14 reads pay no 28 MHz wait — dedicated dpram2 CPU port, zxnext.vhd:6670-6686; pkg/memory Read28NoWait + pkg/z80 readMem/halt-grid exemption, conformance-pinned; hot in the NextZXOS DOS era, not in the game's own slots) and a deterministic two-state SD Nac model replacing the pseudo-random 4..64 pad (sequential read-ahead continuation 2 byte-times, random-access 8; pkg/next/sdcard/spi.go, TestCard_NacModel_Deterministic). The fire-skip STILL dies, and a Nac grid (2/4/8/16) dies at every value — SD latency is a phase lottery, not the lever. The frame-5126 death ring now shows the sharpest mechanism yet: the skip window itself is clean (every NMI lands with SP on the $F9xx mainline stack; the track chain fires at frame 5023 exactly as silicon showed), then during the menu bulk load the mainline exits its sample-poll wait loop ($1C12 IN A,(C)/CP (HL)/JR NZ on a per-NMI-period observable), runs a fixed ~40-instruction path to LD SP,HL at $26A4 (SP→$26DD parameter block), and the NMI is accepted ONE instruction later at the very end of the 170.125-refT period — the push corrupts $26DB/$26DC and the next track_start reads zeroed garbage (screen freezes over a half-drawn colour menu, further than any previous corpse). Residual skew to hunt: the phase of that polled observable (divMMC-handler-era shared state) vs the lattice, magnitude ≈ the walk length (~15-20 refT per period). ZX_GO_SD_FAST_NAC=1, ZX_GO_SD_NAC_RANDOM=<n> and ZX_GO_NO_COPPER_NMI_PACER=1 remain as bisection switches. Diagnostic harness: cmd/zx_go/aticatac_probe_test.go (ZX_GO_ATIC_PROBE=1). Previous history: Premise corrected 2026-07-15: the 111 MB `ATICATAC.NEX` IS a valid `NextV1.2` file (3 banks of code + ~111.6 MB appended data the game streams at runtime) — it had simply never fit the 64 MB card, so "invalid" was a misread. Triaged on a 256 MB `BuildFAT32` card (r52 + the port $37 fix below): loads and renders its full Layer 2 title screen, then hangs there ignoring all input. The title's exit is gated on its streamed intro music finishing (track table at $DCA2; exit when the current track's flag byte has bit 6, queued by the track-end handler), and the music never starts: the game's own raw-SPI sector streamer ($D140-$D1FF, direct CMD18/CMD12 via port $EB) reads an audio index from the card and then streams data sectors that are EMPTY on our staged card ($48BF/$49E8 all-zero) — its sector math bakes in assumptions about the file's on-card placement/contiguity that our staging doesn't satisfy. In the browser (zip staging, where the .nex lands as `/zx.nex`) it fails earlier with an on-screen FILE ERROR — consistent with the game F_OPENing its own filename, which the zip-staging rename breaks. Verdict: a card-layout/staging sensitivity in the game, not a core emulation bug — same family as the #164 staging artifacts. Real fix needs staging that preserves the release layout (own folder, own filename, contiguity). One genuine conformance gap found and FIXED en route (r53): Next joystick ports $1F/$37 are decoded on the low address byte alone and always answer — an unrouted port reads $00, never floating-bus $FF (zxnext.vhd:2546-2547, :2829-2830, NR$05 routing :3472-3494; `pkg/ula` nextJoyPortByte, pinned by `joyports_next_test.go`); the game ORs IN($1F) with IN($37) every frame and the floating $FF read as every button held. Backlogged as work item #167. The capacity blocker fell with r55 (the shipped browser card is now 512 MB, sparse-mounted — the 111 MB payload FITS), and r56's Browser-launch import stages own folder + own filename — retested 2026-07-16 in the play app: the FILE ERROR is gone, the .nex loads and RUNS, and its streamer now stops one probe later with an on-screen "SDHC OR BETTER REQUIRED". RESOLVED 2026-07-16 (#167), two fixes: (1) the wasm SD mount now advertises SDHC like the desktop mounts (`wasm_js.go` SetSDHC; a 512 MB CSD v2 card is accepted — the game checks the OCR CCS class, not capacity), clearing the refusal. (2) The title then hung because its sample playback never ran — and the OLD placement/contiguity verdict was a misread (staging is contiguous and byte-correct; re-verified by FAT-chain walk). The real mechanism: the game plays streamed audio on divMMC NMIs paced by a free-running COPPER loop (1024-entry mode-01 list, last entry MOVE NR$02,$04 = one divMMC NMI per wrap, ~20 kHz; per-sample NMI handler stubs cycle through divMMC banks via port $E3, whose bit-1 ping-pong the consumers edge-detect). Our functional copper `Step` engine STOPPED the copper when the list ran off the end instead of wrapping the FPGA's 10-bit address counter (copper.vhd `copper_list_addr_s + 1`), so the pump died after one pass and the tune-end flag ($F994 bit 6) never set. Fixed in `pkg/next/copper` Step: address wraps in every running mode, budget is 1792 copper cycles/line at MOVE=2/NOOP=1 costs (was 64 instructions), HALT parks instead of latching stopped. Verified headless (per-frame render) and in the play app: title (Layer 2) → ~3 min streamed intro tune → castle intro cinematic → door/menu screens, SD streaming resuming in step with playback. |

### Next failure classes and the ranked gap list (re-baselined 2026-07-14 against r47, work item #164)

The failures cluster into classes; ranked by how many titles each
blocks (the conformance prioritizer — see work items #159/#164):

1. **CLOSED (work item #171, 2026-07-15): Next wide-layer geometry —
   one 320×256 frame coordinate system.** Found by a manual game-test
   pass: border-area corruption and a consistent vertical offset
   between sprites and background layers (Tyvarian's torn title +
   sprite/backdrop drift, Crowley World Tour's displaced text and
   falling shapes, and any title drawing tilemap or wide Layer 2
   content). In the FPGA, sprites, the tilemap and Layer 2's
   320×256/640×256 modes all consume the SAME whc/wvc wide counters
   (zxnext.vhd:4208/4337/4389) — one 320×256 frame, paper at (32,32).
   Our render used a 320×240 canvas with THREE vertical conventions:
   sprites correct, tilemap 32 px low in the paper area (frame offset
   applied horizontally but not vertically) and torn 24 px against
   itself at the paper/border seam, wide Layer 2 8 px low with its
   bottom 16 rows cropped, over-border sprites dropped in hi-res L2
   mode, and L2 painted over sprites regardless of NR$15. Fixed by
   making the compositor-wired ULA render the full 320×256 frame
   (`SetNextCompositor` switches the geometry; image row = frame row)
   with every layer routed through frame coordinates, plus a sprite
   repaint above wide L2 in the S-above-L modes. 320×256 doubles to
   exactly the browser's 640×512 box. Pinned by
   `TestNextWideFrameLayerAnchoring`; NextZXOS Browser (full-frame
   tilemap) and Celeste (full-frame starfield) verified by headless
   screenshot. Tyvarian/Crowley gameplay alignment re-verified in the
   browser 2026-07-15 (r53 bundle) — both correct; see their rows.
2. **CLOSED (work items #166/#169, 2026-07-16, r54): TX-1696's
   install — FOUR real gaps fixed across three sessions, the last one
   measured on real silicon.** Final fix (r54): the hardware-IM2
   vectored interrupt mode (NR$C0 bit 0) wired end-to-end — the
   game's install is caught by the CTC ch0 interrupt with a
   hardware-generated vector, not the frame INT the earlier geometry
   analysis chased (see the TX-1696 row for the full mechanism and
   the silicon measurements). The path there:
   the #166 story (r49): `ULA.BeamPosition` divided raw CPU
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
   line interrupt-vs-slide geometry shortfall — since hardware-
   probed (2026-07-15): the real Next matches our instruction
   timing and INT raster exactly, so timing is exonerated on both
   sides; see its row for the open launch-path hypothesis.
3. **CLOSED (work item #165, 2026-07-14): runtime data-load failures
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
4. **CLOSED (work item #163, 2026-07-14): RETI mistreated as RETN
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
5. **NR $B0/$B1/$B2 extended-keys / MD-pad registers — CLOSED
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
6. **RAMS input pump (work item #175) — 1 title, re-classed
   2026-07-15.** The old "architectural timing (Axis 10), do not
   chase" verdict is retired: post-r51 the browser plays RAMS
   Donkey Kong/Galaxian/Pacman, and Frogger's wedge traced to its
   per-frame input pump never running (static $E000-$E007
   virtualized 8255 bytes), not cycle timing. See the RAMS row and
   #175 for the established state and next steps.

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
FAT16). The card budget stopped being 64 MB at r55: the shipped
browser image is now 512 MB / 4 KB clusters, mounted SPARSELY in the
wasm (~5 MB resident for the distro; a staged game costs its real
bytes), so 100 MB-class payloads (Atic Atac's 111 MB .nex) fit. The
old 64 MB/512 B-cluster image remains as `tbblue-64mb-backup.mmc` and for
the ZEsarUX oracle. For custom sizes,
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
