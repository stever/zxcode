import { defineBasicMode, NEXT_KEYWORDS } from "./basic-common"

// NextBASIC (ZX Spectrum Next) = Sinclair 48K/128K BASIC plus the NextBASIC
// additions. The shared Sinclair keyword set and tokeniser live in
// basic-common.js; NEXT_KEYWORDS is the delta documented in the "NextBASIC New
// Commands and Features" (NextZXOS v2.09) new-keyword-token table.
defineBasicMode("nextbas", "text/x-nextbas", NEXT_KEYWORDS)
