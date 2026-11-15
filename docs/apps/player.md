# The player

[zxplay.org](https://zxplay.org) is a ZX Spectrum player built for phones as
much as for desktops: the screen and an on-screen Spectrum keyboard lay
themselves out to fit whatever viewport you open it in, stacked in portrait
and side by side in landscape. Turn the keyboard off and the screen takes
its room.

It runs the same emulation core as everything else in this project, compiled
to WebAssembly — the 48K and the 128K. The site does not support the ZX
Spectrum Next.

## Loading something

Open a file from the menu, or link straight to one with the `u` query
parameter. The engine sniffs the file rather than trusting its name, and
loads snapshots (`.sna`, `.z80`, `.szx`), tapes (`.tap`, `.tzx`), and zip
archives containing one of those. Spectrum Next programs (`.nex` files, or a
zip holding one) are not supported: the player says so rather than loading
them.

```
https://zxplay.org/?u=https://example.org/games/mygame.tap
```

`u` may be repeated to open several files in sequence.

## URL parameters

| Parameter | Effect |
| --- | --- |
| `u=URL` | Open this file. Repeat for several. |
| `m=48` \| `128` | Force the machine, and lock the choice so the program cannot be started on the wrong one. Without it, your last choice is remembered. |
| `k=ROWS` | Override the on-screen keyboard (below). |
| `a=0` | Do not auto-load tapes; you type `LOAD ""` yourself. |
| `f=1` | Smooth the scaled display instead of showing hard pixels. |

Older links using `m=5` (Pentagon) or `m=next` still work — the value maps to
the 128K, the closest supported machine, rather than failing. A remembered
Next choice falls back the same way.

### The keyboard matches the machine

The on-screen keyboard is the one the selected machine actually has:

| Machine | Keyboard |
| --- | --- |
| 48K | the 40 rubber keys |
| 128K | the 58-key Spectrum+ / toastrack keyboard |

The 58-key layout adds the keys the 48K makes you type as combinations —
EDIT, DELETE, GRAPH, EXTEND MODE, CAPS LOCK, TRUE and INV VIDEO, BREAK, the
cursor keys and `;` `"` `,` `.` — which is what makes the 128K menus and
the BASIC editors usable without a physical keyboard.
They press the same keys underneath as a real machine does: EDIT holds CAPS
SHIFT and 1. The on-screen keys show what the machine sees, so a key you
press lights up, and so does one the running program is holding down.

Both are drawn rather than pictured — every key rectangle, every legend,
the shape of each moulding and the colours transcribed from a reference, the
128K from photographs of the real machine and the 48K from the key art it
replaces. So what you press is what the hardware looks like, down to the
keyword printed on each key, but crisp at any size and nothing to download.
Both draw into the same box, so switching machine moves nothing on the
page.

Pressing an on-screen key also hands your real keyboard to the emulator, just
as clicking the screen does, so the two can be used together: press EDIT on
screen and carry on typing.

Switching machines switches the keyboard; nothing to set. When that is not
what you want, the **Keyboard** menu names both outright and the choice
sticks until you change it — useful for a 48K program you would rather drive
with the Spectrum+'s dedicated EDIT and cursor keys. The keys are matrix
positions, so either keyboard drives either machine: BREAK on the Spectrum+
keyboard is CAPS SHIFT and SPACE, which is BREAK on a 48K too. Your
choice is remembered, along with the machine and the joystick.

### No keyboard, and a bigger screen

The same menu offers **No Keyboard**, for playing with a real keyboard in
front of you. The screen then takes the room the keyboard had rather than
leaving it blank: it is no longer held to twice the Spectrum's own size, and
grows until it meets the window. On a 1920x1080 desktop that is a screen about
1250 pixels wide instead of 640. In landscape, where the screen already uses
the full height, the keyboard simply goes: the screen has no use for the width
it frees, so the column shrinks to the menu button that shares it and the two
are centred together rather than left at opposite edges. Only View > Keyboard
Side has nothing left to say, so it steps out of the menu.

Nothing else changes: clicking the screen still hands it your keyboard, and
your choice is remembered like the rest. A game that names its own keys with
the `k` parameter (below) still draws them — those are its controls, and on a
phone they may be the only ones — so the choice comes back with the next game.

### Pixel perfect

Filling the window means the screen is usually not a whole multiple of the
Spectrum's own size, and the pixels are drawn hard-edged rather than smoothed.
At 1250 pixels wide, for instance, each Spectrum pixel wants to be 3.9 across,
so some are drawn 4 and some 3 — a faint unevenness across the picture, most
visible on dithered artwork and single-pixel detail.

**View > Pixel Perfect** rounds the screen down to a whole multiple instead —
1x, 2x, 3x and so on — so every pixel is exactly the same size. It is off by
default, because it costs whatever is left over: that 1250-pixel screen becomes
960, and on a phone in landscape it can be the difference between 488 and 320.
The window decides which is the better trade, so it is a switch rather than a
rule, and it is remembered like the rest.

Two cases where it does nothing. A screen already on a whole multiple — a
desktop showing the usual 2x — does not move. And where not even 1x would fit,
on a very narrow window, the screen keeps filling the space: there is no whole
step left to drop to, and a screen shrunk below the Spectrum's own resolution
would be a worse answer than uneven pixels.

### Tailoring the keyboard to a game

Most games use four or five keys. Showing a full keyboard on a phone makes
all of them small. The `k` parameter replaces the on-screen keyboard with just
the keys your game uses, and the layout resizes to match — fewer keys means
bigger keys. Keys you name this way are the 48K's rubber keys, and they are
kept on every machine, so a game's play surface does not change size when the
machine does.

The value is comma-separated rows of key characters. Letters and digits are
themselves; four characters are special:

| Character | Key |
| --- | --- |
| `e` | ENTER |
| `c` | CAPS SHIFT |
| `s` | SYMBOL SHIFT |
| `_` | SPACE |
| `-` | a blank gap (holds a position without drawing a key) |

A row is capped at 10 keys. The full default keyboard is:

```
1234567890,QWERTYUIOP,ASDFGHJKLe,cZXCVBNMs_
```

So a Manic Miner link needs only:

```
https://zxplay.org/?u=...&k=OPeZ
```

and a game using QAOP plus space becomes `k=-Q-,OP-_,--A` or whatever
arrangement suits the thumbs.

Whatever you show, the on-screen keys stay in sync with the machine's actual
keyboard matrix — if the running program holds a key down, the on-screen key
lights up.

## Joysticks

A connected gamepad drives one of the classic interfaces: Kempston (the
default, and the most common), Sinclair 1 or 2, or Cursor/Protek. A game
reads exactly one and there is no way to detect which, so the choice is
yours, and it is remembered.

## What is actually running

Every machine and video mode composites into a fixed 640×512 display, so the
page layout never jumps when a program changes mode. [Game
compatibility](compatibility.html) lists the titles the emulator has been
tested against.
