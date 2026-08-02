// Physical key layouts for the machines whose keyboards are not the 48K's
// 40 rubber keys: the ZX Spectrum+ / 128K toastrack, and the ZX Spectrum Next.
//
// Both machines lay their 58 keys on the SAME grid — 13.5 key widths across,
// five rows down — and every key is a whole or a quarter of a key width. That
// is not a simplification: measuring the keys off photographs of both machines
// gives those figures to within a percent. So one geometry serves both, the two
// keyboards are identical in size, and their rows line up with each other.
//
// They arrange the keys differently, hence a row table each: the Spectrum+
// opens its top row with TRUE VIDEO / INV VIDEO and ends it with BREAK, where
// the Next opens with BREAK / EDIT and ends with DELETE. Both have the L-shaped
// ENTER, given here as the two rectangles it spans (`ENTER_TOP` beside P, the
// wider `ENTER` beside L) and drawn as one moulding.

const UNITS = 13.5; // key widths across
const ROWS = 5;
// Height / width of the whole keyboard: the 48K's rubber keyboard, which is
// four rows of ten square keys. Every machine's keyboard therefore draws into
// the SAME box, so switching machine moves nothing on the page. Both these
// machines measure a shade under it (0.377, a row being a touch taller than a
// key width), so their keys end up a few percent taller than square.
const ASPECT = 4 / 10;

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];
const TOP = ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'];
const HOME = ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'];
const BOTTOM = ['Z', 'X', 'C', 'V', 'B', 'N', 'M'];

// Rows of ids, or [id, widthInKeyWidths] where a key is wider than one.
const PLUS_ROWS = [
    ['TRUEVIDEO', 'INVVIDEO', ...DIGITS, ['BREAK', 1.5]],
    [['DELETE', 1.5], 'GRAPH', ...TOP, 'ENTER_TOP'],
    [['EXTEND', 1.5], ['EDIT', 1.25], ...HOME, ['ENTER', 1.75]],
    [['CAPS', 2.25], 'CAPSLOCK', ...BOTTOM, 'PERIOD', ['CAPS2', 2.25]],
    ['SYMBOL', 'SEMI', 'QUOTE', 'LEFT', 'RIGHT', ['SPACE', 4.5], 'UP', 'DOWN', 'COMMA', 'SYMBOL2'],
];

const NEXT_ROWS = [
    ['BREAK', 'EDIT', ...DIGITS, ['DELETE', 1.5]],
    [['TRUEVIDEO', 1.25], ['INVVIDEO', 1.25], ...TOP, 'ENTER_TOP'],
    [['CAPSLOCK', 1.5], ['GRAPH', 1.25], ...HOME, ['ENTER', 1.75]],
    [['CAPS', 2.25], ['EXTEND', 1.25], ...BOTTOM, 'UP', ['CAPS2', 2]],
    ['SYMBOL', 'SEMI', 'QUOTE', 'COMMA', 'PERIOD', ['SPACE', 4.5], 'LEFT', 'DOWN', 'RIGHT',
        'SYMBOL2'],
];

// Rows of ids become keys with rectangles in fractions of the whole keyboard,
// and the two halves of ENTER become one key.
function build(rows) {
    const keys = [];
    const byId = {};
    rows.forEach((row, r) => {
        let x = 0;
        for (const entry of row) {
            const [id, w = 1] = Array.isArray(entry) ? entry : [entry];
            const rect = {x: x / UNITS, y: r / ROWS, w: w / UNITS, h: 1 / ROWS};
            const key = id === 'ENTER_TOP' ? 'ENTER' : id;
            if (byId[key]) {
                byId[key].rects.push(rect);
            } else {
                byId[key] = {id: key, rects: [rect]};
                keys.push(byId[key]);
            }
            x += w;
        }
    });
    // ENTER's narrow piece is entered first; keep its rectangles top to bottom.
    for (const key of keys) key.rects.sort((a, b) => a.y - b.y);
    return keys;
}

export const LAYOUTS = {
    plus: {name: 'plus', aspect: ASPECT, units: UNITS, rows: ROWS, keys: build(PLUS_ROWS)},
    next: {name: 'next', aspect: ASPECT, units: UNITS, rows: ROWS, keys: build(NEXT_ROWS)},
};

// The second CAPS/SYMBOL SHIFT keys act as (and light with) the first; their
// layout ids carry a suffix so a layout can name both.
export const baseKeyId = (id) => (id === 'CAPS2' ? 'CAPS' : id === 'SYMBOL2' ? 'SYMBOL' : id);

// Every rectangle a key occupies, in fractions of the keyboard.
export const keyRects = (key) => key.rects;

/**
 * The keyboard layout a machine's on-screen keyboard should use, or null when
 * the machine keeps the 48K's rubber-key art.
 * @param {Number|String} machine 48, 128 or 'next'
 * @returns {'plus'|'next'|null}
 */
export function layoutForMachine(machine) {
    if (machine === 'next') return 'next';
    if (machine === 128 || machine === '128') return 'plus';
    return null;
}

/**
 * Height / width of a layout drawn at a given width — the shape the app's
 * responsive layout needs before anything is rendered. The same for both
 * machines, so switching between them moves nothing on the page.
 * @param {'plus'|'next'} name
 * @returns {Number}
 */
export function layoutAspect(name) {
    const layout = LAYOUTS[name];
    return layout ? layout.aspect : 0;
}
