// How big the emulator's display is allowed to be drawn.
//
// The engine composites every machine into a fixed 640x512 canvas, and
// UIController sizes the element to `320 * zoom` CSS pixels wide (its setZoom).
// So 320 is one whole step of the display's own scale: at 960 CSS pixels every
// Spectrum pixel is exactly 3 wide, and at 1000 some are 3 and some are 4.
//
// That unevenness is what "pixel perfect" avoids. It is visible because the
// canvas is drawn with `image-rendering: crisp-edges` — the pixels are meant to
// be square and hard-edged, so a row of them being one wider than its
// neighbours reads as a defect rather than as smoothing.
export const PIXEL_UNIT = 320;

/**
 * The largest whole scale of the display that fits the width given.
 *
 * Below one whole scale the width is returned untouched: on a narrow phone
 * there is no whole step to drop to, and shrinking the screen to nothing would
 * be a worse answer than uneven pixels. Everywhere else this rounds DOWN, so
 * the result always fits the space the caller had measured.
 *
 * @param {Number} width the width the layout would otherwise have used
 * @returns {Number}
 */
export function snapToWholeScale(width) {
    if (!(width > PIXEL_UNIT)) return Math.max(0, width);
    return Math.floor(width / PIXEL_UNIT) * PIXEL_UNIT;
}
