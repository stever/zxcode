// Source map builder for Pasta80 Pascal programs — the fourth map producer
// after sld.js (sjasmplus), basicMap.js (interpreted BASICs) and
// lineCallMap.js (Boriel). Pasta80's backend is sjasmplus: its generated
// asm marks every Pascal source line and the service parses the listing
// into line→address entries ({kind: "pasta80", entries: [[line, addr]]} —
// see apps/pasta80 build_debug_info).
//
// These are plain Z80 program addresses, so the returned map is a straight
// ADDRESS map like parseSld's (no `kind`): breakpoints arm as ordinary
// address breakpoints, the paused line resolves from the pc, and the
// pause lands BEFORE the line executes — sjasmplus semantics, not the
// Boriel post-line variant. Only the main source participates.
//
// One toolchain wart to know about: a typed declaration (`I: Integer;`)
// can map — pasta attributes the global's storage bytes to it — and a dot
// there never fires, the same as a dot on an asm `dw` line.

// buildPasta80Map(debug) -> null | map (parseSld shape).
// `debug` is the parsed service payload; null/invalid input returns null.
export function buildPasta80Map(debug) {
    if (!debug || !Array.isArray(debug.entries)) return null;
    const lineToAddr = new Map();
    const addrToLoc = new Map();
    for (const entry of debug.entries) {
        if (!Array.isArray(entry) || entry.length !== 2) continue;
        const [line, addr] = entry;
        if (!Number.isInteger(line) || line < 1) continue;
        if (!Number.isInteger(addr) || addr < 0 || addr > 0xFFFF) continue;
        if (!lineToAddr.has(line)) lineToAddr.set(line, addr);
        if (!addrToLoc.has(addr)) addrToLoc.set(addr, {file: null, line});
    }
    if (lineToAddr.size === 0) return null;
    const mappedLines = [...lineToAddr.keys()].sort((a, b) => a - b);
    const addrToLine = new Map();
    for (const [addr, loc] of addrToLoc) addrToLine.set(addr, loc.line);
    return {
        byFile: new Map([[null, {lineToAddr, mappedLines}]]),
        addrToLoc,
        lineToAddr,
        addrToLine,
        mappedLines,
        labels: new Map(),
    };
}
