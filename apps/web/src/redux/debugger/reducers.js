import {actionTypes} from "./actions";
import {actionTypes as projectActionTypes} from "../project/actions";
import {snapLine} from "../../lib/debugger/sld";

// -----------------------------------------------------------------------------
// Initial state
// -----------------------------------------------------------------------------

const initialState = {
    active: false,
    // 'paused' | 'running' — while running the panels show the last snapshot.
    status: 'paused',
    // Why execution stopped: 'entry' | 'step' | 'breakpoint' | 'pause'.
    reason: null,
    pc: 0,
    registers: null,
    // The previous snapshot's registers, kept so the strip can highlight
    // values that changed on the last step.
    previousRegisters: null,
    disasm: [],
    // The full 64K address space as the CPU currently sees it (Uint8Array;
    // empty until the first snapshot). The memory pane virtualises the view.
    memory: {bytes: new Uint8Array(0)},
    // Scroll target for the memory pane. seq bumps on every jump so entering
    // the same address again still rescrolls after the user scrolled away.
    memoryJump: {address: 0x4000, seq: 0},
    // Memory-map pane data from the session (mode/slots/roles); null until a
    // snapshot arrives or when the backend cannot describe paging.
    paging: null,
    // The editor line to highlight while paused (1-based), when the pc maps
    // to source. Null when the pc is outside the project code (or, for now,
    // when the mock session has nothing better to offer).
    pausedLine: null,
    // Source-line breakpoints; `file` stays null until multi-file projects
    // (#79) give it a value. On the real backend they arm through sourceMap;
    // without one (or with a stale one) they are stored but inert.
    breakpoints: [],
    // Parsed SLD map from the last successful sjasmplus compile
    // (lib/debugger/sld.js shape plus `stale`). Belongs to the loaded
    // program, not the session, so it survives open/close. `stale` flips on
    // the first edit after the compile — the map still describes the binary
    // in the machine, but no longer the editor's line numbers.
    sourceMap: null,
    // Address breakpoints (numbers), set from the disassembly pane.
    addrBreakpoints: [],
    // 'zxgo' (wasm bridge) or 'mock' (no bridge available).
    backend: null,
    consoleHistory: [],
    selectedTab: 'console',
    // Command-backed panel text (backtrace/watches/nextState/history),
    // refreshed by the saga while paused. Keyed by tab name; missing keys
    // render as "no data yet".
    panels: {},
};

// -----------------------------------------------------------------------------
// Reducer
// -----------------------------------------------------------------------------

export default function debuggerReducer(state = initialState, action) {
    switch (action.type) {
        case actionTypes.openDebugger:
            // active flips here, synchronously with the click, so the
            // Debug button shows pressed in the same frame. The saga
            // attaches the session (heavy: pauses the machine and snapshots
            // the address space) afterwards and reports the backend via
            // debuggerOpened.
            return {
                ...state,
                active: true,
                status: 'paused',
                reason: 'entry',
                backend: null,
                consoleHistory: [],
            };
        case actionTypes.debuggerOpened:
            return {
                ...state,
                backend: action.backend,
            };
        case actionTypes.closeDebugger:
            // Breakpoints and the source map survive the session; everything
            // else resets.
            return {
                ...initialState,
                breakpoints: state.breakpoints,
                addrBreakpoints: state.addrBreakpoints,
                sourceMap: state.sourceMap,
            };
        case actionTypes.debugSnapshot: {
            const s = action.snapshot;
            return {
                ...state,
                status: 'paused',
                reason: s.reason,
                pc: s.pc,
                previousRegisters: state.registers,
                registers: s.registers,
                disasm: s.disasm || state.disasm,
                memory: s.memory || state.memory,
                paging: s.paging || state.paging,
                pausedLine: s.pausedLine !== undefined ? s.pausedLine : null,
            };
        }
        case actionTypes.debugLiveUpdate: {
            // Panels track the running machine; run state and reason are
            // untouched. previousRegisters advances so the change highlight
            // flickers with real activity.
            const s = action.snapshot;
            return {
                ...state,
                pc: s.pc,
                previousRegisters: state.registers,
                registers: s.registers,
                disasm: s.disasm || state.disasm,
                memory: s.memory || state.memory,
                paging: s.paging || state.paging,
            };
        }
        case actionTypes.debugResumed:
            return {
                ...state,
                status: 'running',
                reason: null,
                pausedLine: null,
            };
        case actionTypes.consoleOutput:
            return {
                ...state,
                consoleHistory: [...state.consoleHistory, ...action.entries],
            };
        case actionTypes.toggleBreakpoint: {
            // With a live map, snap the click to the next line that has code
            // (so the dot sits on a real instruction) and refuse lines with
            // nothing below — data and directives cannot break. Toggling an
            // existing dot from the panel resolves to itself: stored lines
            // are always mapped lines.
            const map = state.sourceMap;
            let line = action.line;
            if (map && !map.stale) {
                line = snapLine(map, line);
                if (line === null) return state;
            }
            const exists = state.breakpoints.some(
                (bp) => bp.line === line && bp.file === null);
            const breakpoints = exists
                ? state.breakpoints.filter(
                    (bp) => !(bp.line === line && bp.file === null))
                : [...state.breakpoints, {file: null, line}].sort(
                    (a, b) => a.line - b.line);
            return {...state, breakpoints};
        }
        case actionTypes.toggleAddrBreakpoint: {
            const exists = state.addrBreakpoints.includes(action.address);
            const addrBreakpoints = exists
                ? state.addrBreakpoints.filter((a) => a !== action.address)
                : [...state.addrBreakpoints, action.address].sort((a, b) => a - b);
            return {...state, addrBreakpoints};
        }
        case actionTypes.clearBreakpoints:
            return {...state, breakpoints: [], addrBreakpoints: []};
        case actionTypes.setDebugTab:
            return {...state, selectedTab: action.tab};
        case actionTypes.setMemoryAddress:
            return {
                ...state,
                memoryJump: {
                    address: action.address & 0xFFFF,
                    seq: state.memoryJump.seq + 1,
                },
            };
        case actionTypes.panelOutput:
            return {
                ...state,
                panels: {...state.panels, [action.panel]: action.text},
            };
        case actionTypes.sourceMapLoaded:
            return {
                ...state,
                sourceMap: action.map ? {...action.map, stale: action.stale} : null,
            };
        case actionTypes.sourceMapCleared:
            return state.sourceMap ? {...state, sourceMap: null} : state;
        case projectActionTypes.setCode:
            // Any edit after the compile means the map's line numbers no
            // longer describe the buffer. One-way until the next compile;
            // no-op (same state object) on the keystrokes that follow.
            if (state.sourceMap && !state.sourceMap.stale) {
                return {...state, sourceMap: {...state.sourceMap, stale: true}};
            }
            return state;
        default:
            return state;
    }
}
