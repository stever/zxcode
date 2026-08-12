// Source map builder for z88dk C programs — the fifth map producer after
// sld.js (sjasmplus), basicMap.js (interpreted BASICs), lineCallMap.js
// (Boriel) and pasta80Map.js. The z88dk service parses the compiler's
// listing + link map into per-file line→address entries ({kind: "z88dk",
// files: {"<file>": [[line, addr], ...]}, labels: {"<sym>": addr}} — see
// apps/z88dk build_debug_info); the "" key is the main source and other
// keys are project files by relative path, matching the debugger's
// breakpoint file keying (null = main, folder/name otherwise). The
// optional labels object carries the user module's code symbols
// (functions, inline-asm labels) at their linked absolute addresses —
// realSession pushes them into the engine's sym table so disassembly and
// backtrace read annotated, like sjasmplus projects.
//
// These are plain Z80 program addresses, so the returned map is a straight
// ADDRESS map like parseSld's (no `kind`): breakpoints arm as ordinary
// address breakpoints, the paused line resolves from the pc, and the pause
// lands BEFORE the line executes. The usual optimised-C caveat applies:
// a breakpoint lands on the first instruction the compiler attributed to
// the line.

// buildZ88dkMap(debug) -> null | map (parseSld shape).
// `debug` is the parsed service payload; null/invalid input returns null.
export function buildZ88dkMap(debug) {
    if (!debug || !debug.files || typeof debug.files !== "object") return null;
    const byFile = new Map();
    const addrToLoc = new Map();
    for (const [key, entries] of Object.entries(debug.files)) {
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
    const labels = new Map();
    if (debug.labels && typeof debug.labels === "object" && !Array.isArray(debug.labels)) {
        for (const [name, addr] of Object.entries(debug.labels)) {
            if (!name) continue;
            if (!Number.isInteger(addr) || addr < 0 || addr > 0xFFFF) continue;
            if (!labels.has(name)) labels.set(name, addr);
        }
    }
    return {
        byFile,
        addrToLoc,
        lineToAddr: main.lineToAddr,
        addrToLine,
        mappedLines: main.mappedLines,
        labels,
    };
}
