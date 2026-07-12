import {
    SPRITE_BYTES,
    TRANSPARENT_INDEX,
    base64ByteLength,
    base64ToBytes,
    bytesToBase64,
    blankSpriteBase64,
    defaultSpritePalette,
    isEditableSpriteContent,
    isSpriteFileName,
    spritePatternCount,
} from "./spr";

describe("isSpriteFileName", () => {
    test("matches the .spr extension case-insensitively", () => {
        expect(isSpriteFileName("tiles.spr")).toBe(true);
        expect(isSpriteFileName("SHIP.SPR")).toBe(true);
        expect(isSpriteFileName("tiles.spr.bak")).toBe(false);
        expect(isSpriteFileName("sprites")).toBe(false);
        expect(isSpriteFileName("")).toBe(false);
        expect(isSpriteFileName(null)).toBe(false);
    });
});

describe("base64 round trip", () => {
    test("bytes survive encode/decode unchanged", () => {
        const bytes = new Uint8Array(SPRITE_BYTES);
        for (let i = 0; i < bytes.length; i++) {
            bytes[i] = i & 0xff;
        }
        expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    });

    test("byte length is computed without decoding", () => {
        for (const size of [1, 2, 3, 255, 256, 512]) {
            const b64 = bytesToBase64(new Uint8Array(size));
            expect(base64ByteLength(b64)).toBe(size);
        }
        expect(base64ByteLength("")).toBe(0);
        expect(base64ByteLength(null)).toBe(0);
    });
});

describe("sprite content shape", () => {
    test("whole 256-byte patterns are editable", () => {
        expect(isEditableSpriteContent(bytesToBase64(new Uint8Array(256)))).toBe(true);
        expect(isEditableSpriteContent(bytesToBase64(new Uint8Array(1024)))).toBe(true);
    });

    test("empty or partial patterns are not", () => {
        expect(isEditableSpriteContent("")).toBe(false);
        expect(isEditableSpriteContent(bytesToBase64(new Uint8Array(100)))).toBe(false);
        // A lone 4-bit pattern (128 bytes) falls back to the asset panel.
        expect(isEditableSpriteContent(bytesToBase64(new Uint8Array(128)))).toBe(false);
    });

    test("pattern count", () => {
        expect(spritePatternCount(256)).toBe(1);
        expect(spritePatternCount(1024)).toBe(4);
    });

    test("a new sprite file is one all-transparent pattern", () => {
        const bytes = base64ToBytes(blankSpriteBase64());
        expect(bytes.length).toBe(SPRITE_BYTES);
        expect(bytes.every((b) => b === TRANSPARENT_INDEX)).toBe(true);
    });
});

describe("defaultSpritePalette", () => {
    const palette = defaultSpritePalette();

    test("has 256 CSS colours", () => {
        expect(palette.length).toBe(256);
        for (const colour of palette) {
            expect(colour).toMatch(/^#[0-9a-f]{6}$/);
        }
    });

    test("RGB332 corners", () => {
        expect(palette[0x00]).toBe("#000000");
        // All bits set: white.
        expect(palette[0xff]).toBe("#ffffff");
        // Red only (111 00 000).
        expect(palette[0xe0]).toBe("#ff0000");
        // Green only (000 111 00).
        expect(palette[0x1c]).toBe("#00ff00");
        // Blue only (000 000 11): 9-bit blue 111 -> full blue.
        expect(palette[0x03]).toBe("#0000ff");
    });

    test("blue LSB is the OR of the two blue bits", () => {
        // BB=01 -> 9-bit blue 011 (3/7); BB=10 -> 101 (5/7).
        expect(palette[0x01]).toBe(`#0000${Math.round((3 * 255) / 7).toString(16).padStart(2, "0")}`);
        expect(palette[0x02]).toBe(`#0000${Math.round((5 * 255) / 7).toString(16).padStart(2, "0")}`);
    });
});
