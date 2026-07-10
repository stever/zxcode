// Source map builder for the in-browser 8bitworker toolchains (sdcc, zmac)
// — the sixth map producer. The worker's build result already carries
// per-file line→address listings (lib/8bitworker/defs_build_result.ts:
// listings[path].lines = [{line, offset, path?}]), parsed from SDCC's
// relocated .rst (C-line markers, `<stdin>` = the piped main source) or
// zmac's .lst (include banners; path undefined = main). Addresses are
// absolute: both toolchains build for code_start $8000 and bin2tap loads
// the binary there.
//
// The result is a plain multi-file ADDRESS map like parseSld's (no
// `kind`): sjasmplus-style breakpoints, pause-before-line, per-file keying
// by the staged `folder/name` path (null = main source). Paths that are
// neither the main source nor a staged project file (system headers,
// crt0) are dropped.

// The main translation unit's listing key: the saga stages the main source
// as source.c / source.asm, and the worker names outputs <stem>.lst.
const MAIN_LISTING_KEY = "source.lst";

// Marker spellings that mean "the main source" rather than a project file.
const MAIN_PATHS = new Set(["<stdin>", "source.c", "source.asm", "./source.c", "./source.asm"]);

// buildWorkerListingMap(lang, listings, stagedNames) -> null | map.
// `lang` decides how a missing path is read: zmac's main-file rows carry
// no path, while sdcc source rows always carry one (`<stdin>` for main) —
// sdcc rows WITHOUT a path are its asm-level fallback listing and must
// not map onto C lines. `stagedNames` is a Set of project file paths.
export function buildWorkerListingMap(lang, listings, stagedNames) {
    const lines = listings?.[MAIN_LISTING_KEY]?.lines;
    if (!Array.isArray(lines) || lines.length === 0) return null;
    const byFile = new Map();
    const addrToLoc = new Map();
    for (const entry of lines) {
        const {line, offset, path} = entry ?? {};
        if (!Number.isInteger(line) || line < 1) continue;
        if (!Number.isInteger(offset) || offset < 0 || offset > 0xFFFF) continue;
        let file;
        if (path === undefined || path === null) {
            if (lang !== "zmac") continue; // sdcc asm-fallback rows
            file = null;
        } else if (MAIN_PATHS.has(path)) {
            file = null;
        } else if (stagedNames?.has(path)) {
            file = path;
        } else {
            continue; // system header / crt0 / unknown
        }
        let maps = byFile.get(file);
        if (!maps) {
            maps = {lineToAddr: new Map(), mappedLines: []};
            byFile.set(file, maps);
        }
        if (!maps.lineToAddr.has(line)) maps.lineToAddr.set(line, offset);
        if (!addrToLoc.has(offset)) addrToLoc.set(offset, {file, line});
    }
    let hasLines = false;
    for (const maps of byFile.values()) {
        maps.mappedLines = [...maps.lineToAddr.keys()].sort((a, b) => a - b);
        if (maps.mappedLines.length > 0) hasLines = true;
    }
    if (!hasLines) return null;
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
