# Automating the emulator

zxplay_go is designed to be driven by something other than a person. If you
are building a Spectrum or Spectrum Next game, you can run it headlessly on
every commit, capture what the screen actually showed, break on the exact
instruction that corrupted a table, and walk a bad value back to whoever
wrote it — all from a shell script.

This page is the game developer's tour of that surface. The exhaustive
reference for every debugger command is the
[debugger reference](debugger.html); every flag is in
`zxplay_go --help`.

> **Before you start**, read [DeZog, ZEsarUX and CSpect](debug-protocols.html)
> if you already have a debugging setup. zxplay_go does **not** speak DZRP or
> ZRCP and DeZog cannot attach to it — its automation story is the headless
> CLI and its own telnet protocol, not a VS Code integration.

## Getting a binary

Grab a [release build](https://github.com/stever/zxcode/releases) for your
platform, or build it:

```bash
git clone https://github.com/stever/zxcode
cd zxcode/packages/emulator-core/zxplay_go
go build -o bin/zxplay_go ./cmd/zxplay_go
```

Building needs Go 1.25+ and a C toolchain, because the GUI layer uses cgo.
The classic ROMs are embedded in the binary. The Next needs licensed
NextZXOS ROMs plus SD-card content, which the emulator offers to install for
you on first use — see [The Spectrum Next](next.html).

## The shape of a headless run

`--headless` runs the machine with no window. It is the base of everything
else on this page.

```bash
# Run a program for 2500 frames and save what the screen showed.
zxplay_go --headless --frames=2500 --save-screen=/tmp/run.png game.nex
```

A positional file picks its own machine from its extension: `.tap`/`.tzx`
mount and auto-type `LOAD ""`, `.nex` boots the Next, `.trd` boots the
Pentagon, and snapshots restore the model they were saved from. An explicit
model flag wins over the extension (`--pentagon game.tap`).

The flags you will reach for most:

| Flag | What it does |
| --- | --- |
| `--headless` | No GUI. Combine with `--frames` to bound the run. |
| `--frames=N` | Exit after N emulated frames (50 frames ≈ 1 second). `0` runs forever. |
| `--save-screen=PATH` | Write the final rendered screen as a PNG before exiting. |
| `--dump-state=N` | Run N frames, print a full CPU / sysvar / NextReg / paging snapshot, exit. |
| `--snapshot-every=N` | Print that snapshot every N frames instead of once. |
| `--snapshot-prefix=P --snapshot-screens` | Save a PNG at every snapshot — a filmstrip of the run. |
| `--press-key=SPEC` | Drive the keyboard on a schedule (below). |
| `--no-sound` | Skip audio device setup entirely. Use it in CI. |
| `--symbol-map=PATH` | Load `$XXXX NAME` lines so every dump names your routines. |

### Driving the keyboard

`--press-key` takes a comma-separated schedule of `KEY@FRAME` entries. Each
press is held for 30 frames (~0.6 s) — long enough for a debounced scan loop
to see it, short enough not to auto-repeat.

```bash
# Boot the Next, wait for the menu, pick an item, then screenshot.
zxplay_go --headless --next --press-key='enter@600,3@900' \
          --frames=1500 --save-screen=/tmp/menu.png
```

Key names are lowercase: the letters `a`–`z`, the digits `0`–`9`, `enter`,
`space`, `caps`, `sym`. Combine keys at the same frame with `+` to make a
chord — `caps+space@100` is BREAK, `sym+p@120` is a quote character. The
built-in Kempston joystick is `kleft`, `kright`, `kup`, `kdown` and `kfire`,
which is usually what you want for driving a game rather than a menu.

### Making a run mean pass or fail

The headless binary is an **instrument, not an assertion engine**: it exits
`0` for a normal run, and also exits `0` when a break-on-write fires and
dumps state. Setup failures (a missing image, an unconstructable machine)
exit non-zero. So a CI check needs to decide for itself, in one of three
ways:

1. **Grep the diagnostics.** Everything the run observes is logged as
   structured lines on stderr. `--watch-writes 'LIVES@$8C40=0'` breaks and
   dumps the moment the guest writes 0 to that address; a script that greps
   for the dump has a pass/fail signal.
2. **Drive it over telnet** and let the script decide (next section). This is
   the most precise option: your script sets breakpoints, resumes, reads
   memory, compares, and exits with its own status.
3. **Write Go tests against the harness** (below). This is the only option
   where the emulator gives you a real test verdict.

## Scripted debugging over telnet

`--debugger-port=N` opens a line-oriented debug server on `localhost:N`. It
is plain text, one command per line, one response per line, and every
response starts with `OK ` or `ERR ` — so it parses with three lines of any
scripting language.

```bash
zxplay_go --next --headless --debugger-port=10000 --debugger-pause-at-start game.nex
```

`--debugger-pause-at-start` halts before the first instruction so you can
arm breakpoints against a machine that has not run yet. Then, from anywhere:

```bash
nc localhost 10000
```

A worked example — stop when the game writes a bad value into its object
table, and find out who wrote it:

```
provenance on
watch-mem ram 5 $1800 $18FF
continue
```

When it halts, ask the questions:

```
get-registers
backtrace 12
provenance $D807
disassemble
```

`backtrace` classifies each stack word as a real return address or a
speculative one and disassembles the target, so you get the call ancestry
rather than a column of hex. `provenance` names the instruction that last
wrote a byte — the single most useful command for "where did this garbage
come from", and the reason the tracer exists.

Same idea as a non-interactive script:

```bash
#!/usr/bin/env bash
# Fail the build if the title screen doesn't reach the game loop.
zxplay_go --headless --next --debugger-port=10000 --debugger-pause-at-start \
          --symbol-map=game.sym game.nex &
emu=$!
sleep 1
exec 3<>/dev/tcp/localhost/10000
read -r _ <&3                       # the welcome banner

send() { printf '%s\r\n' "$1" >&3; read -r reply <&3; echo "$reply"; }

send 'set-breakpoint $8100 any-bank'   # game_loop
send 'set-pause-timeout 30'
send 'continue'
result=$(send 'get-registers')
send 'quit'
kill $emu

case "$result" in
  *PC=\$8100*) echo "reached the game loop"; exit 0 ;;
  *)           echo "never reached the game loop: $result"; exit 1 ;;
esac
```

Note `set-pause-timeout`: state-reading commands wait a bounded time for the
emulator loop to acknowledge a pause, and the 2-second default is too short
when the breakpoint is deep in a boot.

### The commands worth knowing

The full reference is in the [debugger reference](debugger.html). For game
work, these carry most of the weight:

| Command | Use |
| --- | --- |
| `set-breakpoint $ADDR [bank=N\|any-bank] [if EXPR] [do "CMD; CMD"]` | Conditional, bank-aware breakpoints. On the Next, **always think about the bank** — the same address is different code under different paging, and a bank-less breakpoint is flagged `[any bank!]` for exactly that reason. |
| `cont-until EXPR` | One-shot conditional resume: `cont-until a=$41`. |
| `watch-mem ram BANK FROM TO` / `watch-read ...` | Halt on a write (or a read) into a bank range. The read watch is what catches a parser rejecting your data file. |
| `watch-reg REG [from V] [to V]` | Halt on a register transition — `watch-reg iff1 to 1` answers "when do interrupts come on?". |
| `watch-port PORT [=VAL]` | Halt on an `OUT`. |
| `tp $ADDR` | Tracepoint: log registers at an address **without** halting. Ideal for counting how often a routine runs. |
| `provenance $ADDR` / `why-pc` | Data lineage: who wrote this byte, and how did the CPU get to this PC. |
| `backtrace [N]` | Classified stack walk with disassembly at each return target. |
| `bank-peek KIND BANK OFF [LEN]` | Read a bank the CPU does **not** currently have paged in. |
| `hot [N]` / `callgraph [N]` | Profile: hottest PCs, and the most frequent caller→callee edges. Needs `--debugger-history=N`. |
| `tt-on` / `tt-rewind INSN` | Time travel. On the Next this captures the full 2 MB pool, MMU slots, divMMC RAM and NextRegs, so re-execution after a rewind is faithful. |

### Symbols

Every dump, disassembly and history line is annotated when you load a symbol
map — a plain text file of `$XXXX NAME` lines:

```
$8100 game_loop
$8240 draw_sprites
$8C40 player_lives
```

Pass it as `--symbol-map=game.sym`, or add names live with
`sym $8100 game_loop`, or reload after regenerating with
`reload-syms game.sym`. Most assemblers can emit a label list you can
reshape into this format with a few lines of `awk`.

## Diagnostics for when the game misbehaves

These are the instruments that exist because they were needed to chase real
bugs. Each is a flag you add to a headless run.

**"It crashed and I don't know where."**

```bash
zxplay_go --headless --crash-detect --loop-threshold=5000 --frames=6000 game.nex
```

`--crash-detect` arms conservative heuristics — a PC walking through a NOP
slide, a stack that underran, a `HALT` with interrupts disabled (in practice
a deadlock) — and each fires a state snapshot. `--loop-threshold=N` catches
the softer failure: the same PC fetched N times in a row with nothing
changing. Add `--crash-pc-region='SCREEN@$4000-$5AFF'` to make executing
screen memory a fatal event.

**"Something is overwriting my data."**

```bash
zxplay_go --headless --watch-writes 'SCORE@$8C40,STATE@$8C42=$FF' \
          --provenance --dump-mem '$8C40:32' --frames=8000 game.nex
```

Every write to a watched address logs with its source PC. Adding `=VAL`
upgrades it to break-on-write: the run dumps full state and stops. Add
`--provenance` from boot and any dump can name the last writer of any byte.

**"Is this garbage a computed value, or uninitialised RAM?"**

`--detect-uninit` logs any guest read of a RAM byte never written since
power-on, with the reading PC. It is reference-free — it needs no known-good
run to compare against. Narrow it with `--detect-uninit-pc=$8000-$8FFF`.

**"Where does the time go?"**

Run with `--debugger-history=65536` and ask `hot`, `callgraph` and `retgraph`
over the telnet port, or record M1 fetches to a SQLite file with
`--trace-db=/tmp/trace.db` and query it with the `sqlite3` CLI.

**"How did the PC get here?"**

`--why-pc-at='$0000'` arms provenance and emits a trace the first time PC
enters that address — capturing the stack at the instant a bad jump lands,
before a self-loop trap obscures it.

## Go tests against the harness

`pkg/testharness` is the emulator as a library: construct a machine, run
frames, press keys, read memory, read the screen **as text**, and assert.
This is how the emulator tests itself (40+ integration tests), and it is the
only route that gives a genuine pass/fail verdict rather than output to
grep.

```go
func TestTitleScreenAppears(t *testing.T) {
    h, err := testharness.New(roms.ModelSpectrum48)
    if err != nil {
        t.Fatal(err)
    }
    defer h.CloseFiles()

    if err := h.LoadSnapshot("testdata/game.sna"); err != nil {
        t.Fatal(err)
    }
    if _, err := h.RunUntilText("PRESS FIRE", 500); err != nil {
        t.Fatalf("title screen never appeared: %v\n%s", err, h.ScreenText())
    }

    h.TapKey(fyne.KeySpace)
    h.RunFrames(120)

    if got := h.Memory(0x8C40); got != 3 {
        t.Errorf("lives = %d, want 3", got)
    }
    if err := h.SaveScreenshot("/tmp/after-start.png"); err != nil {
        t.Fatal(err)
    }
}
```

`ScreenText()` decodes the character cells against the ROM font, so
assertions read like the screen does. Cells that are not printable ROM
characters — your graphics, UDGs — come back as spaces; for those use
`ScreenImage()` and compare pixels. On the Next there is `MountSDCard(dir)`
and `LoadNEX(path)`.

One practical wrinkle: the module declares itself as
`github.com/stever/zxplay_go` while the source lives inside the zxcode
monorepo, so point Go at a local checkout rather than expecting it to
resolve:

```
require github.com/stever/zxplay_go v0.0.0
replace github.com/stever/zxplay_go => ../zxcode/packages/emulator-core/zxplay_go
```

## Spectrum Next specifics

The Next needs its licensed ROMs and SD content installed before any
headless run — see [The Spectrum Next](next.html). Once installed:

```bash
# Cold-boot NextZXOS and capture the menu.
zxplay_go --next --headless --frames=3000 --save-screen=/tmp/boot.png

# Point at a specific card image (also what the test suite uses).
ZX_GO_NEXT_SD_IMG=/path/to/tbblue.mmc zxplay_go --next --headless --frames=3000
```

Two things to know about Next automation:

- **Headless boots skip the NextZXOS welcome screen** that the browser build
  shows. Frame counts from a headless run do not transfer to the browser.
- **An `autoexec.bas` with an autostart line does run from a cold headless
  boot** — `10 .nexload /zx.nex` launches a game with no keypresses at all,
  which is by far the most reliable way to get a `.nex` running under
  automation.

`--sd-writeback` persists guest writes back to the card image at exit
(keeping the previous file as `.bak`); without it, writes live in RAM only,
which is what you want for a repeatable test.

## When the emulator itself is the suspect

If your game works on real hardware and not here, the difference is worth
finding — for you and for the emulator. The tools for that comparison are
real: `--next-nrdiff`, `--next-memdiff`, `--next-lockstep` and
`--next-bisect` diff our boot against a live reference emulator and report
the first divergence, and
[debugging real hardware](hardware-debug.html) drives an actual Spectrum
Next over a serial cable so you can run the same probes on silicon.

Check [known gaps](known-gaps.html) and
[game compatibility](compatibility.html) first, then
[open an issue](https://github.com/stever/zxcode/issues) with what you
measured. A concrete emulator-versus-hardware comparison is the most useful
bug report this project can receive.
