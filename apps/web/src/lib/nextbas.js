import { file2bas } from "txt2bas";

// Tokenise NextBASIC source into a PLUS3DOS program (the on-disk format
// NextZXOS LOADs from SD). txt2bas is Remy Sharp's in-browser NextBASIC
// tokeniser — the NextBASIC counterpart to zmakebas for Sinclair BASIC — so it
// understands the Next-only keywords (DEFPROC, LAYER, SPRITE, ...) the app
// highlights. The bytes it returns are handed straight to the Next's zxRunBas
// delivery (see GoEmulator.openTapeBytes, which detects the PLUS3DOS magic).

// NextZXOS only auto-runs a LOADed program when the PLUS3DOS header carries an
// autostart line. Inject `#autostart <first line>` if the source doesn't set
// one, so the tokenised file runs on LOAD rather than just listing.
function ensureAutostart(src) {
    if (/^\s*#autostart\b/m.test(src)) return src;
    const m = src.match(/^\s*(\d+)\b/m);
    return m ? `#autostart ${m[1]}\n${src}` : src;
}

// Returns a Uint8Array of PLUS3DOS bytes. Throws on a tokeniser error (the
// caller surfaces it the same way as a zmakebas/pasmo compile failure).
export default function getNextBasicProgram(code) {
    const out = file2bas(ensureAutostart(code), "PROGRAM.BAS", "3dos");
    return out instanceof Uint8Array ? out : new Uint8Array(out);
}
