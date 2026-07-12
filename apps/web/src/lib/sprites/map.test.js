import { base64ToBytes, bytesToBase64 } from "./spr";
import {
    defaultMapBase64,
    defaultMapWidth,
    isEditableMapContent,
    isMapFileName,
    mapWidthOptions,
} from "./map";

describe("isMapFileName", () => {
    test("matches .map case-insensitively", () => {
        expect(isMapFileName("level1.map")).toBe(true);
        expect(isMapFileName("LEVEL.MAP")).toBe(true);
        expect(isMapFileName("level.spr")).toBe(false);
    });
});

describe("map content", () => {
    test("any non-empty payload is editable", () => {
        expect(isEditableMapContent(bytesToBase64(new Uint8Array(1)))).toBe(true);
        expect(isEditableMapContent(bytesToBase64(new Uint8Array(768)))).toBe(true);
        expect(isEditableMapContent("")).toBe(false);
    });

    test("a new map is 32x24 of tile 0", () => {
        const bytes = base64ToBytes(defaultMapBase64());
        expect(bytes.length).toBe(768);
        expect(bytes.every((b) => b === 0)).toBe(true);
    });
});

describe("width selection", () => {
    test("width options are divisors", () => {
        expect(mapWidthOptions(12)).toEqual([1, 2, 3, 4, 6, 12]);
    });

    test("default width prefers 32", () => {
        expect(defaultMapWidth(768)).toBe(32);
        expect(defaultMapWidth(160)).toBe(32);
        // 100 cells: closest divisor to 32 is 25.
        expect(defaultMapWidth(100)).toBe(25);
    });
});
