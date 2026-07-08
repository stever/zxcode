import {actionTypes} from "./actions";

// -----------------------------------------------------------------------------
// Initial state
// -----------------------------------------------------------------------------

const initialState = {
    selectedTabIndex: 0,
    asmCode: `; zxplay.org demo - colour bars and coloured text
; the assembly counterpart of the BASIC demo

        org 32768

CHAN_OPEN equ 5633              ; ROM 0x1601: open channel (A = channel)
ROM_CLS   equ 3503              ; ROM 0x0DAF: clear screen (uses ATTR-P)
ATTR_P    equ 23693             ; permanent colours - used by CLS and scrolling
BORDCR    equ 23624             ; border / lower-screen attribute

start:
        ld a,2
        call CHAN_OPEN          ; channel 2 (main screen)

        ld a,2                  ; BORDER 2
        out (254),a
        ld a,2*8+7              ; paper 2, ink 7 - what BORDER 2 stores
        ld (BORDCR),a           ; so the lower screen (scroll?) is red too

        ld a,7                  ; PAPER 0 : INK 7 (permanent)
        ld (ATTR_P),a
        call ROM_CLS            ; CLS clears with ATTR-P and copies it to ATTR-T

loop:
        ld c,0                  ; eight PAPER colour bars
bars:
        ld a,17                 ; PAPER control
        rst 16
        ld a,c
        rst 16
        ld b,4
space:
        ld a,32
        rst 16
        djnz space
        inc c
        ld a,c
        cp 8
        jr nz,bars

        ld a,17                 ; back to PAPER 0, new line
        rst 16
        xor a
        rst 16
        ld a,13
        rst 16

        ld hl,msg               ; message
        call print

        ld c,1                  ; six rows of asterisks, INK 1..6
rows:
        ld a,16                 ; INK control
        rst 16
        ld a,c
        rst 16
        ld hl,stars
        call print
        inc c
        ld a,c
        cp 7
        jr nz,rows

        ld a,16                 ; back to INK 7
        rst 16
        ld a,7
        rst 16

        jr loop

print:                          ; print null-terminated string at HL
        ld a,(hl)
        or a
        ret z
        rst 16
        inc hl
        jr print

msg:
        db "Hello from zxplay.org",13,0
stars:
        db "**********",13,0

        end start`,
    sinclairBasicCode: `10 REM zxplay.org demo
20 BORDER 2: PAPER 0: INK 7: CLS
30 FOR n=0 TO 7
40 PAPER n: PRINT "    ";
50 NEXT n
60 PAPER 0: PRINT
70 PRINT "Hello from zxplay.org"
80 FOR n=1 TO 6
90 INK n: PRINT "**********"
100 NEXT n
110 INK 7
120 GO TO 30`,
    zxBasicCode: `REM From the ZX Spectrum 48K Manual

DIM m, n, c AS BYTE

FOR m = 0 TO 1: BRIGHT m
FOR n = 1 TO 10
FOR c = 0 TO 7
PAPER c: PRINT "    ";: REM 4 coloured spaces
NEXT c: NEXT n: NEXT m

FOR m = 0 TO 1: BRIGHT m: PAPER 7
FOR c = 0 TO 3
INK c: PRINT c; "   ";
NEXT c: PAPER 0
FOR c = 4 TO 7
INK c: PRINT c; "   ";
NEXT c: NEXT m
PAPER 7: INK 0: BRIGHT 0`,
    cCode: `#include <arch/zx.h>
#include <stdio.h>
 
int main()
{
  zx_cls(PAPER_WHITE);
  puts("Hello, world!");
  return 0;
}`
};

// -----------------------------------------------------------------------------
// Actions
// -----------------------------------------------------------------------------

function setSelectedTabIndex(state, action) {
    return {
        ...state,
        selectedTabIndex: action.index
    }
}

function setAssemblyCode(state, action) {
    return {
        ...state,
        asmCode: action.code
    }
}

function setSinclairBasicCode(state, action) {
    return {
        ...state,
        sinclairBasicCode: action.code
    }
}

// -----------------------------------------------------------------------------
// Reducer
// -----------------------------------------------------------------------------

const actionsMap = {
    [actionTypes.setSelectedTabIndex]: setSelectedTabIndex,
    [actionTypes.setAssemblyCode]: setAssemblyCode,
    [actionTypes.setSinclairBasicCode]: setSinclairBasicCode,
};

export default function reducer(state = initialState, action) {
    const reducerFunction = actionsMap[action.type];
    return reducerFunction ? reducerFunction(state, action) : state;
}
