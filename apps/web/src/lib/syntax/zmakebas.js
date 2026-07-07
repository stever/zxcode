import { defineBasicMode } from "./basic-common"

// Sinclair 48K/128K BASIC, as accepted by zmakebas. The keyword set and
// tokeniser live in basic-common.js and are shared with the NextBASIC and
// Boriel ZX BASIC modes.
defineBasicMode("zmakebas", "text/x-zmakebas")
