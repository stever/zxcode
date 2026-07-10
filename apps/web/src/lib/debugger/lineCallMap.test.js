import {buildLineCallMap} from "./lineCallMap";
import {snapLine, locToAddr} from "./sld";

const DEBUG = {kind: "zxbasic", anchor: 0x9333, lines: [2, 3, 5, 6]};

describe("buildLineCallMap", () => {
    test("builds an identity line map with the anchor", () => {
        const map = buildLineCallMap(DEBUG);
        expect(map.kind).toBe("linecall");
        expect(map.anchor).toBe(0x9333);
        expect(map.mappedLines).toEqual([2, 3, 5, 6]);
        expect(map.lineToAddr.get(2)).toBe(2);
        expect(map.addrToLoc.get(5)).toEqual({file: null, line: 5});
        expect(map.labels.size).toBe(0);
    });

    test("returns null for missing or invalid payloads", () => {
        expect(buildLineCallMap(null)).toBeNull();
        expect(buildLineCallMap({kind: "zxbasic", anchor: 0x9333, lines: []})).toBeNull();
        expect(buildLineCallMap({kind: "zxbasic", lines: [1]})).toBeNull();
        expect(buildLineCallMap({kind: "zxbasic", anchor: 0x9333, lines: [0, 70000]})).toBeNull();
    });

    test("interops with the sld helpers the reducer and session use", () => {
        const map = buildLineCallMap(DEBUG);
        // A click on the REM/blank line 4 snaps down to line 5.
        expect(snapLine(map, 4, null)).toBe(5);
        expect(snapLine(map, 7, null)).toBeNull();
        expect(locToAddr(map, null, 6)).toBe(6);
        expect(locToAddr(map, null, 4)).toBeUndefined();
    });
});
