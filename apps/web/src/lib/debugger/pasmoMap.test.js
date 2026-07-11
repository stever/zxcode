import {injectPasmoDebugLabels, buildPasmoDebugMap} from "./pasmoMap";
import {snapLine, locToAddr} from "./sld";

// Convenience: run injection, then feed a synthetic -d echo built from
// [labelName, addr] pairs through the map builder.
function mapFrom(entries, labelToLoc) {
    const echo = entries.map(([name, addr]) =>
        `${addr.toString(16).toUpperCase().padStart(4, "0")}:\t\tlabel ${name}`);
    return buildPasmoDebugMap(echo, labelToLoc);
}

describe("injectPasmoDebugLabels", () => {
    test("prefixes mnemonic lines, leaves labelled lines for their own label", () => {
        const code = [
            "ORG 32768",       // 1: directive, untouched
            "start:",          // 2: user label, recorded
            "    ld a, 2",     // 3: injected
            "loop ret",        // 4: colonless label line, recorded
        ].join("\n");
        const {code: out, labelToLoc} = injectPasmoDebugLabels(code);
        const lines = out.split("\n");
        expect(lines[0]).toBe("ORG 32768");
        expect(lines[1]).toBe("start:");
        expect(lines[2]).toMatch(/^__zxdbg_\d+:     ld a, 2$/);
        expect(lines[3]).toBe("loop ret");
        expect(labelToLoc.get("start")).toEqual(
            {file: null, line: 2, injected: false});
        expect(labelToLoc.get("loop")).toEqual(
            {file: null, line: 4, injected: false});
        const injected = [...labelToLoc.entries()]
            .find(([, loc]) => loc.injected);
        expect(injected[1]).toEqual({file: null, line: 3, injected: true});
    });

    test("never injects inside MACRO/REPT bodies, does before invocations", () => {
        const code = [
            "WRCH MACRO ch",   // 1: opens macro body
            "    ld a, ch",    // 2: body — untouched
            "    ENDM",        // 3: closes
            "    REPT 3",      // 4: opens
            "    nop",         // 5: body — untouched
            "    ENDM",        // 6: closes
            "    WRCH 65",     // 7: known-macro invocation — injected
            "    ret",         // 8: injected
        ].join("\n");
        const {code: out} = injectPasmoDebugLabels(code);
        const lines = out.split("\n");
        expect(lines[1]).toBe("    ld a, ch");
        expect(lines[4]).toBe("    nop");
        expect(lines[6]).toMatch(/^__zxdbg_\d+:     WRCH 65$/);
        expect(lines[7]).toMatch(/^__zxdbg_\d+:     ret$/);
    });

    test("injects asm project files, passes other staged data through", () => {
        const files = {
            "lib/util.asm": "    xor a\n    ret",
            "data/sprites.bin": Uint8Array.of(1, 2, 3),
            "notes.txt": "not assembly",
        };
        const result = injectPasmoDebugLabels("    ret", files);
        expect(result.files["lib/util.asm"].split("\n")[0])
            .toMatch(/^__zxdbg_\d+:     xor a$/);
        expect(result.files["data/sprites.bin"]).toBe(files["data/sprites.bin"]);
        expect(result.files["notes.txt"]).toBe("not assembly");
        const utilLoc = [...result.labelToLoc.values()]
            .find((loc) => loc.file === "lib/util.asm");
        expect(utilLoc).toEqual({file: "lib/util.asm", line: 1, injected: true});
    });

    test("returns null when the source already uses the injection prefix", () => {
        expect(injectPasmoDebugLabels("__zxdbg_0: ret")).toBeNull();
        expect(injectPasmoDebugLabels("    ret", {"a.asm": "__zxdbg_1: nop"}))
            .toBeNull();
    });

    test("comment and blank lines are untouched", () => {
        const code = "; comment\n\n    ld a, 1";
        const {code: out} = injectPasmoDebugLabels(code);
        const lines = out.split("\n");
        expect(lines[0]).toBe("; comment");
        expect(lines[1]).toBe("");
        expect(lines[2]).toMatch(/^__zxdbg_\d+: /);
    });
});

describe("buildPasmoDebugMap", () => {
    test("joins echoed labels to their recorded lines, parseSld shape", () => {
        const labelToLoc = new Map([
            ["start", {file: null, line: 2, injected: false}],
            ["__zxdbg_0", {file: null, line: 3, injected: true}],
            ["__zxdbg_1", {file: "lib/util.asm", line: 1, injected: true}],
        ]);
        const map = mapFrom([
            ["start", 0x8000],
            ["__zxdbg_0", 0x8000],
            ["__zxdbg_1", 0x8005],
        ], labelToLoc);
        expect(map.mappedLines).toEqual([2, 3]);
        expect(locToAddr(map, null, 3)).toBe(0x8000);
        expect(locToAddr(map, "lib/util.asm", 1)).toBe(0x8005);
        expect(snapLine(map, 1)).toBe(2);
        // The user label line and the instruction below share 0x8000; the
        // pause highlights the instruction (injected entries win).
        expect(map.addrToLoc.get(0x8000)).toEqual({file: null, line: 3});
        // Only user labels are reported as symbols.
        expect([...map.labels.keys()]).toEqual(["start"]);
        expect(map.labels.get("start")).toBe(0x8000);
    });

    test("ignores unknown labels, local labels and non-label echo lines", () => {
        const labelToLoc = new Map([
            ["__zxdbg_0", {file: null, line: 1, injected: true}],
        ]);
        const map = buildPasmoDebugMap([
            "\t\tORG 8000",
            "8000:\t\tlabel __zxdbg_0",
            "8000:3E02\tLD A, 02",
            "8002:\t\tlocal label lloc",
            "8002:\t\tlabel mystery",
            "count\t\tDEFL 0005",
            "-     ld c, 2",
        ], labelToLoc);
        expect(map.mappedLines).toEqual([1]);
        expect(map.addrToLoc.size).toBe(1);
        expect(map.labels.size).toBe(0);
    });

    test("returns null when nothing joins", () => {
        expect(buildPasmoDebugMap([], new Map())).toBeNull();
        expect(buildPasmoDebugMap(
            ["8000:\t\tlabel unknown"], new Map())).toBeNull();
        expect(buildPasmoDebugMap(null, new Map())).toBeNull();
    });
});
