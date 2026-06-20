import {takeLatest, put} from "redux-saga/effects";
import {history} from "../store";
import {actionTypes} from "./actions";
import {reset} from "../jsspeccy/actions";
import {handleException} from "../../errors";

// -----------------------------------------------------------------------------
// Action watchers
// -----------------------------------------------------------------------------

// noinspection JSUnusedGlobalSymbols
export function* watchForShowActiveEmulatorActions() {
    yield takeLatest(actionTypes.showActiveEmulator, handleShowActiveEmulatorActions);
}

// noinspection JSUnusedGlobalSymbols
export function* watchForResetEmulatorActions() {
    yield takeLatest(actionTypes.resetEmulator, handleResetEmulatorActions);
}

// -----------------------------------------------------------------------------
// Action handlers
// -----------------------------------------------------------------------------

function* handleShowActiveEmulatorActions(_) {
    try {
        history.push('/');
    } catch (e) {
        handleException(e);
    }
}

function* handleResetEmulatorActions(_) {
    try {
        history.push('/');
        yield put(reset());
    } catch (e) {
        handleException(e);
    }
}
