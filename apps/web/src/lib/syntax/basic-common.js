import * as CodeMirror from "codemirror"

// Shared tokeniser for the Sinclair-derived BASIC dialects used in the IDE:
// zmakebas (Sinclair 48K/128K BASIC), NextBASIC and the Boriel ZX BASIC mode.
// Based on the pascal mode available in the CodeMirror repository:
// https://github.com/codemirror/CodeMirror/blob/master/mode/pascal/pascal.js
// CodeMirror, copyright (c) by Marijn Haverbeke and others.
// Distributed under an MIT license: https://codemirror.net/LICENSE

// Sinclair 48K/128K BASIC keywords, common to every dialect below.
export const SINCLAIR_KEYWORDS = [
    "ABS",
    "ACS",
    "AND",
    "ASN",
    "AT",
    "ATN",
    "ATTR",
    "BEEP",
    "BIN",
    "BORDER",
    "BRIGHT",
    "CAT",
    "CHR$",
    "CIRCLE",
    "CLEAR",
    "CLOSE",
    "CLOSE#",
    "CLS",
    "CODE",
    "CONTINUE",
    "COPY",
    "COS",
    "DATA",
    "DEF",
    "DEFFN",
    "DIM",
    "DRAW",
    "ERASE",
    "EXP",
    "FLASH",
    "FN",
    "FOR",
    "FORMAT",
    "GO",
    "GOSUB",
    "GOTO",
    "IF",
    "IN",
    "INK",
    "INKEY$",
    "INPUT",
    "INT",
    "INVERSE",
    "LEN",
    "LET",
    "LINE",
    "LIST",
    "LLIST",
    "LN",
    "LOAD",
    "LPRINT",
    "MERGE",
    "MOVE",
    "NEW",
    "NEXT",
    "NOT",
    "OPEN",
    "OPEN#",
    "OR",
    "OUT",
    "OVER",
    "PAPER",
    "PAUSE",
    "PEEK",
    "PI",
    "PLAY",
    "PLOT",
    "POINT",
    "POKE",
    "PRINT",
    "RANDOMISE",
    "RANDOMIZE",
    "READ",
    "REM",
    "RESTORE",
    "RETURN",
    "RND",
    "RUN",
    "SAVE",
    "SCREEN$",
    "SGN",
    "SIN",
    "SPECTRUM",
    "SQR",
    "STEP",
    "STOP",
    "STR$",
    "TAB",
    "TAN",
    "THEN",
    "TO",
    "USR",
    "VAL",
    "VAL$",
    "VERIFY",
]

// Keywords new to NextBASIC, on top of the Sinclair set above. Source of truth:
// the "NextBASIC New Commands and Features" document (NextZXOS v2.09), section
// "New keyword tokens" ($81-$a2), which states NextBASIC adds these on top of
// SPECTRUM, PLAY and all 48K BASIC tokens. Operators << ($8c) and >> ($8d) are
// omitted here (matched by the operator character class instead), as is the
// internal-only IFELSE token ($83, "displays as IF"). TIME$/ERROR$ are the
// string-returning forms of TIME/ERROR, listed so both spellings highlight.
export const NEXT_KEYWORDS = [
    "BANK",
    "CD",
    "DEFPROC",
    "DPEEK",
    "DPOKE",
    "DRIVER",
    "ELSE",
    "ENDIF",
    "ENDPROC",
    "ERROR",
    "ERROR$",
    "EXIT",
    "LAYER",
    "LOCAL",
    "MKDIR",
    "MOD",
    "ON",
    "PALETTE",
    "PEEK$",
    "PRIVATE",
    "PROC",
    "PWD",
    "REF",
    "REG",
    "REMOUNT",
    "REPEAT",
    "RMDIR",
    "SPRITE",
    "TILE",
    "TIME",
    "TIME$",
    "UNTIL",
    "WHILE",
]

// Boriel's ZX BASIC reserved words. Boriel is a C-like cross-compiler, not the
// Sinclair interpreter, so it does NOT share SINCLAIR_KEYWORDS. Source of truth:
// the KEYWORDS table in src/zxbc/keywords.py of boriel/zxbasic (pinned to the
// installed compiler, zxbasic==1.18.7 — see apps/zxbasic/requirements.txt). The
// lexer maps both the bare and the "$" spelling of CHR/INKEY/STR to one token,
// so both are listed here. The Z80/Z80N opcode mnemonics are deliberately NOT
// here: they are only meaningful inside ASM ... END ASM blocks and are handled
// by the assembly sub-mode below.
export const BORIEL_KEYWORDS = [
    "ABS",
    "ACS",
    "AND",
    "AS",
    "ASM",
    "ASN",
    "AT",
    "ATN",
    "BAND",
    "BEEP",
    "BIN",
    "BNOT",
    "BOLD",
    "BOR",
    "BORDER",
    "BRIGHT",
    "BXOR",
    "BYREF",
    "BYVAL",
    "BYTE",
    "CAST",
    "CHR",
    "CHR$",
    "CIRCLE",
    "CLS",
    "CODE",
    "CONST",
    "CONTINUE",
    "COS",
    "DATA",
    "DECLARE",
    "DIM",
    "DO",
    "DRAW",
    "ELSE",
    "ELSEIF",
    "END",
    "ENDIF",
    "ERROR",
    "EXIT",
    "EXP",
    "FASTCALL",
    "FIXED",
    "FLASH",
    "FLOAT",
    "FOR",
    "FUNCTION",
    "GO",
    "GOSUB",
    "GOTO",
    "IF",
    "IN",
    "INK",
    "INKEY",
    "INKEY$",
    "INT",
    "INTEGER",
    "INVERSE",
    "ITALIC",
    "LBOUND",
    "LEN",
    "LET",
    "LN",
    "LOAD",
    "LONG",
    "LOOP",
    "MOD",
    "NEXT",
    "NOT",
    "ON",
    "OR",
    "OUT",
    "OVER",
    "PAPER",
    "PAUSE",
    "PEEK",
    "PI",
    "PLOT",
    "POKE",
    "PRINT",
    "RANDOMIZE",
    "READ",
    "RESTORE",
    "RETURN",
    "RND",
    "SAVE",
    "SGN",
    "SHL",
    "SHR",
    "SIN",
    "SIZEOF",
    "SQR",
    "STDCALL",
    "STEP",
    "STOP",
    "STR",
    "STR$",
    "STRING",
    "SUB",
    "TAB",
    "TAN",
    "THEN",
    "TO",
    "UBOUND",
    "UBYTE",
    "UINTEGER",
    "ULONG",
    "UNTIL",
    "USR",
    "VAL",
    "VERIFY",
    "WEND",
    "WHILE",
    "XOR",
]

// The mnemonic/register/flag set accepted by Boriel's inline assembler, used to
// highlight the body of an ASM ... END ASM block. Source of truth: asmlex.py in
// boriel/zxbasic (reserved_instructions + zx_next_mnemonics for opcodes, pseudo
// for directives, regs8/regs16/flags for operands). The pasmo z80 mode is not
// reused here: it lacks the Z80N and pseudo-op sets and carries a register-
// context state machine that does not fit this sub-mode.
const Z80_OPCODES = [
    // reserved_instructions (base Z80)
    "ADC", "ADD", "AND", "BIT", "CALL", "CCF", "CP", "CPD", "CPDR", "CPI",
    "CPIR", "CPL", "DAA", "DEC", "DI", "DJNZ", "EI", "EX", "EXX", "HALT",
    "IM", "IN", "INC", "IND", "INDR", "INI", "INIR", "JP", "JR", "LD",
    "LDD", "LDDR", "LDI", "LDIR", "NEG", "NOP", "OR", "OTDR", "OTIR", "OUT",
    "OUTD", "OUTI", "POP", "PUSH", "RES", "RET", "RETI", "RETN", "RL", "RLA",
    "RLC", "RLCA", "RLD", "RR", "RRA", "RRC", "RRCA", "RRD", "RST", "SBC",
    "SCF", "SET", "SLA", "SLL", "SRA", "SRL", "SUB", "XOR",
    // zx_next_mnemonics (Z80N, ZX Spectrum Next)
    "LDIX", "LDWS", "LDIRX", "LDDX", "LDDRX", "LDPIRX", "OUTINB", "MUL",
    "SWAPNIB", "MIRROR", "NEXTREG", "PIXELDN", "PIXELAD", "SETAE", "TEST",
    "BSLA", "BSRA", "BSRL", "BSRF", "BRLC",
]

// Assembler pseudo-ops / directives (pseudo table in asmlex.py). END is omitted:
// it is consumed as part of the "END ASM" block terminator, not as a directive.
const Z80_PSEUDO = [
    "ALIGN", "ORG", "DEFB", "DEFM", "DB", "DEFS", "DEFW", "DS", "DW", "EQU",
    "PROC", "ENDP", "LOCAL", "INCBIN", "NAMESPACE",
]

// Registers (regs8 + regs16) and condition flags. Styled as variable-2 to set
// them apart from opcodes and from ordinary BASIC identifiers.
const Z80_REGISTERS = [
    "A", "B", "C", "D", "E", "H", "L", "I", "R", "IXH", "IXL", "IYH", "IYL",
    "AF", "BC", "DE", "HL", "IX", "IY", "SP",
    "Z", "NZ", "NC", "PO", "PE", "P", "M",
]

// noinspection JSCheckFunctionSignatures
const ASM_KEYWORDS = new Set([...Z80_OPCODES, ...Z80_PSEUDO])
// noinspection JSCheckFunctionSignatures
const ASM_REGISTERS = new Set(Z80_REGISTERS)

// Tokeniser for the body of an ASM ... END ASM block. Reads one Z80 token per
// call and returns to BASIC mode when it consumes the "END ASM" terminator.
function asmTokeniser(stream, state) {
    // "END ASM" closes the block. Consumed as a single span so the trailing ASM
    // cannot be re-read by the BASIC tokeniser and re-open the block.
    if (stream.match(/^END[ \t]+ASM\b/i)) {
        state.asm = false
        return "keyword"
    }

    // noinspection JSValidateTypes
    const c = stream.next()

    if (c === ";") {
        stream.skipToEnd()
        return "comment"
    }

    if (c === '"') {
        let next
        // noinspection JSValidateTypes
        while ((next = stream.next()) != null) {
            if (next === '"') {
                break
            }
        }
        return "string"
    }

    if (c === "'") {
        // Character literal, e.g. 'A'. Highlighted as a number (its lexed type).
        stream.match(/^\\?.'/)
        return "number"
    }

    if (c === "$") {
        // $hex, or a bare $ meaning the current address.
        stream.eatWhile(/[0-9a-fA-F_]/)
        return "number"
    }

    if (c === "%") {
        stream.eatWhile(/[01_]/)
        return "number"
    }

    if (/\d/.test(c)) {
        // Decimal, 0x.., NNh and %.. / 0b.. binary all fall out of this class.
        stream.eatWhile(/[0-9a-fA-Fx_]/i)
        return "number"
    }

    if (/[A-Za-z_.]/.test(c)) {
        stream.eatWhile(/[\w.]/)
        const token = stream.current().toUpperCase()
        if (ASM_KEYWORDS.has(token)) {
            return "keyword"
        }
        if (ASM_REGISTERS.has(token)) {
            return "variable-2"
        }
        return "variable"
    }

    return null
}

// TODO: Are there any atom values to add here?
// noinspection JSCheckFunctionSignatures
const atoms = new Set([])

// TODO: Operators characters to be verified.
const isOperatorChar = /[+\-*&%=<>!?|\/]/

function getOpenCloseTokeniser() {
    return function(stream, state) {
        // noinspection JSValidateTypes
        const next = stream.next()
        state.tokeniser = null
        return next === '#' ? "keyword" : null
    }
}

function getCommentTokeniser() {
    return function(stream, state) {
        stream.skipToEnd()
        state.tokeniser = null
        return "comment"
    }
}

function getStringTokeniser(quote) {
    return function(stream, state) {
        let escaped = false, next, end = false

        // noinspection JSValidateTypes
        while ((next = stream.next()) != null) {
            if (next === quote && !escaped) {
                end = true; break
            }

            escaped = !escaped && next === "#"
        }

        if (end || !escaped) {
            state.tokeniser = null
        }

        return "string"
    }
}

// Register a BASIC mode plus its MIME. Options:
//   baseKeywords  - the authoritative reserved-word set (default: Sinclair).
//   extraKeywords - merged on top of baseKeywords (e.g. the NextBASIC additions).
//   asm           - when true, ASM ... END ASM blocks switch into the Z80
//                   assembly sub-mode (Boriel's inline assembler).
export function defineBasicMode(name, mime, {baseKeywords = SINCLAIR_KEYWORDS, extraKeywords = [], asm = false} = {}) {
    // noinspection JSCheckFunctionSignatures
    const keywords = new Set([...baseKeywords, ...extraKeywords])

    function initialTokeniser(stream, state) {

        // noinspection JSValidateTypes
        const c = stream.next()

        if (c === "#") {
            stream.skipToEnd()
            return "comment"
        }

        if (c === '"' || c === "'") {
            state.tokeniser = getStringTokeniser(c)
            return state.tokeniser(stream, state)
        }

        if (/\d/.test(c)) {
            stream.eatWhile(/[\w.]/)
            return "number"
        }

        if (isOperatorChar.test(c)) {
            stream.eatWhile(isOperatorChar)
            return "operator"
        }

        stream.eatWhile(/[\w$_]/)

        const token = stream.current().toUpperCase()
        if (keywords.has(token)) {
            switch (token) {
                case 'REM':
                    // If keyword is 'REM' the rest of the line is a comment.
                    state.tokeniser = getCommentTokeniser()
                    return "keyword"
                case 'OPEN':
                case 'CLOSE':
                    // If keyword is 'OPEN' or 'CLOSE' it is followed by '#'.
                    state.tokeniser = getOpenCloseTokeniser();
                    return "keyword"
                case 'ASM':
                    // Enter the Z80 assembly sub-mode until 'END ASM'.
                    if (asm) {
                        state.asm = true
                    }
                    return "keyword"
                default:
                    return "keyword"
            }
        }

        if (atoms.has(token)) {
            return "atom"
        }

        return "variable"
    }

    // noinspection JSUnresolvedFunction
    CodeMirror.defineMode(name, function() {
        return {
            startState: function() {
                return {tokeniser: null, asm: false}
            },
            token: function(stream, state) {
                if (stream.eatSpace()) {
                    return null
                }

                if (state.tokeniser) {
                    return state.tokeniser(stream, state)
                }

                if (state.asm) {
                    return asmTokeniser(stream, state)
                }

                return initialTokeniser(stream, state)
            }
        }
    })

    // noinspection JSUnresolvedFunction
    CodeMirror.defineMIME(mime, name)
}
