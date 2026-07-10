import {toActionFiles, toSdFiles, toWorkerUpdates, sdFileNameErrors} from "./compileFiles";

// jest's jsdom environment lacks TextEncoder; Node's is identical.
if (typeof global.TextEncoder === "undefined") {
    // eslint-disable-next-line no-undef
    global.TextEncoder = require("util").TextEncoder;
}

describe("toSdFiles", () => {
    test("decodes binary files from base64 to raw bytes", () => {
        const files = [{name: "sprites.spr", content: btoa("\x01\x02\xFF"), isBinary: true}];
        const [out] = toSdFiles(files);
        expect(out.name).toBe("sprites.spr");
        expect(Array.from(out.data)).toEqual([1, 2, 255]);
    });

    test("encodes text files as UTF-8 bytes", () => {
        const [out] = toSdFiles([{name: "notes.txt", content: "hi", isBinary: false}]);
        // Node's polyfilled TextEncoder yields a cross-realm Uint8Array in
        // jsdom, so assert the view rather than the constructor identity.
        expect(ArrayBuffer.isView(out.data)).toBe(true);
        expect(Array.from(out.data)).toEqual([104, 105]);
    });

    test("handles a missing file list", () => {
        expect(toSdFiles(undefined)).toEqual([]);
    });

    test("stages files under their folder path", () => {
        const [out] = toSdFiles([
            {name: "tiles.spr", folder: "gfx", content: "hi", isBinary: false},
        ]);
        expect(out.name).toBe("gfx/tiles.spr");
    });
});

describe("path-bearing adapters", () => {
    test("toActionFiles sends the relative path as name", () => {
        expect(toActionFiles([
            {name: "util.asm", folder: "lib", content: "ret", isBinary: false},
            {name: "notes.txt", folder: "", content: "hi", isBinary: false},
        ]).map((f) => f.name)).toEqual(["lib/util.asm", "notes.txt"]);
    });

    test("toWorkerUpdates uses the relative path as the VFS path", () => {
        expect(toWorkerUpdates([
            {name: "util.h", folder: "inc", content: "x", isBinary: false},
        ])[0].path).toBe("inc/util.h");
    });
});

describe("sdFileNameErrors", () => {
    test("accepts names that fit FAT 8.3", () => {
        expect(sdFileNameErrors([
            {name: "sprites.spr"},
            {name: "A1_23-45.bin"},
            {name: "noext"},
        ])).toEqual([]);
    });

    test("rejects long bases, long extensions and multiple dots", () => {
        expect(sdFileNameErrors([
            {name: "loading-screen.scr"},
            {name: "tiles.data"},
            {name: "a.b.c"},
        ])).toEqual(["loading-screen.scr", "tiles.data", "a.b.c"]);
    });

    test("handles a missing file list", () => {
        expect(sdFileNameErrors(undefined)).toEqual([]);
    });

    test("checks every folder segment against 8.3", () => {
        expect(sdFileNameErrors([
            {name: "tiles.spr", folder: "sprites"},
            {name: "tiles.spr", folder: "gfx/level1"},
        ])).toEqual([]);
        expect(sdFileNameErrors([
            {name: "tiles.spr", folder: "loading-screens"},
            {name: "tiles.spr", folder: "gfx/level.one.x"},
        ])).toEqual(["loading-screens/tiles.spr", "gfx/level.one.x/tiles.spr"]);
    });
});
