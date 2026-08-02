// What each drawable key DOES: the PC key codes a virtual press dispatches,
// and the keyboard-matrix positions it ends up holding down.
//
// Presses go out as synthetic key events aimed at the emulator canvas, exactly
// as the 40-key rubber keyboard has always done — the engine's
// StandardKeyboardHandler turns them into matrix positions. The dedicated keys
// the Spectrum+ / Next add (EDIT, GRAPH, EXTEND MODE, TRUE/INV VIDEO, BREAK,
// the cursors and the punctuation keys) have no PC key code of their own, so
// they dispatch TWO codes: the shift, then the key. That is the same path a
// physical PC keyboard already takes — holding Shift and pressing 1 is EDIT —
// so nothing in the emulator package has to know about them.
//
// `matrix` lists the (row, mask) positions the key holds. It must match the
// engine's SPECCY table (packages/emulator/src/KeyboardHandler.js); the apps
// use it to mirror the machine's real key state back onto the drawn keys, and
// a combination key lights only when EVERY position it names is down.

const CAPS = 16;
const SYM = 17;

// Matrix positions, named as in the engine's SPECCY table.
const M = {
    ONE: [3, 0x01], TWO: [3, 0x02], THREE: [3, 0x04], FOUR: [3, 0x08], FIVE: [3, 0x10],
    SIX: [4, 0x10], SEVEN: [4, 0x08], EIGHT: [4, 0x04], NINE: [4, 0x02], ZERO: [4, 0x01],
    Q: [2, 0x01], W: [2, 0x02], E: [2, 0x04], R: [2, 0x08], T: [2, 0x10],
    Y: [5, 0x10], U: [5, 0x08], I: [5, 0x04], O: [5, 0x02], P: [5, 0x01],
    A: [1, 0x01], S: [1, 0x02], D: [1, 0x04], F: [1, 0x08], G: [1, 0x10],
    H: [6, 0x10], J: [6, 0x08], K: [6, 0x04], L: [6, 0x02], ENTER: [6, 0x01],
    CAPS: [0, 0x01], Z: [0, 0x02], X: [0, 0x04], C: [0, 0x08], V: [0, 0x10],
    B: [7, 0x10], N: [7, 0x08], M: [7, 0x04], SYMBOL: [7, 0x02], SPACE: [7, 0x01],
};

const simple = (code, matrix) => ({codes: [code], matrix: [matrix]});
// A dedicated key: hold CAPS SHIFT (or SYMBOL SHIFT) and press another key.
const withCaps = (code, matrix) => ({codes: [CAPS, code], matrix: [M.CAPS, matrix]});
const withSym = (code, matrix) => ({codes: [SYM, code], matrix: [M.SYMBOL, matrix]});

export const KEY_ACTIONS = {
    '1': simple(49, M.ONE), '2': simple(50, M.TWO), '3': simple(51, M.THREE),
    '4': simple(52, M.FOUR), '5': simple(53, M.FIVE), '6': simple(54, M.SIX),
    '7': simple(55, M.SEVEN), '8': simple(56, M.EIGHT), '9': simple(57, M.NINE),
    '0': simple(48, M.ZERO),

    Q: simple(81, M.Q), W: simple(87, M.W), E: simple(69, M.E), R: simple(82, M.R),
    T: simple(84, M.T), Y: simple(89, M.Y), U: simple(85, M.U), I: simple(73, M.I),
    O: simple(79, M.O), P: simple(80, M.P),

    A: simple(65, M.A), S: simple(83, M.S), D: simple(68, M.D), F: simple(70, M.F),
    G: simple(71, M.G), H: simple(72, M.H), J: simple(74, M.J), K: simple(75, M.K),
    L: simple(76, M.L),

    Z: simple(90, M.Z), X: simple(88, M.X), C: simple(67, M.C), V: simple(86, M.V),
    B: simple(66, M.B), N: simple(78, M.N), M: simple(77, M.M),

    ENTER: simple(13, M.ENTER),
    CAPS: simple(CAPS, M.CAPS),
    SYMBOL: simple(SYM, M.SYMBOL),
    SPACE: simple(32, M.SPACE),

    // CAPS SHIFT combinations, in the order the machine prints them on the
    // number row: EDIT CAPS-LOCK TRUE-VIDEO INV-VIDEO ← ↓ ↑ → GRAPH DELETE.
    EDIT: withCaps(49, M.ONE),
    CAPSLOCK: withCaps(50, M.TWO),
    TRUEVIDEO: withCaps(51, M.THREE),
    INVVIDEO: withCaps(52, M.FOUR),
    LEFT: withCaps(53, M.FIVE),
    DOWN: withCaps(54, M.SIX),
    UP: withCaps(55, M.SEVEN),
    RIGHT: withCaps(56, M.EIGHT),
    GRAPH: withCaps(57, M.NINE),
    DELETE: withCaps(48, M.ZERO),
    BREAK: withCaps(32, M.SPACE),
    // EXTEND MODE is both shifts at once.
    EXTEND: {codes: [CAPS, SYM], matrix: [M.CAPS, M.SYMBOL]},

    // SYMBOL SHIFT combinations for the punctuation keys.
    SEMI: withSym(79, M.O),
    QUOTE: withSym(80, M.P),
    COMMA: withSym(78, M.N),
    PERIOD: withSym(77, M.M),
};

// Key into the flat table the apps use to mirror matrix events onto keys.
export const matrixKey = (row, mask) => row * 256 + mask;
