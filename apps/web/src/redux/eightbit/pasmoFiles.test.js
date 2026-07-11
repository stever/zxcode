/**
 * Integration tests for pasmo's files-map staging (pasmo 0.0.1-alpha.7):
 * project files are written into the emscripten module's virtual FS at
 * their relative paths, so INCLUDE/INCBIN resolve natively — replacing the
 * old in-app expansion (pasmoIncludes.js), whose inlining made error line
 * numbers drift from the editor (work item #85).
 *
 * These run the REAL pasmo wasm, pinning the contract the asm saga branch
 * relies on: the {path: string|Uint8Array} map shape, per-file error
 * attribution, and pasmo's own missing-file diagnostics.
 */
import getPasmoTap from "pasmo";

describe("pasmo files-map staging (real module)", () => {
    test("INCLUDE + INCBIN in folders compile to a TAP", async () => {
        const code = [
            "org 32768",
            'include "lib/util.asm"',
            "start:",
            "    ld a, 2",
            "    call setb",
            'incbin "data/blob.bin"',
            "end 32768",
        ].join("\n");
        const tap = await getPasmoTap(code, {
            "lib/util.asm": "setb:\n    out (254), a\n    ret\n",
            "data/blob.bin": new Uint8Array([1, 2, 3, 4]),
        });
        expect(tap.length).toBeGreaterThan(0);
    });

    test("an error inside an include reports the include's own file and line", async () => {
        const code = 'org 32768\ninclude "lib/bad.asm"\nend 32768\n';
        await expect(getPasmoTap(code, {
            "lib/bad.asm": "    ld a, 2\n    ld a,\n    ret\n",
        })).rejects.toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: "err",
                text: expect.stringContaining("line 2 of file lib/bad.asm"),
            }),
        ]));
    });

    test("an error in the main source keeps the editor's own line number", async () => {
        // Line 3 references an undefined symbol; with an include ABOVE it,
        // the reported line must still be the editor's 3 (the old inliner
        // drifted here by the include's length).
        const code = 'org 32768\ninclude "lib/util.asm"\nld hl, missing\nend 32768\n';
        await expect(getPasmoTap(code, {
            "lib/util.asm": "setb:\n    out (254), a\n    ret\n",
        })).rejects.toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: "err",
                text: expect.stringContaining("line 3 of file input.asm"),
            }),
        ]));
    });

    test("a missing include surfaces pasmo's own diagnostic", async () => {
        const code = 'org 32768\ninclude "nope.asm"\nend 32768\n';
        await expect(getPasmoTap(code, {})).rejects.toEqual(
            expect.arrayContaining([expect.objectContaining({type: "err"})]));
    });

    test("compiling without a files map still works (legacy callers)", async () => {
        const tap = await getPasmoTap("org 32768\nld a, 1\nend 32768\n");
        expect(tap.length).toBeGreaterThan(0);
    });
});
