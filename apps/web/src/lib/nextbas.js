import { file2bas, statements } from "txt2bas";

// The consolidated Sinclair/Next BASIC compiler (#110): txt2bas (Remy
// Sharp's in-browser NextBASIC tokeniser) is the single tokeniser for every
// machine, so one source convention covers the whole range. The output
// format follows the target: a PLUS3DOS program for the Next (handed to the
// zxRunBas delivery — GoEmulator.openTapeBytes detects the PLUS3DOS magic),
// a program TAP for the 48/128 (classic tape load). NextBASIC is a superset
// of Sinclair BASIC, so classic targets are linted for Next-only keywords —
// a named compile error beats a runtime crash on a ROM that lacks the token.

// NextZXOS only auto-runs a LOADed program when the PLUS3DOS header carries
// an autostart line, and txt2bas's TAP header behaves the same way (no
// directive leaves the header's autostart at 0x8000 = none). Inject
// `#autostart <first line>` if the source doesn't set one, so the program
// runs on delivery rather than just listing.
function ensureAutostart(src) {
  if (/^\s*#autostart\b/m.test(src)) return src;
  const m = src.match(/^\s*(\d+)\b/m);
  return m ? `#autostart ${m[1]}\n${src}` : src;
}

// Spectrum token bytes: the 48K set occupies 0xA5-0xFF and the 128K editor
// adds SPECTRUM (0xA3) and PLAY (0xA4). Any keyword tokenising below the
// target's floor is a NextBASIC extension the classic ROM cannot run.
function classicKeywordErrors(src, machine) {
  const floor = machine === 128 ? 0xa3 : 0xa5;
  const errors = [];
  for (const st of statements(src)) {
    for (const tok of st.tokens) {
      if (tok.name === "KEYWORD" && tok.value < floor) {
        errors.push({
          type: "err",
          text: `line ${st.lineNumber}: ${tok.text} is NextBASIC-only and cannot run on the ZX Spectrum ${machine}K`,
        });
      }
    }
  }
  return errors;
}

// Returns a Uint8Array of PLUS3DOS bytes (machine 'next') or TAP bytes
// (48/128). Failures throw an array of {type, text} items — the same shape
// the zmakebas/pasmo wrappers reject with — so the toast plumbing shows
// tokeniser errors instead of dropping a bare Error on the floor.
export default function getBasicProgram(code, machine) {
  try {
    if (machine === "next") {
      const out = file2bas(ensureAutostart(code), "PROGRAM.BAS", "3dos");
      return out instanceof Uint8Array ? out : new Uint8Array(out);
    }
    const lintErrors = classicKeywordErrors(code, machine);
    if (lintErrors.length > 0) throw lintErrors;
    const out = file2bas(ensureAutostart(code), {
      filename: "PROGRAM",
      format: "tap",
    });
    return out instanceof Uint8Array ? out : new Uint8Array(out);
  } catch (e) {
    if (Array.isArray(e)) throw e;
    throw [{ type: "err", text: e && e.message ? e.message : String(e) }];
  }
}
