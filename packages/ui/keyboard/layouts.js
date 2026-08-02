// Physical key layouts for the three machines: the 48K's forty rubber keys,
// and the fifty-eight of the ZX Spectrum+ / 128K toastrack and the ZX Spectrum
// Next.
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

// The 48K: forty rubber keys, ten to a row, four rows — the grid whose shape
// every keyboard now draws into.
const RUBBER_ROWS = [
    DIGITS,
    TOP,
    [...HOME, 'ENTER'],
    ['CAPS', ...BOTTOM, 'SYMBOL', 'SPACE'],
];
const RUBBER_UNITS = 10;
const RUBBER_GRID_ROWS = 4;

function buildGrid(rows, units, rowCount) {
    const keys = [];
    rows.forEach((row, r) => {
        row.forEach((id, i) => {
            keys.push({id, rects: [{x: i / units, y: r / rowCount, w: 1 / units, h: 1 / rowCount}]});
        });
    });
    return keys;
}

export const LAYOUTS = {
    plus: {name: 'plus', style: 'plastic', aspect: ASPECT, units: UNITS, rows: ROWS,
        keys: build(PLUS_ROWS)},
    next: {name: 'next', style: 'plastic', aspect: ASPECT, units: UNITS, rows: ROWS,
        keys: build(NEXT_ROWS)},
    rubber: {name: 'rubber', style: 'rubber', aspect: RUBBER_GRID_ROWS / RUBBER_UNITS,
        units: RUBBER_UNITS, rows: RUBBER_GRID_ROWS, rainbow: true,
        keys: buildGrid(RUBBER_ROWS, RUBBER_UNITS, RUBBER_GRID_ROWS)},
};

// The characters a game's "k" key string may name, mapped to key ids. A dash
// holds a place without drawing a key.
const KEYSTR_KEYS = {
    e: 'ENTER', c: 'CAPS', s: 'SYMBOL', _: 'SPACE',
    ...Object.fromEntries([...'1234567890QWERTYUIOPASDFGHJKLZXCVBNM'].map((k) => [k, k])),
};

/**
 * A layout for the keys a game named with the "k" query parameter: the same
 * rubber keys, in whatever rows it asked for. Fewer keys in a row means bigger
 * keys, which is the point of naming them.
 *
 * @param {String} keystr comma-separated rows of key characters
 * @returns {Object} a layout, or null when the string names no keys
 */
export function layoutFromKeystr(keystr) {
    const rows = String(keystr || '').split(',').filter((row) => row.length > 0)
        .map((row) => row.slice(0, 10));
    if (!rows.length) return null;

    // Each row's keys are square, so a row of n keys is 1/n of the width tall.
    const heights = rows.map((row) => 1 / row.length);
    const total = heights.reduce((a, b) => a + b, 0);

    const keys = [];
    let y = 0;
    rows.forEach((row, r) => {
        const h = heights[r] / total;
        [...row].forEach((ch, i) => {
            const id = KEYSTR_KEYS[ch];
            if (id) {
                keys.push({id, rects: [{x: i / row.length, y, w: 1 / row.length, h}]});
            }
        });
        y += h;
    });
    return {name: 'rubber', style: 'rubber', aspect: total, units: 10, rows: rows.length, keys};
}

// The second CAPS/SYMBOL SHIFT keys act as (and light with) the first; their
// layout ids carry a suffix so a layout can name both.
export const baseKeyId = (id) => (id === 'CAPS2' ? 'CAPS' : id === 'SYMBOL2' ? 'SYMBOL' : id);

// Every rectangle a key occupies, in fractions of the keyboard.
export const keyRects = (key) => key.rects;

/**
 * The keyboard layout a machine's on-screen keyboard should use.
 * @param {Number|String} machine 48, 128 or 'next'
 * @returns {'rubber'|'plus'|'next'}
 */
export function layoutForMachine(machine) {
    if (machine === 'next') return 'next';
    if (machine === 128 || machine === '128') return 'plus';
    return 'rubber';
}

// What the user can ask for: the keyboard the machine has ('auto'), or one
// named outright. A machine can be running something its own keyboard does not
// suit — a Next in 48K mode, a 128K program driven from BASIC — so the choice
// is worth having (#214). 'auto' is the default and the usual answer.
export const KEYBOARD_CHOICES = ['auto', 'rubber', 'plus', 'next'];

/**
 * The keyboard to draw, given what the user asked for and what machine is
 * selected. An unknown choice falls back to the machine's own keyboard, so a
 * stale saved preference cannot leave the app with no keyboard at all.
 *
 * @param {String} choice one of KEYBOARD_CHOICES
 * @param {Number|String} machine 48, 128 or 'next'
 * @returns {'rubber'|'plus'|'next'}
 */
export function layoutForChoice(choice, machine) {
    if (choice && choice !== 'auto' && LAYOUTS[choice]) return choice;
    return layoutForMachine(machine);
}

/**
 * Height / width of a layout drawn at a given width — the shape the app's
 * responsive layout needs before anything is rendered. The same for all three
 * machines, so switching between them moves nothing on the page.
 * @param {'rubber'|'plus'|'next'} name
 * @returns {Number}
 */
export function layoutAspect(name) {
    const layout = LAYOUTS[name];
    return layout ? layout.aspect : 0;
}
