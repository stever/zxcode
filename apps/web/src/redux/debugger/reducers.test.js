import reducer from "./reducers";
import {
    toggleBreakpoint,
    toggleAddrBreakpoint,
    clearBreakpoints,
    sourceMapLoaded,
    sourceMapCleared,
    closeDebugger,
} from "./actions";
import {setCode, receiveLoadedProject} from "../project/actions";
import {parseSld} from "../../lib/debugger/sld";

// Minimal real-shaped map: code on lines 4 and 15, nothing after 15.
const SLD = `|SLD.data.version|1
program.asm|4||0|2|32768|T|
program.asm|15||0|2|32784|T|
`;

const withMap = (stale = false) =>
    reducer(undefined, sourceMapLoaded(parseSld(SLD), stale));

describe("debugger reducer source map", () => {
    test("sourceMapLoaded stores the map with its staleness", () => {
        expect(withMap().sourceMap.stale).toBe(false);
        expect(withMap(true).sourceMap.stale).toBe(true);
        expect(withMap().sourceMap.lineToAddr.get(4)).toBe(0x8000);
    });

    test("sourceMapCleared drops it and no-ops when absent", () => {
        const state = withMap();
        expect(reducer(state, sourceMapCleared()).sourceMap).toBeNull();
        const empty = reducer(undefined, {type: "@@INIT"});
        expect(reducer(empty, sourceMapCleared())).toBe(empty);
    });

    test("an edit stales the map once, then no-ops per keystroke", () => {
        const fresh = withMap();
        const staled = reducer(fresh, setCode("changed"));
        expect(staled.sourceMap.stale).toBe(true);
        expect(reducer(staled, setCode("changed more"))).toBe(staled);
    });

    test("the map survives closeDebugger like breakpoints do", () => {
        const state = reducer(withMap(), closeDebugger());
        expect(state.sourceMap).not.toBeNull();
    });
});

describe("sourceMapLoaded breakpoint normalization", () => {
    test("re-anchors pre-compile breakpoints to instruction lines", () => {
        // Dots set with no map: a label line (3), an instruction line (4),
        // and a line past all code (16).
        let state = reducer(undefined, toggleBreakpoint(3));
        state = reducer(state, toggleBreakpoint(4));
        state = reducer(state, toggleBreakpoint(16));
        state = reducer(state, sourceMapLoaded(parseSld(SLD)));
        // 3 snaps to 4 and merges with the existing 4; 16 has no code
        // below and drops.
        expect(state.breakpoints).toEqual([{file: null, line: 4}]);
    });

    test("a stale-on-arrival map leaves breakpoints untouched", () => {
        let state = reducer(undefined, toggleBreakpoint(3));
        state = reducer(state, sourceMapLoaded(parseSld(SLD), true));
        expect(state.breakpoints).toEqual([{file: null, line: 3}]);
    });

    test("distinct dots stay distinct when they map to different lines", () => {
        let state = reducer(undefined, toggleBreakpoint(3));   // -> 4
        state = reducer(state, toggleBreakpoint(14));          // -> 15
        state = reducer(state, sourceMapLoaded(parseSld(SLD)));
        expect(state.breakpoints).toEqual([
            {file: null, line: 4},
            {file: null, line: 15},
        ]);
    });
});

describe("toggleBreakpoint snapping", () => {
    test("keeps a mapped line as-is", () => {
        const state = reducer(withMap(), toggleBreakpoint(4));
        expect(state.breakpoints).toEqual([{file: null, line: 4}]);
    });

    test("snaps an unmapped line forward to the next instruction", () => {
        const state = reducer(withMap(), toggleBreakpoint(7));
        expect(state.breakpoints).toEqual([{file: null, line: 15}]);
    });

    test("refuses a line with no code below it", () => {
        const state = withMap();
        expect(reducer(state, toggleBreakpoint(16))).toBe(state);
    });

    test("toggling the snapped line again removes the breakpoint", () => {
        let state = reducer(withMap(), toggleBreakpoint(7));   // snaps to 15
        state = reducer(state, toggleBreakpoint(15));
        expect(state.breakpoints).toEqual([]);
    });

    test("no snapping without a map or with a stale one", () => {
        const noMap = reducer(undefined, toggleBreakpoint(7));
        expect(noMap.breakpoints).toEqual([{file: null, line: 7}]);
        const staleMap = reducer(withMap(true), toggleBreakpoint(7));
        expect(staleMap.breakpoints).toEqual([{file: null, line: 7}]);
    });
});

// Main-source code on lines 4/15, included-file code on lines 2/5.
const MULTI_SLD = `|SLD.data.version|1
program.asm|4||0|2|32768|T|
part.asm|2||0|2|32770|T|
part.asm|5||0|2|32773|T|
program.asm|15||0|2|32784|T|
`;

const withMultiMap = (stale = false) =>
    reducer(undefined, sourceMapLoaded(parseSld(MULTI_SLD), stale));

describe("multi-file breakpoints", () => {
    test("dots in different files with the same line coexist", () => {
        let state = reducer(undefined, toggleBreakpoint(4));
        state = reducer(state, toggleBreakpoint(4, "part.asm"));
        expect(state.breakpoints).toEqual([
            {file: null, line: 4},
            {file: "part.asm", line: 4},
        ]);
        // Toggling one off leaves the other.
        state = reducer(state, toggleBreakpoint(4));
        expect(state.breakpoints).toEqual([{file: "part.asm", line: 4}]);
    });

    test("snapping uses the file's own line space", () => {
        const state = reducer(withMultiMap(), toggleBreakpoint(3, "part.asm"));
        expect(state.breakpoints).toEqual([{file: "part.asm", line: 5}]);
    });

    test("refuses lines in files the assembly never included", () => {
        const state = withMultiMap();
        expect(reducer(state, toggleBreakpoint(1, "missing.asm"))).toBe(state);
    });

    test("re-anchoring keeps per-file dots and drops orphaned files", () => {
        let state = reducer(undefined, toggleBreakpoint(1, "part.asm"));  // -> 2
        state = reducer(state, toggleBreakpoint(4));
        state = reducer(state, toggleBreakpoint(3, "deleted.asm"));
        state = reducer(state, sourceMapLoaded(parseSld(MULTI_SLD)));
        expect(state.breakpoints).toEqual([
            {file: null, line: 4},
            {file: "part.asm", line: 2},
        ]);
    });
});

// (id, title, lang, code) is all the debugger slice looks at.
const loadedProject = (id) => receiveLoadedProject(id, "Title", "asm", "");

describe("breakpoint persistence (#104)", () => {
    beforeEach(() => localStorage.clear());

    test("dots survive a refresh of the same project", () => {
        let state = reducer(undefined, loadedProject("p1"));
        state = reducer(state, toggleBreakpoint(4));
        state = reducer(state, toggleBreakpoint(2, "part.asm"));
        state = reducer(state, toggleAddrBreakpoint(0x8000));
        // A refresh is a fresh store meeting the same project load.
        const restored = reducer(undefined, loadedProject("p1"));
        expect(restored.breakpoints).toEqual([
            {file: null, line: 4},
            {file: "part.asm", line: 2},
        ]);
        expect(restored.addrBreakpoints).toEqual([0x8000]);
    });

    test("toggling a dot off and clearing both persist", () => {
        let state = reducer(undefined, loadedProject("p1"));
        state = reducer(state, toggleBreakpoint(4));
        state = reducer(state, toggleBreakpoint(4));
        expect(reducer(undefined, loadedProject("p1")).breakpoints).toEqual([]);
        state = reducer(state, toggleBreakpoint(7));
        state = reducer(state, toggleAddrBreakpoint(0x9000));
        reducer(state, clearBreakpoints());
        const restored = reducer(undefined, loadedProject("p1"));
        expect(restored.breakpoints).toEqual([]);
        expect(restored.addrBreakpoints).toEqual([]);
        // A project with no breakpoints left holds no storage entry at all.
        expect(localStorage.getItem("projectBreakpoints")).toBe("{}");
    });

    test("projects keep separate dots and switching restores each set", () => {
        let state = reducer(undefined, loadedProject("p1"));
        state = reducer(state, toggleBreakpoint(4));
        state = reducer(state, loadedProject("p2"));
        // The switch starts p2 clean rather than leaking p1's dot.
        expect(state.breakpoints).toEqual([]);
        state = reducer(state, toggleBreakpoint(9));
        state = reducer(state, loadedProject("p1"));
        expect(state.breakpoints).toEqual([{file: null, line: 4}]);
        state = reducer(state, loadedProject("p2"));
        expect(state.breakpoints).toEqual([{file: null, line: 9}]);
    });

    test("revisiting the loaded project keeps live state untouched", () => {
        let state = reducer(undefined, loadedProject("p1"));
        state = reducer(state, sourceMapLoaded(parseSld(SLD)));
        state = reducer(state, toggleBreakpoint(4));
        const revisited = reducer(state, loadedProject("p1"));
        expect(revisited).toBe(state);
    });

    test("switching projects drops the old project's source map", () => {
        let state = reducer(undefined, loadedProject("p1"));
        state = reducer(state, sourceMapLoaded(parseSld(SLD)));
        state = reducer(state, loadedProject("p2"));
        expect(state.sourceMap).toBeNull();
    });

    test("re-anchored dots are what a refresh restores", () => {
        let state = reducer(undefined, loadedProject("p1"));
        state = reducer(state, toggleBreakpoint(3));   // label line
        state = reducer(state, toggleBreakpoint(16));  // past all code
        reducer(state, sourceMapLoaded(parseSld(SLD)));
        expect(reducer(undefined, loadedProject("p1")).breakpoints)
            .toEqual([{file: null, line: 4}]);
    });

    test("dots set with no project loaded are not saved", () => {
        reducer(undefined, toggleBreakpoint(4));
        expect(localStorage.getItem("projectBreakpoints")).toBeNull();
    });

    test("garbage in storage restores as no breakpoints", () => {
        localStorage.setItem("projectBreakpoints", "not json");
        expect(reducer(undefined, loadedProject("p1")).breakpoints).toEqual([]);
        localStorage.setItem("projectBreakpoints", JSON.stringify({
            p1: {breakpoints: [{file: 7, line: "x"}, {file: null, line: 4}, null],
                addrBreakpoints: [0x8000, "no", -1]},
        }));
        const restored = reducer(undefined, loadedProject("p1"));
        expect(restored.breakpoints).toEqual([{file: null, line: 4}]);
        expect(restored.addrBreakpoints).toEqual([0x8000]);
    });

    test("projectId survives closeDebugger so later toggles still save", () => {
        let state = reducer(undefined, loadedProject("p1"));
        state = reducer(state, closeDebugger());
        reducer(state, toggleBreakpoint(4));
        expect(reducer(undefined, loadedProject("p1")).breakpoints)
            .toEqual([{file: null, line: 4}]);
    });
});
