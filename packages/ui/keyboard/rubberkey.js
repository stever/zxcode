// Drawing one key of the 48K's rubber keyboard.
//
// A different machine and a different design from the later mouldings: a small
// rubber cap sitting on the case with a soft shadow under it, the character
// large on the left, the SYMBOL SHIFT legend in red at its top right and the
// BASIC keyword in white below that — and the E-mode words printed on the CASE,
// green above the key and red below it. Above the number keys the white CAPS
// SHIFT function takes the green word's place.
//
// Measurements and colours are transcribed from the key art this replaces
// (apps/*/public/keys/key*.png), as fractions of one square key cell.

import {GRAPHIC_QUADRANTS} from './legends';

export const RUBBER_PALETTE = {
    case: '#2c2b30',
    capTop: '#5c666c', capBottom: '#4e565c',
    edge: 'rgba(255, 255, 255, 0.10)',
    shadow: 'rgba(0, 0, 0, 0.55)',
    ink: '#ffffff',
    green: '#6d8421',
    sym: '#dd584a',
};

// The rainbow, which crosses the case behind the ENTER and BREAK SPACE keys.
export const RAINBOW = ['#eb5a46', '#e3c924', '#62ab3e', '#6eb9e5'];

// Fractions of a key cell.
const CAP = {x: 0.144, y: 0.242, w: 0.704, h: 0.493, radius: 0.075};
const EXT_X = 0.18;          // the case words are left-aligned, not centred
const EXT_Y = 0.122;         // E-mode word (or the CAPS SHIFT function) above
const EXT_SYM_Y = 0.872;     // E-mode + SYMBOL SHIFT word below
const MAIN_X = 0.235;        // the character, large, on the left of the cap
const MAIN_Y = 0.420;        // letters sit high, over the keyword below right
const MAIN_Y_DIGIT = 0.485;  // a number key has its graphic to the right instead
const RIGHT_X = 0.53;        // the SYMBOL SHIFT legend and the keyword
const SYM_Y = 0.417;
const KEYWORD_Y = 0.610;
const GRAPHIC = {x: 0.583, y: 0.333, size: 0.128};

// Type sizes, as a fraction of the cell. The art measures its legends about
// 0.72 of these in cap height, which is the ratio of the face.
const CASE_TEXT = 0.126;
const SYM_TEXT = 0.10;
const KEYWORD_TEXT = 0.117;
const MAIN_TEXT = 0.27;
const LABEL_TEXT = 0.145;  // ENTER, CAPS SHIFT, SYMBOL SHIFT, BREAK SPACE

const FONT = "'Arial Narrow', 'Helvetica Neue', Arial, sans-serif";

function fitFont(ctx, str, maxW, px) {
    let size = px;
    for (let i = 0; i < 10; i++) {
        ctx.font = `bold ${size}px ${FONT}`;
        if (ctx.measureText(str).width <= maxW) break;
        size *= 0.92;
    }
    return size;
}

// The art's legends are heavier than a plain bold face; stroking the glyph in
// its own colour makes up the difference whatever font the browser has.
function label(ctx, str, x, y, px, colour, align, maxW) {
    if (!str) return;
    const size = fitFont(ctx, str, maxW, px);
    ctx.fillStyle = colour;
    ctx.strokeStyle = colour;
    ctx.lineWidth = size * 0.055;
    ctx.lineJoin = 'round';
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.strokeText(str, x, y);
    ctx.fillText(str, x, y);
}

// The 48K prints the block graphic the other way up from the later machines: a
// white square with the character's own quadrants knocked out of it.
function drawGraphic(ctx, n, x, y, size, ink, casing) {
    const quads = GRAPHIC_QUADRANTS[n];
    if (!quads) return;
    ctx.fillStyle = ink;
    ctx.fillRect(x, y, size, size);
    const half = size / 2;
    const at = {tl: [0, 0], tr: [half, 0], bl: [0, half], br: [half, half]};
    ctx.fillStyle = casing;
    for (const name of quads) {
        const [dx, dy] = at[name];
        ctx.fillRect(x + dx + size * 0.06, y + dy + size * 0.06, half - size * 0.12,
            half - size * 0.12);
    }
}

// How far a pressed rubber key travels — into the space its own shadow
// occupied — and how much darker it sits there.
const SINK = 0.024;
const SHADE = 'rgba(0, 0, 0, 0.22)';

const capRect = (rect) => ({
    x: rect.x + rect.w * CAP.x, y: rect.y + rect.h * CAP.y,
    w: rect.w * CAP.w, h: rect.h * CAP.h,
});

// The cap itself, and the legends printed on it. `sink` slides the whole thing
// down; a sunk key has no shadow, because it is sitting in it.
function drawCap(ctx, {rect, legend, palette, sink = 0}) {
    const {h} = rect;
    const cap = capRect(rect);
    cap.y += sink;
    const radius = Math.min(h * CAP.radius, cap.h / 2);

    const fill = ctx.createLinearGradient(0, cap.y, 0, cap.y + cap.h);
    fill.addColorStop(0, palette.capTop);
    fill.addColorStop(1, palette.capBottom);

    ctx.save();
    if (!sink) {
        ctx.shadowColor = palette.shadow;
        ctx.shadowBlur = h * 0.035;
        ctx.shadowOffsetY = h * 0.028;
    }
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(cap.x, cap.y, cap.w, cap.h, radius)
        : ctx.rect(cap.x, cap.y, cap.w, cap.h);
    ctx.fill();
    ctx.restore();

    // A hairline along the top of the rubber, where it catches the light.
    if (!sink) {
        ctx.strokeStyle = palette.edge;
        ctx.lineWidth = Math.max(1, h * 0.008);
        ctx.beginPath();
        ctx.moveTo(cap.x + radius, cap.y + ctx.lineWidth);
        ctx.lineTo(cap.x + cap.w - radius, cap.y + ctx.lineWidth);
        ctx.stroke();
    }

    drawCapLegends(ctx, legend, {rect, cap, palette, sink});

    if (sink) {
        ctx.fillStyle = SHADE;
        ctx.beginPath();
        ctx.roundRect ? ctx.roundRect(cap.x, cap.y, cap.w, cap.h, radius)
            : ctx.rect(cap.x, cap.y, cap.w, cap.h);
        ctx.fill();
    }
}

/**
 * Draw the rubber cap of one key, with the legends printed on the rubber.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Object} opts
 * @param {{x,y,w,h}} opts.rect the key's cell, in pixels
 * @param {Object} opts.legend an entry from the 48K legend table
 * @param {Object} opts.palette RUBBER_PALETTE
 */
export function drawRubberKeyCap(ctx, {rect, legend = {}, palette}) {
    drawCap(ctx, {rect, legend, palette});
}

/**
 * Draw what one key prints on the CASE — the E-mode words above and below the
 * cap, or the white CAPS SHIFT function on a number key. Part of the keyboard
 * rather than of the key: it does not move when the key goes down.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Object} opts as for drawRubberKeyCap
 */
export function drawRubberKeyCase(ctx, {rect, legend = {}, palette}) {
    drawCaseLegends(ctx, legend, {rect, palette});
}

/**
 * Redraw one rubber key as held down: only the cap travels, into the space its
 * shadow occupied.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Object} opts as for drawRubberKeyCap, plus:
 * @param {Function} [opts.backdrop] paints the keyboard BEHIND the keys over a
 *     given rectangle. Without it the patch is filled with the case colour,
 *     which is only right where nothing is printed behind the key.
 */
export function drawRubberKeyPressed(ctx, {rect, legend = {}, palette, backdrop}) {
    const cap = capRect(rect);
    const margin = rect.h * 0.07; // enough to take the shadow with it
    const patch = {
        x: cap.x - margin, y: cap.y - margin,
        w: cap.w + margin * 2, h: cap.h + margin * 2,
    };

    ctx.save();
    ctx.beginPath();
    ctx.rect(patch.x, patch.y, patch.w, patch.h);
    ctx.clip();
    // Clear the key out of the way by putting back what is behind it. It has
    // to be the real backdrop rather than the flat case colour: the rainbow
    // crosses the case behind ENTER and BREAK SPACE, and filling over it drew
    // a dark rectangle around those two keys whenever they were held.
    if (backdrop) {
        backdrop(patch.x, patch.y, patch.w, patch.h);
    } else {
        ctx.fillStyle = palette.case;
        ctx.fillRect(patch.x, patch.y, patch.w, patch.h);
    }
    drawCap(ctx, {rect, legend, palette, sink: rect.h * SINK});
    ctx.restore();
}

// The words printed on the case: green above (or the white CAPS SHIFT function
// on the number keys), red below.
function drawCaseLegends(ctx, legend, {rect, palette}) {
    const {x, y, w, h} = rect;
    label(ctx, legend.caps || legend.ext, x + w * EXT_X, y + h * EXT_Y, h * CASE_TEXT,
        legend.caps ? palette.ink : palette.green, 'left', w * 0.8);
    label(ctx, legend.extSym, x + w * EXT_X, y + h * EXT_SYM_Y, h * CASE_TEXT,
        palette.sym, 'left', w * 0.8);
}

function drawCapLegends(ctx, legend, {rect, cap, palette, sink = 0}) {
    const {x, w, h} = rect;
    const y = rect.y + sink;
    const ink = palette.ink;

    // A named key puts its name on the cap, over one or two lines. BREAK SPACE
    // sets the second line larger; SYMBOL SHIFT prints in red.
    if (legend.label) {
        const lines = legend.label.split('\n');
        const colour = legend.ink === 'sym' ? palette.sym : ink;
        const lead = h * LABEL_TEXT * 1.15;
        const y0 = cap.y + cap.h / 2 - ((lines.length - 1) * lead) / 2;
        lines.forEach((line, i) => {
            const size = h * LABEL_TEXT * (legend.emphasis === i ? 1.45 : 1);
            label(ctx, line, cap.x + cap.w / 2, y0 + i * lead, size, colour, 'center',
                cap.w * 0.9);
        });
        return;
    }

    // On the cap: the character on the left, and to its right the SYMBOL SHIFT
    // legend above the keyword — or, on a number key, the block graphic with
    // the SYMBOL SHIFT character under it.
    label(ctx, legend.main, x + w * MAIN_X, y + h * (legend.graphic ? MAIN_Y_DIGIT : MAIN_Y),
        h * MAIN_TEXT, ink, 'left', w * 0.26);
    if (legend.graphic) {
        drawGraphic(ctx, legend.graphic, x + w * GRAPHIC.x, y + h * GRAPHIC.y,
            h * GRAPHIC.size, ink, palette.capTop);
        label(ctx, legend.sym, x + w * (GRAPHIC.x + GRAPHIC.size / 2), y + h * 0.6,
            h * SYM_TEXT, palette.sym, 'center', w * 0.22);
        return;
    }
    label(ctx, legend.sym, x + w * RIGHT_X, y + h * SYM_Y, h * SYM_TEXT, palette.sym,
        'left', w * 0.34);
    label(ctx, legend.keyword, x + w * 0.782, y + h * KEYWORD_Y,
        h * KEYWORD_TEXT, ink, 'right', w * 0.46);
}

/**
 * Draw the rainbow that crosses the case behind the ENTER and BREAK SPACE
 * keys, before the keys go down.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Object} grid {cols, rows} of the keyboard, and its size in pixels
 */
export function drawRainbow(ctx, {cols, rows, width, height}) {
    const cw = width / cols;
    const ch = height / rows;
    const top = 2 * ch;              // the row ENTER sits in
    const bottom = height;
    const lean = -0.39 * ch;         // how far a stripe moves left over one row
    const stripe = 0.152 * cw;
    const start = (cols - 1) * cw + 0.712 * cw;

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, top, width, bottom - top);
    ctx.clip();
    RAINBOW.forEach((colour, i) => {
        const x0 = start + i * stripe;
        const drop = (bottom - top) / ch * lean;
        ctx.fillStyle = colour;
        ctx.beginPath();
        ctx.moveTo(x0, top);
        ctx.lineTo(x0 + stripe, top);
        ctx.lineTo(x0 + stripe + drop, bottom);
        ctx.lineTo(x0 + drop, bottom);
        ctx.closePath();
        ctx.fill();
    });
    ctx.restore();
}
