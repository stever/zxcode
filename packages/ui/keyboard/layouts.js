// Physical key layouts for the machines whose keyboards are not the 48K's
// 40 rubber keys: the ZX Spectrum+ / 128K toastrack, and the ZX Spectrum Next.
//
// Each is a photograph of the real machine (see keys/README.md), and each key
// is a rectangle IN that photograph, given in fractions of the image so the
// same table serves whatever size the keyboard is drawn at. A key made of more
// than one rectangle — the L-shaped ENTER both machines have — lists them in
// `rects`, drawn and hit-tested as one key. The rectangles were measured off
// the photographs rather than laid out by hand, so a key's hit area is exactly
// the key you can see.
//
// Both machines carry the same 58 keys: the 40-key matrix, the 16 keys the
// membrane folds onto CAPS/SYMBOL SHIFT combinations, and a second CAPS and
// SYMBOL SHIFT. They arrange them differently, hence a table each — the
// Spectrum+ opens its top row with TRUE/INV VIDEO and ends it with BREAK,
// where the Next opens with BREAK/EDIT and ends with DELETE.

const PLUS = {
    name: 'plus',
    image: '/keys/spectrum-plus.webp',
    aspect: 0.3771, // height / width of the photograph
    seam: '#0c0c0c', // the dark gap between keys, painted in above a pressed one
    keys: [
        {id: 'TRUEVIDEO', rects: [{x: 0.0, y: 0.0, w: 0.0754, h: 0.2031}]},
        {id: 'INVVIDEO', rects: [{x: 0.0754, y: 0.0, w: 0.0749, h: 0.2031}]},
        {id: '1', rects: [{x: 0.1503, y: 0.0, w: 0.0742, h: 0.2031}]},
        {id: '2', rects: [{x: 0.2245, y: 0.0, w: 0.0737, h: 0.2031}]},
        {id: '3', rects: [{x: 0.2982, y: 0.0, w: 0.0736, h: 0.2031}]},
        {id: '4', rects: [{x: 0.3718, y: 0.0, w: 0.0743, h: 0.2031}]},
        {id: '5', rects: [{x: 0.4461, y: 0.0, w: 0.0731, h: 0.2031}]},
        {id: '6', rects: [{x: 0.5192, y: 0.0, w: 0.073, h: 0.2031}]},
        {id: '7', rects: [{x: 0.5922, y: 0.0, w: 0.0731, h: 0.2031}]},
        {id: '8', rects: [{x: 0.6653, y: 0.0, w: 0.0731, h: 0.2031}]},
        {id: '9', rects: [{x: 0.7384, y: 0.0, w: 0.0742, h: 0.2031}]},
        {id: '0', rects: [{x: 0.8126, y: 0.0, w: 0.0731, h: 0.2031}]},
        {id: 'BREAK', rects: [{x: 0.8857, y: 0.0, w: 0.1143, h: 0.2031}]},
        {id: 'DELETE', rects: [{x: 0.0, y: 0.2031, w: 0.1126, h: 0.1953}]},
        {id: 'GRAPH', rects: [{x: 0.1126, y: 0.2031, w: 0.0748, h: 0.1953}]},
        {id: 'Q', rects: [{x: 0.1874, y: 0.2031, w: 0.0736, h: 0.1953}]},
        {id: 'W', rects: [{x: 0.261, y: 0.2031, w: 0.0743, h: 0.1953}]},
        {id: 'E', rects: [{x: 0.3353, y: 0.2031, w: 0.0742, h: 0.1953}]},
        {id: 'R', rects: [{x: 0.4095, y: 0.2031, w: 0.0737, h: 0.1953}]},
        {id: 'T', rects: [{x: 0.4832, y: 0.2031, w: 0.0725, h: 0.1953}]},
        {id: 'Y', rects: [{x: 0.5557, y: 0.2031, w: 0.0731, h: 0.1953}]},
        {id: 'U', rects: [{x: 0.6288, y: 0.2031, w: 0.073, h: 0.1953}]},
        {id: 'I', rects: [{x: 0.7018, y: 0.2031, w: 0.0737, h: 0.1953}]},
        {id: 'O', rects: [{x: 0.7755, y: 0.2031, w: 0.0742, h: 0.1953}]},
        {id: 'P', rects: [{x: 0.8497, y: 0.2031, w: 0.0725, h: 0.1953}]},
        {id: 'ENTER', rects: [{x: 0.9222, y: 0.2031, w: 0.0778, h: 0.1953}, {x: 0.868, y: 0.3984, w: 0.132, h: 0.1985}]},
        {id: 'EXTEND', rects: [{x: 0.0, y: 0.3984, w: 0.112, h: 0.1985}]},
        {id: 'EDIT', rects: [{x: 0.112, y: 0.3984, w: 0.0937, h: 0.1985}]},
        {id: 'A', rects: [{x: 0.2057, y: 0.3984, w: 0.0736, h: 0.1985}]},
        {id: 'S', rects: [{x: 0.2793, y: 0.3984, w: 0.0737, h: 0.1985}]},
        {id: 'D', rects: [{x: 0.353, y: 0.3984, w: 0.0742, h: 0.1985}]},
        {id: 'F', rects: [{x: 0.4272, y: 0.3984, w: 0.0743, h: 0.1985}]},
        {id: 'G', rects: [{x: 0.5015, y: 0.3984, w: 0.073, h: 0.1985}]},
        {id: 'H', rects: [{x: 0.5745, y: 0.3984, w: 0.0725, h: 0.1985}]},
        {id: 'J', rects: [{x: 0.647, y: 0.3984, w: 0.0743, h: 0.1985}]},
        {id: 'K', rects: [{x: 0.7213, y: 0.3984, w: 0.0736, h: 0.1985}]},
        {id: 'L', rects: [{x: 0.7949, y: 0.3984, w: 0.0731, h: 0.1985}]},
        {id: 'CAPS', rects: [{x: 0.0, y: 0.5969, w: 0.1679, h: 0.1984}]},
        {id: 'CAPSLOCK', rects: [{x: 0.1679, y: 0.5969, w: 0.0749, h: 0.1984}]},
        {id: 'Z', rects: [{x: 0.2428, y: 0.5969, w: 0.0736, h: 0.1984}]},
        {id: 'X', rects: [{x: 0.3164, y: 0.5969, w: 0.0743, h: 0.1984}]},
        {id: 'C', rects: [{x: 0.3907, y: 0.5969, w: 0.0736, h: 0.1984}]},
        {id: 'V', rects: [{x: 0.4643, y: 0.5969, w: 0.0737, h: 0.1984}]},
        {id: 'B', rects: [{x: 0.538, y: 0.5969, w: 0.0731, h: 0.1984}]},
        {id: 'N', rects: [{x: 0.6111, y: 0.5969, w: 0.073, h: 0.1984}]},
        {id: 'M', rects: [{x: 0.6841, y: 0.5969, w: 0.0743, h: 0.1984}]},
        {id: 'PERIOD', rects: [{x: 0.7584, y: 0.5969, w: 0.0731, h: 0.1984}]},
        {id: 'CAPS2', rects: [{x: 0.8315, y: 0.5969, w: 0.1685, h: 0.1984}]},
        {id: 'SYMBOL', rects: [{x: 0.0, y: 0.7953, w: 0.0748, h: 0.2047}]},
        {id: 'SEMI', rects: [{x: 0.0748, y: 0.7953, w: 0.0749, h: 0.2047}]},
        {id: 'QUOTE', rects: [{x: 0.1497, y: 0.7953, w: 0.0742, h: 0.2047}]},
        {id: 'LEFT', rects: [{x: 0.2239, y: 0.7953, w: 0.0737, h: 0.2047}]},
        {id: 'RIGHT', rects: [{x: 0.2976, y: 0.7953, w: 0.0748, h: 0.2047}]},
        {id: 'SPACE', rects: [{x: 0.3724, y: 0.7953, w: 0.3312, h: 0.2047}]},
        {id: 'UP', rects: [{x: 0.7036, y: 0.7953, w: 0.0742, h: 0.2047}]},
        {id: 'DOWN', rects: [{x: 0.7778, y: 0.7953, w: 0.0725, h: 0.2047}]},
        {id: 'COMMA', rects: [{x: 0.8503, y: 0.7953, w: 0.0737, h: 0.2047}]},
        {id: 'SYMBOL2', rects: [{x: 0.924, y: 0.7953, w: 0.076, h: 0.2047}]},
    ],
};

const NEXT = {
    name: 'next',
    image: '/keys/spectrum-next.webp',
    aspect: 0.3773, // height / width of the photograph
    seam: '#080808', // the dark gap between keys, painted in above a pressed one
    keys: [
        {id: 'BREAK', rects: [{x: 0.0, y: 0.0, w: 0.0766, h: 0.2061}]},
        {id: 'EDIT', rects: [{x: 0.0766, y: 0.0, w: 0.0747, h: 0.2061}]},
        {id: '1', rects: [{x: 0.1513, y: 0.0, w: 0.0741, h: 0.2061}]},
        {id: '2', rects: [{x: 0.2254, y: 0.0, w: 0.073, h: 0.2061}]},
        {id: '3', rects: [{x: 0.2984, y: 0.0, w: 0.0747, h: 0.2061}]},
        {id: '4', rects: [{x: 0.3731, y: 0.0, w: 0.0742, h: 0.2061}]},
        {id: '5', rects: [{x: 0.4473, y: 0.0, w: 0.0729, h: 0.2061}]},
        {id: '6', rects: [{x: 0.5202, y: 0.0, w: 0.0729, h: 0.2061}]},
        {id: '7', rects: [{x: 0.5931, y: 0.0, w: 0.073, h: 0.2061}]},
        {id: '8', rects: [{x: 0.6661, y: 0.0, w: 0.0729, h: 0.2061}]},
        {id: '9', rects: [{x: 0.739, y: 0.0, w: 0.0735, h: 0.2061}]},
        {id: '0', rects: [{x: 0.8125, y: 0.0, w: 0.0736, h: 0.2061}]},
        {id: 'DELETE', rects: [{x: 0.8861, y: 0.0, w: 0.1139, h: 0.2061}]},
        {id: 'TRUEVIDEO', rects: [{x: 0.0, y: 0.2061, w: 0.094, h: 0.1965}]},
        {id: 'INVVIDEO', rects: [{x: 0.094, y: 0.2061, w: 0.0935, h: 0.1965}]},
        {id: 'Q', rects: [{x: 0.1875, y: 0.2061, w: 0.0741, h: 0.1965}]},
        {id: 'W', rects: [{x: 0.2616, y: 0.2061, w: 0.0741, h: 0.1965}]},
        {id: 'E', rects: [{x: 0.3357, y: 0.2061, w: 0.0742, h: 0.1965}]},
        {id: 'R', rects: [{x: 0.4099, y: 0.2061, w: 0.0735, h: 0.1965}]},
        {id: 'T', rects: [{x: 0.4834, y: 0.2061, w: 0.0736, h: 0.1965}]},
        {id: 'Y', rects: [{x: 0.557, y: 0.2061, w: 0.0723, h: 0.1965}]},
        {id: 'U', rects: [{x: 0.6293, y: 0.2061, w: 0.0729, h: 0.1965}]},
        {id: 'I', rects: [{x: 0.7022, y: 0.2061, w: 0.073, h: 0.1965}]},
        {id: 'O', rects: [{x: 0.7752, y: 0.2061, w: 0.0741, h: 0.1965}]},
        {id: 'P', rects: [{x: 0.8493, y: 0.2061, w: 0.0735, h: 0.1965}]},
        {id: 'ENTER', rects: [{x: 0.9228, y: 0.2061, w: 0.0772, h: 0.1965}, {x: 0.8674, y: 0.4026, w: 0.1326, h: 0.1996}]},
        {id: 'CAPSLOCK', rects: [{x: 0.0, y: 0.4026, w: 0.1127, h: 0.1996}]},
        {id: 'GRAPH', rects: [{x: 0.1127, y: 0.4026, w: 0.0928, h: 0.1996}]},
        {id: 'A', rects: [{x: 0.2055, y: 0.4026, w: 0.0742, h: 0.1996}]},
        {id: 'S', rects: [{x: 0.2797, y: 0.4026, w: 0.0741, h: 0.1996}]},
        {id: 'D', rects: [{x: 0.3538, y: 0.4026, w: 0.0742, h: 0.1996}]},
        {id: 'F', rects: [{x: 0.428, y: 0.4026, w: 0.0735, h: 0.1996}]},
        {id: 'G', rects: [{x: 0.5015, y: 0.4026, w: 0.0723, h: 0.1996}]},
        {id: 'H', rects: [{x: 0.5738, y: 0.4026, w: 0.0736, h: 0.1996}]},
        {id: 'J', rects: [{x: 0.6474, y: 0.4026, w: 0.0729, h: 0.1996}]},
        {id: 'K', rects: [{x: 0.7203, y: 0.4026, w: 0.0736, h: 0.1996}]},
        {id: 'L', rects: [{x: 0.7939, y: 0.4026, w: 0.0735, h: 0.1996}]},
        {id: 'CAPS', rects: [{x: 0.0, y: 0.6022, w: 0.1682, h: 0.1981}]},
        {id: 'EXTEND', rects: [{x: 0.1682, y: 0.6022, w: 0.0928, h: 0.1981}]},
        {id: 'Z', rects: [{x: 0.261, y: 0.6022, w: 0.0735, h: 0.1981}]},
        {id: 'X', rects: [{x: 0.3345, y: 0.6022, w: 0.0742, h: 0.1981}]},
        {id: 'C', rects: [{x: 0.4087, y: 0.6022, w: 0.0735, h: 0.1981}]},
        {id: 'V', rects: [{x: 0.4822, y: 0.6022, w: 0.0736, h: 0.1981}]},
        {id: 'B', rects: [{x: 0.5558, y: 0.6022, w: 0.0729, h: 0.1981}]},
        {id: 'N', rects: [{x: 0.6287, y: 0.6022, w: 0.0735, h: 0.1981}]},
        {id: 'M', rects: [{x: 0.7022, y: 0.6022, w: 0.0736, h: 0.1981}]},
        {id: 'UP', rects: [{x: 0.7758, y: 0.6022, w: 0.0735, h: 0.1981}]},
        {id: 'CAPS2', rects: [{x: 0.8493, y: 0.6022, w: 0.1507, h: 0.1981}]},
        {id: 'SYMBOL', rects: [{x: 0.0, y: 0.8003, w: 0.0753, h: 0.1997}]},
        {id: 'SEMI', rects: [{x: 0.0753, y: 0.8003, w: 0.0742, h: 0.1997}]},
        {id: 'QUOTE', rects: [{x: 0.1495, y: 0.8003, w: 0.0741, h: 0.1997}]},
        {id: 'COMMA', rects: [{x: 0.2236, y: 0.8003, w: 0.0742, h: 0.1997}]},
        {id: 'PERIOD', rects: [{x: 0.2978, y: 0.8003, w: 0.0735, h: 0.1997}]},
        {id: 'SPACE', rects: [{x: 0.3713, y: 0.8003, w: 0.3315, h: 0.1997}]},
        {id: 'LEFT', rects: [{x: 0.7028, y: 0.8003, w: 0.0736, h: 0.1997}]},
        {id: 'DOWN', rects: [{x: 0.7764, y: 0.8003, w: 0.0729, h: 0.1997}]},
        {id: 'RIGHT', rects: [{x: 0.8493, y: 0.8003, w: 0.0735, h: 0.1997}]},
        {id: 'SYMBOL2', rects: [{x: 0.9228, y: 0.8003, w: 0.0772, h: 0.1997}]},
    ],
};

export const LAYOUTS = {plus: PLUS, next: NEXT};

// The second CAPS/SYMBOL SHIFT keys act as (and light with) the first; their
// layout ids carry a suffix so a layout can name both.
export const baseKeyId = (id) => (id === 'CAPS2' ? 'CAPS' : id === 'SYMBOL2' ? 'SYMBOL' : id);

// Every rectangle a key occupies, in fractions of the image.
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
 * responsive layout needs before anything is rendered.
 * @param {'plus'|'next'} name
 * @returns {Number}
 */
export function layoutAspect(name) {
    const layout = LAYOUTS[name];
    return layout ? layout.aspect : 0;
}
