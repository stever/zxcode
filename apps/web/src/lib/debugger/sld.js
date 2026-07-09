// Parser for sjasmplus SLD ("Source Level Debugging") files — the map the
// debugger uses to arm source-line breakpoints and to highlight the paused
// line. Format reference: sjasmplus docs (the same data DeZog consumes).
//
// Every record is one pipe-separated line:
//
//   sourcefile|line|definitionfile|definitionline|page|value|type|data
//
// of which this parser reads:
//   T — an instruction: `line` (1-based) assembled at address `value`
//   L — a label definition: `value` is its address, `data` is
//       ",name,...traits" (traits like +used, +equ, +module)
//
// The compile service assembles the main source as a fixed name
// (program.asm) with the project's additional files staged next to it, so
// records arrive per file. The main source is keyed as `null` here to match
// the debugger's breakpoint shape ({file: null, line} = main source);
// additional files are keyed by their project file name. Records from files
// with no editor buffer (e.g. Lua-generated) are parsed too — they simply
// never match a tab.

const MAIN_SOURCE_FILE = "program.asm";

// parseSld(text) -> null | {
//     byFile: Map<file, {                — file: null (main) or project name
//         lineToAddr: Map<line, addr>    — first instruction of each line
//         mappedLines: number[]          — sorted lines with code, for snapping
//     }>
//     addrToLoc: Map<addr, {file, line}> — reverse, first-wins (macros expand
//                                          many lines to one address range)
//     lineToAddr, addrToLine, mappedLines — the MAIN file's maps (addrToLine
//                                          restricted to main-file lines),
//                                          kept for single-file callers
//     labels: Map<name, addr>            — address labels (EQUs excluded:
//                                          their value is not an address)
// }
// Returns null when the text holds no instruction records (not assembled in
// device mode, or no code).
export function parseSld(text) {
    if (typeof text !== "string" || text.length === 0) return null;
    const byFile = new Map();
    const addrToLoc = new Map();
    const labels = new Map();
    const fileMaps = (file) => {
        let maps = byFile.get(file);
        if (!maps) {
            maps = {lineToAddr: new Map(), mappedLines: []};
            byFile.set(file, maps);
        }
        return maps;
    };
    for (const record of text.split("\n")) {
        const f = record.split("|");
        if (f.length < 8 || f[0] === "") continue;
        const file = f[0] === MAIN_SOURCE_FILE ? null : f[0];
        const line = parseInt(f[1], 10);
        const addr = parseInt(f[5], 10);
        if (!Number.isInteger(line) || !Number.isInteger(addr)) continue;
        const type = f[6];
        if (type === "T") {
            const a = addr & 0xFFFF;
            const maps = fileMaps(file);
            if (!maps.lineToAddr.has(line)) maps.lineToAddr.set(line, a);
            if (!addrToLoc.has(a)) addrToLoc.set(a, {file, line});
        } else if (type === "L") {
            // data is ",name,...": an optional module prefix before the
            // name, traits after. Skip EQUs — their value is arbitrary.
            const parts = f.slice(7).join("|").split(",");
            const name = parts[1];
            if (name && !parts.some((p) => p === "+equ")) {
                if (!labels.has(name)) labels.set(name, addr & 0xFFFF);
            }
        }
    }
    let hasCode = false;
    for (const maps of byFile.values()) {
        maps.mappedLines = [...maps.lineToAddr.keys()].sort((a, b) => a - b);
        if (maps.mappedLines.length > 0) hasCode = true;
    }
    if (!hasCode) return null;
    const main = byFile.get(null) ?? {lineToAddr: new Map(), mappedLines: []};
    const addrToLine = new Map();
    for (const [a, loc] of addrToLoc) {
        if (loc.file === null) addrToLine.set(a, loc.line);
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

// The nearest line at or below `line` that has code in the given file (null
// = the main source), the way IDE gutters snap a click on a comment or
// blank line down to the next instruction. Null when nothing below has code
// (data or directives to end of file, or a file with no records).
export function snapLine(map, line, file = null) {
    const maps = map.byFile?.get(file ?? null);
    if (!maps) return null;
    for (const candidate of maps.mappedLines) {
        if (candidate >= line) return candidate;
    }
    return null;
}

// The address a (file, line) breakpoint arms at, or undefined.
export function locToAddr(map, file, line) {
    return map.byFile?.get(file ?? null)?.lineToAddr.get(line);
}
