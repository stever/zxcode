# Next-specific Boriel ZX BASIC

The ZX BASIC compile service targets the classic 48K Spectrum by default.
Programs can opt into the ZX Spectrum Next instead, which enables the Z80N
opcodes and the Next hardware library. This document explains how to opt in,
what the Next library provides, and how to port NextBuild programs.

## Opting in

The service compiles with `zxbc --arch=zxnext` when the source contains
either of these markers:

```basic
'!arch=zxnext
```

or

```basic
#include <NextLibLite.bas>
```

The directive comment suits programs that use Z80N inline assembly without
the library. The include is the normal route for hardware programs.

Next output cannot be the default because zxnext code generation emits Z80N
opcodes (for example `mul d, e`) in ordinary compiled code. A program built
for the Next will crash on a 48K or 128K machine. Run Next programs on the
Next machine in the player.

## What --arch=zxnext provides

- Z80N opcodes accepted in inline `ASM` blocks (`nextreg`, `mul`, `ldirx`,
  and the rest).
- The zxnext standard library, including `NextLibLite.bas` and
  `retrace.bas`.

`NextLibLite.bas` ships with the stock Boriel compiler and covers most of
what NextBuild's `nextlib.bas` offers:

| Area | Routines |
| --- | --- |
| NextReg access | `NextReg(reg, val)`, `NextRegA(reg, a)`, `GetReg(reg)` |
| Layer 2 | `ShowLayer2(on)`, `CLS256(colour)`, `PlotL2(x, y, colour)`, `ScrollLayer(x, y)` |
| Sprites | `InitSprites(count, address, first)`, `UpdateSprite(x, y, id, pattern, mflip, anchor)`, `RemoveSprite(id, visible)` |
| Tiles | `DoTile`, `DoTile8` |
| Files | `LoadSD`, `SaveSD`, `LoadBMP` |

`retrace.bas` provides `waitretrace`, a HALT-based frame wait.

## Porting from NextBuild

NextBuild bundles the same Boriel compiler, so most sources port with small
changes:

- `#include <nextlib.bas>` becomes `#include <NextLibLite.bas>`.
- `WaitRetrace(1)` becomes `waitretrace` from `#include <retrace.bas>`.
- `UpdateSprite` takes six arguments: `x, y, spriteid, pattern, mflip,
  anchor`. Pass 0 for `mflip` and `anchor` on a plain sprite.
- Drop `'!org=32768` and `#define NEX`. The compiler defaults to org 32768
  and the player wraps the binary as a .NEX automatically.

## How programs run

The service produces a TAP. The player converts it in the browser to a .NEX
container and runs it through NextZXOS's `.nexload`, so there is a short
reboot pause before the program starts. The program is CALLed with
interrupts enabled (IM 1), matching a `RANDOMIZE USR` environment, and the
final screen is held after `END`.

## Type pitfalls

Boriel does not promote small integer types inside expressions. Two cases
bite hardware code in particular:

- Array index arithmetic. `DIM py AS BYTE` makes `ball(py * 16 + px)`
  overflow for `py >= 8` (240 does not fit a signed byte), so writes land
  outside the array and corrupt nearby memory. Use `UBYTE` for 0-255 index
  variables.
- Signed intermediate values. With `px AS UBYTE`, the expression
  `px * 2 - 15` underflows for small `px`. Cast first:
  `CAST(INTEGER, px) * 2 - 15`.

Both produce silent corruption rather than compile errors.

## Example

A bouncing hardware sprite over a Layer 2 backdrop at 28MHz:

```basic
#include <NextLibLite.bas>
#include <retrace.bas>

NextReg($07, %11)          ' 28MHz
NextReg($14, $E3)          ' global transparency colour
NextReg($15, %00000001)    ' sprites visible

BORDER 0

ShowLayer2(1)
CLS256(0)

DIM x AS UINTEGER
DIM y AS UBYTE

FOR y = 0 TO 191
    FOR x = 0 TO 255
        PlotL2(CAST(UBYTE, x), y, CAST(UBYTE, x) BXOR y)
    NEXT x
NEXT y

DIM ball(255) AS UBYTE
DIM px, py AS UBYTE
DIM dx, dy AS INTEGER

FOR py = 0 TO 15
    FOR px = 0 TO 15
        dx = CAST(INTEGER, px) * 2 - 15
        dy = CAST(INTEGER, py) * 2 - 15
        IF dx * dx + dy * dy <= 196 THEN
            ball(py * 16 + px) = 32 + px + py
        ELSE
            ball(py * 16 + px) = $E3
        END IF
    NEXT px
NEXT py

InitSprites(1, @ball(0))

DIM sx AS UINTEGER = 120
DIM sy AS UBYTE = 96
DIM vx AS INTEGER = 2
DIM vy AS INTEGER = 1

DO
    waitretrace
    sx = sx + vx
    sy = sy + CAST(UBYTE, vy)
    IF sx <= 32 OR sx >= 272 THEN vx = -vx
    IF sy <= 32 OR sy >= 208 THEN vy = -vy
    UpdateSprite(sx, sy, 0, 0, 0, 0)
LOOP
```

## Known limitations

- `GetReg` read-back is unreliable in the emulator: a probe reading NR$07
  after writing 3 got 1 back. Avoid logic that depends on reading NextRegs
  until this is resolved.
- `LoadSD`, `SaveSD` and `LoadBMP` are untested in the player.
- NextBuild's `nextlib.bas` itself is not installed. Its `WaitRetrace(1)`
  polls the raster through the NextReg read ports, which depends on the
  read-back path above, so vendoring it needs that verified first.
