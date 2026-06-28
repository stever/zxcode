// Pure, viewport-driven layout for the editor + emulator across orientations.
//
// The emulator stacks a 4:3 screen above the on-screen keyboard, so its total
// height at a given width W is W * (SCREEN_ASPECT + kbAspect). That lets us size
// the emulator to fit whatever box it has, instead of pinning a fixed 640px.

const SCREEN_ASPECT = 240 / 320; // 0.75, screen height / width
const MAX_EMU_W = 640; // never larger than the original 2x size

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
 * @param {{width:Number, height:Number, kbAspect:Number}} params
 * @returns {Number}
 */
export function tabEmulatorWidth({width, height, kbAspect}) {
    return fitEmulatorWidth({
        availW: width,
        availH: Math.max(0, height - TAB_CHROME),
        kbAspect,
    });
}
