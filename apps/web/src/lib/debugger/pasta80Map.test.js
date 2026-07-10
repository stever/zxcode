import {buildPasta80Map} from "./pasta80Map";
import {snapLine, locToAddr} from "./sld";

const DEBUG = {kind: "pasta80", entries: [[5, 0x8100], [6, 0x8108], [8, 0x8120]]};

describe("buildPasta80Map", () => {
    test("builds a plain address map (no kind) from the entries", () => {
        const map = buildPasta80Map(DEBUG);
        expect(map.kind).toBeUndefined();
        expect(map.mappedLines).toEqual([5, 6, 8]);
        expect(map.lineToAddr.get(5)).toBe(0x8100);
        expect(map.addrToLoc.get(0x8108)).toEqual({file: null, line: 6});
        expect(map.addrToLine.get(0x8120)).toBe(8);
        expect(map.labels.size).toBe(0);
    });

    test("returns null for missing or invalid payloads", () => {
        expect(buildPasta80Map(null)).toBeNull();
        expect(buildPasta80Map({kind: "pasta80", entries: []})).toBeNull();
        expect(buildPasta80Map({kind: "pasta80"})).toBeNull();
        expect(buildPasta80Map({kind: "pasta80", entries: [[0, 0x8000], [1, 0x10000], [1]]})).toBeNull();
    });

    test("interops with the sld helpers the reducer and session use", () => {
        const map = buildPasta80Map(DEBUG);
        // A click on the unmapped line 7 snaps down to line 8.
        expect(snapLine(map, 7, null)).toBe(8);
        expect(snapLine(map, 9, null)).toBeNull();
        expect(locToAddr(map, null, 6)).toBe(0x8108);
        expect(locToAddr(map, null, 7)).toBeUndefined();
    });
});
