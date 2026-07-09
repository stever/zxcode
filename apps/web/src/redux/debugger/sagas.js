import {take, takeLatest, takeEvery, put, call, select, fork, delay} from "redux-saga/effects";
import {eventChannel} from "redux-saga";
import {
    actionTypes,
    closeDebugger,
    debuggerOpened,
    debugSnapshot,
    debugLiveUpdate,
    debugResumed,
    consoleOutput,
    panelOutput
} from "./actions";
import {actionTypes as jsspeccyActionTypes} from "../jsspeccy/actions";
import {actionTypes as appActionTypes} from "../app/actions";
import {actionTypes as projectActionTypes} from "../project/actions";
import {getJsspeccy} from "../jsspeccy/handle";
import {createDebugSession} from "../../lib/debugger/mockSession";
import {createRealSession} from "../../lib/debugger/realSession";
import {handleException} from "../../errors";

// The live session for this tab: the zx_go wasm bridge when the loaded
// engine exposes it, else the mock (older wasm, tests). Both implement the
// contract documented in lib/debugger/mockSession.js.
let session = null;

// -----------------------------------------------------------------------------
// Action watchers
// -----------------------------------------------------------------------------

// noinspection JSUnusedGlobalSymbols
export function* watchForOpenDebuggerActions() {
    yield takeLatest(actionTypes.openDebugger, handleOpenDebuggerActions);
}

// noinspection JSUnusedGlobalSymbols
export function* watchForCloseDebuggerActions() {
    yield takeLatest(actionTypes.closeDebugger, handleCloseDebuggerActions);
}

// noinspection JSUnusedGlobalSymbols
export function* watchForDebugStepActions() {
    yield takeLatest(actionTypes.debugStep, handleDebugStepActions);
}

// noinspection JSUnusedGlobalSymbols
export function* watchForDebugStepOverActions() {
    yield takeLatest(actionTypes.debugStepOver, handleDebugStepOverActions);
}

// noinspection JSUnusedGlobalSymbols
export function* watchForDebugStepFrameActions() {
    yield takeLatest(actionTypes.debugStepFrame, handleDebugStepFrameActions);
}

// noinspection JSUnusedGlobalSymbols
export function* watchForDebugContinueActions() {
    yield takeLatest(actionTypes.debugContinue, handleDebugContinueActions);
}

// noinspection JSUnusedGlobalSymbols
export function* watchForDebugPauseActions() {
    yield takeLatest(actionTypes.debugPause, handleDebugPauseActions);
}

// noinspection JSUnusedGlobalSymbols
export function* watchForSendConsoleCommandActions() {
    yield takeEvery(actionTypes.sendConsoleCommand, handleSendConsoleCommandActions);
}

// noinspection JSUnusedGlobalSymbols
export function* watchForBreakpointChanges() {
    yield takeEvery(
        [
            actionTypes.toggleBreakpoint,
            actionTypes.toggleAddrBreakpoint,
            actionTypes.clearBreakpoints,
        ],
        handleBreakpointChanges);
}

// The command-backed panels refresh whenever a pause snapshot lands or the
// user switches onto one of them. Never while running: state-reading
// commands implicitly pause the CPU and leave it paused, so an automatic
// refresh mid-run would silently stop the machine.
// noinspection JSUnusedGlobalSymbols
export function* watchForPanelRefresh() {
    yield takeLatest(
        [
            actionTypes.debugSnapshot,
            actionTypes.setDebugTab,
        ],
        refreshDebugPanel);
}

// The session's view of the source map follows the store: a compile loads
// or clears it, and the first edit after a compile stales it (the reducer's
// setCode case), which reaches the session as null so its line breakpoints
// disarm. setCode fires per keystroke but only the first one changes
// anything; the rest fall through the no-change guard in the handler.
// noinspection JSUnusedGlobalSymbols
export function* watchForSourceMapChanges() {
    yield takeEvery(
        [
            actionTypes.sourceMapLoaded,
            actionTypes.sourceMapCleared,
            projectActionTypes.setCode,
        ],
        handleSourceMapChanges);
}

// The debug session binds to the machine instance that was live when it
// opened; anything that replaces or restarts the machine invalidates it.
// The panel stays open throughout: machine change and reset reattach to the
// new machine, and Play (runProjectCode → compile → loadTap → reset) also
// reattaches, resumed, so the freshly loaded program runs under the
// debugger. loadTap is watched only to mark that intent for the reset that
// follows it. takeLatest so the machineChanged+reset burst a machine pick
// dispatches coalesces into one reattach (see handleSessionInvalidation).
// noinspection JSUnusedGlobalSymbols
export function* watchForSessionInvalidation() {
    yield takeLatest(
        [
            jsspeccyActionTypes.reset,
            appActionTypes.machineChanged,
            jsspeccyActionTypes.loadTap,
        ],
        handleSessionInvalidation);
}

// -----------------------------------------------------------------------------
// Action handlers
// -----------------------------------------------------------------------------

function getPauseEventChannel(debugSession) {
    return eventChannel((emit) => {
        debugSession.onPause((snapshot) => emit(snapshot));
        return () => debugSession.onPause(null);
    });
}

// Forward breakpoint-hit snapshots from the session into the store until the
// session goes away.
function* pumpPauseEvents(debugSession) {
    const chan = yield call(getPauseEventChannel, debugSession);
    try {
        while (true) {
            const snapshot = yield take(chan);
            yield put(debugSnapshot(snapshot));
        }
    } finally {
        chan.close();
    }
}

// While the machine runs under the debugger, sample it a few times a second
// so the panels track live execution instead of freezing at the last pause.
// Reads never disturb the CPU (single JS thread — the machine is between
// frames whenever this runs). The loop dies with its session.
function* pumpLiveUpdates(debugSession) {
    while (true) {
        yield delay(250);
        if (session !== debugSession) return;
        const status = yield select((state) => state?.debugger.status);
        if (status !== 'running') continue;
        const snapshot = debugSession.snapshot('running');
        if (snapshot) {
            yield put(debugLiveUpdate(snapshot));
        }
    }
}

function* syncBreakpointsToSession() {
    if (!session) return;
    const breakpoints = yield select((state) => state?.debugger.breakpoints);
    const addrBreakpoints = yield select((state) => state?.debugger.addrBreakpoints);
    session.setBreakpoints({
        lines: breakpoints.map((bp) => bp.line),
        addrs: addrBreakpoints,
    });
}

// The map the session may act on: a stale one (edited since compile) is
// withheld — its line numbers describe the old buffer, so arming or
// highlighting with it would land on the wrong lines.
const selectLiveSourceMap = (state) => {
    const map = state?.debugger.sourceMap;
    return map && !map.stale ? map : null;
};

// The map last pushed to the live session, so per-keystroke setCode
// dispatches don't re-push and re-diff breakpoints. Sessions are recreated
// with the same store state, so a stale ref only ever short-circuits a
// genuinely redundant push (wireSession pushes unconditionally).
let pushedSourceMap = null;

function* handleSourceMapChanges() {
    if (!session) return;
    const live = yield select(selectLiveSourceMap);
    if (live === pushedSourceMap) return;
    pushedSourceMap = live;
    session.setSourceMap(live);
    yield call(syncBreakpointsToSession);
}

// Engine console commands behind each command-backed panel. Multiple
// commands concatenate, blank-line separated.
const PANEL_COMMANDS = {
    backtrace: ["backtrace 16"],
    // Register watches, tracepoints, and port watches (bare `watch-port`
    // is its list form). The mem/read watches are single-slot with no
    // list command — console-only.
    watches: ["list-watches", "list-tp", "watch-port"],
    nextState: ["nr-panel"],
    history: ["history", "prev 24"],
};

function* refreshDebugPanel() {
    if (!session) return;
    const status = yield select((state) => state?.debugger.status);
    if (status !== 'paused') return;
    const tab = yield select((state) => state?.debugger.selectedTab);
    const cmds = PANEL_COMMANDS[tab];
    if (!cmds) return;
    try {
        const parts = [];
        for (const cmd of cmds) {
            parts.push(yield call([session, session.sendCommand], cmd));
        }
        yield put(panelOutput(tab, parts.join("\n\n")));
    } catch (e) {
        handleException(e);
    }
}

function createSession() {
    const handle = getJsspeccy();
    if (handle && handle.debug && handle.debug.available()) {
        return createRealSession(handle);
    }
    return createDebugSession();
}

// Resolves just after the browser has painted the current state: rAF fires
// right before paint, so a timeout scheduled inside it lands after the frame
// is on screen.
function afterNextPaint() {
    return new Promise((resolve) => {
        requestAnimationFrame(() => setTimeout(resolve, 0));
    });
}

function* handleOpenDebuggerActions() {
    try {
        // Stop the frame loop first, inside the click's task: the wasm core
        // runs on the main thread, and while the machine is running its
        // frame work owns it — the debugger panel's render would queue
        // behind emulator frames for as long as they keep coming. The
        // session opens paused anyway; this just moves the pause ahead of
        // the rendering. Only when the debug bridge is live: that is the
        // same condition under which the session below drives the real
        // machine (and resumes it on dispose).
        const handle = getJsspeccy();
        const realMachine = Boolean(
            handle && handle.debug && handle.debug.available());
        if (realMachine) {
            // Attach before pausing: the engine suppresses its "machine
            // paused" overlay while a debugger is attached, and attach is
            // idempotent so the session's own attach below is a no-op.
            handle.debug.attach();
            handle.pause();
        }
        // The reducer already flipped `active` on openDebugger. Let that
        // frame paint before the attach below blocks the main thread, so
        // the panel appears without waiting for the session to come up.
        yield call(afterNextPaint);
        const active = yield select((state) => state?.debugger.active);
        if (!active) {
            // Toggled off again before the session was created; undo the
            // attach and restart the machine (mirrors session.dispose()).
            if (realMachine) {
                handle.debug.detach();
                handle.start();
            }
            return;
        }
        if (session) {
            session.dispose();
        }
        if (!(yield call(wireSession))) return;
        yield fork(pumpPauseEvents, session);
        yield fork(pumpLiveUpdates, session);
        yield put(debugSnapshot(session.snapshot('entry')));
    } catch (e) {
        handleException(e);
    }
}

// Create a session against the live machine and plumb it into the store:
// breakpoints, backend report. Shared by the first open and the
// machine-change/reset reattach; the caller decides what happens next
// (entry snapshot vs. resume) and must have disposed any prior session.
// Returns false (after closing the panel) when there is nothing to attach
// to. The caller forks the pump loops itself: forked inside this generator
// they would attach to its scope and the enclosing `call` would never
// resolve (the pumps run for the session's whole life).
function* wireSession() {
    session = createSession();
    if (!session) {
        // The engine is still booting; nothing to attach to yet.
        console.error("debugger: emulator not ready to attach");
        yield put(closeDebugger());
        return false;
    }
    // Map before breakpoints, so line breakpoints arm in the same sync.
    pushedSourceMap = yield select(selectLiveSourceMap);
    session.setSourceMap(pushedSourceMap);
    yield call(syncBreakpointsToSession);
    yield put(debuggerOpened(session.backend));
    return true;
}

// eslint-disable-next-line require-yield
function* handleCloseDebuggerActions() {
    if (session) {
        session.dispose();
        session = null;
    }
}

// Set by loadTap (a compiled program is about to be loaded) and consumed by
// the reset that follows: the tape only loads on a running machine, so that
// reattach must resume regardless of the debugger's previous run state.
// Consumed LATE (only once a reattach actually acts on it): takeLatest
// cancels an in-flight handler whenever another invalidating action lands
// inside its settle delay, and a flag consumed at handler start would leave
// with the cancelled handler — the successor would then reattach paused and
// the tape load would stall. A cancelled handler leaving the flag set is
// harmless: its successor applies the same resume.
let resumeOnReattach = false;

function* handleSessionInvalidation(action) {
    if (action.type === jsspeccyActionTypes.loadTap) {
        resumeOnReattach = true;
        return;
    }
    const active = yield select((state) => state?.debugger.active);
    if (!active) {
        resumeOnReattach = false;
        return;
    }
    // Machine change or reset: the machine under the session is being
    // replaced, but the panel stays open — reattach in place, without
    // re-dispatching openDebugger (its reducer resets the slice, which
    // reads as a flash: backend/console/status all blank and repopulate).
    // The delay outlasts the reset saga's deferred jsspeccy.start() (100ms)
    // so the fresh session's pause is the last word on the frame loop; with
    // takeLatest it also coalesces the machineChanged+reset pair a machine
    // pick dispatches into a single reattach.
    yield delay(150);
    const stillActive = yield select((state) => state?.debugger.active);
    if (!stillActive) {
        resumeOnReattach = false;
        return;
    }
    // Carry the run state across: a debugger left running (Continue) stays
    // running on the new machine; a paused one lands paused at entry —
    // except when a program is loading, which always needs a running machine.
    const loadingProgram = resumeOnReattach;
    const wasRunning = loadingProgram || (yield select(
        (state) => state?.debugger.status === 'running'));
    if (session) {
        // The engine already detached from the dying machine (setMachine and
        // reset both do); resuming here would poke the new machine the
        // reattach is about to pause.
        session.dispose({resume: false});
        session = null;
    }
    if (!(yield call(wireSession))) {
        resumeOnReattach = false;
        return;
    }
    resumeOnReattach = false;
    yield fork(pumpPauseEvents, session);
    yield fork(pumpLiveUpdates, session);
    if (wasRunning) {
        // The session constructor paused the new machine for a moment;
        // resume without ever dispatching a paused snapshot, so the panels
        // keep tracking live execution with no pause flicker. debugResumed
        // is belt-and-braces: the status should still read 'running'.
        session.resume();
        yield put(debugResumed());
    } else {
        yield put(debugSnapshot(session.snapshot('entry')));
    }
}

function* handleDebugStepActions() {
    if (!session) return;
    const snapshot = session.step();
    if (snapshot) yield put(debugSnapshot(snapshot));
}

function* handleDebugStepOverActions() {
    if (!session) return;
    const result = session.stepOver();
    if (result && result.running) {
        yield put(debugResumed());
    } else if (result) {
        yield put(debugSnapshot(result));
    }
}

function* handleDebugStepFrameActions() {
    if (!session) return;
    const snapshot = session.stepFrame();
    if (snapshot) yield put(debugSnapshot(snapshot));
}

function* handleDebugContinueActions() {
    if (!session) return;
    session.resume();
    yield put(debugResumed());
}

function* handleDebugPauseActions() {
    if (!session) return;
    const snapshot = session.pause();
    if (snapshot) yield put(debugSnapshot(snapshot));
}

function* handleSendConsoleCommandActions(action) {
    const text = action.text.trim();
    if (!text) return;
    yield put(consoleOutput([{kind: 'cmd', text}]));
    if (!session) {
        yield put(consoleOutput([{kind: 'err', text: 'ERR no debug session'}]));
        return;
    }
    try {
        const response = yield call([session, session.sendCommand], text);
        yield put(consoleOutput([{
            kind: response.startsWith('ERR') ? 'err' : 'ok',
            text: response
        }]));
        // The command may have changed what a panel shows (a new watch,
        // history armed); keep the visible one in step.
        yield call(refreshDebugPanel);
    } catch (e) {
        handleException(e);
    }
}

function* handleBreakpointChanges() {
    yield call(syncBreakpointsToSession);
}
