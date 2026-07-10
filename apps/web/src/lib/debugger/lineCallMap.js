// Source map builder for Boriel ZX BASIC (compiled) programs — the third
// map producer after sld.js (sjasmplus) and basicMap.js (interpreted
// BASICs). The zxbasic service compiles with --enable-break, which plants
// one CHECK_BREAK runtime call per executed source line with the line
// number in HL; the emulator's linecall breakpoints anchor on that
// routine's address (`linecall-anchor` / `set-linecall-bp`, zx_go
// linecallbp_cmd.go). The service reports the anchor address and the exact
// set of lines that received a check ({kind: "zxbasic", anchor, lines} —
// see apps/zxbasic build_debug_info).
//
// zxbc line numbers are file lines (leading BASIC numbers are labels), so
// the editor-line mapping is the identity over the reported line set. The
// returned object matches the parseSld shape, with `kind: "linecall"` and
// `anchor` telling the session to arm through linecall commands and to
// resolve the paused line from HL at the anchor instead of the Z80 pc.
//
// Semantics note baked into the toolchain: the check runs at the END of a
// line's statements, so a breakpoint on line N pauses after N executes.
//
// Only the main source participates: a check's HL value cannot say which
// #include'd file it came from, so the service reports main-file lines
// only.

// buildLineCallMap(debug) -> null | map (parseSld shape + kind/anchor).
// `debug` is the parsed service payload; null/invalid input returns null.
export function buildLineCallMap(debug) {
    if (!debug || !Number.isInteger(debug.anchor) || !Array.isArray(debug.lines)) {
        return null;
    }
    const lineToAddr = new Map();
    const addrToLoc = new Map();
    for (const line of debug.lines) {
        if (!Number.isInteger(line) || line < 1 || line > 0xFFFF) continue;
        if (!lineToAddr.has(line)) {
            lineToAddr.set(line, line);
            addrToLoc.set(line, {file: null, line});
        }
    }
    if (lineToAddr.size === 0) return null;
    const mappedLines = [...lineToAddr.keys()].sort((a, b) => a - b);
    return {
        kind: "linecall",
        anchor: debug.anchor & 0xFFFF,
        byFile: new Map([[null, {lineToAddr, mappedLines}]]),
        addrToLoc,
        lineToAddr,
        addrToLine: new Map(lineToAddr),
        mappedLines,
        labels: new Map(),
    };
}
