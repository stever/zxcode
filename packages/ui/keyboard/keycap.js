// Drawing one key of a Sinclair keyboard, from the shape both machines share.
//
// A key is a square shoulder with a raised fingertip pad set into its lower
// part: flat across the top, generously rounded below, so a letter key's pad
// reads as a circle chopped flat and a space bar's as a long stadium. The
// E-mode words print on the shoulder above the pad; the keyword, the SYMBOL
// SHIFT legend and the character itself print on the pad. Everything is white.
//
// Measurements are fractions of the key CELL (the pitch of the grid), taken off
// photographs of a ZX Spectrum+ and a ZX Spectrum Next.

import {GRAPHIC_QUADRANTS} from './legends';

// One scheme for both machines: the ZX Spectrum Next's, which is glossy black
// keys with a lighter pad set into them. The Spectrum+'s own keys are the other
// way round — grey with a darker pad — but this reads better on screen and is
// what the project owner asked both keyboards to use.
export const PALETTE = {
    case: '#08080a',
    shoulderTop: '#232328', shoulderBottom: '#141417',
    padTop: '#43434a', padBottom: '#303036',
    ink: '#f0f0f0',
};

// Fractions of a key cell.
const SHOULDER_INSET = 0.016;  // dark gap between neighbouring keys
const SHOULDER_RADIUS = 0.05;
// The pad reaches almost to the shoulder's edges, and its underside is a
// single sweeping arc — on a letter key, a circle chopped flat across the top.
// Every pad starts on the same line, which is where a key carrying E-mode
// words on its shoulder has to put it: the machines let their bare keys (the
// shifts, the dedicated keys) start higher, but a row of pads that do not line
// up reads as a mistake on screen.
const PAD = {top: 0.335, bottom: 0.045, inset: 0.065, topRadius: 0.06, corner: 0.42};

// Where each legend sits, as a fraction of the cell's height (y) or width (x).
const EXT_Y = 0.135;
const EXT_SYM_Y = 0.265;
const HEAD_Y = 0.475;         // the keyword / graphic / symbol line on the pad
const STACKED_SYM_Y = 0.605;  // a SYMBOL SHIFT word takes its own line
const MAIN_Y = 0.79;

const TEXT = 0.125;   // cap height of the small legends
const MAIN = 0.205;   // cap height of the character itself

const FONT = "'Arial Narrow', 'Helvetica Neue', Arial, sans-serif";

const isWord = (text) => /^[A-Za-z]{2,}$/.test(text);

// A rectangle with a radius per corner, added to the current path. A bottom
// corner may take a radius of up to half the WIDTH, which is what turns a
// letter key's pad into a circle chopped flat across the top.
function roundRectPath(ctx, x, y, w, h, {tl = 0, tr = 0, br = 0, bl = 0}) {
    const cap = (r, head) => Math.max(0, Math.min(r, w / 2, h - head));
    const rtl = cap(tl, 0);
    const rtr = cap(tr, 0);
    const rbr = cap(br, Math.max(rtl, rtr));
    const rbl = cap(bl, Math.max(rtl, rtr));
    ctx.moveTo(x + rtl, y);
    ctx.lineTo(x + w - rtr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rtr);
    ctx.lineTo(x + w, y + h - rbr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rbr, y + h);
    ctx.lineTo(x + rbl, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rbl);
    ctx.lineTo(x, y + rtl);
    ctx.quadraticCurveTo(x, y, x + rtl, y);
    ctx.closePath();
}

function fitFont(ctx, str, maxW, px, weight = 'bold') {
    let size = px;
    for (let i = 0; i < 10; i++) {
        ctx.font = `${weight} ${size}px ${FONT}`;
        if (ctx.measureText(str).width <= maxW) break;
        size *= 0.92;
    }
    return size;
}

// The machines print in a heavy condensed grotesque. Stroking the glyph in its
// own colour fattens whatever face the browser actually has to the same weight.
function label(ctx, str, x, y, px, colour, align, maxW) {
    if (!str) return;
    const size = fitFont(ctx, str, maxW, px);
    ctx.fillStyle = colour;
    ctx.strokeStyle = colour;
    ctx.lineWidth = size * 0.07;
    ctx.lineJoin = 'round';
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.strokeText(str, x, y);
    ctx.fillText(str, x, y);
}

// The block graphic printed on keys 1-8: a square outline with the quadrants
// the character fills painted in.
function drawGraphic(ctx, n, x, y, size, colour) {
    const quads = GRAPHIC_QUADRANTS[n];
    if (!quads) return;
    const line = Math.max(1, size * 0.14);
    ctx.strokeStyle = colour;
    ctx.lineWidth = line;
    ctx.strokeRect(x + line / 2, y + line / 2, size - line, size - line);

    const inner = size - line * 2;
    const half = inner / 2;
    const at = {tl: [0, 0], tr: [half, 0], bl: [0, half], br: [half, half]};
    ctx.fillStyle = colour;
    for (const name of quads) {
        const [dx, dy] = at[name];
        ctx.fillRect(x + line + dx, y + line + dy, half, half);
    }
}

/**
 * Draw one key.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Object} opts
 * @param {Array<{x,y,w,h}>} opts.rects the key's rectangles, in pixels
 * @param {Object} opts.legend an entry from the machine's legend table
 * @param {Object} opts.palette the drawing colours (PALETTE)
 * @param {Number} opts.cell the grid pitch in pixels: {w, h}
 */
export function drawKey(ctx, {rects, legend = {}, palette, cell}) {
    const {w: cw, h: ch} = cell;

    // The shoulder, as one piece: an L-shaped ENTER is one moulding.
    const shoulders = rects.map((r) => ({
        x: r.x + cw * SHOULDER_INSET, y: r.y + ch * SHOULDER_INSET,
        w: r.w - cw * SHOULDER_INSET * 2, h: r.h - ch * SHOULDER_INSET * 2,
    }));
    const top = Math.min(...shoulders.map((s) => s.y));
    const bottom = Math.max(...shoulders.map((s) => s.y + s.h));

    const shoulder = ctx.createLinearGradient(0, top, 0, bottom);
    shoulder.addColorStop(0, palette.shoulderTop);
    shoulder.addColorStop(1, palette.shoulderBottom);
    ctx.fillStyle = shoulder;
    const sr = ch * SHOULDER_RADIUS;
    for (const s of shoulders) {
        ctx.beginPath();
        roundRectPath(ctx, s.x, s.y, s.w, s.h, {tl: sr, tr: sr, br: sr, bl: sr});
        ctx.fill();
    }
    // Bridge the join between an L's two rectangles, so its rounded corners do
    // not notch the middle of one moulding.
    for (let i = 1; i < shoulders.length; i++) {
        const a = shoulders[i - 1];
        const b = shoulders[i];
        const x0 = Math.max(a.x, b.x);
        const x1 = Math.min(a.x + a.w, b.x + b.w);
        if (x1 <= x0) continue;
        const seam = Math.min(a.y + a.h, b.y + b.h);
        const r = ch * SHOULDER_RADIUS;
        ctx.fillRect(x0, seam - r, x1 - x0, r * 2);
    }

    // The fingertip pad. It follows the key's whole shape, so the L-shaped
    // ENTER gets an L-shaped pad exactly as the moulding does: the piece above
    // runs into the piece below rather than each having its own rounded end.
    //
    // EVERY piece starts its pad on its own row's pad line, so the L's lower
    // arm lines up with the row it sits in just as its upper arm lines up with
    // the row above. The piece above therefore reaches down to where the piece
    // below begins, and the two meet there rather than at the row boundary.
    const face = rects.reduce((a, b) => (a.w * a.h >= b.w * b.h ? a : b));
    const pads = rects.map((r, i) => {
        const next = rects[i + 1];
        const y = r.y + ch * PAD.top;
        const foot = next ? next.y + ch * PAD.top : r.y + r.h - ch * PAD.bottom;
        return {
            x: r.x + cw * PAD.inset,
            y,
            w: r.w - cw * PAD.inset * 2,
            h: foot - y,
        };
    });
    const pad = pads.find((p) => p.x === face.x + cw * PAD.inset && p.w === face.w - cw * PAD.inset * 2);
    const padBottom = pads[pads.length - 1];
    const padHead = Math.min(...pads.map((p) => p.y));
    const padFoot = Math.max(...pads.map((p) => p.y + p.h));

    const padFill = ctx.createLinearGradient(0, padHead, 0, padFoot);
    padFill.addColorStop(0, palette.padTop);
    padFill.addColorStop(1, palette.padBottom);
    ctx.fillStyle = padFill;
    ctx.beginPath();
    const tr = ch * PAD.topRadius;
    for (const p of pads) {
        // Corners that meet the next piece of the same key stay square.
        const above = pads.find((o) => o !== p && Math.abs(o.y + o.h - p.y) < 0.01
            && o.x + o.w > p.x && o.x < p.x + p.w);
        const below = pads.find((o) => o !== p && Math.abs(p.y + p.h - o.y) < 0.01
            && o.x + o.w > p.x && o.x < p.x + p.w);
        // The mouldings have one corner radius; a letter key's pad is narrow
        // enough that it becomes a full semicircle, which is why that pad reads
        // as a circle and the space bar's as a stadium.
        const round = Math.min(p.w / 2, ch * PAD.corner);
        roundRectPath(ctx, p.x, p.y, p.w, p.h, {
            tl: above && above.x <= p.x + 0.01 ? 0 : tr,
            tr: above && above.x + above.w >= p.x + p.w - 0.01 ? 0 : tr,
            br: below ? 0 : round,
            bl: below ? 0 : round,
        });
    }
    ctx.fill();

    // No sheen along the pad's curve: the machines have one, but a stroked
    // highlight has to stop somewhere, and at these sizes the end of it reads
    // as a stray scratch. The pad's own tone against the shoulder is enough to
    // say it is raised.

    drawLegends(ctx, legend, {face, pad: pad || padBottom, cw, ch, ink: palette.ink});
}

function drawLegends(ctx, legend, {face, pad, cw, ch, ink}) {
    const centre = face.x + face.w / 2;
    const padCentre = pad.x + pad.w / 2;
    const inset = cw * 0.08;

    // E-mode words, on the shoulder above the pad.
    if (legend.ext || legend.extSym) {
        const width = face.w - inset;
        if (legend.ext && legend.extSym) {
            label(ctx, legend.ext, centre, face.y + ch * EXT_Y, ch * TEXT, ink, 'center', width);
            label(ctx, legend.extSym, centre, face.y + ch * EXT_SYM_Y, ch * TEXT, ink, 'center', width);
        } else {
            label(ctx, legend.ext || legend.extSym, centre, face.y + ch * EXT_SYM_Y,
                ch * TEXT, ink, 'center', width);
        }
    }

    // A named key (BREAK, EXTEND MODE, ENTER, the shifts) puts its name on the
    // pad, over one or two lines.
    if (legend.label) {
        const lines = legend.label.split('\n');
        const lead = ch * TEXT * 1.45;
        const y0 = pad.y + pad.h / 2 - ((lines.length - 1) * lead) / 2;
        lines.forEach((line, i) => {
            label(ctx, line, padCentre, y0 + i * lead, ch * TEXT, ink, 'center', pad.w - inset);
        });
        return;
    }

    const stacked = legend.sym && isWord(legend.sym);
    // A number key: the graphic sits where a letter key's keyword does, with
    // the SYMBOL SHIFT character beside it. 9 and 0 have no graphic — the
    // machines print none — but they carry that character in the same place.
    if (legend.graphic || (legend.sym && !legend.keyword)) {
        if (legend.graphic) {
            drawGraphic(ctx, legend.graphic, pad.x + pad.w * 0.10, face.y + ch * (HEAD_Y - 0.09),
                ch * 0.18, ink);
        }
        label(ctx, legend.sym, pad.x + pad.w * 0.70, face.y + ch * HEAD_Y, ch * TEXT * 1.2,
            ink, 'center', pad.w * 0.34);
    } else if (legend.keyword) {
        const y = face.y + ch * HEAD_Y;
        label(ctx, legend.keyword, padCentre, y, ch * TEXT, ink, 'center', pad.w - inset);
        if (legend.sym) {
            if (stacked) {
                label(ctx, legend.sym, padCentre, face.y + ch * STACKED_SYM_Y, ch * TEXT,
                    ink, 'center', pad.w - inset);
            } else {
                label(ctx, legend.sym, pad.x + pad.w * 0.72, face.y + ch * STACKED_SYM_Y,
                    ch * TEXT, ink, 'center', pad.w * 0.5);
            }
        }
    }

    if (!legend.main) return;
    const hasHead = !!(legend.keyword || legend.graphic || (legend.sym && !legend.keyword));
    label(ctx, legend.main, padCentre, hasHead ? face.y + ch * MAIN_Y : pad.y + pad.h / 2,
        ch * MAIN, ink, 'center', pad.w - inset);
}
