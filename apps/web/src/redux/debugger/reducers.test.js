import reducer from "./reducers";
import {
    toggleBreakpoint,
    sourceMapLoaded,
    sourceMapCleared,
    closeDebugger,
} from "./actions";
import {setCode} from "../project/actions";
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
