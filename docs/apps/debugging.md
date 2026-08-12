# Debugging in the browser

The IDE's **Debug** button opens a real debugger against the real emulation
core — the same engine, the same command dispatch and the same breakpoint
machinery that the desktop build exposes over telnet. Nothing here is a
simplified browser imitation.

## What you get

A dock beside the editor with transport controls (pause, step, step over,
continue) and panels for:

- **Registers** — the full Z80 set, updating live.
- **Disassembly** — around the current PC, with a marker column you click to
  toggle breakpoints.
- **Memory** — a hex view of memory as the CPU currently sees it.
- **Paging** — which banks are where, which matters constantly on the Next.
- **Watches** — active register watches.
- **History** — the recent instruction ring, once you arm it.
- **Next State** — the decoded NextReg dashboard, on Next projects.
- **Console** — the command line, which is where the real power is.

The console is English-only: the commands, their arguments and the engine's
replies are all engine-level, and they are identical to the desktop
debugger's. Type `help` for the built-in reference.

## Source-line breakpoints

Click the gutter next to a line in your source and the IDE arms a breakpoint
for it. When execution reaches that line, the machine halts and the line is
highlighted in your editor.

This works in all ten languages, but it works by three genuinely different
mechanisms, and the difference shows up in what "reaching a line" means.

### Address maps — the compiled languages

**sjasmplus**, **Pasta80 Pascal**, **z88dk C**, **SDCC**, **zmac** and
**Pasmo** all end up at the same place: a map from source lines to machine
addresses, armed as plain address breakpoints. The machine pauses *before*
the line's code runs.

Where the map comes from varies:

- **sjasmplus** emits an SLD file — a purpose-built line/address map. This is
  the most exact of the lot.
- **Pasta80** and **z88dk** produce compiler listings that the services parse
  into a map. Pasta80's covers assembly files linked in with `{$l}` as well,
  so you can break inside those. z88dk's covers project headers you
  `#include` — C code in a `.h` file is as breakable as the main source —
  and the individual instructions of inline `__asm`/`#asm` blocks, in the
  main source or a header. (The `__asm` opener line itself carries no code;
  a breakpoint there snaps to the block's first instruction. A header
  inlined at several call sites maps its lines to the first one.) The map
  also carries the program's function and asm-label symbols, so the
  debugger's disassembly and backtrace read annotated.
- **SDCC** and **zmac** compile in a browser worker whose build result
  already carries per-file listings — no service involved.
- **Pasmo** has no listing output at all. After your real compile, the IDE
  runs a *second*, best-effort build with a zero-byte label injected before
  each instruction line, and reads the addresses back from the assembler's
  own echo. The map is thrown away unless that debug build produces a tape
  byte-identical to the real one — so a map you get is a map you can trust,
  and sometimes you get none.

One caveat carried over from the toolchain rather than the IDE: z88dk's
classic-library (`sccz80`) builds can attribute a call to a neighbouring
line, so breakpoints there have ±1 line of fuzz. The `sdcc_iy` builds
attribute exactly.

### The interpreted BASICs

**Sinclair/NextBASIC**, **zmakebas** and **bas2tap** produce a tokenised
program that the ROM interpreter runs — there is no address for a line to
have. So the engine watches the interpreter itself: a hook on the `PPC`
system variable (`$5C45`, bank 5 — the same on every classic machine *and*
the Next) fires when the interpreter enters an armed line, edge-triggered so
a loop does not re-trigger on the same entry.

Two consequences worth knowing. The paused line is resolved from `PPC`, not
from the Z80 program counter — so it is the BASIC line you are on, which is
what you wanted. And because nothing depends on ROM code addresses, this
works identically across machines.

### Boriel ZX BASIC

Boriel compiles to machine code, so it could use an address map — but it
gets something better suited. The program is compiled with `--enable-break`,
which emits one runtime check per source line with the line number in `HL`.
The engine anchors on that check's address and halts on armed line numbers.

The important detail: that check runs at the **end** of a line's statements.
A hit means "line N *just executed*", not "line N is about to execute". Every
other language is the other way round.

## The command console

Anything the panels do, the console can do, plus a good deal they cannot.
The commands below are the browser-relevant subset; the desktop
[debugger reference](debugger.html) documents the full surface, and the same
commands work there.

**Running** — `continue`, `pause`, `step`, `step-over`,
`cont-until EXPR` (e.g. `cont-until a=$41`).

**Breakpoints** — `set-breakpoint $ADDR` with optional `bank=N` /
`any-bank`, an `if EXPR` guard, and `do "cmd; cmd"` actions on hit;
`clear-breakpoint $ADDR`; `list-breakpoints`.

**Watches and tracepoints** — `watch-reg REG [from V] [to V]`,
`watch-mem ram BANK FROM TO`, `watch-read ram BANK FROM TO`,
`watch-port PORT [=VAL]`, and `tp $ADDR` for a tracepoint that logs
registers *without* halting. Set these while paused: arming one from a
running machine halts it.

**Inspecting and poking** — `get-registers`, `set-reg NAME VAL`,
`backtrace [N]`, `disassemble [$ADDR] [N]`, `hexdump $ADDR LEN`,
`read-memory` / `write-memory`, and `sym $ADDR NAME` to name an address.
Labels from your compile load automatically, so a backtrace names your
routines rather than showing bare hex.

**Instruction history** — off by default because it costs a little per
instruction. `history-on 4096` arms the ring (the History panel's button
sends exactly that), `prev N` dumps the last N instructions with registers,
`history-off` disarms.

**Spectrum Next** — `nr-panel` for the decoded NextReg summary,
`get-mmu` / `get-divmmc` / `list-banks` for paging,
`bank-peek KIND BANK OFF [LEN]` to read a bank the CPU has *not* paged in,
`nextreg-read` / `nextreg-write`, and `sprite-list`, `palette-dump`,
`layer-state`, `copper-disasm` for video state.

## A note about banks

On the Spectrum Next, an address alone does not identify code — the same
address is different code under different paging. A breakpoint set without a
bank filter defaults to whatever ROM bank is mapped at the time, and
`list-breakpoints` flags a bank-less breakpoint as `[any bank!]` precisely
because it is a trap for the unwary. If a breakpoint fires somewhere
nonsensical, the bank is the first thing to check.

## When to move to the desktop

The browser debugger is for interactive work. What it cannot do is run
without you: headless regression runs, scripted breakpoint sequences,
provenance tracing from boot, time-travel rewinds, trace databases. Those
live in the desktop build — and because the command language is the same,
moving over costs you nothing you have already learnt.

See [Automating the emulator](automation.html).
