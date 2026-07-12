import { base64ToBytes, bytesToBase64 } from "./spr";
import {
    PAL_FILE_SIZE,
    PALETTE_ENTRIES,
    css9,
    defaultPalette9,
    defaultPaletteBase64,
    isEditablePaletteContent,
    isPaletteFileName,
    parsePalette,
    paletteCssFromBytes,
    serialisePalette,
} from "./pal";

describe("isPaletteFileName", () => {
    test("matches .pal case-insensitively", () => {
        expect(isPaletteFileName("game.pal")).toBe(true);
        expect(isPaletteFileName("GAME.PAL")).toBe(true);
        expect(isPaletteFileName("game.spr")).toBe(false);
        expect(isPaletteFileName(null)).toBe(false);
    });
});

describe("palette entry encoding", () => {
    test("round trips values and priority", () => {
        const values = new Uint16Array(PALETTE_ENTRIES);
        const priority = new Array(PALETTE_ENTRIES).fill(false);
        values[0] = 0b111000111; // bright red + full blue
        values[1] = 0b000000001; // blue LSB only
        values[255] = 0b111111111;
        priority[1] = true;
        const parsed = parsePalette(serialisePalette({ values, priority }));
        expect(Array.from(parsed.values)).toEqual(Array.from(values));
        expect(parsed.priority).toEqual(priority);
    });

    test("byte layout matches the nextreg pair (RRRGGGBB, P000000B)", () => {
        const values = new Uint16Array(PALETTE_ENTRIES);
        const priority = new Array(PALETTE_ENTRIES).fill(false);
        values[0] = 0b101100111;
        priority[0] = true;
        const bytes = serialisePalette({ values, priority });
        expect(bytes[0]).toBe(0b10110011);
        expect(bytes[1]).toBe(0b10000001);
    });
});

describe("default palette", () => {
    test("expands RGB332 with OR'd blue LSB", () => {
        const values = defaultPalette9();
        expect(values[0x00]).toBe(0b000000000);
        expect(values[0xff]).toBe(0b111111111);
        // BB=01 -> blue 011; BB=10 -> blue 101.
        expect(values[0x01] & 7).toBe(0b011);
        expect(values[0x02] & 7).toBe(0b101);
    });

    test("default file content parses back to the default palette", () => {
        const bytes = base64ToBytes(defaultPaletteBase64());
        expect(bytes.length).toBe(PAL_FILE_SIZE);
        const { values, priority } = parsePalette(bytes);
        expect(Array.from(values)).toEqual(Array.from(defaultPalette9()));
        expect(priority.every((p) => !p)).toBe(true);
    });

    test("default .pal renders the same colours as the sprite editor default", () => {
        const css = paletteCssFromBytes(base64ToBytes(defaultPaletteBase64()));
        expect(css[0x00]).toBe("#000000");
        expect(css[0xff]).toBe("#ffffff");
        expect(css[0xe0]).toBe("#ff0000");
        expect(css[0x03]).toBe("#0000ff");
    });
});

describe("css9", () => {
    test("scales 3-bit channels", () => {
        expect(css9(0b111000000)).toBe("#ff0000");
        expect(css9(0b000111000)).toBe("#00ff00");
        expect(css9(0b000000111)).toBe("#0000ff");
        expect(css9(0)).toBe("#000000");
    });
});

describe("isEditablePaletteContent", () => {
    test("exactly 512 bytes is editable", () => {
        expect(isEditablePaletteContent(bytesToBase64(new Uint8Array(512)))).toBe(true);
    });

    test("other sizes are not", () => {
        expect(isEditablePaletteContent(bytesToBase64(new Uint8Array(511)))).toBe(false);
        expect(isEditablePaletteContent(bytesToBase64(new Uint8Array(1024)))).toBe(false);
        expect(isEditablePaletteContent("")).toBe(false);
    });

    test("+3DOS headered palette is editable", () => {
        const bytes = new Uint8Array(128 + 512);
        const sig = "PLUS3DOS\x1a";
        for (let i = 0; i < sig.length; i++) bytes[i] = sig.charCodeAt(i);
        expect(isEditablePaletteContent(bytesToBase64(bytes))).toBe(true);
        // Same size without the signature: not a palette file.
        expect(isEditablePaletteContent(bytesToBase64(new Uint8Array(640)))).toBe(false);
    });
});
