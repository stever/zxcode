// Pure, viewport-driven layout for the emulator + on-screen keyboard.
//
// Screen aspect is 4:3 (the emulator canvas is 320x240). The keyboard's aspect
// (height / width) is derived from its key configuration: each comma-separated
// row contributes 1 / keysInRow to the total height when the keyboard is drawn
// at a given width, matching renderKeyboard's per-row sizing.

const MAX_SCREEN_W = 640; // cap so the screen isn't huge on wide desktops
const MIN_KB_W = 160; // keep the keyboard usable in side-by-side mode
const NAV_ESTIMATE = 48; // nominal nav height used only for the mode decision

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
 * Decide the layout mode from the viewport alone (no DOM measurement), so both
 * the app shell and the home page agree on it. Stacked (screen above keyboard,
 * nav on top) is used in portrait and whenever it would fit the height;
 * otherwise side-by-side (screen fills the height, nav + keyboard beside it).
 *
 * @param {{width:Number, height:Number, kbAspect:Number}} params
 * @returns {'stacked'|'side'}
 */
export function computeMode({width, height, kbAspect}) {
    if (width <= height) return 'stacked';
    const screenW = Math.min(width, MAX_SCREEN_W);
    const stackedH = screenW * SCREEN_ASPECT + screenW * kbAspect + NAV_ESTIMATE;
    return stackedH <= height ? 'stacked' : 'side';
}

/**
 * Compute concrete pixel sizes for the current viewport.
 *
 * In side-by-side mode the screen uses the full viewport height (the nav sits in
 * the keyboard column, not above the screen), and the keyboard is sized to fit
 * the remaining width beside it, below the nav.
 *
 * @param {{width:Number, height:Number, navHeight?:Number, kbAspect:Number, side?:('left'|'right')}} params
 * @returns {{mode:('stacked'|'side'), screenW:Number, screenH:Number, kbW:Number, kbH:Number, colW:Number, side:String}}
 */
export function computeLayout({width, height, navHeight = 0, kbAspect, side = 'right'}) {
    const availW = Math.max(0, width);
    const mode = computeMode({width, height, kbAspect});

    if (mode === 'stacked') {
        const screenW = Math.min(availW, MAX_SCREEN_W);
        const screenH = screenW * SCREEN_ASPECT;
        return {
            mode,
            screenW: Math.round(screenW),
            screenH: Math.round(screenH),
            kbW: Math.round(screenW),
            kbH: Math.round(screenW * kbAspect),
            colW: Math.round(screenW),
            side,
        };
    }

    // Side-by-side: screen fills the full height; nav + keyboard share the
    // remaining width on the opposite side.
    let screenH = height;
    let screenW = screenH / SCREEN_ASPECT;

    const maxScreenW = availW - MIN_KB_W;
    if (screenW > maxScreenW) {
        screenW = Math.max(0, maxScreenW);
        screenH = screenW * SCREEN_ASPECT;
    }

    const colW = availW - screenW;
    const kbAreaH = Math.max(0, height - navHeight);

    let kbW = colW;
    let kbH = kbW * kbAspect;
    if (kbH > kbAreaH) {
        kbH = kbAreaH;
        kbW = kbAspect ? kbH / kbAspect : kbW;
    }

    return {
        mode,
        screenW: Math.round(screenW),
        screenH: Math.round(screenH),
        kbW: Math.round(kbW),
        kbH: Math.round(kbH),
        colW: Math.round(colW),
        side,
    };
}
