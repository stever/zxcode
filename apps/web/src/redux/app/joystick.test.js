import {setJoystick, joystickChanged} from "./actions";

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

describe("joystick preference", () => {
    beforeEach(() => {
        localStorage.clear();
        jest.restoreAllMocks();
    });

    it("defaults to Kempston", () => {
        const reducer = freshReducer();
        expect(stateAfter(reducer, {type: "@@INIT"}).joystick).toBe("Kempston");
    });

    it("restores a persisted choice", () => {
        localStorage.setItem("joystick", "Cursor");
        const reducer = freshReducer();
        expect(stateAfter(reducer, {type: "@@INIT"}).joystick).toBe("Cursor");
    });

    it("persists a new choice", () => {
        const reducer = freshReducer();
        const next = stateAfter(reducer, setJoystick("Sinclair1"));
        expect(next.joystick).toBe("Sinclair1");
        expect(localStorage.getItem("joystick")).toBe("Sinclair1");
    });

    // The value crosses into the emulator and on into the wasm core, which
    // rejects unknown names. Filtering here keeps a corrupted or
    // hand-edited localStorage entry from wedging the setting.
    it("ignores values the engine would reject", () => {
        const reducer = freshReducer();
        const before = stateAfter(reducer, {type: "@@INIT"}).joystick;
        for (const bad of ["Atari", "", null, "kempston", "None"]) {
            expect(stateAfter(reducer, setJoystick(bad)).joystick).toBe(before);
        }
    });

    it("falls back to the default when storage holds junk", () => {
        localStorage.setItem("joystick", "Atari");
        const reducer = freshReducer();
        expect(stateAfter(reducer, {type: "@@INIT"}).joystick).toBe("Kempston");
    });

    // joystickChanged mirrors an engine-initiated change into state. It shares
    // the reducer with setJoystick, but must NOT be what drives the engine —
    // that is the saga's job, and only for setJoystick.
    it("accepts the engine-initiated mirror action", () => {
        const reducer = freshReducer();
        expect(stateAfter(reducer, joystickChanged("Sinclair2")).joystick).toBe("Sinclair2");
    });

    // Storage can throw outright (Safari private browsing, storage disabled).
    // A picker that crashes the app is worse than one that forgets.
    it("survives localStorage throwing", () => {
        const reducer = freshReducer();
        jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
            throw new Error("QuotaExceededError");
        });
        jest.spyOn(console, "error").mockImplementation(() => {});
        expect(() => stateAfter(reducer, setJoystick("Cursor"))).not.toThrow();
        expect(stateAfter(reducer, setJoystick("Cursor")).joystick).toBe("Cursor");
    });
});
