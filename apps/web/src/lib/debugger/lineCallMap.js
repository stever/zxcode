// Source map builder for Boriel ZX BASIC (compiled) programs. The zxbasic
// service compiles with --enable-break, which plants one CHECK_BREAK
// runtime call per executed source line with a line number in HL; the
// emulator's linecall breakpoints anchor on that routine's address
// (`linecall-anchor` / `set-linecall-bp`, zx_go linecallbp_cmd.go).
//
// Line numbers are per-file in the raw codegen, so the service rewrites
// include-file check operands to disjoint VIRTUAL ranges (base 10000·k per
// include) before assembly and reports {kind: "zxbasic", anchor, files:
// {"<file>": [[line, virt], ...]}} — "" keys the main source (virt ==
// line there), other keys staged #include files by relative path (see
// apps/zxbasic build_multifile_tap). An older service may still send the
// single-file shape ({lines: [...]}), which reads as main-source-only.
//
// The returned map matches the parseSld shape with the VIRTUAL line as the
// "address": `kind: "linecall"` plus `anchor` tell the session to arm the
// virtual numbers through linecall commands and to resolve the paused
// line from HL at the anchor — addrToLoc(hl) then lands in the right file
// and real line. Session logic is unchanged from the single-file era.
//
// Semantics note baked into the toolchain: the check runs at the END of a
// line's statements, so a breakpoint on line N pauses after N executes.

// buildLineCallMap(debug) -> null | map (parseSld shape + kind/anchor).
// `debug` is the parsed service payload; null/invalid input returns null.
export function buildLineCallMap(debug) {
    if (!debug || !Number.isInteger(debug.anchor)) return null;
    let fileEntries;
    if (debug.files && typeof debug.files === "object") {
        fileEntries = Object.entries(debug.files);
    } else if (Array.isArray(debug.lines)) {
        // Legacy single-file shape: plain line numbers, virt == line.
        fileEntries = [["", debug.lines.map((line) => [line, line])]];
    } else {
        return null;
    }
    const byFile = new Map();
    const addrToLoc = new Map();
    for (const [key, entries] of fileEntries) {
        if (!Array.isArray(entries)) continue;
        const file = key === "" ? null : key;
        const lineToAddr = new Map();
        for (const entry of entries) {
            if (!Array.isArray(entry) || entry.length !== 2) continue;
            const [line, virt] = entry;
            if (!Number.isInteger(line) || line < 1) continue;
            if (!Number.isInteger(virt) || virt < 1 || virt > 0xFFFE) continue;
            if (!lineToAddr.has(line)) lineToAddr.set(line, virt);
            if (!addrToLoc.has(virt)) addrToLoc.set(virt, {file, line});
        }
        if (lineToAddr.size > 0) {
            byFile.set(file, {
                lineToAddr,
                mappedLines: [...lineToAddr.keys()].sort((a, b) => a - b),
            });
        }
    }
    if (byFile.size === 0) return null;
    const main = byFile.get(null) ?? {lineToAddr: new Map(), mappedLines: []};
    const addrToLine = new Map();
    for (const [virt, loc] of addrToLoc) {
        if (loc.file === null) addrToLine.set(virt, loc.line);
    }
    return {
        kind: "linecall",
        anchor: debug.anchor & 0xFFFF,
        byFile,
        addrToLoc,
        lineToAddr: main.lineToAddr,
        addrToLine,
        mappedLines: main.mappedLines,
        labels: new Map(),
    };
}
