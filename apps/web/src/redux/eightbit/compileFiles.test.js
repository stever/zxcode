import {toSdFiles, sdFileNameErrors} from "./compileFiles";

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
});
