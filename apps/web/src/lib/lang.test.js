import {
    joinProjectFilePath,
    projectFileNameError,
    projectFilePathError,
    splitProjectFilePath,
} from "./lang";

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
