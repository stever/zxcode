import { toAsmSource, toBasicData } from "./sourceExport";

describe("toAsmSource", () => {
    test("groups rows per pattern with a header comment", () => {
        const bytes = new Uint8Array(64);
        bytes[0] = 0xe3;
        bytes[32] = 0x01;
        const src = toAsmSource(bytes, 32, "2 x 8x8 4-bit tiles");
        const lines = src.trimEnd().split("\n");
        expect(lines[0]).toBe("; 2 x 8x8 4-bit tiles");
        expect(lines[1]).toBe("sprites:");
        expect(lines[2]).toBe("; pattern 0");
        expect(lines[3].startsWith("    db $e3,$00,")).toBe(true);
        // 32 bytes = 2 rows per pattern.
        expect(lines[5]).toBe("; pattern 1");
        expect(lines[6].startsWith("    db $01,$00,")).toBe(true);
        expect(lines.length).toBe(2 + 2 * 3);
    });

    test("emits 16 bytes per db row", () => {
        const src = toAsmSource(new Uint8Array(256), 256, "one sprite");
        const row = src.split("\n")[3];
        expect(row.match(/\$00/g).length).toBe(16);
    });
});

describe("toBasicData", () => {
    test("numbers lines from 9000 in steps of 10", () => {
        const bytes = new Uint8Array(32).fill(227);
        const lines = toBasicData(bytes).trimEnd().split("\n");
        expect(lines[0].startsWith("9000 DATA 227,227,")).toBe(true);
        expect(lines[1].startsWith("9010 DATA ")).toBe(true);
        expect(lines.length).toBe(2);
    });

    test("respects custom numbering", () => {
        const lines = toBasicData(new Uint8Array(16), { startLine: 100, step: 5 })
            .trimEnd().split("\n");
        expect(lines[0].startsWith("100 DATA 0,0,")).toBe(true);
    });
});
