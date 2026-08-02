// What is printed on each key of the Spectrum+ / 128K toastrack and the ZX
// Spectrum Next, transcribed from photographs of both machines.
//
// A Sinclair key carries up to five legends, in two places:
//
//   ext      on the key's shoulder, first line    E-mode
//   extSym   on the key's shoulder, second line   E-mode + SYMBOL SHIFT
//   keyword  on the fingertip pad, upper          the unshifted BASIC keyword
//   sym      on the pad, right of the keyword     SYMBOL SHIFT — a word (STOP,
//                                                 THEN, AND …) takes its own
//                                                 line under the keyword.
//                                                 O, P, N and M print none:
//                                                 their ; " , . have keys of
//                                                 their own on these machines,
//                                                 so only the 48K, which has
//                                                 no such keys, prints them
//   main     on the pad, large                    the character itself
//
// All of it prints in white; the machines use no other ink. The number keys
// carry a block graphic where a letter key has its keyword.
//
// The 48K prints its own version of the same information, in its own words and
// in three colours — see RUBBER below.

// The block graphic on keys 1-8: which quadrants of the little square are
// filled. Read off the Spectrum+ photograph, and the same as the 48K's rubber
// art draws (in reverse, dark on white). Key 8 is the blank graphic, so it
// prints as an empty square.
export const GRAPHIC_QUADRANTS = {
    1: ['tr'],
    2: ['tl'],
    3: ['tl', 'tr'],
    4: ['br'],
    5: ['tr', 'br'],
    6: ['tl', 'br'],
    7: ['tl', 'tr', 'br'],
    8: [],
};

// Common to both machines.
const LEGENDS = {
    '1': {main: '1', sym: '!', ext: 'BLUE', extSym: 'DEF FN', graphic: 1},
    '2': {main: '2', sym: '@', ext: 'RED', extSym: 'FN', graphic: 2},
    '3': {main: '3', sym: '#', ext: 'MGNTA', extSym: 'LINE', graphic: 3},
    '4': {main: '4', sym: '$', ext: 'GREEN', extSym: 'OPEN #', graphic: 4},
    '5': {main: '5', sym: '%', ext: 'CYAN', extSym: 'CLOSE #', graphic: 5},
    '6': {main: '6', sym: '&', ext: 'YELLOW', extSym: 'MOVE', graphic: 6},
    '7': {main: '7', sym: "'", ext: 'WHITE', extSym: 'ERASE', graphic: 7},
    '8': {main: '8', sym: '(', extSym: 'POINT', graphic: 8},
    '9': {main: '9', sym: ')', extSym: 'CAT'},
    '0': {main: 'Ø', sym: '−', ext: 'BLACK', extSym: 'FORMAT'},

    Q: {main: 'Q', keyword: 'PLOT', sym: '<=', ext: 'SIN', extSym: 'ASN'},
    W: {main: 'W', keyword: 'DRAW', sym: '<>', ext: 'COS', extSym: 'ACS'},
    E: {main: 'E', keyword: 'REM', sym: '>=', ext: 'TAN', extSym: 'ATN'},
    R: {main: 'R', keyword: 'RUN', sym: '<', ext: 'INT', extSym: 'VERIFY'},
    T: {main: 'T', keyword: 'RAND', sym: '>', ext: 'RND', extSym: 'MERGE'},
    Y: {main: 'Y', keyword: 'RETURN', sym: 'AND', ext: 'STR$', extSym: '['},
    U: {main: 'U', keyword: 'IF', sym: 'OR', ext: 'CHR$', extSym: ']'},
    I: {main: 'I', keyword: 'INPUT', sym: 'AT', ext: 'CODE', extSym: 'IN'},
    O: {main: 'O', keyword: 'POKE', ext: 'PEEK', extSym: 'OUT'},
    P: {main: 'P', keyword: 'PRINT', ext: 'TAB', extSym: '(c)'},

    A: {main: 'A', keyword: 'NEW', sym: 'STOP', ext: 'READ', extSym: '~'},
    S: {main: 'S', keyword: 'SAVE', sym: 'NOT', ext: 'RESTR', extSym: '|'},
    D: {main: 'D', keyword: 'DIM', sym: 'STEP', ext: 'DATA', extSym: '\\'},
    F: {main: 'F', keyword: 'FOR', sym: 'TO', ext: 'SGN', extSym: '{'},
    G: {main: 'G', keyword: 'GOTO', sym: 'THEN', ext: 'ABS', extSym: '}'},
    H: {main: 'H', keyword: 'GOSUB', sym: '↑', ext: 'SQR', extSym: 'CIRCLE'},
    J: {main: 'J', keyword: 'LOAD', sym: '−', ext: 'VAL', extSym: 'VAL$'},
    K: {main: 'K', keyword: 'LIST', sym: '+', ext: 'LEN', extSym: 'SCRN$'},
    L: {main: 'L', keyword: 'LET', sym: '=', ext: 'USR', extSym: 'ATTR'},

    Z: {main: 'Z', keyword: 'COPY', sym: ':', ext: 'LN', extSym: 'BEEP'},
    X: {main: 'X', keyword: 'CLEAR', sym: '£', ext: 'EXP', extSym: 'INK'},
    C: {main: 'C', keyword: 'CONT', sym: '?', ext: 'LPRINT', extSym: 'PAPER'},
    V: {main: 'V', keyword: 'CLS', sym: '/', ext: 'LLIST', extSym: 'FLASH'},
    B: {main: 'B', keyword: 'BORDER', sym: '*', ext: 'BIN', extSym: 'BRIGHT'},
    N: {main: 'N', keyword: 'NEXT', ext: 'INKEY$', extSym: 'OVER'},
    M: {main: 'M', keyword: 'PAUSE', ext: 'PI', extSym: 'INVERS'},

    ENTER: {label: 'ENTER'},
    CAPS: {label: 'CAPS SHIFT'},
    SYMBOL: {label: 'SYMBOL\nSHIFT'},
    SPACE: {},

    BREAK: {label: 'BREAK'},
    DELETE: {label: 'DELETE'},
    EDIT: {label: 'EDIT'},
    GRAPH: {label: 'GRAPH'},
    EXTEND: {label: 'EXTEND\nMODE'},
    CAPSLOCK: {label: 'CAPS\nLOCK'},
    TRUEVIDEO: {label: 'TRUE\nVIDEO'},
    INVVIDEO: {label: 'INV\nVIDEO'},
    LEFT: {main: '⇦'},
    RIGHT: {main: '⇨'},
    UP: {main: '⇧'},
    DOWN: {main: '⇩'},
    SEMI: {main: ';'},
    QUOTE: {main: '”'},
    COMMA: {main: ','},
    PERIOD: {main: '.'},
};


// The 48K's rubber keyboard says the same things in its own words — RESTORE
// where the later machines abbreviate to RESTR, SCREEN $ for SCRN$, L PRINT
// for LPRINT — and prints them in three colours rather than one: the E-mode
// word above the key in green, the E-mode + SYMBOL SHIFT word below it in red,
// and on the key itself the character, the SYMBOL SHIFT legend in red and the
// BASIC keyword in white. Above the NUMBER keys it prints the CAPS SHIFT
// function instead, in white, because that machine has no keys for those.
//
// It also prints ; " , . on O, P, N and M — the Spectrum+ and the Next leave
// them off, having given them keys of their own.
const RUBBER = {
    '1': {main: '1', sym: '!', caps: 'EDIT', extSym: 'DEF FN', graphic: 1},
    '2': {main: '2', sym: '@', caps: 'CAPS LOCK', extSym: 'FN', graphic: 2},
    '3': {main: '3', sym: '#', caps: 'TRUE VIDEO', extSym: 'LINE', graphic: 3},
    '4': {main: '4', sym: '$', caps: 'INV. VIDEO', extSym: 'OPEN #', graphic: 4},
    '5': {main: '5', sym: '%', caps: '⇦', extSym: 'CLOSE #', graphic: 5},
    '6': {main: '6', sym: '&', caps: '⇩', extSym: 'MOVE', graphic: 6},
    '7': {main: '7', sym: "'", caps: '⇧', extSym: 'ERASE', graphic: 7},
    '8': {main: '8', sym: '(', caps: '⇨', extSym: 'POINT', graphic: 8},
    '9': {main: '9', sym: ')', caps: 'GRAPHICS', extSym: 'CAT'},
    '0': {main: '0', sym: '_', caps: 'DELETE', extSym: 'FORMAT'},

    Q: {main: 'Q', keyword: 'PLOT', sym: '<=', ext: 'SIN', extSym: 'ASN'},
    W: {main: 'W', keyword: 'DRAW', sym: '<>', ext: 'COS', extSym: 'ACS'},
    E: {main: 'E', keyword: 'REM', sym: '>=', ext: 'TAN', extSym: 'ATN'},
    R: {main: 'R', keyword: 'RUN', sym: '<', ext: 'INT', extSym: 'VERIFY'},
    T: {main: 'T', keyword: 'RAND', sym: '>', ext: 'RND', extSym: 'MERGE'},
    Y: {main: 'Y', keyword: 'RETURN', sym: 'AND', ext: 'STR $', extSym: '['},
    U: {main: 'U', keyword: 'IF', sym: 'OR', ext: 'CHR $', extSym: ']'},
    I: {main: 'I', keyword: 'INPUT', sym: 'AT', ext: 'CODE', extSym: 'IN'},
    O: {main: 'O', keyword: 'POKE', sym: ';', ext: 'PEEK', extSym: 'OUT'},
    P: {main: 'P', keyword: 'PRINT', sym: '"', ext: 'TAB', extSym: '©'},

    A: {main: 'A', keyword: 'NEW', sym: 'STOP', ext: 'READ', extSym: '~'},
    S: {main: 'S', keyword: 'SAVE', sym: 'NOT', ext: 'RESTORE', extSym: '|'},
    D: {main: 'D', keyword: 'DIM', sym: 'STEP', ext: 'DATA', extSym: '\\'},
    F: {main: 'F', keyword: 'FOR', sym: 'TO', ext: 'SGN', extSym: '{'},
    G: {main: 'G', keyword: 'GOTO', sym: 'THEN', ext: 'ABS', extSym: '}'},
    H: {main: 'H', keyword: 'GOSUB', sym: '↑', ext: 'SQR', extSym: 'CIRCLE'},
    J: {main: 'J', keyword: 'LOAD', sym: '−', ext: 'VAL', extSym: 'VAL $'},
    K: {main: 'K', keyword: 'LIST', sym: '+', ext: 'LEN', extSym: 'SCREEN $'},
    L: {main: 'L', keyword: 'LET', sym: '=', ext: 'USR', extSym: 'ATTR'},
    ENTER: {label: 'ENTER'},

    CAPS: {label: 'CAPS\nSHIFT'},
    Z: {main: 'Z', keyword: 'COPY', sym: ':', ext: 'LN', extSym: 'BEEP'},
    X: {main: 'X', keyword: 'CLEAR', sym: '£', ext: 'EXP', extSym: 'INK'},
    C: {main: 'C', keyword: 'CONT', sym: '?', ext: 'L PRINT', extSym: 'PAPER'},
    V: {main: 'V', keyword: 'CLS', sym: '/', ext: 'L LIST', extSym: 'FLASH'},
    B: {main: 'B', keyword: 'BORDER', sym: '*', ext: 'BIN', extSym: 'BRIGHT'},
    N: {main: 'N', keyword: 'NEXT', sym: ',', ext: 'IN KEY $', extSym: 'OVER'},
    M: {main: 'M', keyword: 'PAUSE', sym: '.', ext: 'PI', extSym: 'INVERSE'},
    SYMBOL: {label: 'SYMBOL\nSHIFT', ink: 'sym'},
    SPACE: {label: 'BREAK\nSPACE', emphasis: 1},
};

// Where the two machines word the same legend differently. The Next had room
// for the full words.
const PER_MACHINE = {
    plus: {},
    next: {
        '3': {ext: 'MAGENTA'},
        M: {extSym: 'INVERSE'},
        P: {extSym: '(C)'},
    },
};

/**
 * The legend table for one machine.
 * @param {'plus'|'next'|'rubber'} machine
 * @returns {Object} key id → legends
 */
export function legendsFor(machine) {
    if (machine === 'rubber') return RUBBER;
    const overrides = PER_MACHINE[machine] || {};
    const out = {};
    for (const [id, legend] of Object.entries(LEGENDS)) {
        out[id] = overrides[id] ? {...legend, ...overrides[id]} : legend;
    }
    return out;
}
