/**
 * showToastsForErrorItems must surface every build-error shape the compilers
 * produce - errors as toasts, warnings/chatter folded into the summary that
 * opens the build-output dialog (#217), and never silence. The item shapes
 * pinned here were captured from the real 8bitworker (zmac/sdcc) and the
 * in-browser compilers:
 *   - pasmo/zmakebas reject with {type: 'out'|'err', text}
 *   - the compile services reject with one multi-line {type: 'err', text}
 *   - worker diagnostics are {line, msg, path?} with line >= 1
 *   - worker linker/global failures are {line: 0, msg} - these used to be
 *     silently dropped (line 0 is falsy), leaving the user with nothing.
 */
import {showToastsForErrorItems} from "./errors";

jest.mock("./redux/store", () => ({store: {dispatch: jest.fn()}}));
jest.mock("./redux/error/actions", () => ({error: (msg) => ({type: "error", msg})}));
jest.mock("./dashboard_lock", () => ({dashboardLock: jest.fn(), dashboardUnlock: jest.fn()}));
jest.mock("@zxplay/i18n", () => ({
    i18n: {t: (key, vars) => (vars ? `${key} ${JSON.stringify(vars)}` : key)},
}));

function makeToastRef() {
    const shown = [];
    return {ref: {current: {show: (toasts) => shown.push(...toasts)}}, shown};
}

describe("showToastsForErrorItems", () => {
    test("sdcc linker error with line 0 still produces an error toast", () => {
        const {ref, shown} = makeToastRef();
        showToastsForErrorItems(
            [{line: 0, msg: "Undefined Global '_main' referenced by module 'crt0'"}],
            ref,
        );
        expect(shown).toHaveLength(1);
        expect(shown[0].severity).toBe("error");
    });

    test("zmac/sdcc diagnostics with a line render as error severity", () => {
        const {ref, shown} = makeToastRef();
        showToastsForErrorItems(
            [
                {line: 1, msg: "Syntax error", path: "source.asm"},
                {line: 1, msg: "token -> '{' ; column 11", path: "source.c"},
            ],
            ref,
        );
        expect(shown).toHaveLength(2);
        expect(shown.map((t) => t.severity)).toEqual(["error", "error"]);
    });

    test("worker warnings render as info severity", () => {
        const {ref, shown} = makeToastRef();
        showToastsForErrorItems(
            [{line: 1, msg: "warning 85: in function main unreferenced local variable"}],
            ref,
        );
        expect(shown).toHaveLength(1);
        expect(shown[0].severity).toBe("info");
    });

    test("wasm-command errors toast; stdout chatter folds into the summary", () => {
        const {ref, shown} = makeToastRef();
        showToastsForErrorItems(
            [
                {type: "err", text: "program.bas:3: error: Syntax error"},
                {type: "out", text: "some stdout chatter"},
            ],
            ref,
        );
        expect(shown).toHaveLength(2);
        expect(shown[0].severity).toBe("error");
        // The chatter no longer gets a toast of its own: it is readable in
        // the build-output dialog the warn-severity summary points at.
        expect(shown[1].severity).toBe("warn");
    });

    test("a warning-heavy service blob surfaces its errors, not its warnings (#217)", () => {
        const {ref, shown} = makeToastRef();
        const blob = [
            ...Array.from({length: 30},
                (_, i) => `program.c:${i + 1}: warning 85: unreferenced local variable`),
            "program.c:40: error 101: too many parameters",
            "program.c:41: error 101: too many parameters",
        ].join("\n");
        showToastsForErrorItems([{type: "err", text: blob}], ref);
        // Two error toasts plus one warn summary - not 32 toasts.
        expect(shown).toHaveLength(3);
        expect(shown.map((t) => t.severity)).toEqual(["error", "error", "warn"]);
    });

    test("repeated errors collapse into one toast", () => {
        const {ref, shown} = makeToastRef();
        const blob = [
            "program.c:9: error 101: too many parameters",
            "program.c:9: error 101: too many parameters",
            "program.c:9: error 101: too many parameters",
        ].join("\n");
        showToastsForErrorItems([{type: "err", text: blob}], ref);
        // One deduplicated error toast (carrying its repeat count); with
        // nothing actually hidden there is no summary toast either.
        expect(shown).toHaveLength(1);
        expect(shown[0].severity).toBe("error");
    });

    test("never shows toasts without items or a mounted toast", () => {
        const {ref, shown} = makeToastRef();
        showToastsForErrorItems([], ref);
        showToastsForErrorItems(undefined, ref);
        showToastsForErrorItems([{line: 1, msg: "x"}], {current: null});
        expect(shown).toHaveLength(0);
    });
});
