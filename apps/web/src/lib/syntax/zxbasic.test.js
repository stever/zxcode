import * as CodeMirror from "codemirror"
import "./zxbasic"
import "./nextbas"
import "./zmakebas"

// Tokenise `text` with the registered CodeMirror mode for `mime`, returning the
// non-whitespace tokens as {text, style} pairs. This is the jsdom + CodeMirror
// harness pattern: CodeMirror needs a DOM, which jest's jsdom environment
// supplies.
function tokenize(mime, text) {
    const mode = CodeMirror.getMode({}, mime)
    const state = mode.startState()
    const tokens = []

    text.split("\n").forEach((line) => {
        const stream = new CodeMirror.StringStream(line, 4)
        if (line === "" && mode.blankLine) {
            mode.blankLine(state)
        }
        while (!stream.eol()) {
            const style = mode.token(stream, state)
            const value = stream.current()
            if (value.trim() !== "") {
                tokens.push({text: value, style})
            }
            stream.start = stream.pos
        }
    })

    return tokens
}

// Style of the first token whose text matches `value` (case-insensitive).
function styleOf(tokens, value) {
    const found = tokens.find((t) => t.text.toUpperCase() === value.toUpperCase())
    return found ? found.style : undefined
}

const ZXBASIC = "text/x-zxbasic"

describe("zxbasic (Boriel) base keywords", () => {
    test("recognises Boriel structural keywords as keyword", () => {
        const src = "SUB foo\nFUNCTION bar\nDECLARE\nCONST\nDO\nLOOP\nWHILE\nWEND"
        const tokens = tokenize(ZXBASIC, src)
        for (const kw of ["SUB", "FUNCTION", "DECLARE", "CONST", "DO", "LOOP", "WHILE", "WEND"]) {
            expect(styleOf(tokens, kw)).toBe("keyword")
        }
    })

    test("recognises Boriel type keywords as keyword", () => {
        const src = "DIM x AS UBYTE\nDIM y AS INTEGER\nDIM z AS STRING"
        const tokens = tokenize(ZXBASIC, src)
        for (const kw of ["DIM", "AS", "UBYTE", "INTEGER", "STRING"]) {
            expect(styleOf(tokens, kw)).toBe("keyword")
        }
        // identifiers between the keywords stay variables
        expect(styleOf(tokens, "x")).toBe("variable")
    })

    test("both bare and $ spellings of CHR/INKEY/STR highlight", () => {
        const tokens = tokenize(ZXBASIC, "CHR CHR$ INKEY INKEY$ STR STR$")
        for (const kw of ["CHR", "CHR$", "INKEY", "INKEY$", "STR", "STR$"]) {
            expect(styleOf(tokens, kw)).toBe("keyword")
        }
    })

    test("Sinclair-only tokens are NOT Boriel keywords", () => {
        // DEFFN, RANDOMISE (British spelling) and INPUT are not in Boriel's set.
        const tokens = tokenize(ZXBASIC, "DEFFN RANDOMISE INPUT")
        expect(styleOf(tokens, "DEFFN")).toBe("variable")
        expect(styleOf(tokens, "RANDOMISE")).toBe("variable")
        expect(styleOf(tokens, "INPUT")).toBe("variable")
        // ...but the Boriel RANDOMIZE spelling is a keyword.
        expect(styleOf(tokenize(ZXBASIC, "RANDOMIZE"), "RANDOMIZE")).toBe("keyword")
    })
})

describe("zxbasic ASM-block scoping (Problem 1)", () => {
    test("Z80N opcodes are plain variables OUTSIDE an ASM block", () => {
        // A SUB named 'test' and a variable 'mul' must not highlight as opcodes.
        const tokens = tokenize(ZXBASIC, "SUB test\nLET mul = 1")
        expect(styleOf(tokens, "test")).toBe("variable")
        expect(styleOf(tokens, "mul")).toBe("variable")
    })

    test("Z80 and Z80N opcodes highlight INSIDE an ASM block", () => {
        const src = "ASM\n  LD A, 1\n  NEXTREG 7, 3\n  SWAPNIB\nEND ASM"
        const tokens = tokenize(ZXBASIC, src)
        expect(styleOf(tokens, "ASM")).toBe("keyword")
        expect(styleOf(tokens, "LD")).toBe("keyword")
        expect(styleOf(tokens, "NEXTREG")).toBe("keyword")
        expect(styleOf(tokens, "SWAPNIB")).toBe("keyword")
        // registers are distinguished from opcodes
        expect(styleOf(tokens, "A")).toBe("variable-2")
        // the block terminator is consumed as one "END ASM" keyword span
        expect(styleOf(tokens, "END ASM")).toBe("keyword")
    })

    test("tokenising returns to BASIC after END ASM", () => {
        const src = "ASM\n  NEXTREG 7, 3\nEND ASM\nLET mul = 2"
        const tokens = tokenize(ZXBASIC, src)
        expect(styleOf(tokens, "NEXTREG")).toBe("keyword")
        // 'mul' after the block is a BASIC identifier again, not an opcode
        expect(styleOf(tokens, "mul")).toBe("variable")
        expect(styleOf(tokens, "LET")).toBe("keyword")
    })

    test("asm comments and numbers highlight inside the block", () => {
        const src = "ASM\n  LD A, $FF  ; load\nEND ASM"
        const tokens = tokenize(ZXBASIC, src)
        expect(styleOf(tokens, "$FF")).toBe("number")
        const comment = tokens.find((t) => t.text.includes("load"))
        expect(comment.style).toBe("comment")
    })
})

describe("sibling modes are unaffected", () => {
    test("zmakebas keeps the Sinclair set (RANDOMISE, DEF FN)", () => {
        const tokens = tokenize("text/x-zmakebas", "RANDOMISE\nDEFFN")
        expect(styleOf(tokens, "RANDOMISE")).toBe("keyword")
        expect(styleOf(tokens, "DEFFN")).toBe("keyword")
    })

    test("nextbas keeps Sinclair + Next additions, no ASM sub-mode", () => {
        const tokens = tokenize("text/x-nextbas", "DEFPROC foo\nLAYER\nNEXTREG")
        expect(styleOf(tokens, "DEFPROC")).toBe("keyword")
        expect(styleOf(tokens, "LAYER")).toBe("keyword")
        // NEXTREG is not a NextBASIC keyword, so it stays a variable
        expect(styleOf(tokens, "NEXTREG")).toBe("variable")
    })
})
