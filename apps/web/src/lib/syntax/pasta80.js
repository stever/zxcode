import * as CodeMirror from "codemirror"

// Highlighter for Pasta80 Turbo Pascal 3.0 sources, including the embedded
// machine code Pasta80 supports: TP3-style inline($3e/66/...) opcode lists.
// Token sets are taken from the pinned compiler source, Pasta80 v0.99 (see
// apps/pasta80/Dockerfile): the TokenStr keyword block in pasta.pas for
// reserved words, and docs/rtl-reference.md for the run-time library. The
// stock CodeMirror pascal mode is not reused: it lacks Pasta80's extensions
// (// comments, % binary literals, #n char codes, the overlay/absolute/
// external/inline keywords) and has no inline() handling.

// Reserved words (pasta.pas TokenStr, toAbsolute..toXor). 'string' and
// 'file' are type-ish but genuinely reserved. 'register' is a contextual
// routine directive (parsed as an identifier by the compiler) but only ever
// appears in that role, so it is included here.
const KEYWORDS = [
    "absolute", "and", "array", "begin", "case", "const", "div", "do",
    "downto", "else", "end", "external", "file", "for", "forward",
    "function", "goto", "if", "in", "inline", "label", "mod", "not", "of",
    "or", "overlay", "packed", "procedure", "program", "record", "register",
    "repeat", "set", "shl", "shr", "string", "then", "to", "type", "until",
    "var", "while", "with", "xor",
]

// Built-in types (rtl-reference.md Types; String/File are keywords above).
const TYPES = ["boolean", "byte", "char", "integer", "pointer", "real", "text"]

// Value-like built-ins.
const ATOMS = ["nil", "true", "false", "maxint", "minint", "maxreal", "minreal", "pi"]

// The public run-time library (rtl-reference.md, all platforms' procedures,
// functions, variables and colour constants).
const BUILTINS = [
    "abs", "addr", "append", "arctan", "assert", "assertfailed",
    "assertpassed", "assign", "bdos", "bdoshl", "beep", "black", "blockread",
    "blockwrite", "blue", "border", "break", "chr", "circle", "close",
    "clreol", "clreos", "clrscr", "concat", "continue", "copy", "cos",
    "cursoroff", "cursoron", "cyan", "debug", "dec", "delay", "delete",
    "delline", "dispose", "draw", "eof", "eoln", "erase", "esxdos", "even",
    "exclude", "exec", "exit", "exp", "filepos", "filesize", "fillchar",
    "floodfill", "flush", "frac", "frames", "freemem", "getcpuspeed",
    "getmem", "getmempage", "getnextreg", "gotoxy", "green", "halt", "hi",
    "high", "highvideo", "inc", "include", "insert", "insline", "int",
    "ioresult", "keypressed", "length", "linebreak", "ln", "lo", "locase",
    "log", "low", "lowvideo", "magenta", "maxavail", "mem", "memavail",
    "memw", "mosapi", "move", "new", "normvideo", "odd", "ord", "paramcount",
    "paramstr", "plot", "point", "port", "pos", "pred", "ptr", "random",
    "randomize", "randomreal", "read", "readkey", "readln", "red", "rename",
    "reset", "rewrite", "round", "screenheight", "screenwidth", "seek",
    "seekeof", "seekeoln", "selectbank", "setcolor", "setcpuspeed",
    "setgraphmode", "setmempage", "setnextreg", "sin", "sizeof", "sound",
    "sqr", "sqrt", "str", "succ", "swap", "tan", "textbackground",
    "textcolor", "trunc", "upcase", "val", "wherex", "wherey", "white",
    "write", "writeln", "yellow",
]

// noinspection JSCheckFunctionSignatures
const KEYWORD_SET = new Set(KEYWORDS)
// noinspection JSCheckFunctionSignatures
const TYPE_SET = new Set(TYPES)
// noinspection JSCheckFunctionSignatures
const ATOM_SET = new Set(ATOMS)
// noinspection JSCheckFunctionSignatures
const BUILTIN_SET = new Set(BUILTINS)

const OPERATOR_CHARS = /[+\-*/=<>@^]/

// noinspection JSUnresolvedFunction
CodeMirror.defineMode("pasta80", function () {

    // Multi-line comment body; state.comment holds the closer ("}" or "*)")
    // and state.commentStyle keeps {$...} compiler directives styled as meta
    // across wrapped lines.
    function tokenComment(stream, state) {
        while (!stream.eol()) {
            if (stream.match(state.comment)) {
                const style = state.commentStyle
                state.comment = null
                state.commentStyle = null
                return style
            }
            stream.next()
        }
        return state.commentStyle
    }

    function startComment(stream, state, closer) {
        // A comment whose body starts with $ is a compiler directive
        // ({$I file}, (*$A+*)) — pasta.pas HandleDirective.
        state.comment = closer
        state.commentStyle = stream.peek() === "$" ? "meta" : "comment"
        return tokenComment(stream, state)
    }

    function token(stream, state) {
        if (state.comment) {
            return tokenComment(stream, state)
        }

        if (stream.eatSpace()) {
            return null
        }

        // noinspection JSValidateTypes
        const c = stream.next()

        if (c === "{") {
            return startComment(stream, state, "}")
        }
        if (c === "(" && stream.eat("*")) {
            return startComment(stream, state, "*)")
        }
        if (c === "/" && stream.eat("/")) {
            stream.skipToEnd()
            return "comment"
        }

        // inline( ... ) embedded machine code: track the parens so the body
        // gets asm-flavoured styling (operand identifiers pop out and the /
        // separators read as structure, not division). The pending flag only
        // survives whitespace and comments between 'inline' and its '('.
        const pending = state.inlinePending
        state.inlinePending = false

        if (c === "(") {
            if (pending) {
                state.inline = 1
            } else if (state.inline > 0) {
                state.inline++
            }
            return null
        }
        if (c === ")") {
            if (state.inline > 0) {
                state.inline--
            }
            return null
        }

        if (c === "'") {
            // Strings are single-line; '' is a literal apostrophe.
            for (;;) {
                if (stream.eol()) break
                if (stream.next() === "'" && !stream.eat("'")) break
            }
            return "string"
        }

        if (c === "#") {
            // #n character codes chain onto strings ('done'#13#10).
            return stream.eatWhile(/\d/) ? "string-2" : null
        }

        if (c === "$") {
            return stream.eatWhile(/[0-9a-fA-F]/) ? "number" : null
        }

        if (c === "%") {
            return stream.eatWhile(/[01]/) ? "number" : null
        }

        if (/\d/.test(c)) {
            stream.eatWhile(/\d/)
            // A decimal part, but not the start of a '..' range (1..10).
            if (stream.match(/^\.\d+/)) { /* consumed */ }
            stream.match(/^[eE][+-]?\d+/)
            return "number"
        }

        if (/[A-Za-z_]/.test(c)) {
            stream.eatWhile(/\w/)
            const word = stream.current().toLowerCase()

            if (state.inline > 0) {
                // Identifiers inside inline() are operand references (vars,
                // consts) resolved to addresses in the machine code.
                return "variable-2"
            }
            if (KEYWORD_SET.has(word)) {
                if (word === "inline") {
                    state.inlinePending = true
                }
                return "keyword"
            }
            if (TYPE_SET.has(word)) return "variable-2"
            if (ATOM_SET.has(word)) return "atom"
            if (BUILTIN_SET.has(word)) return "builtin"
            return null
        }

        if (c === "." && stream.eat(".")) {
            // '..' subrange (1..10); a lone '.' is field access / program end.
            return "operator"
        }

        if (OPERATOR_CHARS.test(c)) {
            stream.eatWhile(OPERATOR_CHARS)
            return "operator"
        }

        return null
    }

    return {
        startState: function () {
            return {comment: null, commentStyle: null, inline: 0, inlinePending: false}
        },
        copyState: function (state) {
            return {
                comment: state.comment,
                commentStyle: state.commentStyle,
                inline: state.inline,
                inlinePending: state.inlinePending,
            }
        },
        token: token,
        lineComment: "//",
        blockCommentStart: "{",
        blockCommentEnd: "}",
    }
})

// noinspection JSUnresolvedFunction
CodeMirror.defineMIME("text/x-pasta80", "pasta80")
