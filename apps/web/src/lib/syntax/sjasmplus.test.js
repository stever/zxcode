import * as CodeMirror from "codemirror"
import "./sjasmplus"

// Same jsdom + CodeMirror tokeniser harness as zxbasic.test.js.
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
                tokens.push({text: value.trim(), style})
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

const SJASMPLUS = "text/x-sjasmplus"

describe("sjasmplus opcodes and registers", () => {
    test("Z80 opcodes are keywords, registers variable-2", () => {
        const tokens = tokenize(SJASMPLUS, "    ld hl, 42\n    djnz loop\n    ret")
        expect(styleOf(tokens, "ld")).toBe("keyword")
        expect(styleOf(tokens, "djnz")).toBe("keyword")
        expect(styleOf(tokens, "ret")).toBe("keyword")
        expect(styleOf(tokens, "hl")).toBe("variable-2")
    })

    test("sjasmplus-only mnemonics and register aliases are valid, not errors", () => {
        // The pasmo mode flagged all of these as 'error'.
        const tokens = tokenize(SJASMPLUS, "    sll a\n    sli b\n    ld ixh, 1\n    ld lx, 2")
        expect(styleOf(tokens, "sll")).toBe("keyword")
        expect(styleOf(tokens, "sli")).toBe("keyword")
        expect(styleOf(tokens, "ixh")).toBe("variable-2")
        expect(styleOf(tokens, "lx")).toBe("variable-2")
    })

    test("Z80N (Next) opcodes are keywords", () => {
        const tokens = tokenize(SJASMPLUS, "    nextreg 7, 3\n    swapnib\n    ldpirx\n    brlc de, b")
        expect(styleOf(tokens, "nextreg")).toBe("keyword")
        expect(styleOf(tokens, "swapnib")).toBe("keyword")
        expect(styleOf(tokens, "ldpirx")).toBe("keyword")
        expect(styleOf(tokens, "brlc")).toBe("keyword")
    })

    test("condition codes highlight like registers", () => {
        const tokens = tokenize(SJASMPLUS, "    jr nz, loop\n    ret po")
        expect(styleOf(tokens, "nz")).toBe("variable-2")
        expect(styleOf(tokens, "po")).toBe("variable-2")
    })
})

describe("sjasmplus directives", () => {
    test("core output directives are def, in bare and dot spellings", () => {
        const src = "    DEVICE ZXSPECTRUM48\n    ORG $8000\n    SAVETAP \"out.tap\", start\n    .org $9000"
        const tokens = tokenize(SJASMPLUS, src)
        expect(styleOf(tokens, "DEVICE")).toBe("def")
        expect(styleOf(tokens, "ORG")).toBe("def")
        expect(styleOf(tokens, "SAVETAP")).toBe("def")
        expect(styleOf(tokens, ".org")).toBe("def")
    })

    test("EQU and DEFL are directives despite living off-table in sjasmplus", () => {
        const tokens = tokenize(SJASMPLUS, "five EQU 5\ncounter DEFL 0")
        expect(styleOf(tokens, "EQU")).toBe("def")
        expect(styleOf(tokens, "DEFL")).toBe("def")
        expect(styleOf(tokens, "five")).toBe("tag")
    })

    test("structure directives are def", () => {
        const src = "    MACRO copy\n    ENDM\n    DUP 3\n    EDUP\n    STRUCT vec\n    ENDS\n    MODULE main\n    ENDMODULE"
        const tokens = tokenize(SJASMPLUS, src)
        for (const d of ["MACRO", "ENDM", "DUP", "EDUP", "STRUCT", "ENDS", "MODULE", "ENDMODULE"]) {
            expect(styleOf(tokens, d)).toBe("def")
        }
    })
})

describe("sjasmplus labels, numbers, comments", () => {
    test("first-column words and indented name: are labels", () => {
        const tokens = tokenize(SJASMPLUS, "start:\nloop\n    inner:  ld a, 1\n    jr .local")
        expect(styleOf(tokens, "start:")).toBe("tag")
        expect(styleOf(tokens, "loop")).toBe("tag")
        expect(styleOf(tokens, "inner:")).toBe("tag")
        expect(styleOf(tokens, ".local")).toBe("tag")
    })

    test("all sjasmplus numeric literal forms are numbers", () => {
        const src = "    ld a, $FF\n    ld b, #1F\n    ld c, 0x2A\n    ld d, %1010\n    ld e, 0b0101\n    ld h, 12h\n    ld l, 42"
        const tokens = tokenize(SJASMPLUS, src)
        for (const n of ["$FF", "#1F", "0x2A", "%1010", "0b0101", "12h", "42"]) {
            expect(styleOf(tokens, n)).toBe("number")
        }
    })

    test("line and block comment forms", () => {
        const src = "    ld a, 1 ; semicolon\n    ld b, 2 // slashes\n    /* block\n       spans lines */\n    ld c, 3"
        const tokens = tokenize(SJASMPLUS, src)
        expect(tokens.find((t) => t.text.includes("semicolon")).style).toBe("comment")
        expect(tokens.find((t) => t.text.includes("slashes")).style).toBe("comment")
        expect(tokens.find((t) => t.text.includes("spans")).style).toBe("comment")
        // tokenising resumes after the block comment closes
        expect(styleOf(tokens, "ld")).toBe("keyword")
        const after = tokens[tokens.length - 1]
        expect(after.text).toBe("3")
        expect(after.style).toBe("number")
    })

    test("strings in both quote styles", () => {
        const tokens = tokenize(SJASMPLUS, '    DB "hello", \'world\'')
        expect(styleOf(tokens, '"hello"')).toBe("string")
        expect(styleOf(tokens, "'world'")).toBe("string")
    })
})

describe("embedded Lua blocks", () => {
    test("LUA/ENDLUA are directives and the body uses the lua mode", () => {
        const src = "    LUA PASS2\nlocal x = 1\nsjasm.parse_line(\"nop\")\n    ENDLUA\n    ld a, 1"
        const tokens = tokenize(SJASMPLUS, src)
        expect(styleOf(tokens, "LUA")).toBe("def")
        expect(styleOf(tokens, "ENDLUA")).toBe("def")
        // 'local' is a lua keyword; 'ld' would be one in the asm mode but the
        // block must NOT treat asm words specially.
        expect(styleOf(tokens, "local")).toBe("keyword")
        expect(styleOf(tokens, '"nop"')).toBe("string")
    })

    test("asm tokenising resumes after ENDLUA", () => {
        const src = "    LUA\nprint(1)\n    ENDLUA\n    nextreg 7, 3"
        const tokens = tokenize(SJASMPLUS, src)
        expect(styleOf(tokens, "nextreg")).toBe("keyword")
    })

    test("asm opcodes inside the lua block are NOT asm keywords", () => {
        const src = "    LUA\nld = 5\n    ENDLUA"
        const tokens = tokenize(SJASMPLUS, src)
        expect(styleOf(tokens, "ld")).not.toBe("keyword")
    })

    test("lua comments do not close the block", () => {
        const src = "    LUA\n-- endlua mentioned mid-comment stays lua\nx = 1\n    ENDLUA\n    ret"
        const tokens = tokenize(SJASMPLUS, src)
        expect(styleOf(tokens, "ret")).toBe("keyword")
        const comment = tokens.find((t) => t.text.includes("mentioned"))
        expect(comment.style).toBe("comment")
    })

    test("blank lines inside the lua block are handled", () => {
        const src = "    LUA\n\nx = 1\n    ENDLUA\n    ret"
        const tokens = tokenize(SJASMPLUS, src)
        expect(styleOf(tokens, "ret")).toBe("keyword")
    })
})
