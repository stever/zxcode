import { defineBasicMode } from "./basic-common"

// Boriel's ZX BASIC. Shares the Sinclair-derived tokeniser in basic-common.js.
// Boriel is a cross-compiler, not the NextBASIC interpreter, so it has no
// NextBASIC commands (DEFPROC/PROC/LAYER/SPRITE/...). Its ZX Spectrum Next
// surface is the Z80N opcode mnemonics its inline assembler accepts, used
// inside ASM ... END ASM blocks. Source of truth: src/zxbasm/zxnext.py in
// boriel/zxbasic. Standard Z80 opcodes that Z80N overloads (ADD, JP, PUSH) are
// omitted, since they are not Next-specific.
const Z80N_OPCODES = [
    "BRLC",
    "BSLA",
    "BSRA",
    "BSRF",
    "BSRL",
    "LDDRX",
    "LDDX",
    "LDIRX",
    "LDIX",
    "LDPIRX",
    "LDWS",
    "MIRROR",
    "MUL",
    "NEXTREG",
    "OUTINB",
    "PIXELAD",
    "PIXELDN",
    "SETAE",
    "SWAPNIB",
    "TEST",
]

defineBasicMode("zxbasic", "text/x-zxbasic", Z80N_OPCODES)
