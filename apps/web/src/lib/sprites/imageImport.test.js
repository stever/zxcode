import { SPRITE_BYTES, TRANSPARENT_INDEX } from "./spr";
import { imageDataToPatterns, quantiseRGB } from "./imageImport";

function image(width, height, fillRGBA) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        data.set(fillRGBA, i * 4);
    }
    return { width, height, data };
}

describe("quantiseRGB", () => {
    test("primaries map to RGB332 corners", () => {
        expect(quantiseRGB(0, 0, 0)).toBe(0x00);
        expect(quantiseRGB(255, 255, 255)).toBe(0xff);
        expect(quantiseRGB(255, 0, 0)).toBe(0xe0);
        expect(quantiseRGB(0, 255, 0)).toBe(0x1c);
        expect(quantiseRGB(0, 0, 255)).toBe(0x03);
    });

    test("rounds to the nearest channel step", () => {
        // 128/255 * 7 = 3.5 -> 4.
        expect(quantiseRGB(128, 0, 0)).toBe(4 << 5);
    });

    test("opaque colours never land on the transparency index", () => {
        // Bright red + full blue would be $E3; nudged one blue step down.
        expect(quantiseRGB(255, 0, 255)).toBe(TRANSPARENT_INDEX - 1);
    });
});

describe("imageDataToPatterns", () => {
    test("a 16x16 red image becomes one all-red pattern", () => {
        const patterns = imageDataToPatterns(image(16, 16, [255, 0, 0, 255]));
        expect(patterns.length).toBe(SPRITE_BYTES);
        expect(patterns.every((b) => b === 0xe0)).toBe(true);
    });

    test("transparent pixels map to the transparency index", () => {
        const patterns = imageDataToPatterns(image(16, 16, [255, 0, 0, 0]));
        expect(patterns.every((b) => b === TRANSPARENT_INDEX)).toBe(true);
    });

    test("partial cells pad with transparency", () => {
        // 17x5: two cells wide, one high.
        const patterns = imageDataToPatterns(image(17, 5, [0, 0, 255, 255]));
        expect(patterns.length).toBe(2 * SPRITE_BYTES);
        // First cell row 0, x0..15 blue.
        expect(patterns[0]).toBe(0x03);
        expect(patterns[15]).toBe(0x03);
        // Second cell only x=16 -> local x=0 blue, x=1 padded.
        expect(patterns[SPRITE_BYTES]).toBe(0x03);
        expect(patterns[SPRITE_BYTES + 1]).toBe(TRANSPARENT_INDEX);
        // Below the 5-pixel-high image everything is padding.
        expect(patterns[5 * 16]).toBe(TRANSPARENT_INDEX);
    });

    test("cells read left to right, top to bottom", () => {
        // 32x32 image: distinct colour per 16x16 quadrant.
        const img = image(32, 32, [0, 0, 0, 255]);
        const paint = (x, y, rgba) => img.data.set(rgba, (y * 32 + x) * 4);
        paint(0, 0, [255, 0, 0, 255]); // cell 0
        paint(16, 0, [0, 255, 0, 255]); // cell 1
        paint(0, 16, [0, 0, 255, 255]); // cell 2
        paint(16, 16, [255, 255, 255, 255]); // cell 3
        const patterns = imageDataToPatterns(img);
        expect(patterns[0]).toBe(0xe0);
        expect(patterns[SPRITE_BYTES]).toBe(0x1c);
        expect(patterns[2 * SPRITE_BYTES]).toBe(0x03);
        expect(patterns[3 * SPRITE_BYTES]).toBe(0xff);
    });
});
