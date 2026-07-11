import {buildLineCallMap} from "./lineCallMap";
import {snapLine, locToAddr} from "./sld";

// Per-file shape: main lines map to themselves; include lines to their
// virtual range (base 10000 for the first include, sorted by name).
const DEBUG = {
    kind: "zxbasic",
    anchor: 0x9333,
    files: {
        "": [[2, 2], [3, 3], [5, 5], [6, 6]],
        "lib/util.bas": [[3, 10003], [4, 10004]],
    },
};

describe("buildLineCallMap", () => {
    test("builds a per-file virtual-line map with the anchor", () => {
        const map = buildLineCallMap(DEBUG);
        expect(map.kind).toBe("linecall");
        expect(map.anchor).toBe(0x9333);
        expect(map.mappedLines).toEqual([2, 3, 5, 6]);
        expect(map.lineToAddr.get(2)).toBe(2);
        expect(map.addrToLoc.get(5)).toEqual({file: null, line: 5});
        // The include's real line 3 arms as virtual 10003 and resolves
        // back to its own file and line.
        expect(map.byFile.get("lib/util.bas").lineToAddr.get(3)).toBe(10003);
        expect(map.addrToLoc.get(10003)).toEqual({file: "lib/util.bas", line: 3});
        // Main-file convenience map excludes other files' virtuals.
        expect(map.addrToLine.has(10003)).toBe(false);
        expect(map.labels.size).toBe(0);
    });

    test("accepts the older single-file lines shape as main-only", () => {
        const map = buildLineCallMap({kind: "zxbasic", anchor: 0x9333, lines: [2, 5]});
        expect(map.mappedLines).toEqual([2, 5]);
        expect(map.lineToAddr.get(5)).toBe(5);
        expect(map.byFile.size).toBe(1);
    });

    test("returns null for missing or invalid payloads", () => {
        expect(buildLineCallMap(null)).toBeNull();
        expect(buildLineCallMap({kind: "zxbasic", anchor: 0x9333, lines: []})).toBeNull();
        expect(buildLineCallMap({kind: "zxbasic", anchor: 0x9333, files: {}})).toBeNull();
        expect(buildLineCallMap({kind: "zxbasic", lines: [1]})).toBeNull();
        expect(buildLineCallMap({kind: "zxbasic", anchor: 0x9333, lines: [0, 70000]})).toBeNull();
        // The unmapped sentinel (65535) is not an armable virtual.
        expect(buildLineCallMap({
            kind: "zxbasic", anchor: 0x9333, files: {"": [[1, 0xFFFF]]},
        })).toBeNull();
    });

    test("interops with the sld helpers the reducer and session use", () => {
        const map = buildLineCallMap(DEBUG);
        // A click on the REM/blank line 4 snaps down to line 5.
        expect(snapLine(map, 4, null)).toBe(5);
        expect(snapLine(map, 7, null)).toBeNull();
        expect(snapLine(map, 1, "lib/util.bas")).toBe(3);
        expect(locToAddr(map, null, 6)).toBe(6);
        expect(locToAddr(map, "lib/util.bas", 4)).toBe(10004);
        expect(locToAddr(map, null, 4)).toBeUndefined();
    });
});
