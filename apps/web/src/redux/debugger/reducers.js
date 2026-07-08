import {actionTypes} from "./actions";

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
    // (#79) give it a value. Inert on the real backend until symbol maps.
    breakpoints: [],
    // Address breakpoints (numbers), set from the disassembly pane.
    addrBreakpoints: [],
    // 'zxgo' (wasm bridge) or 'mock' (no bridge available).
    backend: null,
    consoleHistory: [],
    selectedTab: 'console',
};

// -----------------------------------------------------------------------------
// Reducer
// -----------------------------------------------------------------------------

export default function debuggerReducer(state = initialState, action) {
    switch (action.type) {
        case actionTypes.openDebugger:
            // active flips here, synchronously with the click, so the
            // toolbar slims in the same frame. The saga attaches the session
            // (heavy: pauses the machine and snapshots the address space)
            // afterwards and reports the backend via debuggerOpened.
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
            // Breakpoints survive the session; everything else resets.
            return {
                ...initialState,
                breakpoints: state.breakpoints,
                addrBreakpoints: state.addrBreakpoints,
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
            const exists = state.breakpoints.some(
                (bp) => bp.line === action.line && bp.file === null);
            const breakpoints = exists
                ? state.breakpoints.filter(
                    (bp) => !(bp.line === action.line && bp.file === null))
                : [...state.breakpoints, {file: null, line: action.line}].sort(
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
        default:
            return state;
    }
}
