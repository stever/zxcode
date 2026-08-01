# DeZog, ZEsarUX and CSpect

If you already develop Spectrum Next software, you probably debug through
[DeZog](https://github.com/maziac/DeZog) in VS Code, backed by CSpect or
ZEsarUX. This page answers the question that follows directly from that:
**can I point DeZog at zxplay_go?**

## The short answer

**No.** DeZog cannot attach to zxplay_go.

zxplay_go's remote debugger is a **custom line-oriented telnet protocol**. It
is not DZRP (what DeZog speaks to CSpect and to real hardware), and it is not
ZEsarUX's ZRCP (what DeZog speaks to ZEsarUX). It is described in the
codebase as "ZRCP-style" and it is, in spirit — plain text over TCP, one
command per line, the same kind of vocabulary, and the same conventional port
10000 — but the command set and the response format are its own. DeZog's
ZEsarUX driver expects specific commands and specific reply shapes, and will
not get them.

There is no DZRP server and no ZRCP-compatibility mode in the emulator, and
neither is currently on the roadmap. If you want one,
[say so on the issue tracker](https://github.com/stever/zxcode/issues) — it
is a bounded piece of work and interest is the thing that would schedule it.

## So what does zxplay_go give you instead?

A protocol you can drive from a shell in three lines, and a debugger that is
unusually strong at the specific questions Next development throws up:

- **Bank-aware breakpoints.** On the Next the same address is different code
  under different paging. A breakpoint defaults to the ROM bank that is
  mapped when you set it, `bank=N` pins it, `any-bank` makes it polymorphic,
  and a bank-less one is flagged `[any bank!]` in listings so the footgun is
  visible.
- **Provenance.** `provenance $ADDR` names the instruction that last wrote a
  byte, and `why-pc` explains how the CPU arrived at the current PC by
  pairing the popped return word with its last writer. This is the
  data-lineage axis that stepping cannot give you.
- **Reads as well as writes.** `watch-read` halts when the guest *reads* a
  range — which is how you catch a loader rejecting your data file, entirely
  invisible to a write watch.
- **Full-state time travel on the Next.** A rewind restores the whole 2 MB
  pool, the MMU slots, divMMC RAM, the NextReg file and the paging ports, so
  re-execution after rewinding actually matches.
- **Unpaged bank access.** `bank-peek` and `disasm-bank` read any physical
  bank regardless of what the CPU has mapped.
- **Headless everything.** Every one of the above works in a windowless run
  in CI.

[Automating the emulator](automation.html) shows these in use; the
[debugger reference](debugger.html) documents all of them.

## Where DeZog *does* fit in this project

Two places, both real:

**Against actual hardware.** `hwdebug/dzrp.py` is a standalone DZRP client
that debugs a **real Spectrum Next** over a serial cable to the Joy 2 port,
using [dezogif](https://github.com/maziac/dezogif) — the DeZog stub that
replaces the Multiface ROM on the card. It loads `.nex` files over the wire,
sets breakpoints, waits for hits, and reads registers, memory, ports and
NextRegs, with no VS Code involved. See
[debugging real hardware](hardware-debug.html) for the wiring, the arming
procedure and the protocol details — several of which contradict a plain
reading of the DZRP spec and were established the hard way.

**In VS Code against that same hardware.** DeZog itself works normally with
dezogif over serial; the repository carries a worked example of a real
investigation driven that way (`_tools/dezog-tx1696/`), with its
`launch.json`, its probe addresses, and the emulator-side baseline it was
compared against.

That combination is the point. When a game behaves differently here than on
silicon, you run the same probes on both sides — zxplay_go's telnet debugger
on one, DZRP on the other — and diff the answers. That comparison is what
resolves conformance questions the VHDL alone cannot settle.

## Choosing between emulators

Neither honesty nor loyalty is served by pretending zxplay_go is the right
tool for everything. The
[full comparison](comparison.html) has the criterion-by-criterion table with
sources; the summary for a game developer choosing a debugger:

| If you want… | Use |
| --- | --- |
| DeZog in VS Code, source-level stepping against your assembler's listings | **CSpect** or **ZEsarUX** — both are first-class DeZog targets. |
| The deepest interactive debugger and reverse execution | **ZEsarUX** — its time machine is the most complete reverse-debugging implementation available. |
| Speed and the de-facto Next development ecosystem | **CSpect** — the plugin SDK and team-insider provenance are real advantages. |
| Scriptable headless runs, provenance tracing, bank-aware conditional breakpoints, an open Go codebase, and conformance measured against the FPGA VHDL | **zxplay_go**. |

Using more than one is normal and sensible. A useful pattern: develop with
whatever gives you the best edit-compile-debug loop, and bring zxplay_go in
when you need a scripted regression check, a CI run, or an answer to "is my
game wrong, or is the emulator wrong?" — a question it is unusually well
equipped to answer, because the emulator's own conformance against the Next's
FPGA source is [published and measured](conformance.html).

## In the browser IDE

[code.zxplay.org](https://code.zxplay.org) exposes the *same command
dispatch* in a console beside the editor, with source-line breakpoints
mapped from each compiler's output. If your project is small enough to live
in the IDE, that is the fastest path to a debugger with no local setup at
all — see [Debugging in the browser](ide-debugging.html).
