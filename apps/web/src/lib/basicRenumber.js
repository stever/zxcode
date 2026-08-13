// Line renumbering for the interpreted-BASIC dialects (nextbas/txt2bas,
// basic/zmakebas and bas2tap — the isBasicLang set; Boriel compiles to
// machine code and jumps by label, so it has nothing to renumber). The
// program keeps its file order: each numbered line gets a fresh number
// (10, 20, 30 … by default) and every line REFERENCE — the numeric
// argument after GO TO / GO SUB / GOTO / GOSUB / RUN / RESTORE / LIST /
// LLIST / SAVE … LINE — is rewritten to follow its target. References
// resolve the way the ROM does: a jump lands on the first line >= n, so a
// reference between lines snaps to the next existing line's new number.
// References beyond the last line (the "GO TO 9999" stop idiom) still
// point beyond the last line afterwards, so they are left unchanged.
//
// Only simple numeric references are rewritten. A computed target
// (GO TO n*100) cannot be renumbered by any tool; it is left alone.
// String literals (with Sinclair's "" escaping) and everything after REM
// are never touched. The same caution applies to keyword matching: where
// the scanner cannot be sure (an identifier character joins the keyword),
// it leaves the text as it is — under-rewriting is recoverable, corrupting
// a DATA line is not.

// The ROM editors and all three tokenisers cap program lines at 9999;
// leading numbers outside 1..9999 are not line numbers (see basicMap.js).
const MAX_BASIC_LINE = 9999;

// Keywords whose immediate numeric argument is a line reference. Spaced
// and fused GO TO / GO SUB spellings both appear in real sources; every
// tokeniser accepts both. LINE is SAVE "name" LINE n. A digit may follow
// the keyword directly (GOTO10) but a letter may not (RUNNER is not RUN).
const REF_KEYWORD = /^(?:go\s*to|go\s*sub|goto|gosub|restore|run|llist|list|line)(?![a-zA-Z$_])/i;
// Word-bounded like the tokenisers: an identifier merely starting with
// "rem" (LET remainder=…) is not a comment, and mistaking it for one
// would leave the rest of the line's references un-renumbered.
const REM_KEYWORD = /^rem(?![a-zA-Z0-9$_])/i;
const IDENT_CHAR = /[a-zA-Z0-9$_]/;

// Rewrite the line references in one physical line's text (which must not
// include a leading line number — the caller strips it first). snap maps a
// referenced number to its replacement or null. Returns {text, updated}.
function rewriteRefs(text, snap) {
    let out = "";
    let updated = 0;
    let inString = false;
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (inString) {
            out += ch;
            if (ch === '"') inString = false;
            i++;
            continue;
        }
        if (ch === '"') {
            out += ch;
            inString = true;
            i++;
            continue;
        }
        // A keyword can only start at an identifier boundary.
        const prev = i > 0 ? text[i - 1] : "";
        if (!IDENT_CHAR.test(prev) && /[a-zA-Z]/.test(ch)) {
            const rest = text.slice(i);
            // Everything after REM is a comment; copy it verbatim. No
            // trailing-boundary check: the tokenisers match the keyword
            // prefix the same way (REMARK is REM + text).
            if (REM_KEYWORD.test(rest)) {
                out += rest;
                break;
            }
            const kw = rest.match(REF_KEYWORD);
            if (kw) {
                out += kw[0];
                i += kw[0].length;
                // The argument: optional spaces then a plain integer. The
                // (?![\d.]) guard cannot be satisfied by backtracking into
                // fewer digits, so a fractional target (150.5) matches
                // nothing at all rather than its leading digits.
                const arg = text.slice(i).match(/^(\s*)(\d+)(?![\d.])/);
                if (arg) {
                    const tail = text.slice(i + arg[0].length);
                    // An operator after the number (GO TO 5+10) or a
                    // scientific suffix (10e2) makes it a computed target:
                    // leave the whole expression alone.
                    if (/^\s*[+\-*\/^(]/.test(tail) || /^[eE]\d/.test(tail)) {
                        out += arg[0];
                    } else {
                        const target = snap(parseInt(arg[2], 10));
                        out += arg[1] + (target === null ? arg[2] : String(target));
                        if (target !== null && String(target) !== arg[2]) updated++;
                    }
                    i += arg[0].length;
                }
                continue;
            }
        }
        out += ch;
        i++;
    }
    return {text: out, updated};
}

// Pick the numbering scheme: prefer start/step as given, tighten the step
// (then the start) until the whole program fits under 9999.
function chooseScheme(count, start, step) {
    const fits = (s, t) => s + (count - 1) * t <= MAX_BASIC_LINE;
    for (const [s, t] of [[start, step], [start, 5], [start, 2], [start, 1], [1, 1]]) {
        if (fits(s, t)) return [s, t];
    }
    return null;
}

// renumberBasicSource(source, opts) -> {code, count, refsUpdated} on
// success, {error} otherwise. Options:
//   start, step        — numbering scheme (default 10/10, auto-tightened)
//   continuations      — honour zmakebas trailing-\ line continuations: a
//                        continuation row is program text, never a new
//                        numbered line, but its references are rewritten
//   autostartDirective — rewrite the line number of a txt2bas
//                        `#autostart <n>` directive (nextbas)
export function renumberBasicSource(source, opts = {}) {
    const {start = 10, step = 10, continuations = false, autostartDirective = false} = opts;
    if (typeof source !== "string" || source.length === 0) {
        return {error: "No BASIC lines to renumber."};
    }
    const rows = source.split("\n");

    // Pass 1: find the numbered rows, in file order (the order the
    // tokenisers require anyway). Continuation rows are never line starts.
    const numbered = [];
    let continued = false;
    for (let i = 0; i < rows.length; i++) {
        const isContinuation = continued;
        continued = continuations && rows[i].endsWith("\\");
        if (isContinuation) continue;
        const m = rows[i].match(/^\s*(\d+)\b/);
        if (!m) continue;
        const oldNum = parseInt(m[1], 10);
        if (oldNum < 1 || oldNum > MAX_BASIC_LINE) continue;
        numbered.push({row: i, oldNum});
    }
    if (numbered.length === 0) {
        return {error: "No BASIC line numbers found to renumber."};
    }
    const scheme = chooseScheme(numbered.length, start, step);
    if (scheme === null) {
        return {error: `Cannot renumber: ${numbered.length} lines do not fit in 1-${MAX_BASIC_LINE}.`};
    }
    const [firstNum, gap] = scheme;

    // Old -> new number map (first occurrence wins on duplicates, matching
    // basicMap.js) and the sorted old numbers for reference snapping.
    const oldToNew = new Map();
    const newByRow = new Map();
    numbered.forEach(({row, oldNum}, idx) => {
        const newNum = firstNum + idx * gap;
        newByRow.set(row, newNum);
        if (!oldToNew.has(oldNum)) oldToNew.set(oldNum, newNum);
    });
    const sortedOld = [...oldToNew.keys()].sort((a, b) => a - b);
    // A reference lands on the first line >= n (ROM semantics); past the
    // last line there is nothing to follow, so leave it unchanged (null).
    const snap = (n) => {
        let lo = 0, hi = sortedOld.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (sortedOld[mid] < n) lo = mid + 1;
            else hi = mid;
        }
        return lo < sortedOld.length ? oldToNew.get(sortedOld[lo]) : null;
    };

    // Pass 2: rewrite. Numbered rows get their new number and rewritten
    // references; continuation rows get references only; comment/directive
    // rows are untouched (bar #autostart when asked).
    let refsUpdated = 0;
    continued = false;
    const out = rows.map((row, i) => {
        const isContinuation = continued;
        continued = continuations && row.endsWith("\\");
        if (isContinuation) {
            const r = rewriteRefs(row, snap);
            refsUpdated += r.updated;
            return r.text;
        }
        if (newByRow.has(i)) {
            const m = row.match(/^(\s*)\d+/);
            const rest = row.slice(m[0].length);
            const r = rewriteRefs(rest, snap);
            refsUpdated += r.updated;
            return m[1] + newByRow.get(i) + r.text;
        }
        if (autostartDirective) {
            const m = row.match(/^(\s*#autostart\s+)(\d+)(.*)$/i);
            if (m) {
                const target = snap(parseInt(m[2], 10));
                if (target !== null && String(target) !== m[2]) {
                    refsUpdated++;
                    return m[1] + target + m[3];
                }
            }
        }
        return row;
    });

    return {code: out.join("\n"), count: numbered.length, refsUpdated};
}
