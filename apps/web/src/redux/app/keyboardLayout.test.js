import {setKeyboardLayout} from "./actions";

// The reducer imports query-string, which ships as ESM and sits outside
// jest's transform allowlist. Only the machine setting uses it (for the "m"
// query parameter), so a stub keeps this test off the shared jest config.
jest.mock("query-string", () => ({
    __esModule: true,
    default: {parse: () => ({})},
    parse: () => ({}),
}));

// The reducer reads localStorage at import time to seed initial state, so
// each case re-imports the module with storage already arranged.
const freshReducer = () => {
    let mod;
    jest.isolateModules(() => {
        mod = require("./reducers").default;
    });
    return mod;
};

const stateAfter = (reducer, action) => reducer(undefined, action);

// #214: which on-screen keyboard is drawn. 'auto' is the machine's own, which
// is right almost always — the setting exists for when it is not.
describe("keyboard layout preference", () => {
    beforeEach(() => {
        localStorage.clear();
        jest.restoreAllMocks();
    });

    it("follows the machine until told otherwise", () => {
        const reducer = freshReducer();
        expect(stateAfter(reducer, {type: "@@INIT"}).keyboardLayout).toBe("auto");
    });

    it("restores a persisted choice", () => {
        localStorage.setItem("keyboardLayout", "next");
        const reducer = freshReducer();
        expect(stateAfter(reducer, {type: "@@INIT"}).keyboardLayout).toBe("next");
    });

    it("persists a new choice", () => {
        const reducer = freshReducer();
        for (const choice of ["rubber", "plus", "next", "none", "auto"]) {
            expect(stateAfter(reducer, setKeyboardLayout(choice)).keyboardLayout).toBe(choice);
            expect(localStorage.getItem("keyboardLayout")).toBe(choice);
        }
    });

    // Wanting no keyboard at all is a choice like any other, and one worth
    // remembering: the screen takes the room it frees.
    it("remembers wanting no keyboard", () => {
        localStorage.setItem("keyboardLayout", "none");
        const reducer = freshReducer();
        expect(stateAfter(reducer, {type: "@@INIT"}).keyboardLayout).toBe("none");
    });

    // The value names a layout table, or "none". An unknown name would draw no
    // keyboard by accident rather than by asking, so it never reaches state.
    it("ignores a name no keyboard answers to", () => {
        const reducer = freshReducer();
        const before = stateAfter(reducer, {type: "@@INIT"}).keyboardLayout;
        for (const bad of ["toastrack", "", null, "48", "RUBBER"]) {
            expect(stateAfter(reducer, setKeyboardLayout(bad)).keyboardLayout).toBe(before);
        }
    });

    it("falls back to following the machine when storage holds junk", () => {
        localStorage.setItem("keyboardLayout", "toastrack");
        const reducer = freshReducer();
        expect(stateAfter(reducer, {type: "@@INIT"}).keyboardLayout).toBe("auto");
    });

    // Storage can throw outright (Safari private browsing, storage disabled).
    // A picker that crashes the app is worse than one that forgets.
    it("survives localStorage throwing", () => {
        const reducer = freshReducer();
        jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
            throw new Error("QuotaExceededError");
        });
        jest.spyOn(console, "error").mockImplementation(() => {});
        expect(() => stateAfter(reducer, setKeyboardLayout("plus"))).not.toThrow();
        expect(stateAfter(reducer, setKeyboardLayout("plus")).keyboardLayout).toBe("plus");
    });
});
