// Pasmo runs in the browser as an emscripten module whose virtual FS holds
// only the main source (the module glue resets preRun, so extra files cannot
// be staged the way the 8bitworker VFS does for zmac/sdcc). Includes are
// therefore resolved here, before pasmo sees the source: INCLUDE lines are
// replaced by the referenced project file's text (recursively) and INCBIN
// lines by DEFB rows of the binary's bytes. Names that match no project file
// are left untouched so pasmo reports them exactly as any missing file.
//
// Trade-off: pasmo's error line numbers refer to the expanded source, so
// diagnostics after a large INCBIN drift from the editor's line numbers.

import {joinProjectFilePath} from "../../lib/lang";

// Leading whitespace, the directive, a quoted or bare filename, then only
// whitespace/comment — anything else (e.g. a label in column 0) is left to
// pasmo, matching how the directives are conventionally written.
const DIRECTIVE_RE = /^(\s*)(include|incbin)\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*(;.*)?$/i;

const BYTES_PER_DEFB = 16;

function fileBytes(file) {
    if (file.isBinary) {
        // noinspection JSDeprecatedSymbols
        return Uint8Array.from(atob(file.content), (c) => c.charCodeAt(0));
    }
    return new TextEncoder().encode(file.content);
}

function toDefbLines(bytes, indent) {
    const lines = [];
    for (let i = 0; i < bytes.length; i += BYTES_PER_DEFB) {
        lines.push(indent + "DEFB " + Array.from(bytes.slice(i, i + BYTES_PER_DEFB)).join(","));
    }
    // An empty asset still has to leave a line behind so the line count only
    // ever grows by the file's size, never shrinks by the directive's removal.
    return lines.length > 0 ? lines : [indent + "; INCBIN of empty file"];
}

function expand(code, byName, stack) {
    const out = [];
    for (const line of code.split("\n")) {
        const m = DIRECTIVE_RE.exec(line);
        const name = m && (m[3] || m[4] || m[5]);
        const file = m && byName.get(name.toLowerCase());
        if (!file) {
            out.push(line);
            continue;
        }
        if (m[2].toLowerCase() === "incbin") {
            out.push(...toDefbLines(fileBytes(file), m[1]));
            continue;
        }
        const path = joinProjectFilePath(file.folder, file.name);
        if (file.isBinary) {
            throw [{
                type: "err",
                text: `INCLUDE "${path}" refers to a binary file; use INCBIN for binary data.`,
            }];
        }
        if (stack.has(path)) {
            throw [{
                type: "err",
                text: `Circular INCLUDE of "${path}".`,
            }];
        }
        stack.add(path);
        out.push(expand(file.content, byName, stack));
        stack.delete(path);
    }
    return out.join("\n");
}

// files use the store's project-file shape ({name, folder, content,
// isBinary}); directives reference them by relative path (folder/name),
// matching how the other toolchains stage them on disk. Throws an
// error-items array (the pasmo compile's error contract) on a circular
// INCLUDE or an INCLUDE of a binary asset.
export function expandPasmoIncludes(code, files) {
    if (!files || files.length === 0) return code;
    // Duplicate project file paths are already rejected case-insensitively,
    // so a lower-cased map resolves the case-insensitive directive lookup.
    const byName = new Map(files.map(
        (f) => [joinProjectFilePath(f.folder, f.name).toLowerCase(), f]));
    return expand(code, byName, new Set());
}
