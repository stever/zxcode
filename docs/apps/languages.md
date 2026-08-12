# Languages and toolchains

[code.zxplay.org](https://code.zxplay.org) ships ten toolchains. You pick one
when you create a project, at `/new/<language>`, and it fixes the language
for that project — but **not** the target machine: every project can switch
between 48K, 128K and Spectrum Next freely.

Some toolchains run entirely in your browser (WebAssembly or a web worker),
so compiling costs nothing but your own CPU and works with no round trip.
The rest run as services on the server. You do not have to care which,
except that the in-browser ones keep working if the network hiccups.

## The ten

| Language | Project | Main file | Compiles | Extra files |
| --- | --- | --- | --- | :---: |
| **Pasmo** — Z80 assembly | `/new/asm` | `program.asm` | In browser (wasm) | ✓ |
| **sjasmplus** — Z80/Z80N assembly | `/new/sjasmplus` | `program.asm` | Server | ✓ |
| **zmac** — Z80 assembly | `/new/zmac` | `program.asm` | In browser (worker) | ✓ |
| **z88dk C** | `/new/c` | `program.c` | Server | ✓ |
| **SDCC** — C | `/new/sdcc` | `program.c` | In browser (worker) | ✓ |
| **Pasta80 Pascal** | `/new/pascal` | `program.pas` | Server | ✓ |
| **Boriel ZX BASIC** — compiled | `/new/zxbasic` | `program.bas` | Server | ✓ |
| **Sinclair / NextBASIC** — interpreted | `/new/nextbas` | `program.bas` | In browser (txt2bas) | ✓ |
| **zmakebas** — Sinclair BASIC | `/new/basic` | `program.bas` | In browser | — |
| **bas2tap** — Sinclair BASIC | `/new/bas2tap` | `program.bas` | In browser | — |

The main source file always has a fixed name — that is also the name the
compilers' own diagnostics use, so an error message points at something you
can see in the editor.

## Assembly

**Pasmo** is the original in-browser assembler and the lightest way in: no
service call, `INCLUDE` and `INCBIN` resolve against your project's files at
their real `folder/name` paths, and diagnostics carry each file's own name
and line numbers.

**sjasmplus** is the assembler most Spectrum Next projects actually use, with
full Z80N support. It is the best-supported language in the IDE's debugger
because it emits an SLD file — a proper line→address map — so breakpoints
land exactly.

**zmac** compiles in a web worker and carries per-file listings in its build
result, so its includes get source-line debugging too.

For all three, `.asm` project files are syntax-highlighted as sjasmplus.

## C

**z88dk C** is the full z88dk toolchain on the server, with both back ends.
The `sdcc_iy` build attributes generated code to source lines exactly; the
classic-library `sccz80` build can attribute a call to a neighbouring line,
so its breakpoints carry ±1 line of fuzz. That is a property of the compiler
output, not of the debugger. Breakpoints work in project headers you
`#include` (C code in a `.h` is as breakable as `program.c`) and on the
individual instructions of inline `__asm`/`#asm` blocks, and the compile
also feeds the program's function and asm-label symbols to the debugger's
disassembly and backtrace.

**SDCC** compiles in the browser via the 8-bit worker. Its build result
already carries per-file listings, so it needs no service at all.

## Pascal

**Pasta80** compiles Pascal to Z80 through sjasmplus, and marks each Pascal
line in the listing it produces. That map also covers assembly files you
link in with `{$l}`, so breakpoints work inside those too.

## BASIC

Four dialects, and the difference between them matters more than it looks.

**Sinclair / NextBASIC** (`nextbas`) is the consolidated one, and the one to
choose unless you have a reason not to. A single tokeniser (txt2bas) handles
the same source for every machine: on 48K/128K it produces a program tape, on
the Next a PLUS3DOS file NextZXOS loads directly. Next-only keywords used on
a 48K project fail the compile with a named error rather than producing
something that dies on the machine. It is also the only BASIC that can carry
extra project files, because the Next has an SD card to stage them onto —
your program can `LOAD` a sprite sheet at runtime by the same relative path
it has in the project.

**Boriel ZX BASIC** (`zxbasic`) is a different proposition: a *compiled*
BASIC producing real machine code, so it is dramatically faster than anything
the ROM interpreter runs, at the cost of being its own language rather than
Sinclair BASIC.

**zmakebas** and **bas2tap** are standalone Sinclair BASIC tools kept for
their own source conventions — zmakebas has backslash escapes and
case-insensitive keywords, for instance. Neither has an include mechanism,
and their tapes carry only the tokenised program, so the IDE hides the
add-file interface for them rather than offering you dead weight.

## Choosing a target machine

The machine is a per-project toggle — 48K, 128K or Next — and no language
pins it. What changes is how the compiled program is delivered:

- On **48K and 128K**, everything arrives as a tape and loads the classic
  way.
- On the **Next**, the BASICs arrive as a PLUS3DOS file that NextZXOS
  `LOAD`s, while the machine-code languages are packaged as a real `.nex`
  file and launched through NextZXOS's genuine `.nexload`.

There is one constraint worth knowing before you name your files: the Next's
SD card is FAT, so **every path segment must fit 8.3**. The IDE rejects
names that do not fit before compiling rather than letting them fail on the
card.

## Extra project files

Every language except zmakebas and bas2tap accepts additional files
alongside the main source, in folders if you want them. A file's identity is
its `folder/name` — that same path is what `INCLUDE`/`INCBIN` resolves,
what the compiler diagnostics name, what breakpoints key against, and what
the file gets in the project download ZIP.

On the Next those files are also staged onto the SD card at the same
relative path before your program runs, with folders created to match. So
the layout in your project, the layout in the ZIP, and the layout on a real
Next's card are the same layout — a `LOAD "gfx/sprites.spr"` works
identically in all three.

Limits: 32 files per project, 256 KB each. Names stemmed `program` are
reserved for the main source and the compiler's own output.

## What each language supports in the debugger

Every language gets the machine-level debugger — registers, memory,
disassembly, address breakpoints. What varies is whether the IDE can map
**your source lines** to it, and that mapping comes from whatever the
toolchain can be persuaded to emit. [Debugging in the
browser](ide-debugging.html) explains the mechanisms; this is the summary:

| Language | Source-line breakpoints | How |
| --- | :---: | --- |
| sjasmplus | ✓ | SLD line→address map — exact. |
| Pasta80 Pascal | ✓ | Compiler listing; also covers `{$l}`-linked asm files. |
| z88dk C | ✓ | Link map + listing; covers headers and inline asm; exact on `sdcc_iy`, ±1 line on `sccz80`. |
| SDCC | ✓ | Worker build listings, keyed by `.rst` markers. |
| zmac | ✓ | Worker build listings, keyed by listing banners. |
| Pasmo | ✓ | A second, best-effort debug build with injected labels. The map is discarded unless that build is byte-identical to the real one. |
| Boriel ZX BASIC | ✓ | Compiled with `--enable-break`; a hit means "line N *just executed*". |
| Sinclair/NextBASIC, zmakebas, bas2tap | ✓ | The engine watches the interpreter's own `PPC` variable — no dependence on ROM addresses, so it works identically on every machine including the Next. |

The practical upshot: **you get source-line breakpoints in all ten**. Only
the precision differs, and only in the two cases noted above.

## Under the hood

The in-browser toolchains come from
[8bitworkshop](https://8bitworkshop.com/)'s worker, from Pasmo compiled to
WebAssembly, and from Remy Sharp's txt2bas. The server-side ones run the
genuine upstream toolchains in containers, and their tests run inside those
images against the real compilers. Nothing here is a reimplementation of a
compiler.
