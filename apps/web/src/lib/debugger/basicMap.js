// Source map builder for NextBASIC programs — the interpreted counterpart
// to the sjasmplus SLD parser (sld.js). BASIC lines carry their own numbers
// in the source, so the "address" a breakpoint arms at is simply the BASIC
// line number; the engine watches the interpreter's PPC system variable
// ($5C45, the line being executed) and halts when it enters an armed line
// (`set-basic-bp` — see zx_go's basicbp_cmd.go).
//
// The returned object matches the parseSld shape so the debugger reducer's
// snapping/re-anchoring and the session's map plumbing work unchanged:
// lineToAddr maps editor line -> BASIC line number, addrToLoc maps BASIC
// line number -> editor location. `kind: "basic"` tells the session to arm
// through basic-bp commands and to resolve the paused line from PPC instead
// of the Z80 pc.
//
// Only the main source participates: extra project files on a Next are SD
// card assets, not compiled code. Unnumbered lines (#program/#autostart
// directives, blanks, txt2bas comments) get no mapping — a gutter click on
// one snaps to the next numbered line, like a click on an asm comment.

// NextZXOS accepts program lines 1-9999; anything else on the front of a
// line is not a line number (and PPC values above this range are
// interpreter states, never program lines).
const MAX_BASIC_LINE = 9999;

// parseBasicMap(source) -> null | map (parseSld shape + kind: "basic").
// Null when no line of the source starts with a BASIC line number.
export function parseBasicMap(source) {
    if (typeof source !== "string" || source.length === 0) return null;
    const lineToAddr = new Map();
    const addrToLoc = new Map();
    const rows = source.split("\n");
    for (let i = 0; i < rows.length; i++) {
        const m = rows[i].match(/^\s*(\d+)\b/);
        if (!m) continue;
        const basicLine = parseInt(m[1], 10);
        if (basicLine < 1 || basicLine > MAX_BASIC_LINE) continue;
        const editorLine = i + 1;
        // First occurrence wins in both directions, mirroring parseSld;
        // duplicate BASIC line numbers in a source file are already a
        // program bug the tokeniser surfaces.
        if (!lineToAddr.has(editorLine)) lineToAddr.set(editorLine, basicLine);
        if (!addrToLoc.has(basicLine)) {
            addrToLoc.set(basicLine, {file: null, line: editorLine});
        }
    }
    if (lineToAddr.size === 0) return null;
    const mappedLines = [...lineToAddr.keys()].sort((a, b) => a - b);
    const addrToLine = new Map();
    for (const [basicLine, loc] of addrToLoc) {
        addrToLine.set(basicLine, loc.line);
    }
    return {
        kind: "basic",
        byFile: new Map([[null, {lineToAddr, mappedLines}]]),
        addrToLoc,
        lineToAddr,
        addrToLine,
        mappedLines,
        labels: new Map(),
    };
}
