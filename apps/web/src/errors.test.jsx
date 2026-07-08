/**
 * showToastsForErrorItems must render a toast for every build-error shape the
 * compilers produce. The item shapes pinned here were captured from the real
 * 8bitworker (zmac/sdcc) and the in-browser compilers:
 *   - pasmo/zmakebas reject with {type: 'out'|'err', text}
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

    test("wasm-command items ({type, text}) keep their behaviour", () => {
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
        expect(shown[1].severity).toBe("info");
    });

    test("never shows toasts without items or a mounted toast", () => {
        const {ref, shown} = makeToastRef();
        showToastsForErrorItems([], ref);
        showToastsForErrorItems(undefined, ref);
        showToastsForErrorItems([{line: 1, msg: "x"}], {current: null});
        expect(shown).toHaveLength(0);
    });
});
