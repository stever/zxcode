import {takeLatest, select, put, call} from "redux-saga/effects";
import getZmakebasTap from "zmakebas";
import getPasmoTap from "pasmo";
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
        const tap = yield call(getZmakebasTap, code);
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
