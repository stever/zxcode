import {parseBasicMap} from "./basicMap";
import {snapLine, locToAddr} from "./sld";

const SRC = `#program test
#autostart 10
10 PRINT "A"
20 FOR %i=1 TO 3

30 NEXT %i
REM not a numbered line
100 STOP
`;

describe("parseBasicMap", () => {
    test("maps editor lines to BASIC line numbers and back", () => {
        const map = parseBasicMap(SRC);
        expect(map.kind).toBe("basic");
        // Directives, blanks, and unnumbered lines get no mapping.
        expect(map.mappedLines).toEqual([3, 4, 6, 8]);
        expect(map.lineToAddr.get(3)).toBe(10);
        expect(map.lineToAddr.get(8)).toBe(100);
        expect(map.addrToLoc.get(20)).toEqual({file: null, line: 4});
        expect(map.addrToLoc.get(30)).toEqual({file: null, line: 6});
        expect(map.labels.size).toBe(0);
    });

    test("returns null for source with no numbered lines", () => {
        expect(parseBasicMap("")).toBeNull();
        expect(parseBasicMap("#program only\nREM nothing")).toBeNull();
        expect(parseBasicMap(null)).toBeNull();
    });

    test("rejects numbers outside the NextZXOS line range", () => {
        const map = parseBasicMap("0 REM zero\n10000 REM big\n50 PRINT");
        expect(map.mappedLines).toEqual([3]);
        expect(map.lineToAddr.get(3)).toBe(50);
    });

    test("interops with the sld helpers the reducer and session use", () => {
        const map = parseBasicMap(SRC);
        // A gutter click on the blank editor line 5 snaps down to line 6.
        expect(snapLine(map, 5, null)).toBe(6);
        // Nothing numbered below the last line: no snap target.
        expect(snapLine(map, 9, null)).toBeNull();
        // Only the main source exists in a BASIC project.
        expect(snapLine(map, 3, "other.bas")).toBeNull();
        expect(locToAddr(map, null, 6)).toBe(30);
        expect(locToAddr(map, null, 5)).toBeUndefined();
    });

    test("first occurrence wins for duplicate BASIC line numbers", () => {
        const map = parseBasicMap("10 PRINT 1\n10 PRINT 2");
        expect(map.addrToLoc.get(10)).toEqual({file: null, line: 1});
        expect(map.lineToAddr.get(1)).toBe(10);
        expect(map.lineToAddr.get(2)).toBe(10);
    });
});
