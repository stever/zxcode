# The player

[zxplay.org](https://zxplay.org) is a ZX Spectrum player built for phones as
much as for desktops: the screen and an on-screen Spectrum keyboard lay
themselves out to fit whatever viewport you open it in, stacked in portrait
and side by side in landscape.

It runs the same emulation core as everything else in this project, compiled
to WebAssembly — 48K, 128K and a Spectrum Next that cold-boots real NextZXOS.

## Loading something

Open a file from the menu, or link straight to one with the `u` query
parameter. The engine sniffs the file rather than trusting its name, and
loads snapshots (`.sna`, `.z80`, `.szx`), tapes (`.tap`, `.tzx`), `.nex`
files, and zip archives containing any of those.

```
https://zxplay.org/?u=https://example.org/games/mygame.tap
```

`u` may be repeated to open several files in sequence.

The program's own needs generally pick the machine: opening a `.nex` moves
the emulator to the Next, a `.tap` on a Next moves it back to the 128K. The
menu's checkmark follows those switches rather than going stale.

## URL parameters

| Parameter | Effect |
| --- | --- |
| `u=URL` | Open this file. Repeat for several. |
| `m=48` \| `128` \| `next` | Force the machine, and lock the choice so the program cannot be started on the wrong one. Without it, your last choice is remembered. |
| `k=ROWS` | Override the on-screen keyboard (below). |
| `a=0` | Do not auto-load tapes; you type `LOAD ""` yourself. |
| `f=1` | Smooth the scaled display instead of showing hard pixels. |

Older links using `m=5` (Pentagon) still work — the value maps to the 128K,
the closest supported machine, rather than failing.

### The keyboard matches the machine

The on-screen keyboard is the one the selected machine actually has:

| Machine | Keyboard |
| --- | --- |
| 48K | the 40 rubber keys |
| 128K | the 58-key Spectrum+ / toastrack keyboard |
| Next | the Next's own 58-key keyboard |

The two 58-key layouts add the keys the 48K makes you type as combinations —
EDIT, DELETE, GRAPH, EXTEND MODE, CAPS LOCK, TRUE and INV VIDEO, BREAK, the
cursor keys and `;` `"` `,` `.` — which is what makes the 128K menus, the
NextZXOS Browser and the BASIC editors usable without a physical keyboard.
They press the same keys underneath as a real machine does: EDIT holds CAPS
SHIFT and 1. The on-screen keys show what the machine sees, so a key you
press lights up, and so does one the running program is holding down.

All three are drawn rather than pictured — every key rectangle, every legend,
the shape of each moulding and the colours transcribed from a reference, the
128K and Next from photographs of the real machines and the 48K from the key
art it replaces. So what you press is what the hardware looks like, down to the
keyword printed on each key, but crisp at any size and nothing to download.
All three draw into the same box, so switching machine moves nothing on the
page.

Pressing an on-screen key also hands your real keyboard to the emulator, just
as clicking the screen does, so the two can be used together: press EDIT on
screen and carry on typing.

Switching machines switches the keyboard; nothing to set. When that is not
what you want, the **Keyboard** menu names all three outright and the choice
sticks until you change it — useful when a machine is running something its
own keyboard does not suit, such as a Next in 48K mode, or a 48K program you
would rather drive with the Spectrum+'s dedicated EDIT and cursor keys. The
keys are matrix positions, so any keyboard drives any machine: BREAK on the
Next's keyboard is CAPS SHIFT and SPACE, which is BREAK on a 48K too. Your
choice is remembered, along with the machine and the joystick.

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

On the Spectrum Next there is nothing to choose — the machine has a built-in
Kempston joystick, so a gamepad works out of the box.

## Spectrum Next games

The Next boots genuine NextZXOS, which means Next software loads the way it
does on real hardware, with the consequences that implies for how a game
must be packaged.

**A bare `.nex` file** is imported to the card as `/zx.nex` and launched
through NextZXOS's own `.nexload`. That fixed short name sidesteps a real
constraint: the SD card is FAT, long names get `~1`-style aliases, and the
command-line macro that types the load command cannot produce a `~`.

**A `.zip` containing exactly one `.nex`** is treated as a game folder, and
this is the form to distribute anything non-trivial in. Every file in the
zip is staged onto a fresh card under the game's own folder, and the `.nex`
is launched by driving the NextZXOS **Browser** to it — under its own name,
in its own directory, from the launcher a player would really use.

That last part is not ceremony. Games that stream their own data reopen
themselves *by filename* at runtime, and at least one known title exits to
the menu if launched any other way. Preserving folder, filename and launch
context is what makes it work. Every load starts from a pristine card, so a
game cannot be affected by whatever ran before it.

A zip with no `.nex` in it keeps the classic behaviour: it should contain
exactly one loadable file, and that is what opens.

## What is actually running

The engine cold-boots the Next through the authentic FPGA chain rather than
restoring a captured state, and every machine and video mode composites into
a fixed 640×512 display, so the page layout never jumps when a program
changes mode.

Next compatibility is the newest part of the project: some titles play,
several render with bugs, and many are unverified. [Game
compatibility](compatibility.html) lists what has been tested.
