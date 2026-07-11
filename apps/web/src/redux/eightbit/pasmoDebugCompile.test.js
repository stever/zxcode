import getPasmoTap from "pasmo";
import {harvestPasmoSourceMap} from "./pasmoDebugCompile";
import {locToAddr} from "../../lib/debugger/sld";

// End-to-end through the real pasmo wasm: the user's build, then the
// label-injected -d harvest, joined into the debugger's address map.

const MAIN = [
    "ORG 32768",           // 1
    "start:",              // 2
    "    ld a, 2",         // 3  -> 0x8000
    "    call 5633",       // 4  -> 0x8002
    '    INCLUDE "lib/util.asm"', // 5
    "loop:",               // 6
    "    ld a, 65",        // 7  -> 0x8006 (after the 1-byte include)
    "    rst 16",          // 8  -> 0x8008
    "msg DEFB \"Hi\"",     // 9  -> 0x8009 (label join, data line)
    "    ret",             // 10 -> 0x800B
    "END 32768",           // 11
].join("\n");

const FILES = {
    "lib/util.asm": [
        "; helper",        // 1
        "    nop",         // 2  -> 0x8005, after the 3-byte call
    ].join("\n"),
};

describe("harvestPasmoSourceMap", () => {
    test("maps instruction lines in the main source and includes", async () => {
        const tap = await getPasmoTap(MAIN, FILES);
        const map = await harvestPasmoSourceMap(MAIN, FILES, tap);
        expect(map).not.toBeNull();
        expect(locToAddr(map, null, 3)).toBe(0x8000);
        expect(locToAddr(map, null, 4)).toBe(0x8002);
        expect(locToAddr(map, "lib/util.asm", 2)).toBe(0x8005);
        expect(locToAddr(map, null, 7)).toBe(0x8006);
        expect(locToAddr(map, null, 8)).toBe(0x8008);
        expect(locToAddr(map, null, 10)).toBe(0x800B);
        // Label-only and labelled-data lines join through their labels.
        expect(locToAddr(map, null, 2)).toBe(0x8000);
        expect(locToAddr(map, null, 6)).toBe(0x8006);
        expect(locToAddr(map, null, 9)).toBe(0x8009);
        // The pause at a shared address highlights the instruction line.
        expect(map.addrToLoc.get(0x8000)).toEqual({file: null, line: 3});
        // User labels only become symbols.
        expect([...map.labels.keys()].sort())
            .toEqual(["loop", "msg", "start"]);
        // Directive and comment lines don't map.
        expect(locToAddr(map, null, 1)).toBeUndefined();
        expect(locToAddr(map, null, 5)).toBeUndefined();
        expect(locToAddr(map, "lib/util.asm", 1)).toBeUndefined();
    });

    test("a broken harvest yields no map, never a wrong one", async () => {
        // Same file included twice: the real build is fine, the injected
        // build duplicates its labels and fails.
        const main = [
            "ORG 32768",
            '    INCLUDE "lib/util.asm"',
            '    INCLUDE "lib/util.asm"',
            "    ret",
            "END 32768",
        ].join("\n");
        const tap = await getPasmoTap(main, FILES);
        const map = await harvestPasmoSourceMap(main, FILES, tap);
        expect(map).toBeNull();
    });
});
