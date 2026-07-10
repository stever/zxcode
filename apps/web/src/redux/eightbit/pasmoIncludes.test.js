import {expandPasmoIncludes} from "./pasmoIncludes";

if (typeof global.TextEncoder === "undefined") {
    // eslint-disable-next-line no-undef
    global.TextEncoder = require("util").TextEncoder;
}

const text = (name, content) => ({name, content, isBinary: false});
const bin = (name, bytes) => ({
    name,
    content: btoa(String.fromCharCode(...bytes)),
    isBinary: true,
});

describe("expandPasmoIncludes", () => {
    test("returns the source unchanged without project files", () => {
        const src = 'ORG 32768\nINCLUDE "lib.asm"\n';
        expect(expandPasmoIncludes(src, [])).toBe(src);
    });

    test("inlines a quoted INCLUDE, case-insensitively", () => {
        const out = expandPasmoIncludes(
            'ORG 32768\n  include "LIB.ASM"\nRET',
            [text("lib.asm", "double: ADD A,A\nRET")]);
        expect(out).toBe("ORG 32768\ndouble: ADD A,A\nRET\nRET");
    });

    test("inlines a bare-name INCLUDE and nested includes", () => {
        const out = expandPasmoIncludes(
            "INCLUDE outer.asm",
            [
                text("outer.asm", 'NOP\nINCLUDE "inner.asm"'),
                text("inner.asm", "HALT"),
            ]);
        expect(out).toBe("NOP\nHALT");
    });

    test("resolves includes by their folder path", () => {
        const out = expandPasmoIncludes(
            'INCLUDE "lib/util.asm"',
            [{...text("util.asm", "HALT"), folder: "lib"}]);
        expect(out).toBe("HALT");
        // The bare name does not match a file that lives in a folder.
        const untouched = 'INCLUDE "util.asm"';
        expect(expandPasmoIncludes(
            untouched,
            [{...text("util.asm", "HALT"), folder: "lib"}])).toBe(untouched);
    });

    test("expands INCBIN to DEFB rows preserving indentation", () => {
        const bytes = Array.from({length: 18}, (_, i) => i + 1);
        const out = expandPasmoIncludes(
            '  INCBIN "font.bin"',
            [bin("font.bin", bytes)]);
        expect(out).toBe(
            "  DEFB " + bytes.slice(0, 16).join(",") + "\n" +
            "  DEFB 17,18");
    });

    test("INCBIN of a text file emits its UTF-8 bytes", () => {
        const out = expandPasmoIncludes(
            'INCBIN "msg.txt"',
            [text("msg.txt", "AB")]);
        expect(out).toBe("DEFB 65,66");
    });

    test("leaves unknown names for pasmo's own missing-file error", () => {
        const src = 'INCLUDE "ghost.asm"\nINCBIN "ghost.bin"';
        expect(expandPasmoIncludes(src, [text("lib.asm", "NOP")])).toBe(src);
    });

    test("ignores directives with trailing junk beyond a comment", () => {
        const src = 'INCLUDE "a.asm" extra tokens';
        expect(expandPasmoIncludes(src, [text("a.asm", "NOP")])).toBe(src);
    });

    test("allows a trailing comment after the filename", () => {
        const out = expandPasmoIncludes(
            'INCLUDE "a.asm" ; helpers',
            [text("a.asm", "NOP")]);
        expect(out).toBe("NOP");
    });

    test("rejects INCLUDE of a binary file", () => {
        expect(() => expandPasmoIncludes(
            'INCLUDE "font.bin"',
            [bin("font.bin", [1])])).toThrow();
        try {
            expandPasmoIncludes('INCLUDE "font.bin"', [bin("font.bin", [1])]);
        } catch (items) {
            expect(items[0].type).toBe("err");
            expect(items[0].text).toMatch(/INCBIN/);
        }
    });

    test("rejects circular includes", () => {
        const files = [
            text("a.asm", 'INCLUDE "b.asm"'),
            text("b.asm", 'INCLUDE "a.asm"'),
        ];
        try {
            expandPasmoIncludes('INCLUDE "a.asm"', files);
            throw new Error("did not throw");
        } catch (items) {
            expect(items[0].text).toMatch(/Circular/);
        }
    });

    test("a self-include is allowed again after the branch unwinds", () => {
        // Diamond shape: main includes a and b, both include shared.
        const files = [
            text("a.asm", 'INCLUDE "shared.asm"'),
            text("b.asm", 'INCLUDE "shared.asm"'),
            text("shared.asm", "NOP"),
        ];
        const out = expandPasmoIncludes('INCLUDE "a.asm"\nINCLUDE "b.asm"', files);
        expect(out).toBe("NOP\nNOP");
    });
});

describe("expanded source assembles with the real pasmo module", () => {
    test("INCLUDE + INCBIN compile to a TAP", async () => {
        const getPasmoTap = require("pasmo").default;
        const src = [
            "ORG 32768",
            'INCLUDE "lib.asm"',
            'INCBIN "font.bin"',
            "END 32768",
        ].join("\n");
        const expanded = expandPasmoIncludes(src, [
            text("lib.asm", "start: LD A,7\nRET"),
            bin("font.bin", [1, 2, 3, 4]),
        ]);
        const tap = await getPasmoTap(expanded);
        expect(tap).toBeInstanceOf(Uint8Array);
        expect(tap.length).toBeGreaterThan(0);
    }, 30000);
});
