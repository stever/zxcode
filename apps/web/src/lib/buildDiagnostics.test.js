/**
 * The classifier and toast plan behind #217: a warning-heavy failed build
 * must surface its errors, fold the warnings away, and never go silent.
 * The sample lines are the dialects the real toolchains emit: zsdcc
 * ("warning 85:", "error 101:"), sccz80/Boriel/sjasmplus (": warning:",
 * ": error:"), sdld ("?ASlink-Warning-"), pasmo ("ERROR: "), Pasta80
 * ("*** Error").
 */
import {
    buildToastPlan,
    classifySeverity,
    MAX_ERROR_TOASTS,
    processErrorItems,
} from "./buildDiagnostics";

describe("classifySeverity", () => {
    test.each([
        ["program.c:12: warning 85: unreferenced local variable", "warning"],
        ["program.bas:5: warning: [W150] something", "warning"],
        ["?ASlink-Warning-Undefined Global", "warning"],
        ["Warning: 2 warnings in total", "warning"],
        ["program.c:13: error 101: too many parameters", "error"],
        ["program.c:3: syntax error: token -> 'x' ; column 5", "error"],
        ["ERROR: Invalid mnemonic", "error"],
        ["*** Error: identifier expected", "error"],
        ["source.asm(4): error: label already defined", "error"],
        ["copyright banner chatter", null],
        ["an error_handler symbol is not a diagnostic", null],
    ])("%s -> %s", (text, expected) => {
        expect(classifySeverity(text)).toBe(expected);
    });

    test("a line naming both severities counts as the error it became", () => {
        expect(classifySeverity("warning treated as error")).toBe("error");
    });
});

describe("processErrorItems", () => {
    test("explodes a service stderr blob into classified lines, order kept", () => {
        const blob = [
            "program.c:3: warning 85: unreferenced local variable 'x'",
            "sccz80 banner chatter",
            "program.c:9: error 101: too many parameters",
            "program.c:12: warning 110: conditional flow changed",
        ].join("\n");
        const units = processErrorItems([{type: "err", text: blob}]);
        expect(units.map((u) => u.severity))
            .toEqual(["warning", "info", "error", "warning"]);
        expect(units[2].text).toBe("program.c:9: error 101: too many parameters");
    });

    test("keeps a blob whole when no line is recognisably an error", () => {
        const blob = "something failed\nin a way this parser\ndoes not know";
        const units = processErrorItems([{type: "err", text: blob}]);
        expect(units).toHaveLength(1);
        expect(units[0]).toEqual({severity: "error", text: blob});
    });

    test("worker items default to error; self-declared warnings stay warnings", () => {
        const units = processErrorItems([
            {line: 0, msg: "Undefined Global '_main' referenced by module 'crt0'"},
            {line: 4, msg: "unreferenced local variable", path: "source.c"},
            {line: 7, msg: "warning 85: in function main"},
        ]);
        expect(units.map((u) => u.severity)).toEqual(["error", "error", "warning"]);
        expect(units[1]).toMatchObject({line: 4, path: "source.c"});
        expect(units[0].line).toBeUndefined();
    });

    test("stdout chatter is info unless it announces an error", () => {
        const units = processErrorItems([
            {type: "out", text: "pasmo v0.5.5"},
            {type: "out", text: "ERROR: Invalid mnemonic"},
        ]);
        expect(units.map((u) => u.severity)).toEqual(["info", "error"]);
    });
});

describe("buildToastPlan", () => {
    const err = (text) => ({severity: "error", text});
    const warn = (text) => ({severity: "warning", text});
    const info = (text) => ({severity: "info", text});

    test("few unique errors, nothing hidden: no summary needed", () => {
        const plan = buildToastPlan([err("a"), err("b")]);
        expect(plan.legacy).toBe(false);
        expect(plan.errorToasts.map((t) => t.text)).toEqual(["a", "b"]);
        expect(plan.summary).toBeNull();
    });

    test("warnings fold into the summary instead of toasting", () => {
        const plan = buildToastPlan([warn("w1"), err("e"), warn("w2"), info("chatter")]);
        expect(plan.errorToasts.map((t) => t.text)).toEqual(["e"]);
        expect(plan.summary).toEqual({errors: 1, warnings: 2});
    });

    test("repeated errors deduplicate with a count", () => {
        const plan = buildToastPlan([err("same"), err("same"), err("other")]);
        expect(plan.errorToasts).toHaveLength(2);
        expect(plan.errorToasts[0]).toMatchObject({text: "same", count: 2});
        // All unique errors shown and nothing else hidden: still no summary.
        expect(plan.summary).toBeNull();
    });

    test("errors beyond the cap are counted, not toasted", () => {
        const units = Array.from({length: MAX_ERROR_TOASTS + 3},
            (_, i) => err(`error ${i}`));
        const plan = buildToastPlan(units);
        expect(plan.errorToasts).toHaveLength(MAX_ERROR_TOASTS);
        expect(plan.summary).toEqual({errors: MAX_ERROR_TOASTS + 3, warnings: 0});
    });

    test("no recognisable errors: legacy mode keeps every unit loud", () => {
        const units = [warn("only warnings here"), info("and chatter")];
        const plan = buildToastPlan(units);
        expect(plan.legacy).toBe(true);
        expect(plan.legacyUnits).toEqual(units);
        expect(plan.errorToasts).toHaveLength(0);
    });

    test("blank info lines do not force a summary", () => {
        const plan = buildToastPlan([err("e"), info(""), info("   ")]);
        expect(plan.summary).toBeNull();
    });
});
