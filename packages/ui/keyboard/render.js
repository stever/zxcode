// Drawing a photographed keyboard onto a canvas.
//
// The picture IS the keyboard, so an idle key costs nothing to draw: the whole
// photograph goes down once, and only a key that is actually held gets redrawn.
// A held key is its own pixels slid down into the seam below it and shaded —
// the same trick the 48K's rubber art uses, and it works here for the same
// reason: a real key travels into its own shadow rather than changing shape.

// How far a held key travels, as a fraction of the keyboard's height.
const SINK = 0.008;
// How much darker a held key sits.
const SHADE = 'rgba(0, 0, 0, 0.28)';

/**
 * Draw the whole keyboard.
 * @param {CanvasRenderingContext2D} ctx
 * @param {HTMLImageElement} image the layout's photograph
 * @param {Number} width canvas width, in pixels
 * @param {Number} height canvas height, in pixels
 */
export function drawKeyboard(ctx, image, width, height) {
    if (!image || !image.naturalWidth) return; // still loading
    ctx.drawImage(image, 0, 0, width, height);
}

// The parts of a rectangle's top edge that are actually exposed — the stretches
// with no other rectangle of the same key resting on them. An L-shaped ENTER is
// one moulding: its lower rectangle only has a gap above it where it juts out
// past the upper one, and a seam drawn across the whole width would split the
// key in half.
function exposedTop(rect, rects) {
    let spans = [[rect.x, rect.x + rect.w]];
    for (const other of rects) {
        if (other === rect || Math.abs(other.y + other.h - rect.y) > 1e-6) continue;
        const [a, b] = [other.x, other.x + other.w];
        spans = spans.flatMap(([x0, x1]) => (
            [[x0, Math.min(x1, a)], [Math.max(x0, b), x1]].filter(([s, e]) => e - s > 1e-6)
        ));
    }
    return spans;
}

/**
 * Redraw one key as held down.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {HTMLImageElement} image the layout's photograph
 * @param {Object} opts
 * @param {Array<{x,y,w,h}>} opts.rects the key's rectangles, in fractions of the image
 * @param {Number} opts.width canvas width, in pixels
 * @param {Number} opts.height canvas height, in pixels
 * @param {String} opts.seam colour of the gap between keys
 */
export function drawKeyPressed(ctx, image, {rects, width, height, seam}) {
    if (!image || !image.naturalWidth) return;
    const iw = image.naturalWidth;
    const ih = image.naturalHeight;
    const sink = Math.max(1, height * SINK);

    const x0 = Math.min(...rects.map((r) => r.x));
    const y0 = Math.min(...rects.map((r) => r.y));
    const x1 = Math.max(...rects.map((r) => r.x + r.w));
    const y1 = Math.max(...rects.map((r) => r.y + r.h));

    ctx.save();
    // Clip to the key's whole shape, so a key made of several rectangles
    // travels as the single piece of plastic it is.
    ctx.beginPath();
    for (const r of rects) {
        ctx.rect(r.x * width, r.y * height, r.w * width, r.h * height);
    }
    ctx.clip();

    // The key itself, one step down and in one piece; its own bottom edge is
    // clipped away, which is exactly what travel looks like from straight on.
    ctx.drawImage(image, x0 * iw, y0 * ih, (x1 - x0) * iw, (y1 - y0) * ih,
        x0 * width, y0 * height + sink, (x1 - x0) * width, (y1 - y0) * height);

    // The gaps it has just vacated. Drawn after the key, because the step down
    // drags a slice of whatever sits above the key into them.
    ctx.fillStyle = seam;
    for (const r of rects) {
        for (const [a, b] of exposedTop(r, rects)) {
            ctx.fillRect(a * width, r.y * height, (b - a) * width, sink + 1);
        }
    }

    ctx.fillStyle = SHADE;
    ctx.fillRect(x0 * width, y0 * height, (x1 - x0) * width, (y1 - y0) * height);
    ctx.restore();
}

/**
 * Which drawn keys should show as held, given the matrix positions that are
 * down.
 *
 * A key is held when every position it holds is down — but a machine keyboard
 * draws BOTH a dedicated key and the keys it stands for, and pressing EDIT
 * must not light EDIT, CAPS SHIFT and 1 all at once. So a key is suppressed
 * when a key holding strictly more positions covers it: EDIT wins over CAPS
 * SHIFT and 1, DELETE over CAPS SHIFT and 0. Where a machine has two of the
 * same key (both CAPS SHIFTs are one position in the matrix), the one under
 * the pointer wins, and failing that — a real Shift on the host keyboard —
 * both light, because the matrix cannot say which.
 *
 * @param {Array<{positions:Array}>} keys every drawn key
 * @param {Set<Number>} down matrix positions currently down, as row * 256 + mask
 * @param {Object} pointerKey the key the pointer is holding, if any
 * @returns {Set<Object>} the keys to draw as held
 */
export function heldKeys(keys, down, pointerKey) {
    const isDown = (positions) => positions.every(([row, mask]) => down.has(row * 256 + mask));
    const holds = (key, [row, mask]) => key.positions.some(([r, m]) => r === row && m === mask);
    const covers = (outer, inner) => (
        outer.positions.length > inner.positions.length
        && inner.positions.every((position) => holds(outer, position))
    );
    const sameKey = (a, b) => (
        a.positions.length === b.positions.length
        && a.positions.every((position) => holds(b, position))
    );

    const active = keys.filter((key) => key.positions.length > 0 && isDown(key.positions));
    const held = new Set();
    for (const key of active) {
        if (active.some((other) => covers(other, key))) continue;
        if (pointerKey && key !== pointerKey && active.includes(pointerKey)
            && sameKey(key, pointerKey)) continue;
        held.add(key);
    }
    return held;
}
