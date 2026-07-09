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
// The compile service assembles a single fixed source, so records are
// filtered to that file name; include-generated records (possible via Lua)
// have no editor buffer to land in.

const SOURCE_FILE = "program.asm";

// parseSld(text) -> null | {
//     lineToAddr: Map<line, addr>    — first instruction of each source line
//     addrToLine: Map<addr, line>    — reverse, first-wins (macros expand
//                                      many lines to one address range)
//     mappedLines: number[]          — sorted lines with code, for snapping
//     labels: Map<name, addr>        — address labels (EQUs excluded: their
//                                      value is not an address)
// }
// Returns null when the text holds no instruction records (not assembled in
// device mode, or no code).
export function parseSld(text) {
    if (typeof text !== "string" || text.length === 0) return null;
    const lineToAddr = new Map();
    const addrToLine = new Map();
    const labels = new Map();
    for (const record of text.split("\n")) {
        const f = record.split("|");
        if (f.length < 8 || f[0] !== SOURCE_FILE) continue;
        const line = parseInt(f[1], 10);
        const addr = parseInt(f[5], 10);
        if (!Number.isInteger(line) || !Number.isInteger(addr)) continue;
        const type = f[6];
        if (type === "T") {
            const a = addr & 0xFFFF;
            if (!lineToAddr.has(line)) lineToAddr.set(line, a);
            if (!addrToLine.has(a)) addrToLine.set(a, line);
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
    if (lineToAddr.size === 0) return null;
    return {
        lineToAddr,
        addrToLine,
        mappedLines: [...lineToAddr.keys()].sort((a, b) => a - b),
        labels,
    };
}

// The nearest line at or below `line` that has code, the way IDE gutters
// snap a click on a comment or blank line down to the next instruction.
// Null when nothing below has code (data or directives to end of file).
export function snapLine(map, line) {
    for (const candidate of map.mappedLines) {
        if (candidate >= line) return candidate;
    }
    return null;
}
