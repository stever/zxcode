# Using the IDE

[code.zxplay.org](https://code.zxplay.org) is a Spectrum and Spectrum Next
development environment that runs entirely in a browser. You write code on
the left, and the emulator that runs it sits on the right — the same
emulation core that runs on the desktop, compiled to WebAssembly.

Nothing to install, and nothing to configure. Ten toolchains are already
there.

## Signing in

Login is passwordless: you give an email address, the site sends a link, and
clicking it signs you in. You can optionally add a TOTP second factor
afterwards.

You do not need an account to look at public projects or to run them. You do
need one to create and save your own.

## Creating a project

Pick a language and go to `/new/<language>` — the language list and what each
one targets is on [Languages and toolchains](languages.html). The choice
fixes the language for that project.

It does **not** fix the machine. Every project carries a target-machine
toggle — **48K**, **128K** or **Next** — that you can change at any time. The
same source can be built for a 48K tape one minute and a Next `.nex` the
next, subject to whether the code you wrote actually works on both.

Your main source file has a fixed name per language (`program.asm`,
`program.bas`, `program.c`, `program.pas`). That is deliberate: it is the name
the compilers use in their own diagnostics, so an error message names
something you can see.

## Editing

The editor gives you syntax highlighting appropriate to the file, not just to
the project: an `.asm` file sitting next to a Pascal main source is
highlighted as assembly, because that is what it is. Extensions that do not
imply a syntax (`.inc`, `.txt`, `.def`) keep the project's own mode, so
Pascal-style `{$i file.inc}` includes still read as Pascal.

### Additional files

Most languages accept extra files beside the main source, organised into
folders if you like. A file's identity is its `folder/name`, and that one
path is used consistently everywhere:

- it is what `INCLUDE` / `INCBIN` resolves,
- it is what compiler diagnostics name,
- it is what breakpoints key against,
- it is the path in the project download ZIP,
- and on the Next it is the path the file is staged to on the SD card, so
  your program can `LOAD` it at runtime by the same name.

Limits are 32 files per project and 256 KB per file. Names stemmed `program`
are reserved for the main source and compiler output.

### The asset editors

Some files open in a graphical editor instead of a text buffer:

| File | Opens as |
| --- | --- |
| `.spr` | Sprite editor |
| `.til`, `.tile` | Sprite editor in 8×8 4-bit tile-bank mode |
| `.pal` | Palette editor (when the file is exactly 256 entries) |
| `.map` | Tile map editor |

Creating a new `.spr` or `.pal` gives you a blank, ready-to-edit file rather
than an empty one. These editors are original code modelled on Remy Sharp's
[zx-tools](https://github.com/remy/zx-tools) — the file formats, drawing
tools and key bindings follow it, so assets move between the two.

## Running and debugging

**Play** compiles the project and runs the result in the emulator beside the
editor. What that means depends on the target machine: a tape on 48K/128K, a
PLUS3DOS file or a real `.nex` on the Next, launched through NextZXOS's own
loader.

**Debug** does the same but with the debugger dock open — registers,
disassembly, memory, paging, and a console. You can set breakpoints by
clicking the editor gutter on any line the compiler could map, and the
paused line is highlighted in your source. All ten languages support this to
some degree; see [Debugging in the browser](ide-debugging.html) for what each
one can do and how it works.

The emulator has the on-screen Spectrum keyboard available, so you can drive
programs that expect specific keys on a machine with no such keys. It matches
the machine you are building for: the 48K's rubber keys, the 128K's Spectrum+
/ toastrack keyboard, or the Next's own — the last two carrying the dedicated
EDIT, DELETE, GRAPH, EXTEND MODE, TRUE/INV VIDEO, BREAK and cursor keys that
the 128K menus and the NextZXOS Browser expect.

## Sharing your work

Projects are private by default and can be made public. A public project gets
a stable URL of the form `/u/<your-slug>/<project-slug>`, which anyone can
open, run and read the source of — no account needed on their side. Other
people can star it, and profiles list what a user has published.

**Download ZIP** gives you the whole project as files, in the same folder
layout the IDE shows and the Next's SD card uses. Unzipped onto a real Next's
card, the relative paths your program loads still resolve.

## When you outgrow the browser

The IDE is genuinely capable, but it is not trying to be everything. If you
want to build a large project with your own editor, a local assembler and a
version-controlled repository, take the ZIP and go — and then use the
emulator locally for the parts the browser cannot do: headless runs on every
commit, scripted breakpoints, provenance tracing, screenshot regression.
[Automating the emulator](automation.html) covers that.

The debugger command language is the same in both places, so what you learn
in the browser console transfers directly to the desktop telnet debugger.
