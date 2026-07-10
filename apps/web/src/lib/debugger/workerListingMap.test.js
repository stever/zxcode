import {buildWorkerListingMap} from "./workerListingMap";
import {snapLine, locToAddr} from "./sld";

// The 8bitworker result shape: listings keyed by output path, lines with
// {line, offset, path} (see lib/8bitworker/defs_build_result.ts).
const SDCC_LISTINGS = {
    "source.lst": {
        lines: [
            {line: 5, offset: 0x8010, path: "<stdin>"},
            {line: 7, offset: 0x8018, path: "<stdin>"},
            {line: 4, offset: 0x8030, path: "lib/util.h"},
            {line: 9, offset: 0x8040, path: "/usr/include/stdio.h"},
            {line: 2, offset: 0x8050}, // asm-fallback row: no path
        ],
    },
    "crt0.lst": {lines: [{line: 1, offset: 0x8000}]},
};

const ZMAC_LISTINGS = {
    "source.lst": {
        lines: [
            {line: 2, offset: 0x8000, insns: "3e02"},
            {line: 3, offset: 0x8002, insns: "cd0580"},
            {line: 2, offset: 0x8005, insns: "d3fe", path: "inc/util.asm"},
            {line: 5, offset: 0x8009, insns: "c30980"},
        ],
    },
};

describe("buildWorkerListingMap", () => {
    test("sdcc: <stdin> keys the main source, staged includes their path", () => {
        const map = buildWorkerListingMap("sdcc", SDCC_LISTINGS, new Set(["lib/util.h"]));
        expect(map.mappedLines).toEqual([5, 7]);
        expect(map.lineToAddr.get(5)).toBe(0x8010);
        expect(map.byFile.get("lib/util.h").mappedLines).toEqual([4]);
        // System headers and pathless asm-fallback rows do not map.
        expect(map.addrToLoc.has(0x8040)).toBe(false);
        expect(map.addrToLoc.has(0x8050)).toBe(false);
    });

    test("zmac: pathless rows are the main source, banner paths their file", () => {
        const map = buildWorkerListingMap("zmac", ZMAC_LISTINGS, new Set(["inc/util.asm"]));
        expect(map.mappedLines).toEqual([2, 3, 5]);
        expect(map.byFile.get("inc/util.asm").lineToAddr.get(2)).toBe(0x8005);
        expect(map.addrToLoc.get(0x8009)).toEqual({file: null, line: 5});
    });

    test("only the main translation unit's listing is read", () => {
        const map = buildWorkerListingMap("sdcc", SDCC_LISTINGS, new Set());
        expect(map.addrToLoc.has(0x8000)).toBe(false); // crt0.lst ignored
    });

    test("returns null for missing or empty listings", () => {
        expect(buildWorkerListingMap("sdcc", null, new Set())).toBeNull();
        expect(buildWorkerListingMap("sdcc", {}, new Set())).toBeNull();
        expect(buildWorkerListingMap("sdcc", {"source.lst": {lines: []}}, new Set())).toBeNull();
        // All rows filtered (unknown paths only) -> null.
        expect(buildWorkerListingMap("sdcc", {
            "source.lst": {lines: [{line: 1, offset: 0x8000, path: "mystery.h"}]},
        }, new Set())).toBeNull();
    });

    test("interops with the sld helpers the reducer and session use", () => {
        const map = buildWorkerListingMap("zmac", ZMAC_LISTINGS, new Set(["inc/util.asm"]));
        expect(snapLine(map, 4, null)).toBe(5);
        expect(snapLine(map, 1, "inc/util.asm")).toBe(2);
        expect(locToAddr(map, null, 3)).toBe(0x8002);
        expect(locToAddr(map, "inc/util.asm", 2)).toBe(0x8005);
    });
});
