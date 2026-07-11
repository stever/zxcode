// Source map builder for Pasmo (asm) programs — the seventh map producer.
// Pasmo has no listing output (its -d debug echo prints each assembled
// statement with its address but no source line numbers), so the map is
// harvested from a second, best-effort "debug build": a uniquely named
// zero-byte label (__zxdbg_<n>) is injected before every instruction line,
// the build runs with -d, and each injected label's `ADDR: label NAME` echo
// pins its source line to an address. Lines that already start with a user
// label can't take a second label (pasmo rejects chained labels) and join
// through their own label's echo instead.
//
// The injection is deliberately conservative — a missing map entry is
// harmless, a wrong one is not:
//   - nothing is injected inside MACRO/REPT/IRP bodies (the label would be
//     defined once per expansion and duplicate),
//   - only lines whose first token is a Z80 mnemonic or a known macro name
//     are injected (label-before-macro-invocation is legal pasmo),
//   - labels injected into false IF branches echo as skipped text, never as
//     `label`, so they simply don't map.
// The caller additionally discards the whole map unless the debug build's
// TAP is byte-identical to the real build's (labels emit no bytes, so any
// difference means the injection perturbed the program).
//
// The result is a plain multi-file ADDRESS map like parseSld's (no `kind`):
// sjasmplus-style breakpoints, pause-before-line, per-file keying by the
// staged `folder/name` path (null = main source). Addresses are absolute —
// pasmo assembles at the program's real ORG.

// Z80 mnemonics pasmo assembles — a line starting with one of these (and
// no label) is an instruction line, matching pasmo's own first-token logic.
const MNEMONICS = new Set([
    "ADC", "ADD", "AND", "BIT", "CALL", "CCF", "CP", "CPD", "CPDR", "CPI",
    "CPIR", "CPL", "DAA", "DEC", "DI", "DJNZ", "EI", "EX", "EXX", "HALT",
    "IM", "IN", "INC", "IND", "INDR", "INI", "INIR", "JP", "JR", "LD",
    "LDD", "LDDR", "LDI", "LDIR", "NEG", "NOP", "OR", "OTDR", "OTIR",
    "OUT", "OUTD", "OUTI", "POP", "PUSH", "RES", "RET", "RETI", "RETN",
    "RL", "RLA", "RLC", "RLCA", "RLD", "RR", "RRA", "RRC", "RRCA", "RRD",
    "RST", "SBC", "SCF", "SET", "SLA", "SLL", "SRA", "SRL", "SUB", "XOR",
]);

// Directives that open a macro-family body; ENDM closes one.
const MACRO_OPENERS = new Set(["MACRO", "REPT", "IRP"]);

const LABEL_PREFIX = "__zxdbg_";
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Staged file extensions that hold pasmo source (INCLUDE targets). Other
// text files (data INCBINed as-is, etc.) must stay byte-identical.
const ASM_EXTENSIONS = new Set(["asm", "inc", "z80"]);

function isAsmPath(path) {
    const dot = path.lastIndexOf(".");
    if (dot < 0) return false;
    return ASM_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

// First two whitespace-separated tokens of a line, comments excluded.
function firstTokens(line) {
    const m = /^\s*([^\s;]+)(?:[ \t]+([^\s;]+))?/.exec(line);
    if (!m) return [undefined, undefined];
    return [m[1], m[2]];
}

// injectPasmoDebugLabels(code, files) -> null | {code, files, labelToLoc}.
// `files` is the pasmo staging map ({path: string|Uint8Array}); string
// files with asm extensions get labels injected, everything else passes
// through untouched. labelToLoc maps every label name the echo could
// report — injected and user — to {file, line, injected} (file null =
// main source, line 1-based). Null when the source already uses the
// injection prefix (the harvest would be ambiguous).
export function injectPasmoDebugLabels(code, files = {}) {
    const units = [{file: null, text: code}];
    for (const [path, data] of Object.entries(files)) {
        if (typeof data === "string" && isAsmPath(path)) {
            units.push({file: path, text: data});
        }
    }
    if (units.some((u) => u.text.includes(LABEL_PREFIX))) return null;

    // Macro names first, across all files — an invocation line looks like
    // a bare label line otherwise. Names are compared uppercased, like
    // pasmo's case-insensitive keywords.
    const macroNames = new Set();
    for (const unit of units) {
        for (const line of unit.text.split(/\r?\n/)) {
            const [tok1, tok2] = firstTokens(line);
            if (!tok1) continue;
            if (tok1.toUpperCase() === "MACRO" && tok2) {
                macroNames.add(tok2.toUpperCase());
            } else if (tok2 && tok2.toUpperCase() === "MACRO") {
                macroNames.add(tok1.replace(/:$/, "").toUpperCase());
            }
        }
    }

    const labelToLoc = new Map();
    let seq = 0;
    const injectUnit = (unit) => {
        const lines = unit.text.split(/\r?\n/);
        let depth = 0;
        const out = lines.map((line, i) => {
            const [tok1, tok2] = firstTokens(line);
            if (!tok1) return line;
            const tok1U = tok1.toUpperCase();
            const tok2U = tok2 ? tok2.toUpperCase() : undefined;
            if (tok1U === "ENDM") {
                depth = Math.max(0, depth - 1);
                return line;
            }
            if (MACRO_OPENERS.has(tok1U) || tok2U === "MACRO") {
                depth += 1;
                return line;
            }
            if (depth > 0) return line;
            if (tok1.endsWith(":")) {
                // A labelled line can't take a second label — it joins
                // through its own label's echo.
                const name = tok1.slice(0, -1);
                if (IDENT_RE.test(name) && !labelToLoc.has(name)) {
                    labelToLoc.set(
                        name, {file: unit.file, line: i + 1, injected: false});
                }
                return line;
            }
            if (MNEMONICS.has(tok1U) || macroNames.has(tok1U)) {
                const name = `${LABEL_PREFIX}${seq++}`;
                labelToLoc.set(
                    name, {file: unit.file, line: i + 1, injected: true});
                return `${name}: ${line}`;
            }
            // Bare identifier: a colonless label (`loop`, `msg DEFB ...`)
            // — or a directive like ORG/INCLUDE, which never echoes as
            // `label <name>` and so never joins. First-wins like pasmo's
            // own unique-globals rule.
            if (IDENT_RE.test(tok1) && !labelToLoc.has(tok1)) {
                labelToLoc.set(
                    tok1, {file: unit.file, line: i + 1, injected: false});
            }
            return line;
        });
        return out.join("\n");
    };

    const injectedCode = injectUnit(units[0]);
    const injectedFiles = {...files};
    for (const unit of units.slice(1)) {
        injectedFiles[unit.file] = injectUnit(unit);
    }
    return {code: injectedCode, files: injectedFiles, labelToLoc};
}

// A label definition in pasmo's -d echo: `8000:\t\tlabel start`. `local
// label` lines (macro LOCALs) intentionally don't match.
const ECHO_LABEL_RE = /^([0-9A-F]{4}):\s+label\s+(\S+)$/i;

// buildPasmoDebugMap(echo, labelToLoc) -> null | map (parseSld shape).
// `echo` is the debug build's stdout lines. Injected labels take
// precedence in addrToLoc — where a user label line and the instruction
// line below it share an address, the pause highlights the instruction.
// User labels (only) are reported in map.labels; EQU/DEFL never echo as
// `label`, so their non-address values are excluded for free.
export function buildPasmoDebugMap(echo, labelToLoc) {
    if (!Array.isArray(echo) || !(labelToLoc instanceof Map)) return null;
    const entries = [];
    for (const text of echo) {
        const m = ECHO_LABEL_RE.exec(text);
        if (!m) continue;
        const loc = labelToLoc.get(m[2]);
        if (!loc) continue;
        entries.push({addr: parseInt(m[1], 16), name: m[2], loc});
    }
    if (entries.length === 0) return null;
    const byFile = new Map();
    const addrToLoc = new Map();
    const labels = new Map();
    for (const pass of [true, false]) {
        for (const {addr, name, loc} of entries) {
            if (loc.injected !== pass) continue;
            let maps = byFile.get(loc.file);
            if (!maps) {
                maps = {lineToAddr: new Map(), mappedLines: []};
                byFile.set(loc.file, maps);
            }
            if (!maps.lineToAddr.has(loc.line)) {
                maps.lineToAddr.set(loc.line, addr);
            }
            if (!addrToLoc.has(addr)) {
                addrToLoc.set(addr, {file: loc.file, line: loc.line});
            }
            if (!loc.injected && !labels.has(name)) labels.set(name, addr);
        }
    }
    for (const maps of byFile.values()) {
        maps.mappedLines = [...maps.lineToAddr.keys()].sort((a, b) => a - b);
    }
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
        labels,
    };
}
