// Pure, viewport-driven layout for the emulator + on-screen keyboard.
//
// Screen aspect is 4:3 (the emulator canvas is 320x240). The keyboard's aspect
// (height / width) is derived from its key configuration: each comma-separated
// row contributes 1 / keysInRow to the total height when the keyboard is drawn
// at a given width, matching renderKeyboard's per-row sizing.

const MAX_SCREEN_W = 640; // cap so the screen isn't huge on wide desktops
const GAP = 0; // no gap between screen and keyboard
const MIN_KB_W = 160; // keep the keyboard usable in side-by-side mode

const SCREEN_ASPECT = 3 / 4; // height / width

/**
 * Parse a keyboard key string (e.g. "1234567890,QWERTYUIOP,...") into the shape
 * the layout and renderer need.
 * @param {String} keystr comma-separated rows of key characters
 * @returns {{keystr: String, rowCount: Number, maxCols: Number, aspect: Number}}
 */
export function parseKeyConfig(keystr) {
    const rows = keystr.split(',').filter(row => row.length > 0);

    let aspect = 0;
    let maxCols = 0;

    for (const row of rows) {
        let len = row.length;
        if (len > 10) len = 10; // renderKeyboard caps a row at 10 keys
        aspect += 1 / len;
        if (len > maxCols) maxCols = len;
    }

    return {keystr, rowCount: rows.length, maxCols, aspect};
}

/**
 * Compute concrete pixel sizes and a layout mode for the current viewport.
 *
 * Stacked (screen above keyboard) is preferred and used whenever it fits the
 * available height, or whenever the viewport is portrait. Otherwise the screen
 * fills the height and the keyboard takes the remaining width beside it.
 *
 * @param {{width:Number, height:Number, navHeight?:Number, kbAspect:Number, side?:('left'|'right')}} params
 * @returns {{mode:('stacked'|'side'), screenW:Number, screenH:Number, kbW:Number, kbH:Number, side:String}}
 */
export function computeLayout({width, height, navHeight = 0, kbAspect, side = 'right'}) {
    const availW = Math.max(0, width);
    const availH = Math.max(0, height - navHeight);

    // Stacked candidate: keyboard drawn at the screen width.
    const screenW_stack = Math.min(availW, MAX_SCREEN_W);
    const screenH_stack = screenW_stack * SCREEN_ASPECT;
    const kbH_stack = screenW_stack * kbAspect;
    const totalH_stack = screenH_stack + GAP + kbH_stack;

    const portrait = width <= height;

    if (portrait || totalH_stack <= availH) {
        return {
            mode: 'stacked',
            screenW: Math.round(screenW_stack),
            screenH: Math.round(screenH_stack),
            kbW: Math.round(screenW_stack),
            kbH: Math.round(kbH_stack),
            side,
        };
    }

    // Side-by-side: screen fills the height, keyboard takes what's left.
    let screenH = availH;
    let screenW = screenH / SCREEN_ASPECT;

    const maxScreenW = availW - MIN_KB_W - GAP;
    if (screenW > maxScreenW) {
        screenW = Math.max(0, maxScreenW);
        screenH = screenW * SCREEN_ASPECT;
    }

    let kbW = availW - screenW - GAP;
    let kbH = kbW * kbAspect;
    if (kbH > availH) {
        kbH = availH;
        kbW = kbAspect ? kbH / kbAspect : kbW;
    }

    return {
        mode: 'side',
        screenW: Math.round(screenW),
        screenH: Math.round(screenH),
        kbW: Math.round(kbW),
        kbH: Math.round(kbH),
        side,
    };
}
