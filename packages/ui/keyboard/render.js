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

    for (const r of rects) {
        const dx = r.x * width, dy = r.y * height;
        const dw = r.w * width, dh = r.h * height;

        ctx.save();
        ctx.beginPath();
        ctx.rect(dx, dy, dw, dh);
        ctx.clip();

        // The gap the key has just vacated at its top edge.
        ctx.fillStyle = seam;
        ctx.fillRect(dx, dy, dw, sink + 1);

        // The key itself, one step down; its own bottom edge is clipped away,
        // which is exactly what travel looks like from straight on.
        ctx.drawImage(image, r.x * iw, r.y * ih, r.w * iw, r.h * ih, dx, dy + sink, dw, dh);

        ctx.fillStyle = SHADE;
        ctx.fillRect(dx, dy, dw, dh);
        ctx.restore();
    }
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
