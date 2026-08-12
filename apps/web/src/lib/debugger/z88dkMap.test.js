import {buildZ88dkMap} from "./z88dkMap";
import {snapLine, locToAddr} from "./sld";

const DEBUG = {
    kind: "z88dk",
    files: {
        "": [[5, 0x9364], [11, 0x9380], [13, 0x9390]],
        "lib/util.h": [[4, 0x93A0]],
    },
};

describe("buildZ88dkMap", () => {
    test("builds a multi-file address map, '' keying the main source", () => {
        const map = buildZ88dkMap(DEBUG);
        expect(map.kind).toBeUndefined();
        expect(map.mappedLines).toEqual([5, 11, 13]);
        expect(map.lineToAddr.get(11)).toBe(0x9380);
        expect(map.addrToLoc.get(0x93A0)).toEqual({file: "lib/util.h", line: 4});
        expect(map.byFile.get("lib/util.h").mappedLines).toEqual([4]);
        // Main-file convenience map excludes other files' addresses.
        expect(map.addrToLine.has(0x93A0)).toBe(false);
        expect(map.labels.size).toBe(0);
    });

    test("returns null for missing or invalid payloads", () => {
        expect(buildZ88dkMap(null)).toBeNull();
        expect(buildZ88dkMap({kind: "z88dk", files: {}})).toBeNull();
        expect(buildZ88dkMap({kind: "z88dk"})).toBeNull();
        expect(buildZ88dkMap({kind: "z88dk", files: {"": [[0, 0x8000], [1, 0x10000]]}})).toBeNull();
    });

    test("parses the optional labels object, skipping invalid entries", () => {
        const map = buildZ88dkMap({
            ...DEBUG,
            labels: {
                _main: 0x9380,
                _add2: 0x9364,
                loop_top: 0x9370,
                bad_addr: 0x10000,
                not_int: "9000",
                "": 0x9000,
            },
        });
        expect([...map.labels.entries()]).toEqual([
            ["_main", 0x9380],
            ["_add2", 0x9364],
            ["loop_top", 0x9370],
        ]);
    });

    test("tolerates a missing or malformed labels field (old service)", () => {
        expect(buildZ88dkMap(DEBUG).labels.size).toBe(0);
        expect(buildZ88dkMap({...DEBUG, labels: [[1, 2]]}).labels.size).toBe(0);
        expect(buildZ88dkMap({...DEBUG, labels: null}).labels.size).toBe(0);
    });

    test("interops with the sld helpers the reducer and session use", () => {
        const map = buildZ88dkMap(DEBUG);
        expect(snapLine(map, 6, null)).toBe(11);
        expect(snapLine(map, 1, "lib/util.h")).toBe(4);
        expect(snapLine(map, 5, "other.h")).toBeNull();
        expect(locToAddr(map, null, 13)).toBe(0x9390);
        expect(locToAddr(map, "lib/util.h", 4)).toBe(0x93A0);
    });
});
