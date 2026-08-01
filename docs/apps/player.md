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

### Tailoring the keyboard to a game

Most games use four or five keys. Showing a full 40-key Spectrum keyboard on
a phone makes all of them small. The `k` parameter replaces the on-screen
keyboard with just the keys your game uses, and the layout resizes to match —
fewer keys means bigger keys.

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
