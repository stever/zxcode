import * as CodeMirror from "codemirror"
import "codemirror/mode/lua/lua"

// Highlighter for sjasmplus assembly sources, including LUA ... ENDLUA blocks,
// which delegate to the stock CodeMirror lua mode. Keyword sets are taken from
// the pinned assembler source, sjasmplus v1.23.1 (see apps/sjasmplus/Dockerfile):
// OpCodeTable in sjasm/z80.cpp for mnemonics, DirectivesTable in
// sjasm/directives.cpp for directives. EQU/DEFL are parsed on the label path
// there rather than via the table, so they are added by hand. The pasmo mode is
// not reused: it lacks the directive and Z80N sets and flags valid sjasmplus
// register aliases (ixh, ixl, ...) as errors.

// Z80 mnemonics, plus sjasmplus extras (exa, exd, inf, mulub, muluw, sli).
const Z80_OPCODES = [
    "ADC", "ADD", "AND", "BIT", "CALL", "CCF", "CP", "CPD", "CPDR", "CPI",
    "CPIR", "CPL", "DAA", "DEC", "DI", "DJNZ", "EI", "EX", "EXA", "EXD",
    "EXX", "HALT", "IM", "IN", "INC", "IND", "INDR", "INF", "INI", "INIR",
    "JP", "JR", "LD", "LDD", "LDDR", "LDI", "LDIR", "MULUB", "MULUW", "NEG",
    "NOP", "OR", "OTDR", "OTIR", "OUT", "OUTD", "OUTI", "POP", "PUSH", "RES",
    "RET", "RETI", "RETN", "RL", "RLA", "RLC", "RLCA", "RLD", "RR", "RRA",
    "RRC", "RRCA", "RRD", "RST", "SBC", "SCF", "SET", "SLA", "SLI", "SLL",
    "SRA", "SRL", "SUB", "XOR",
]

// Z80N (ZX Spectrum Next) extended opcodes, plus the CSpect emulator fakes
// (exit, break, setbrk, clrbrk) sjasmplus accepts alongside them.
const Z80N_OPCODES = [
    "BRLC", "BSLA", "BSRA", "BSRF", "BSRL", "LDDRX", "LDDX", "LDIRX", "LDIX",
    "LDPIRX", "LDWS", "MIRROR", "MUL", "NEXTREG", "OUTINB", "PIXELAD",
    "PIXELDN", "SETAE", "SWAPNIB", "TEST",
    "EXIT", "BREAK", "SETBRK", "CLRBRK",
]

// Directives register in both bare and dot-prefixed spellings; the lookup
// below strips a leading dot, so only the bare names are listed.
const DIRECTIVES = [
    "ABYTE", "ABYTEC", "ABYTEZ", "ALIGN", "ASSERT", "BINARY", "BLOCK",
    "BPLIST", "BYTE", "CSPECTMAP", "D24", "DB", "DC", "DD", "DEFARRAY",
    "DEFB", "DEFD", "DEFDEVICE", "DEFG", "DEFH", "DEFINE", "DEFL", "DEFM",
    "DEFP", "DEFS", "DEFW", "DEPHASE", "DEVICE", "DG", "DH", "DISP",
    "DISPLAY", "DM", "DP", "DS", "DUP", "DW", "DWORD", "DZ", "EDUP", "ELSE",
    "ELSEIF", "EMPTYTAP", "EMPTYTRD", "ENCODING", "END", "ENDIF", "ENDLUA",
    "ENDM", "ENDMOD", "ENDMODULE", "ENDR", "ENDS", "ENDT", "ENDW", "ENT",
    "EQU", "EXPORT", "FPOS", "HEX", "HEXEND", "HEXOUT", "IF", "IFDEF", "IFN",
    "IFNDEF", "IFNUSED", "IFUSED", "INCBIN", "INCHOB", "INCLUDE",
    "INCLUDELUA", "INCTRD", "INSERT", "LABELSLIST", "LUA", "MACRO", "MMU",
    "MODULE", "OPT", "ORG", "OUTEND", "OUTPUT", "PAGE", "PHASE",
    "RELOCATE_END", "RELOCATE_START", "RELOCATE_TABLE", "REPT", "SAVE3DOS",
    "SAVEAMSDOS", "SAVEBIN", "SAVECDT", "SAVECPCSNA", "SAVECPR", "SAVEDEV",
    "SAVEHEX", "SAVEHOB", "SAVENEX", "SAVESNA", "SAVETAP", "SAVETRD",
    "SETBP", "SETBREAKPOINT", "SHELLEXEC", "SIZE", "SLDOPT", "SLOT",
    "STRUCT", "TAPEND", "TAPOUT", "TEXTAREA", "UNDEFINE", "UNPHASE", "WHILE",
    "WINEXEC", "WORD",
]

// Registers (including the ixh/hx/xh-style alias spellings sjasmplus accepts)
// and condition codes, all styled variable-2 as in the zxbasic ASM sub-mode.
const REGISTERS = [
    "A", "B", "C", "D", "E", "H", "L", "I", "R",
    "AF", "BC", "DE", "HL", "IX", "IY", "SP",
    "IXH", "IXL", "IYH", "IYL", "HX", "LX", "XH", "XL", "HY", "LY", "YH", "YL",
    "Z", "NZ", "NC", "PO", "PE", "P", "M",
]

// noinspection JSCheckFunctionSignatures
const OPCODE_SET = new Set([...Z80_OPCODES, ...Z80N_OPCODES])
// noinspection JSCheckFunctionSignatures
const DIRECTIVE_SET = new Set(DIRECTIVES)
// noinspection JSCheckFunctionSignatures
const REGISTER_SET = new Set(REGISTERS)

// noinspection JSUnresolvedFunction
CodeMirror.defineMode("sjasmplus", function (config) {
    const luaMode = CodeMirror.getMode(config, "lua")

    function tokenBlockComment(stream, state) {
        while (!stream.eol()) {
            if (stream.match("*/")) {
                state.inComment = false
                break
            }
            stream.next()
        }
        return "comment"
    }

    function tokenAsm(stream, state) {
        if (stream.match("/*")) {
            state.inComment = true
            return tokenBlockComment(stream, state)
        }

        if (stream.peek() === ";" || stream.match("//", false)) {
            stream.skipToEnd()
            return "comment"
        }

        const col = stream.column()
        // noinspection JSValidateTypes
        const c = stream.next()

        if (c === '"') {
            let next
            // noinspection JSValidateTypes
            while ((next = stream.next()) != null) {
                if (next === '"') {
                    break
                }
                if (next === "\\") {
                    stream.next()
                }
            }
            return "string"
        }

        if (c === "'") {
            // Single-quoted literals have no escapes in sjasmplus.
            let next
            // noinspection JSValidateTypes
            while ((next = stream.next()) != null) {
                if (next === "'") {
                    break
                }
            }
            return "string"
        }

        if (c === "#" || c === "$") {
            if (stream.eatWhile(/[0-9a-fA-F'_]/)) {
                return "number"
            }
            // A bare $ is the current assembly address.
            return c === "$" ? "number" : null
        }

        if (c === "%") {
            // % starts a binary literal; otherwise it is the modulo operator.
            return stream.eatWhile(/[01'_]/) ? "number" : null
        }

        if (/\d/.test(c)) {
            // Covers 0x/0b/0q prefixes, h/b/q/o/d suffixes and ' or _ group
            // separators; a loose match is fine for highlighting.
            stream.eatWhile(/[\w']/)
            return "number"
        }

        if (/[A-Za-z_.@]/.test(c)) {
            stream.eatWhile(/[\w.?!]/)
            const word = stream.current()
            const bare = (word[0] === "." ? word.slice(1) : word).toUpperCase()

            if (DIRECTIVE_SET.has(bare)) {
                if (bare === "LUA") {
                    // The rest of the LUA line is the pass argument; the lua
                    // sub-mode starts on the next line.
                    state.luaPending = true
                }
                return "def"
            }

            if (col === 0) {
                // A word in the first column is a label definition.
                stream.eat(":")
                return "tag"
            }

            if (OPCODE_SET.has(bare)) {
                return "keyword"
            }

            if (REGISTER_SET.has(bare)) {
                return "variable-2"
            }

            if (word[0] === "." || word[0] === "@" || stream.eat(":")) {
                // Local/module label references, or an indented "name:" label.
                return "tag"
            }

            return null
        }

        return null
    }

    return {
        startState: function () {
            return {inComment: false, luaPending: false, lua: null}
        },
        copyState: function (state) {
            return {
                inComment: state.inComment,
                luaPending: state.luaPending,
                lua: state.lua ? CodeMirror.copyState(luaMode, state.lua) : null,
            }
        },
        token: function (stream, state) {
            if (stream.sol() && state.luaPending) {
                state.luaPending = false
                state.lua = CodeMirror.startState(luaMode)
            }

            if (state.lua) {
                // ENDLUA closes the block; sjasmplus requires it to be the
                // first word on its line.
                if (stream.sol() && stream.match(/^\s*\.?endlua\b/i)) {
                    state.lua = null
                    return "def"
                }
                return luaMode.token(stream, state.lua)
            }

            if (state.inComment) {
                return tokenBlockComment(stream, state)
            }

            if (stream.eatSpace()) {
                return null
            }

            return tokenAsm(stream, state)
        },
        blankLine: function (state) {
            if (state.luaPending) {
                state.luaPending = false
                state.lua = CodeMirror.startState(luaMode)
            } else if (state.lua && luaMode.blankLine) {
                luaMode.blankLine(state.lua)
            }
        },
        innerMode: function (state) {
            return state.lua ? {state: state.lua, mode: luaMode} : null
        },
        lineComment: ";",
        blockCommentStart: "/*",
        blockCommentEnd: "*/",
    }
})

// noinspection JSUnresolvedFunction
CodeMirror.defineMIME("text/x-sjasmplus", "sjasmplus")
