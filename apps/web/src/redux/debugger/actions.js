export const actionTypes = {
    openDebugger: 'debugger/open',
    closeDebugger: 'debugger/close',
    debuggerOpened: 'debugger/opened',
    debugStep: 'debugger/step',
    debugStepOver: 'debugger/stepOver',
    debugStepFrame: 'debugger/stepFrame',
    debugContinue: 'debugger/continue',
    debugPause: 'debugger/pause',
    debugResumed: 'debugger/resumed',
    debugSnapshot: 'debugger/snapshot',
    debugLiveUpdate: 'debugger/liveUpdate',
    sendConsoleCommand: 'debugger/sendConsoleCommand',
    consoleOutput: 'debugger/consoleOutput',
    toggleBreakpoint: 'debugger/toggleBreakpoint',
    toggleAddrBreakpoint: 'debugger/toggleAddrBreakpoint',
    clearBreakpoints: 'debugger/clearBreakpoints',
    setDebugTab: 'debugger/setDebugTab',
    setMemoryAddress: 'debugger/setMemoryAddress',
    sourceMapLoaded: 'debugger/sourceMapLoaded',
    sourceMapCleared: 'debugger/sourceMapCleared',
    panelOutput: 'debugger/panelOutput',
};

export const openDebugger = () => ({
    type: actionTypes.openDebugger
});

export const closeDebugger = () => ({
    type: actionTypes.closeDebugger
});

// backend: 'zxgo' when the wasm debug bridge is live, 'mock' otherwise.
export const debuggerOpened = (backend) => ({
    type: actionTypes.debuggerOpened,
    backend
});

export const debugStep = () => ({
    type: actionTypes.debugStep
});

export const debugStepOver = () => ({
    type: actionTypes.debugStepOver
});

export const debugStepFrame = () => ({
    type: actionTypes.debugStepFrame
});

export const debugContinue = () => ({
    type: actionTypes.debugContinue
});

export const debugPause = () => ({
    type: actionTypes.debugPause
});

export const debugResumed = () => ({
    type: actionTypes.debugResumed
});

// A full state snapshot from the session: registers, pc, disassembly and
// memory windows, plus why execution stopped. The single way panel data
// enters the store, whether from step, pause, or a breakpoint hit.
export const debugSnapshot = (snapshot) => ({
    type: actionTypes.debugSnapshot,
    snapshot
});

// Same panel data sampled while the machine RUNS (reads between frames are
// always safe on wasm); updates the panels without touching the run state.
export const debugLiveUpdate = (snapshot) => ({
    type: actionTypes.debugLiveUpdate,
    snapshot
});

export const sendConsoleCommand = (text) => ({
    type: actionTypes.sendConsoleCommand,
    text
});

export const consoleOutput = (entries) => ({
    type: actionTypes.consoleOutput,
    entries
});

// Breakpoints are source-line based. `file` is null until projects grow
// multiple files (#79); keeping it in the shape now avoids a migration.
export const toggleBreakpoint = (line) => ({
    type: actionTypes.toggleBreakpoint,
    line
});

// Address breakpoints, toggled from the disassembly pane. These arm on the
// real backend today; source-line ones join them with symbol maps.
export const toggleAddrBreakpoint = (address) => ({
    type: actionTypes.toggleAddrBreakpoint,
    address
});

export const clearBreakpoints = () => ({
    type: actionTypes.clearBreakpoints
});

export const setDebugTab = (tab) => ({
    type: actionTypes.setDebugTab,
    tab
});

// Jump the memory pane's viewport to an address. The pane always holds the
// whole 64K space; this only scrolls, it fetches nothing.
export const setMemoryAddress = (address) => ({
    type: actionTypes.setMemoryAddress,
    address
});

// A parsed source map (lib/debugger/sld.js) from a successful compile. The
// dispatcher sets `stale` when the editor moved on while the compile was in
// flight; any later edit also stales it (see the reducer's setCode case).
export const sourceMapLoaded = (map, stale = false) => ({
    type: actionTypes.sourceMapLoaded,
    map,
    stale
});

// A program without a source map replaced the mapped one (another language
// compiled, or sjasmplus produced no map).
export const sourceMapCleared = () => ({
    type: actionTypes.sourceMapCleared
});

// Refreshed text for a command-backed panel (backtrace / watches / Next
// state / history) — the engine's own console output, shown verbatim.
export const panelOutput = (panel, text) => ({
    type: actionTypes.panelOutput,
    panel,
    text
});
