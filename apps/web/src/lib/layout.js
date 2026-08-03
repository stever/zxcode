import {layoutForChoice, layoutAspect, KEYBOARD_NONE} from "@zxplay/ui/keyboard";
import {PIXEL_UNIT, snapToWholeScale} from "@zxplay/ui/display";

// Pure, viewport-driven layout for the editor + emulator across orientations.
//
// The emulator stacks the screen above the on-screen keyboard, so its total
// height at a given width W is W * (SCREEN_ASPECT + kbAspect). That lets us size
// the emulator to fit whatever box it has, instead of pinning a fixed 640px.

// Screen aspect is 5:4: the zxplay_go engine composites every machine into a
// fixed 640x512 display box, and UIController sizes the on-screen element from
// the canvas's real shape, so the maths has to assume the same ratio. (It read
// 240/320 = 0.75 — the Spectrum's own screen without border — which sized the
// emulator about 6% shorter than it draws, and so overflowed its box.)
const SCREEN_ASPECT = 512 / 640; // 0.8, screen height / width
const MAX_EMU_W = 640; // never larger than the original 2x size
// Where split mode stops shrinking the screen and lets the page scroll instead.
// Below 1x rather than at it: at the smallest split viewport (992x600) with a
// wrapped toolbar the fit lands just under 320, and a screen a few pixels
// narrower is a better answer than a page that scrolls. It is a floor against
// the screen vanishing, not a target — at every ordinary viewport the fit wins.
const MIN_EMU_W = 256;

// The only chrome worth constants, because it is this repo's own stylesheet
// rather than anything that varies: the shell's bottom padding (pb-1), and in
// split mode the page wrapper's margin (mb-1) plus the 1px border that
// `.desktop .emulator-frame` draws around the screen — which is height the
// emulator costs beyond the size it was given. Everything else above and below
// the panels is MEASURED and passed in; see usePageMetrics.js for why guessing
// it was the bug.
const PAGE_BOTTOM = 4;
export const SPLIT_EMU_CHROME = 6; // mb-1 (4) + the frame's top and bottom border
const FRAME_BORDER = 2;

const MIN_EDITOR_FRACTION = 0.5;

// How narrow the on-screen keyboard may get, as a fraction of the screen above
// it, when pixel-perfect scaling buys the screen a whole scale out of the
// keyboard's height. Narrower than this and it stops reading as part of the
// same machine, and the smaller whole scale is the better answer.
const MIN_KB_FRACTION = 0.6;

// Split (editor beside emulator) only makes sense with enough width for a
// usable editor AND enough height for a usable emulator; otherwise we tab
// between them so neither gets squeezed.
const SPLIT_MIN_W = 992;
const SPLIT_MIN_H = 600;

// The debug dock's own furniture above its scrolling pane bodies: 2 border +
// 39 transport + 31 registers + 30 pane head.
const DOCK_CHROME = 102;
const MIN_PANE_H = 96; // five 19px rows: the least that still reads as a pane
const MAX_PANE_H = 252; // what it has always been; no reason to grow past it
// About nine lines at the editor's 16px: what the editor keeps when a debug
// session is open in the shortest window split mode allows. Together with the
// dock's own minimum this is what has to fit in 992x600, so it is a floor
// chosen to fit, not a comfortable size — every larger window gives more.
const MIN_EDITOR_H = 150;
const DOCK_GAP = 8; // editor-to-dock gap (the dock's own margin)

// Full ZX Spectrum keyboard; games may override it via the "k" query parameter.
export const DEFAULT_KEYSTR = '1234567890,QWERTYUIOP,ASDFGHJKLe,cZXCVBNMs_';

/**
 * The on-screen keyboard string in effect (URL "k" override, else the default).
 * @returns {String}
 */
export function currentKeystr() {
    try {
        const k = new URL(window.location.href).searchParams.get('k');
        if (k) return k;
    } catch (e) {
        // Ignore a malformed URL and fall back to the default keyboard.
    }
    return DEFAULT_KEYSTR;
}

/**
 * Keyboard aspect (height / width) for a key string, matching renderKeyboard's
 * per-row sizing: each row contributes 1 / keysInRow (capped at 10) to height.
 * @param {String} keystr
 * @returns {Number}
 */
export function keyboardAspect(keystr) {
    const rows = keystr.split(',').filter(row => row.length > 0);
    let aspect = 0;
    for (const row of rows) {
        let len = row.length;
        if (len > 10) len = 10; // renderKeyboard caps a row at 10 keys
        aspect += 1 / len;
    }
    return aspect;
}

/**
 * Whether the "k" query parameter names its own keys.
 * @returns {Boolean}
 */
export function hasKeystrOverride() {
    try {
        return !!new URL(window.location.href).searchParams.get('k');
    } catch (e) {
        return false; // A malformed URL names nothing.
    }
}

/**
 * Decide which keyboard is drawn, and the shape it draws at.
 *
 * Keys named by the "k" parameter are kept on every machine. Otherwise the
 * user's own choice wins, and failing that the keyboard matches the machine:
 * the 128K gets the Spectrum+ / toastrack layout, the Next its own, and the
 * 48K the rubber keys it has always had.
 *
 * "hidden" is what the pages branch on, not the layout: a null layout already
 * means "the k= keys are drawn instead", which is the opposite of no keyboard.
 * "aspect" is the height actually given to a keyboard, so it is 0 when there is
 * none — the emulator's own box is what grows into it.
 *
 * @param {Number|String} machine
 * @param {String} [choice] the keyboard the user picked, 'auto' to follow the machine
 * @returns {{layout:(String|null), hidden:Boolean, aspect:Number}}
 */
export function resolveKeyboard(machine, choice = 'auto') {
    if (hasKeystrOverride()) {
        return {layout: null, hidden: false, aspect: keyboardAspect(currentKeystr())};
    }
    const layout = layoutForChoice(choice, machine);
    return {layout, hidden: layout === KEYBOARD_NONE, aspect: layoutAspect(layout)};
}

/**
 * Choose the layout from the viewport alone, so the app shell (body class) and
 * the pages agree without measuring the DOM.
 * @param {Number} width
 * @param {Number} height
 * @returns {'tab'|'split'}
 */
export function computeMode(width, height) {
    return (width >= SPLIT_MIN_W && height >= SPLIT_MIN_H) ? 'split' : 'tab';
}

/**
 * Largest emulator width that fits the available box in both dimensions, capped
 * so it never exceeds the original size.
 * @param {{availW:Number, availH:Number, kbAspect:Number, maxW?:Number}} params
 * @returns {Number}
 */
export function fitEmulatorWidth({availW, availH, kbAspect, maxW = MAX_EMU_W}) {
    const totalAspect = SCREEN_ASPECT + kbAspect;
    const byHeight = totalAspect > 0 ? availH / totalAspect : availW;
    // Down, not nearest: the answer is the largest width that FITS, and half a
    // pixel over a bound is the scrollbar this whole calculation exists to
    // avoid.
    return Math.max(0, Math.floor(Math.min(availW, byHeight, maxW)));
}

/**
 * The height a panel has: from where it starts to the bottom of the viewport,
 * less whatever is reserved under it (the toolbar spanning the page beneath
 * both split-mode columns).
 * @param {{viewportH:Number, top:Number, reserveBelow?:Number}} params
 * @returns {Number}
 */
export function panelHeight({viewportH, top, reserveBelow = 0}) {
    return Math.max(0, viewportH - top - reserveBelow - PAGE_BOTTOM);
}

/**
 * How tall the debugger's panes may be, given the height left for the editor
 * and the dock together — the column's height LESS the editor's own chrome,
 * which is height neither of them can have. The panes scroll internally, so
 * they are what gives up height, down to the point where they stop showing
 * anything useful; below that the editor's floor takes over and it scrolls.
 * @param {Number} availH
 * @returns {{dockH:Number, paneH:Number}}
 */
export function dockSplit(availH) {
    const forPanes = availH - MIN_EDITOR_H - DOCK_GAP - DOCK_CHROME;
    const paneH = Math.round(Math.min(MAX_PANE_H, Math.max(MIN_PANE_H, forPanes)));
    return {dockH: DOCK_CHROME + paneH, paneH};
}

/**
 * The editor's height, so that its column comes to `columnH` — level with the
 * emulator column beside it in split mode, or the rest of the viewport in tab
 * mode. `chrome` is everything else in the editor's own tab view, measured
 * rather than named (usePageMetrics.js), so this stays right whatever sits
 * around the editor; `dockH` is the debugger below it, which the page knows
 * because it decided it.
 * @param {{columnH:Number, chrome:Number, dockH?:Number}} params
 * @returns {Number}
 */
export function editorHeight({columnH, chrome, dockH = 0}) {
    const dock = dockH > 0 ? dockH + DOCK_GAP : 0;
    return Math.max(MIN_EDITOR_H, Math.round(columnH - chrome - dock));
}

/**
 * The emulator's size in the box it has been measured into.
 *
 * `floor` stops split mode shrinking the screen away to nothing beside the
 * editor, at the price of a page that scrolls. Tab mode has no floor — the
 * panel is the whole page there, so fitting it is always the right answer.
 *
 * `pixelPerfect` rounds the SCREEN down to a whole scale of the display, so
 * every Spectrum pixel is drawn the same size. It never asks for more room than
 * the box has.
 *
 * `kbW` is the width the keyboard is drawn at. It is the screen's width in
 * every ordinary case, and narrower only where pixel-perfect scaling had to buy
 * the screen a whole scale out of the keyboard's height — see below.
 *
 * @param {{availW:Number, availH:Number, kbAspect:Number, hidden?:Boolean,
 *          floor?:Number, pixelPerfect?:Boolean}} params
 * @returns {{emuW:Number, kbW:Number, emuH:Number}}
 */
export function emulatorSize({availW, availH, kbAspect, hidden = false, floor = 0,
                              pixelPerfect = false}) {
    // With no keyboard under it the screen takes the space the keyboard had, so
    // the 2x cap is what would stop it using the box it has been given.
    const maxW = hidden ? Infinity : MAX_EMU_W;
    const fitted = fitEmulatorWidth({availW, availH, kbAspect, maxW});

    if (!pixelPerfect) {
        const emuW = Math.max(floor, fitted);
        return {emuW, kbW: emuW, emuH: Math.round(emuW * (SCREEN_ASPECT + kbAspect))};
    }
    if (kbAspect <= 0) {
        // Nothing under the screen to trade against: the fit simply rounds down.
        const emuW = Math.max(floor, snapToWholeScale(fitted));
        return {emuW, kbW: 0, emuH: Math.round(emuW * SCREEN_ASPECT)};
    }

    // The screen must land on a whole scale; the keyboard need not follow it,
    // having no pixel grid of its own — it is drawn to whatever box it is
    // given. So the keyboard's height is what buys the screen its scale: ask
    // what would fit with the keyboard at its narrowest, round THAT down to a
    // whole scale, and hand the keyboard whatever height is then left over.
    //
    // Without this the screen pays instead, and it pays in whole scales: a
    // window 8px short of 2x dropped the screen from 640 to 320, because 1x is
    // the only whole scale under 2x. Now the keyboard gives up those 8px and
    // the screen stays at 640 — at 96% of its width, which is not visible.
    const relaxed = snapToWholeScale(
        fitEmulatorWidth({availW, availH, kbAspect: kbAspect * MIN_KB_FRACTION, maxW}));
    if (relaxed < PIXEL_UNIT) {
        // No whole scale fits even with the keyboard at its narrowest, so
        // narrowing it buys the screen nothing — it would still be off the grid.
        // Fall back to filling the box, keyboard matching the screen.
        const emuW = Math.max(floor, fitted);
        return {emuW, kbW: emuW, emuH: Math.round(emuW * (SCREEN_ASPECT + kbAspect))};
    }
    const emuW = Math.max(floor, relaxed);
    const screenH = emuW * SCREEN_ASPECT;
    // Never wider than the screen (the ordinary case, when there is room), and
    // never taller than the height left under it.
    const kbW = Math.max(0,
        Math.min(emuW, Math.floor(Math.max(0, availH - screenH) / kbAspect)));
    return {emuW, kbW, emuH: Math.round(screenH + kbW * kbAspect)};
}

/**
 * The emulator in split mode (editor beside emulator). Sized to the height it
 * actually has rather than pinned at the original 2x column, which is what used
 * to scroll the page on any laptop; 2x stays its cap while a keyboard is drawn,
 * and with none the screen grows into the keyboard's height — which means
 * width, bounded so the editor keeps half the page.
 * @param {{width:Number, availH:Number, kbAspect:Number, hidden?:Boolean}} params
 * @returns {{emuW:Number, emuH:Number}}
 */
export function splitEmulator({width, availH, kbAspect, hidden = false, pixelPerfect = false}) {
    return emulatorSize({
        availW: width * (1 - MIN_EDITOR_FRACTION),
        availH,
        kbAspect,
        hidden,
        floor: MIN_EMU_W,
        pixelPerfect,
    });
}

/**
 * The bottom edge of the emulator's column, which is what the editor beside it
 * is levelled with: where the emulator starts, its own height, and the frame's
 * border around it.
 * @param {{emuTop:Number, emuH:Number}} params
 * @returns {Number}
 */
export function emulatorBottom({emuTop, emuH}) {
    return emuTop + emuH + FRAME_BORDER;
}

/**
 * The emulator in tab mode: the whole panel is its box.
 * @param {{width:Number, availH:Number, kbAspect:Number, hidden?:Boolean}} params
 * @returns {{emuW:Number, emuH:Number}}
 */
export function tabEmulator({width, availH, kbAspect, hidden = false, pixelPerfect = false}) {
    return emulatorSize({availW: width, availH, kbAspect, hidden, pixelPerfect});
}
