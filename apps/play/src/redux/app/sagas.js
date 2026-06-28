import {takeLatest, put} from "redux-saga/effects";
import queryString from "query-string";
import {history} from "../store";
import {actionTypes} from "./actions";
import {reset, openUrl} from "../jsspeccy/actions";
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
        // Keep the existing query parameters so Reset reloads the same
        // configuration (tape URL, machine, keys) instead of dropping back to a
        // bare machine.
        history.push({pathname: '/', search: location.search});
        const url = queryString.parse(location.search).u;
        if (url) {
            // Cold-boot the machine and re-load the configured tape.
            yield put(openUrl(url));
        } else {
            yield put(reset());
        }
    } catch (e) {
        handleException(e);
    }
}
