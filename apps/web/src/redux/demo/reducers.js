import {actionTypes} from "./actions";

// -----------------------------------------------------------------------------
// Initial state
// -----------------------------------------------------------------------------

const initialState = {
    selectedTabIndex: 0,
    asmCode: `    org 30000

tv_flag    equ 5C3Ch

start
    ; Directs rst 10h output to main screen.
    xor a
    ld (tv_flag),a

    ld b, 50

another

    push bc

    ld hl,hello
again    ld a,(hl)
    cp 0
    jr z, exit
    push hl
    rst 10h
    pop hl
    inc hl
    jr again

exit
    pop bc
    djnz another
    ret

hello    db "Hello, world.", 0Dh, 0

    end start`,
    sinclairBasicCode: `10 PRINT "Hello, world."\n20 GO TO 10`,
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
