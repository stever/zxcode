import {buildPasta80Map} from "./pasta80Map";
import {snapLine, locToAddr} from "./sld";

const DEBUG = {
    kind: "pasta80",
    files: {
        "": [[5, 0x8100], [6, 0x8108], [8, 0x8120]],
        "inc/greet.pas": [[3, 0x8130]],
    },
};

describe("buildPasta80Map", () => {
    test("builds a multi-file address map, '' keying the main source", () => {
        const map = buildPasta80Map(DEBUG);
        expect(map.kind).toBeUndefined();
        expect(map.mappedLines).toEqual([5, 6, 8]);
        expect(map.lineToAddr.get(5)).toBe(0x8100);
        expect(map.addrToLoc.get(0x8108)).toEqual({file: null, line: 6});
        expect(map.addrToLoc.get(0x8130)).toEqual({file: "inc/greet.pas", line: 3});
        expect(map.byFile.get("inc/greet.pas").mappedLines).toEqual([3]);
        // Main-file convenience map excludes other files' addresses.
        expect(map.addrToLine.has(0x8130)).toBe(false);
        expect(map.labels.size).toBe(0);
    });

    test("accepts the older single-file entries shape as main-only", () => {
        const map = buildPasta80Map({kind: "pasta80", entries: [[5, 0x8100]]});
        expect(map.mappedLines).toEqual([5]);
        expect(map.byFile.size).toBe(1);
    });

    test("returns null for missing or invalid payloads", () => {
        expect(buildPasta80Map(null)).toBeNull();
        expect(buildPasta80Map({kind: "pasta80", files: {}})).toBeNull();
        expect(buildPasta80Map({kind: "pasta80", entries: []})).toBeNull();
        expect(buildPasta80Map({kind: "pasta80"})).toBeNull();
        expect(buildPasta80Map({kind: "pasta80", files: {"": [[0, 0x8000], [1, 0x10000], [1]]}})).toBeNull();
    });

    test("interops with the sld helpers the reducer and session use", () => {
        const map = buildPasta80Map(DEBUG);
        // A click on the unmapped line 7 snaps down to line 8.
        expect(snapLine(map, 7, null)).toBe(8);
        expect(snapLine(map, 9, null)).toBeNull();
        expect(snapLine(map, 1, "inc/greet.pas")).toBe(3);
        expect(locToAddr(map, null, 6)).toBe(0x8108);
        expect(locToAddr(map, "inc/greet.pas", 3)).toBe(0x8130);
        expect(locToAddr(map, null, 7)).toBeUndefined();
    });
});
