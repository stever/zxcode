import * as CodeMirror from "codemirror"
import "./pasta80"

// Same jsdom + CodeMirror tokeniser harness as sjasmplus.test.js.
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

const PASTA80 = "text/x-pasta80"

describe("pasta80 keywords, types and builtins", () => {
    test("reserved words are keywords, case-insensitively", () => {
        const src = "program Demo;\nvar I: Integer;\nBEGIN\n  for I := 1 to 10 do\nend."
        const tokens = tokenize(PASTA80, src)
        expect(styleOf(tokens, "program")).toBe("keyword")
        expect(styleOf(tokens, "var")).toBe("keyword")
        expect(styleOf(tokens, "BEGIN")).toBe("keyword")
        expect(styleOf(tokens, "for")).toBe("keyword")
        expect(styleOf(tokens, "to")).toBe("keyword")
        expect(styleOf(tokens, "do")).toBe("keyword")
    })

    test("Pasta80 routine directives are keywords", () => {
        const src = "procedure P; external '__p';\nfunction F: Real; register; forward;\noverlay procedure Q;\nvar X: Byte absolute $5C78;"
        const tokens = tokenize(PASTA80, src)
        for (const word of ["external", "register", "forward", "overlay", "absolute"]) {
            expect(styleOf(tokens, word)).toBe("keyword")
        }
    })

    test("built-in types, atoms and RTL names have their own styles", () => {
        const src = "var B: Boolean;\nbegin\n  B := True;\n  WriteLn('x');\n  TextColor(White);\n  B := B and Odd(MaxInt)\nend."
        const tokens = tokenize(PASTA80, src)
        expect(styleOf(tokens, "Boolean")).toBe("variable-2")
        expect(styleOf(tokens, "True")).toBe("atom")
        expect(styleOf(tokens, "MaxInt")).toBe("atom")
        expect(styleOf(tokens, "WriteLn")).toBe("builtin")
        expect(styleOf(tokens, "TextColor")).toBe("builtin")
        expect(styleOf(tokens, "Odd")).toBe("builtin")
        expect(styleOf(tokens, "and")).toBe("keyword")
    })

    test("plain identifiers are unstyled", () => {
        const tokens = tokenize(PASTA80, "var Score: Integer;\nScore := 1")
        expect(styleOf(tokens, "Score")).toBeNull()
    })
})

describe("pasta80 literals", () => {
    test("numeric literal forms", () => {
        const src = "X := $5CCB;\nY := %1010;\nZ := 42;\nR := 3.14;\nE := 1.5e-3;"
        const tokens = tokenize(PASTA80, src)
        for (const n of ["$5CCB", "%1010", "42", "3.14", "1.5e-3"]) {
            expect(styleOf(tokens, n)).toBe("number")
        }
    })

    test("a range does not swallow the dots", () => {
        const tokens = tokenize(PASTA80, "for I := 1..10 do")
        expect(styleOf(tokens, "1")).toBe("number")
        expect(styleOf(tokens, "10")).toBe("number")
        expect(styleOf(tokens, "..")).toBe("operator")
    })

    test("strings with doubled apostrophes and #n char codes", () => {
        const tokens = tokenize(PASTA80, "S := 'it''s' + 'done'#13#10;")
        expect(styleOf(tokens, "'it''s'")).toBe("string")
        expect(styleOf(tokens, "'done'")).toBe("string")
        expect(styleOf(tokens, "#13")).toBe("string-2")
        expect(styleOf(tokens, "#10")).toBe("string-2")
    })
})

describe("pasta80 comments", () => {
    test("all three comment forms", () => {
        const src = "X := 1; // slashes\nY := 2; { braces\n  span lines }\nZ := 3; (* stars\n  span too *)\nW := 4;"
        const tokens = tokenize(PASTA80, src)
        expect(tokens.find((t) => t.text.includes("slashes")).style).toBe("comment")
        expect(tokens.find((t) => t.text.includes("braces")).style).toBe("comment")
        expect(tokens.find((t) => t.text.includes("span lines")).style).toBe("comment")
        expect(tokens.find((t) => t.text.includes("stars")).style).toBe("comment")
        // tokenising resumes after each block closes
        expect(styleOf(tokens, "W")).toBeNull()
        expect(styleOf(tokens, "4")).toBe("number")
    })

    test("compiler directives in either comment form are meta", () => {
        const tokens = tokenize(PASTA80, "{$I lib.pas}\n(*$A+*)\n{ plain }")
        expect(tokens.find((t) => t.text.includes("$I")).style).toBe("meta")
        expect(tokens.find((t) => t.text.includes("$A+")).style).toBe("meta")
        expect(tokens.find((t) => t.text.includes("plain")).style).toBe("comment")
    })
})

describe("pasta80 embedded machine code", () => {
    test("inline() bodies style opcodes as numbers and operands as variables", () => {
        const src = "begin\n  inline(\n    $dd/$21/$04/$00/  (* ld ix,4 *)\n    $3a/Score/        (* ld a,(Score) *)\n    $c9);             (* ret *)\nend."
        const tokens = tokenize(PASTA80, src)
        expect(styleOf(tokens, "inline")).toBe("keyword")
        expect(styleOf(tokens, "$dd")).toBe("number")
        expect(styleOf(tokens, "$c9")).toBe("number")
        // Operand identifiers inside inline() pop out as variable-2 ...
        expect(styleOf(tokens, "Score")).toBe("variable-2")
        // ... and the comments keep their mnemonics readable.
        expect(tokens.find((t) => t.text.includes("ld ix,4")).style).toBe("comment")
    })

    test("inline state ends at the closing paren", () => {
        const src = "inline($3e/66);\nWriteLn(Message)"
        const tokens = tokenize(PASTA80, src)
        expect(styleOf(tokens, "WriteLn")).toBe("builtin")
        // A plain identifier after the inline block is NOT operand-styled.
        expect(styleOf(tokens, "Message")).toBeNull()
    })

    test("nested parens inside inline() do not end the block early", () => {
        const src = "inline($dd/(Base+2)/$c9/X);"
        const tokens = tokenize(PASTA80, src)
        expect(styleOf(tokens, "Base")).toBe("variable-2")
        expect(styleOf(tokens, "X")).toBe("variable-2")
    })

    test("a lone 'inline' keyword does not poison later parens", () => {
        const src = "X := inline;\nWriteLn(Message)"
        const tokens = tokenize(PASTA80, src)
        expect(styleOf(tokens, "Message")).toBeNull()
    })

    test("inline routine bodies (declaration form) are covered too", () => {
        const src = "function Chr(B: Byte): Char; register; inline\n  ($dd/$6e/$04);"
        const tokens = tokenize(PASTA80, src)
        expect(styleOf(tokens, "$6e")).toBe("number")
    })
})
