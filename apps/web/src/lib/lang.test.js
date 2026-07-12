import {
    editorMode,
    joinProjectFilePath,
    projectFileNameError,
    projectFilePathError,
    splitProjectFilePath,
} from "./lang";

describe("editorMode", () => {
    test("main source follows the project language", () => {
        expect(editorMode("pascal")).toBe("text/x-pasta80");
        expect(editorMode("sjasmplus", null)).toBe("text/x-sjasmplus");
        expect(editorMode("zxbasic")).toBe("text/x-zxbasic");
    });

    test("asm files in a Pascal project read as sjasmplus ({$l} links)", () => {
        expect(editorMode("pascal", "helper.asm")).toBe("text/x-sjasmplus");
        expect(editorMode("pascal", "lib/HELPER.ASM")).toBe("text/x-sjasmplus");
        expect(editorMode("pascal", "helper.z80")).toBe("text/x-sjasmplus");
    });

    test("asm files elsewhere keep their toolchain's dialect", () => {
        expect(editorMode("sjasmplus", "lib/util.asm")).toBe("text/x-sjasmplus");
        expect(editorMode("asm", "util.asm")).toBe("text/x-pasmo");
        // Generic Z80 for toolchains with no asm dialect of their own.
        expect(editorMode("c", "util.asm")).toBe("text/x-pasmo");
    });

    test("extensions that pin a syntax win over the language", () => {
        expect(editorMode("sjasmplus", "defs.h")).toBe("text/x-z88dk-csrc");
        expect(editorMode("c", "unit.pas")).toBe("text/x-pasta80");
        // A .bas in a non-BASIC project is an SD-card NextBASIC program.
        expect(editorMode("c", "loader.bas")).toBe("text/x-nextbas");
        expect(editorMode("zxbasic", "lib.bas")).toBe("text/x-zxbasic");
        expect(editorMode("nextbas", "extra.bas")).toBe("text/x-nextbas");
    });

    test("neutral extensions keep the language mode", () => {
        expect(editorMode("pascal", "part.inc")).toBe("text/x-pasta80");
        expect(editorMode("sjasmplus", "macros.inc")).toBe("text/x-sjasmplus");
        expect(editorMode("pascal", "notes.txt")).toBe("text/x-pasta80");
        expect(editorMode("pascal", "README")).toBe("text/x-pasta80");
    });
});

describe("splitProjectFilePath", () => {
    test("treats a bare name as a root file", () => {
        expect(splitProjectFilePath("tiles.spr")).toEqual({folder: "", name: "tiles.spr"});
    });

    test("splits on the last slash", () => {
        expect(splitProjectFilePath("assets/gfx/tiles.spr"))
            .toEqual({folder: "assets/gfx", name: "tiles.spr"});
    });

    test("handles empty input", () => {
        expect(splitProjectFilePath("")).toEqual({folder: "", name: ""});
        expect(splitProjectFilePath(undefined)).toEqual({folder: "", name: ""});
    });
});

describe("joinProjectFilePath", () => {
    test("joins folder and name, leaving root files bare", () => {
        expect(joinProjectFilePath("assets", "tiles.spr")).toBe("assets/tiles.spr");
        expect(joinProjectFilePath("", "tiles.spr")).toBe("tiles.spr");
        expect(joinProjectFilePath(undefined, "tiles.spr")).toBe("tiles.spr");
    });
});

describe("projectFilePathError", () => {
    test("accepts a plain root name", () => {
        expect(projectFilePathError("tiles.spr")).toBeNull();
    });

    test("accepts folder paths with valid segments", () => {
        expect(projectFilePathError("assets/tiles.spr")).toBeNull();
        expect(projectFilePathError("src/lib/util.asm")).toBeNull();
    });

    test("rejects malformed folder paths", () => {
        expect(projectFilePathError("/tiles.spr")).toBe("editor.files.invalidFolder");
        expect(projectFilePathError("assets//tiles.spr")).toBe("editor.files.invalidFolder");
        expect(projectFilePathError("../tiles.spr")).toBe("editor.files.invalidFolder");
        expect(projectFilePathError(".hidden/tiles.spr")).toBe("editor.files.invalidFolder");
        expect(projectFilePathError("bad dir/tiles.spr")).toBe("editor.files.invalidFolder");
    });

    test("rejects folders longer than the cap", () => {
        const folder = "a".repeat(64) + "/" + "b".repeat(64);
        expect(projectFilePathError(`${folder}/tiles.spr`)).toBe("editor.files.invalidFolder");
    });

    test("still applies the base-name rules to the final segment", () => {
        expect(projectFilePathError("assets/")).toBe("editor.files.invalidName");
        expect(projectFilePathError("assets/program.asm")).toBe("editor.files.reservedName");
        expect(projectFilePathError("assets/game.tap")).toBe("editor.files.outputName");
    });

    test("applies the reserved/output rules to folder segments too", () => {
        expect(projectFilePathError("program.d/tiles.spr")).toBe("editor.files.reservedName");
        expect(projectFilePathError("out.tap/tiles.spr")).toBe("editor.files.outputName");
    });

    test("duplicates are per full path, case-insensitively", () => {
        expect(projectFilePathError("assets/tiles.spr", ["ASSETS/TILES.SPR"]))
            .toBe("editor.files.duplicateName");
        // The same base name in a different folder is a different file.
        expect(projectFilePathError("assets/tiles.spr", ["tiles.spr"])).toBeNull();
    });

    test("rejects a path that clashes with an existing file as a folder", () => {
        expect(projectFilePathError("lib/util.asm", ["lib"]))
            .toBe("editor.files.pathConflict");
        expect(projectFilePathError("lib", ["lib/util.asm"]))
            .toBe("editor.files.pathConflict");
    });
});

describe("projectFileNameError", () => {
    test("rejects names containing a slash", () => {
        expect(projectFileNameError("assets/tiles.spr")).toBe("editor.files.invalidName");
    });
});
