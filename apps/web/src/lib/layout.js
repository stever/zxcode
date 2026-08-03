import {layoutForChoice, layoutAspect, KEYBOARD_NONE} from "@zxplay/ui/keyboard";

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

// Split mode's emulator column. It is the original 2x size while a keyboard is
// drawn; with none, the screen grows into the height the keyboard had, which
// means width, which comes out of the editor beside it — so it is bounded to
// leave the editor half the page, and never shrinks below what it always was.
const SPLIT_EMU_W = MAX_EMU_W;
const SPLIT_CHROME = 110; // nav + the header slot above the emulator
const MIN_EDITOR_FRACTION = 0.5;

// Split (editor beside emulator) only makes sense with enough width for a
// usable editor AND enough height for a usable emulator; otherwise we tab
// between them so neither gets squeezed.
const SPLIT_MIN_W = 992;
const SPLIT_MIN_H = 600;

// Chrome above the emulator in tab mode (nav bar + tab strip + padding). A
// constant is enough: it only bites in short landscape, where being a little
// conservative just makes the emulator marginally smaller, never overflowing.
const TAB_CHROME = 110;

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
    return Math.max(0, Math.round(Math.min(availW, byHeight, maxW)));
}

/**
 * Emulator width for tab mode: the screen + keyboard centred in the tab, sized
 * to fit the viewport width and the height left under the nav and tab strip.
 * extraChrome adds page-specific chrome above the tabs (e.g. the logged-out
 * demo notice on the home page), estimated by the caller. maxW lifts the 2x cap
 * when there is no keyboard, so the screen takes the space it would have had.
 * @param {{width:Number, height:Number, kbAspect:Number, extraChrome?:Number, maxW?:Number}} params
 * @returns {Number}
 */
export function tabEmulatorWidth({width, height, kbAspect, extraChrome = 0, maxW = MAX_EMU_W}) {
    return fitEmulatorWidth({
        availW: width,
        availH: Math.max(0, height - TAB_CHROME - extraChrome),
        kbAspect,
        maxW,
    });
}

/**
 * Emulator width for split mode (editor beside emulator). With a keyboard it is
 * the original 2x size, as it always was. With none, the screen grows to use the
 * height the keyboard had — bounded so the editor keeps half the page, and never
 * below the size it would have had anyway.
 * @param {{width:Number, height:Number, hidden?:Boolean, extraChrome?:Number}} params
 * @returns {Number}
 */
export function splitEmulatorWidth({width, height, hidden = false, extraChrome = 0}) {
    if (!hidden) return SPLIT_EMU_W;
    const byHeight = Math.max(0, height - SPLIT_CHROME - extraChrome) / SCREEN_ASPECT;
    const byWidth = width * (1 - MIN_EDITOR_FRACTION);
    return Math.round(Math.max(SPLIT_EMU_W, Math.min(byHeight, byWidth)));
}
