import {takeLatest, select, put, call} from "redux-saga/effects";
import getZmakebasTap from "zmakebas";
import getPasmoTap from "pasmo";
import getNextBasicProgram from "../../lib/nextbas";
import {actionTypes, setSelectedTabIndex} from "./actions";
import {loadTap, pause} from "../jsspeccy/actions";
import {setErrorItems} from "../project/actions";
import {handleException} from "../../errors";
import {dashboardUnlock} from "../../dashboard_lock";

// -----------------------------------------------------------------------------
// Action watchers
// -----------------------------------------------------------------------------

// noinspection JSUnusedGlobalSymbols
export function* watchForSetSelectedTabIndexActions() {
    yield takeLatest(actionTypes.setSelectedTabIndex, handleSetSelectedTabIndexActions);
}

// noinspection JSUnusedGlobalSymbols
export function* watchForRunAssemblyActions() {
    yield takeLatest(actionTypes.runAssembly, handleRunAssemblyActions);
}

// noinspection JSUnusedGlobalSymbols
export function* watchForRunSinclairBasicActions() {
    yield takeLatest(actionTypes.runSinclairBasic, handleRunSinclairBasicActions);
}

// -----------------------------------------------------------------------------
// Action handlers
// -----------------------------------------------------------------------------

function* handleSetSelectedTabIndexActions(_) {
    yield put(pause())
}

function* handleRunAssemblyActions(_) {
    try {
        const code = yield select((state) => state.demo.asmCode);
        const tap = yield call(getPasmoTap, code);
        yield put(loadTap(tap));

        // Mobile view has emulator on a tab. Switch to the emulator tab when running code.
        const isMobile = yield select((state) => state.window.isMobile);
        if (isMobile) yield put(setSelectedTabIndex(0));
    } catch (e) {
        yield put(setErrorItems(e));
    } finally {
        dashboardUnlock();
    }
}

function* handleRunSinclairBasicActions(_) {
    try {
        const code = yield select((state) => state.demo.sinclairBasicCode);
        const machine = yield select((state) => state.app.machine);
        console.log(`[demo-basic] run requested machine=${machine} codeLength=${code?.length}`);
        // On the Next, tokenise the source straight to a PLUS3DOS program via
        // txt2bas and hand it to the Next delivery — no .tap detour. The
        // GoEmulator delivery detects the PLUS3DOS magic and runs it directly.
        // The 48K/128K path stays zmakebas -> .tap.
        const program = machine === 'next'
            ? yield call(getNextBasicProgram, code)
            : yield call(getZmakebasTap, code);
        yield put(loadTap(program));

        // Mobile view has emulator on a tab. Switch to the emulator tab when running code.
        const isMobile = yield select((state) => state.window.isMobile);
        if (isMobile) yield put(setSelectedTabIndex(0));
    } catch (e) {
        console.error('[demo-basic] dispatching setErrorItems', e);
        yield put(setErrorItems(e));
    } finally {
        dashboardUnlock();
    }
}
