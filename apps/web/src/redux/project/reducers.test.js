import reducer from "./reducers";
import {loadProject, receiveLoadedProject, setCode} from "./actions";

function loadedState(id, code) {
    let state = reducer(undefined, {type: "@@INIT"});
    state = reducer(state, receiveLoadedProject(id, "Title", "basic", code));
    return state;
}

describe("project reducer: loadProject", () => {
    it("resets when no project is loaded", () => {
        const state = reducer(undefined, {type: "@@INIT"});
        const next = reducer(state, loadProject("abc"));
        expect(next.id).toBeUndefined();
        expect(next.code).toBe("");
    });

    it("resets when loading a different project", () => {
        let state = loadedState("abc", "10 PRINT");
        state = reducer(state, setCode("10 PRINT edited"));
        const next = reducer(state, loadProject("def"));
        expect(next.id).toBeUndefined();
        expect(next.code).toBe("");
    });

    it("resets when reloading the same project with no unsaved changes", () => {
        const state = loadedState("abc", "10 PRINT");
        const next = reducer(state, loadProject("abc"));
        expect(next.id).toBeUndefined();
        expect(next.code).toBe("");
    });

    it("keeps the draft when reloading the same project with unsaved changes", () => {
        let state = loadedState("abc", "10 PRINT");
        state = reducer(state, setCode("10 PRINT edited"));
        const next = reducer(state, loadProject("abc"));
        expect(next.id).toBe("abc");
        expect(next.code).toBe("10 PRINT edited");
        expect(next.savedCode).toBe("10 PRINT");
        expect(next.lang).toBe("basic");
    });
});
