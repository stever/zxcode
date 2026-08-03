import {layoutForChoice, layoutForMachine, layoutAspect, KEYBOARD_NONE} from "@zxplay/ui/keyboard";

// Pure, viewport-driven layout for the emulator + on-screen keyboard.
//
// Screen aspect is 5:4 (the zxplay_go engine composites every machine into a
// fixed 640x512 display box; UIController sizes the on-screen element from
// the canvas's real shape, so the layout must assume the same ratio or the
// landscape screen overflows the height it was given). The keyboard's aspect
// (height / width) is derived from its key configuration: each comma-separated
// row contributes 1 / keysInRow to the total height when the keyboard is drawn
// at a given width, matching renderKeyboard's per-row sizing.

const MAX_SCREEN_W = 640; // cap so the screen isn't huge on wide desktops
const MIN_KB_W = 160; // keep the keyboard (and the nav under it) usable side by side
const NAV_ESTIMATE = 48; // nominal nav height used only for the mode decision

// Everything between the nav and the bottom of the page that is not the screen
// itself: the desktop's top spacing, the frame's border, the shell's bottom
// padding, the nav's own margin. Measured at 17px; a few px of slack because it
// only matters with no keyboard, where the screen is sized to the height left
// over and being over by one raises a scrollbar for the whole page.
const STACK_CHROME = 24;

const SCREEN_ASPECT = 512 / 640; // height / width

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
 * Decide which keyboard the player gets, and the shape it draws at.
 *
 * A game that names its own keys (the "k" query parameter) keeps them on every
 * machine — a five-key play surface is the point, and it stays the same size on
 * a phone, so it outranks both of the choices below. Otherwise the player's own
 * choice wins, and failing that the keyboard matches the machine: the 48K's
 * rubber keys, the 128K's Spectrum+ / toastrack layout, or the Next's own.
 *
 * That holds for asking for no keyboard as well: a game's named keys may be the
 * only controls a phone has, so the choice comes back on the next game rather
 * than leaving this one unplayable.
 *
 * "hidden" is what the layout branches on, not the layout name: a null layout
 * already means "the k= keys are drawn instead", the opposite of no keyboard.
 * "aspect" is the shape the keyboard draws at whether or not it is drawn, so
 * that hiding it keeps the page's shape (see computeMode) and only frees the
 * room it was holding.
 *
 * @param {{keystr:String, aspect:Number, override:Boolean}} keyConfig
 * @param {Number|String} machine
 * @param {String} [choice] the keyboard the player picked, 'auto' to follow the machine
 * @returns {{layout:(String|null), keystr:(String|null), hidden:Boolean, aspect:Number}}
 */
export function resolveKeyboard(keyConfig, machine, choice = 'auto') {
    if (keyConfig.override) {
        return {layout: null, keystr: keyConfig.keystr, hidden: false, aspect: keyConfig.aspect};
    }
    const layout = layoutForChoice(choice, machine);
    const hidden = layout === KEYBOARD_NONE;
    return {
        layout,
        keystr: null,
        hidden,
        aspect: layoutAspect(hidden ? layoutForMachine(machine) : layout),
    };
}

/**
 * Decide the layout mode from the viewport alone (no DOM measurement), so both
 * the app shell and the home page agree on it. Stacked (screen above keyboard,
 * nav on top) is used in portrait and whenever it would fit the height;
 * otherwise side-by-side (screen fills the height, nav + keyboard beside it).
 *
 * The decision is deliberately the same whether or not the keyboard is drawn
 * (resolveKeyboard reports its shape either way): hiding a keyboard should give
 * the screen the room it had, not rearrange the page around it. Any laptop
 * window shorter than about 800px is side by side, and flipping those back to a
 * stack would cost the screen the nav's height — more than the keyboard freed.
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
 * With no keyboard the screen takes the room the keyboard had, which is the
 * point of asking for none rather than just hiding one: stacked, it grows past
 * the 2x cap into the height left under the nav. Side by side it is already the
 * full height, so there the keyboard simply goes.
 *
 * @param {{width:Number, height:Number, navHeight?:Number, kbAspect:Number, hidden?:Boolean, side?:('left'|'right')}} params
 * @returns {{mode:('stacked'|'side'), screenW:Number, screenH:Number, kbW:Number, kbH:Number, colW:Number, side:String}}
 */
export function computeLayout({width, height, navHeight = 0, kbAspect, hidden = false,
                               side = 'right'}) {
    const availW = Math.max(0, width);
    const mode = computeMode({width, height, kbAspect});

    if (mode === 'stacked') {
        // With a keyboard, computeMode has already decided the stack fits the
        // height, so width (capped) is what sizes the screen. With none, the
        // height left under the nav is the other bound, and the cap goes.
        const byHeight = Math.max(0, height - navHeight - STACK_CHROME) / SCREEN_ASPECT;
        const screenW = hidden
            ? Math.min(availW, byHeight)
            : Math.min(availW, MAX_SCREEN_W);
        const screenH = screenW * SCREEN_ASPECT;
        return {
            mode,
            screenW: Math.round(screenW),
            screenH: Math.round(screenH),
            kbW: hidden ? 0 : Math.round(screenW),
            kbH: hidden ? 0 : Math.round(screenW * kbAspect),
            colW: Math.round(screenW),
            side,
        };
    }

    // Side-by-side: screen fills the full height; nav + keyboard share the
    // remaining width on the opposite side. With no keyboard the column keeps its
    // width and only the keyboard goes: the screen already has the whole height,
    // so it has no use for more width, and the compact nav needs the column.
    let screenH = height;
    let screenW = screenH / SCREEN_ASPECT;

    const maxScreenW = availW - MIN_KB_W;
    if (screenW > maxScreenW) {
        screenW = Math.max(0, maxScreenW);
        screenH = screenW * SCREEN_ASPECT;
    }

    const colW = availW - screenW;
    const kbAreaH = Math.max(0, height - navHeight);

    let kbW = hidden ? 0 : colW;
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
