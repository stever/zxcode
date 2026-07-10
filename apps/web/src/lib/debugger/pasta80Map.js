// Source map builder for Pasta80 Pascal programs. Pasta80's backend is
// sjasmplus: its generated asm marks every source line and the service
// parses the listing into per-file line→address entries ({kind: "pasta80",
// files: {"<file>": [[line, addr], ...]}} — "" keys the main source, other
// keys staged {$i} include files by relative path; see apps/pasta80
// build_debug_info). An older service may still send the single-file shape
// ({entries: [[line, addr], ...]}), which reads as main-source-only.
//
// These are plain Z80 program addresses, so the returned map is a straight
// ADDRESS map like parseSld's (no `kind`): breakpoints arm as ordinary
// address breakpoints, the paused line resolves from the pc, and the
// pause lands BEFORE the line executes — sjasmplus semantics, not the
// Boriel post-line variant.
//
// One toolchain wart to know about: a typed declaration (`I: Integer;`)
// can map — pasta attributes the global's storage bytes to it — and a dot
// there never fires, the same as a dot on an asm `dw` line.

// buildPasta80Map(debug) -> null | map (parseSld shape).
// `debug` is the parsed service payload; null/invalid input returns null.
export function buildPasta80Map(debug) {
    if (!debug) return null;
    let fileEntries;
    if (debug.files && typeof debug.files === "object") {
        fileEntries = Object.entries(debug.files);
    } else if (Array.isArray(debug.entries)) {
        fileEntries = [["", debug.entries]];
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
            const [line, addr] = entry;
            if (!Number.isInteger(line) || line < 1) continue;
            if (!Number.isInteger(addr) || addr < 0 || addr > 0xFFFF) continue;
            if (!lineToAddr.has(line)) lineToAddr.set(line, addr);
            if (!addrToLoc.has(addr)) addrToLoc.set(addr, {file, line});
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
    for (const [addr, loc] of addrToLoc) {
        if (loc.file === null) addrToLine.set(addr, loc.line);
    }
    return {
        byFile,
        addrToLoc,
        lineToAddr: main.lineToAddr,
        addrToLine,
        mappedLines: main.mappedLines,
        labels: new Map(),
    };
}
