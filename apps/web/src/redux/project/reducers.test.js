import reducer from "./reducers";
import {
    loadProject,
    receiveLoadedProject,
    setCode,
    setActiveFile,
    setFileContent,
    markFilesSaved,
    revertUnsavedChanges,
    receiveAddedFile,
    receiveRenamedFile,
    receiveDeletedFile,
} from "./actions";
import {selectHasUnsavedChanges} from "./selectors";

function loadedState(id, code, files = []) {
    let state = reducer(undefined, {type: "@@INIT"});
    state = reducer(state, receiveLoadedProject(
        id, "Title", "basic", code, false, null, null, null, null, false, "48", files));
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

    it("keeps the draft when only an additional file has unsaved changes", () => {
        let state = loadedState("abc", "10 PRINT",
            [{file_id: "f1", name: "lib.bas", content: "REM lib", is_binary: false}]);
        state = reducer(state, setFileContent("f1", "REM lib edited"));
        const next = reducer(state, loadProject("abc"));
        expect(next.id).toBe("abc");
        expect(next.files[0].content).toBe("REM lib edited");
    });
});

describe("project reducer: additional files", () => {
    const FILES = [{file_id: "f1", name: "lib.bas", content: "REM lib", is_binary: false}];

    it("loads files with saved content and null active file", () => {
        const state = loadedState("abc", "10 PRINT", FILES);
        expect(state.files).toEqual([
            {id: "f1", name: "lib.bas", content: "REM lib", savedContent: "REM lib", isBinary: false},
        ]);
        expect(state.activeFileId).toBeNull();
    });

    it("tracks dirty state across main code and files", () => {
        let state = loadedState("abc", "10 PRINT", FILES);
        expect(selectHasUnsavedChanges({project: state})).toBe(false);
        state = reducer(state, setFileContent("f1", "REM lib edited"));
        expect(selectHasUnsavedChanges({project: state})).toBe(true);
        state = reducer(state, markFilesSaved());
        expect(selectHasUnsavedChanges({project: state})).toBe(false);
        expect(state.files[0].savedContent).toBe("REM lib edited");
    });

    it("reverts main code and file drafts together", () => {
        let state = loadedState("abc", "10 PRINT", FILES);
        state = reducer(state, setCode("10 PRINT edited"));
        state = reducer(state, setFileContent("f1", "REM lib edited"));
        state = reducer(state, revertUnsavedChanges());
        expect(state.code).toBe("10 PRINT");
        expect(state.files[0].content).toBe("REM lib");
    });

    it("adds a file saved and active", () => {
        let state = loadedState("abc", "10 PRINT");
        state = reducer(state, receiveAddedFile("f2", "sprite.bin", "AAAA", true));
        expect(state.files).toHaveLength(1);
        expect(state.files[0]).toMatchObject({id: "f2", name: "sprite.bin", isBinary: true});
        expect(state.files[0].savedContent).toBe("AAAA");
        expect(state.activeFileId).toBe("f2");
        expect(selectHasUnsavedChanges({project: state})).toBe(false);
    });

    it("renames a file in place", () => {
        let state = loadedState("abc", "10 PRINT", FILES);
        state = reducer(state, receiveRenamedFile("f1", "library.bas"));
        expect(state.files[0].name).toBe("library.bas");
    });

    it("deleting the active file falls back to the main source", () => {
        let state = loadedState("abc", "10 PRINT", FILES);
        state = reducer(state, setActiveFile("f1"));
        state = reducer(state, receiveDeletedFile("f1"));
        expect(state.files).toHaveLength(0);
        expect(state.activeFileId).toBeNull();
    });
});
