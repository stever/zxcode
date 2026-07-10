import {buildProjectZip} from "./projectZip";

describe("buildProjectZip", () => {
    test("names the main source for the project language", async () => {
        const zip = buildProjectZip("asm", "org 32768", []);
        expect(await zip.file("program.asm").async("string")).toBe("org 32768");
    });

    test("stores text files as-is and decodes binary files from base64", async () => {
        const zip = buildProjectZip("zxbasic", "PRINT 1", [
            {name: "notes.txt", content: "hi", isBinary: false},
            {name: "sprites.spr", content: btoa("\x01\x02\xFF"), isBinary: true},
        ]);
        expect(await zip.file("notes.txt").async("string")).toBe("hi");
        expect(Array.from(await zip.file("sprites.spr").async("uint8array")))
            .toEqual([1, 2, 255]);
    });

    test("nests files under their folder path", async () => {
        const zip = buildProjectZip("asm", "org 32768", [
            {name: "util.asm", folder: "src", content: "ret", isBinary: false},
            {name: "tiles.spr", folder: "assets/gfx", content: btoa("\x2A"), isBinary: true},
            {name: "notes.txt", folder: "", content: "hi", isBinary: false},
        ]);
        expect(await zip.file("src/util.asm").async("string")).toBe("ret");
        expect(Array.from(await zip.file("assets/gfx/tiles.spr").async("uint8array")))
            .toEqual([42]);
        expect(await zip.file("notes.txt").async("string")).toBe("hi");
        expect(zip.folder("src").file("util.asm")).not.toBeNull();
    });

    test("handles an empty project", async () => {
        const zip = buildProjectZip("basic", undefined, undefined);
        expect(await zip.file("program.bas").async("string")).toBe("");
        expect(Object.keys(zip.files)).toEqual(["program.bas"]);
    });
});
