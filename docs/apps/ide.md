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

### When the compile fails

Errors pop up as individual notifications (deduplicated, and capped at a
handful so a broken build can't bury the screen). Warnings and the
compiler's other output don't get notifications of their own: they are
counted in a single summary notification, whose **Show build output**
button opens the full compiler output in a dialog — every line in its
original order, colour-coded by severity, with a checkbox to hide the
warning lines when a warning-happy toolchain (z88dk especially) is
drowning out what actually failed.

## Fitting the window

The page sizes itself to the window rather than scrolling. In a window with
room for both, the editor sits beside the emulator and the emulator is drawn
at its original 2x size; in a smaller one the screen shrinks to whatever
height is left, so the editor, the emulator, the debugger's dock and the
buttons under them all stay on screen together. Below roughly 992x600 the
page switches to tabs — emulator, your files, and the debugger while a session
is open — all on one strip, with the panel filling the rest of the page.

When the debugger is open in a short window, its panes give up height before
the editor does, since they scroll on their own; in a narrow one they wrap
onto a second row and the dock scrolls rather than pushing the page down. The
menu bar collapses to a single button at whatever width its own items stop
fitting on one line, which differs by language.

Sizing the emulator to the space usually leaves it on a fractional multiple of
the Spectrum's own size, so with the pixels drawn hard-edged some come out a
pixel wider than others. **View > Pixel Perfect** rounds the screen down to a
whole multiple — 1x, 2x, 3x — so every pixel is the same size, at the cost of
the space left over, which goes to the editor. It is off by default and
remembered when set.

The whole multiples are far apart, so where the screen lands just under one it
is the on-screen keyboard that gives way rather than the screen: the keyboard
has no pixel grid to keep, and is simply drawn a little narrower and centred
under the screen. A window a few pixels short of a 2x screen therefore keeps
2x with a keyboard at around 95% of its width, instead of dropping to 1x. Once
the keyboard would have to shrink below about three-fifths of the screen it
stops looking like part of the same machine, and the smaller whole multiple is
used after all. `Keyboard > None` sidesteps the trade entirely, and is the way
to hold a large whole multiple in a short window.

## The keyboard

The emulator has the on-screen Spectrum keyboard available, so you can drive
programs that expect specific keys on a machine with no such keys. It matches
the machine you are building for: the 48K's rubber keys, the 128K's Spectrum+
/ toastrack keyboard, or the Next's own — the last two carrying the dedicated
EDIT, DELETE, GRAPH, EXTEND MODE, TRUE/INV VIDEO, BREAK and cursor keys that
the 128K menus and the NextZXOS Browser expect.

The **Keyboard** menu overrides that when the machine you are building for is
not the keyboard you want in front of you — a Next program running in 48K
mode, or a 48K one you would rather type into with the dedicated EDIT and
cursor keys. The keys are matrix positions, so any keyboard drives any
machine, and the choice is remembered.

**No Keyboard** is also on that menu, for when you are working with your own
keyboard and would rather have the screen. The emulator then takes the room
the keyboard had: beside the editor it grows as far as the window's height
allows while leaving the editor half the page, and in the tabbed layout it
grows into the whole tab. The drawn keyboard is about a third of the
emulator's height, so this is also the answer when the window is small and you
want as much screen as it can give you — on a 1366x768 laptop the screen goes
from roughly 500 to 680 pixels wide.

The emulator only takes your real keyboard while it has focus, so typing goes
to the editor until you ask for it — and pressing an on-screen key asks for
it, exactly as clicking the screen does. So the two can be used together:
press EDIT on screen, then carry on typing on your own keyboard. Clicking
back into the editor hands it back. With no keyboard drawn, clicking the
screen is how you hand your keyboard over.

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
