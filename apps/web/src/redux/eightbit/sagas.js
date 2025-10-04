import {takeLatest, select, call, put, take} from "redux-saga/effects";
import {eventChannel} from "redux-saga";
import gql from "graphql-tag";
import getZmakebasTap from "zmakebas";
import getBas2Tap from "bas2tap";
import getPasmoTap, {bin2tap} from "pasmo";
import {gqlFetch} from "../../graphql_fetch";
import {store} from "../store";
import {
    actionTypes,
    browserTapDownload,
    getProjectTap,
    getSdccTap,
    getZmacTap,
    handleWorkerMessage,
    runTap,
    setFollowTapAction
} from "./actions";
import {loadTap} from "../jsspeccy/actions";
import {setErrorItems, setSelectedTabIndex} from "../project/actions";
import {handleException} from "../../errors";
import {dashboardUnlock} from "../../dashboard_lock";

// -----------------------------------------------------------------------------
// Action watchers
// -----------------------------------------------------------------------------

// noinspection JSUnusedGlobalSymbols
export function* watchForWorkerMessageEvents() {
    const chan = yield call(getWorkerMessagesEventChannel);
    try {
        while (true) {
            const data = yield take(chan);
            yield put(handleWorkerMessage(data));
        }
    } finally {
        chan.close();
    }
}

// noinspection JSUnusedGlobalSymbols
export function* watchForHandleWorkerMessageActions() {
    yield takeLatest(actionTypes.handleWorkerMessage, handleWorkerMessageActions);
}

// noinspection JSUnusedGlobalSymbols
export function* watchForRunProjectCodeActions() {
    yield takeLatest(actionTypes.runProjectCode, handleRunProjectCodeActions);
}

// noinspection JSUnusedGlobalSymbols
export function* watchForDownloadProjectTapActions() {
    yield takeLatest(actionTypes.downloadProjectTap, handleDownloadProjectTapActions);
}

// noinspection JSUnusedGlobalSymbols
export function* watchForGetProjectTapActions() {
    yield takeLatest(actionTypes.getProjectTap, handleGetProjectTapActions);
}

// noinspection JSUnusedGlobalSymbols
export function* watchForGetSdccTapActions() {
    yield takeLatest(actionTypes.getSdccTap, handleGetSdccTapActions);
}

// noinspection JSUnusedGlobalSymbols
export function* watchForGetZmacTapActions() {
    yield takeLatest(actionTypes.getZmacTap, handleGetZmacTapActions);
}

// noinspection JSUnusedGlobalSymbols
export function* watchForBrowserTapDownloadActions() {
    yield takeLatest(actionTypes.browserTapDownload, handleBrowserTapDownloadActions);
}

// noinspection JSUnusedGlobalSymbols
export function* watchForRunTapActions() {
    yield takeLatest(actionTypes.runTap, handleRunTapActions);
}

// -----------------------------------------------------------------------------
// Action handlers
// -----------------------------------------------------------------------------

function* handleWorkerMessageActions(action) {
    // const title = yield select((state) => state.project.title);
    const followTapAction = yield select((state) => state.eightbit.followTapAction);
    try {
        console.assert(action?.msg?.data, action);

        const data = action.msg.data;

        if (data.errors && data.errors.length > 0) {
            yield put(setErrorItems(data.errors));
            return; // Don't continue on errors.
        }

        /*
        // Cause the download of the bin file using browser download.
        const blob = new Blob([data.output], {type: 'application/octet-stream'});
        const objURL = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.download = `${title}.bin`;
        link.href = objURL;
        link.click();
        */

        // Get tap file using Pasmo.
        // NOTE: Start address is 23755 (0x5ccb)
        const tap = yield call(bin2tap, data.output);

        /*
        // Cause the download of the tap file using browser download.
        const blob = new Blob([tap], {type: 'application/octet-stream'});
        const objURL = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.download = `${title}.tap`;
        link.href = objURL;
        link.click();
        */

        // noinspection PointlessBooleanExpressionJS
        if (!tap) {
            console.warn('no tap');
            return;
        }

        yield put(followTapAction(tap));
        yield put(setFollowTapAction(undefined));
    } catch (e) {
        handleException(e);
    } finally {
        dashboardUnlock();
    }
}

function* handleRunProjectCodeActions(_) {
    yield put(setFollowTapAction(runTap));
    yield put(getProjectTap());

    // Mobile view has emulator on a tab. Switch to the emulator tab when running code.
    const isMobile = yield select((state) => state.window.isMobile);
    if (isMobile) yield put(setSelectedTabIndex(0));
}

function* handleDownloadProjectTapActions(_) {
    yield put(setFollowTapAction(browserTapDownload));
    yield put(getProjectTap());
}

function* handleGetProjectTapActions(_) {
    const userId = yield select((state) => state.identity.userId);
    const lang = yield select((state) => state.project.lang);
    const code = yield select((state) => state.project.code);
    const followTapAction = yield select((state) => state.eightbit.followTapAction);
    try {
        let tap;
        switch (lang) {
            case 'asm':
                // Pasmo
                try {
                    tap = yield call(getPasmoTap, code);
                    yield put(followTapAction(tap));
                    yield put(setFollowTapAction(undefined));
                } catch (errorItems) {
                    yield put(setErrorItems(errorItems));
                } finally {
                    dashboardUnlock();
                }
                break;
            case 'basic':
                // Sinclair BASIC (zmakebas)
                try {
                    tap = yield call(getZmakebasTap, code);
                    yield put(followTapAction(tap));
                    yield put(setFollowTapAction(undefined));
                } catch (errorItems) {
                    yield put(setErrorItems(errorItems));
                } finally {
                    dashboardUnlock();
                }
                break;
            case 'bas2tap':
                // Sinclair BASIC (bas2tap)
                try {
                    tap = yield call(getBas2Tap, code);
                    yield put(followTapAction(tap));
                    yield put(setFollowTapAction(undefined));
                } catch (errorItems) {
                    yield put(setErrorItems(errorItems));
                } finally {
                    dashboardUnlock();
                }
                break;
            case 'zxbasic':
                // Boriel ZX BASIC
                try {
                    tap = yield call(getZXBasicTap, code, userId);
                    yield put(followTapAction(tap));
                    yield put(setFollowTapAction(undefined));
                } catch (errorItems) {
                    yield put(setErrorItems(errorItems));
                } finally {
                    dashboardUnlock();
                }
                break;
            case 'c':
                // Z88DK
                try {
                    tap = yield call(getZ88dkTap, code, userId);
                    yield put(followTapAction(tap));
                    yield put(setFollowTapAction(undefined));
                } catch (errorItems) {
                    yield put(setErrorItems(errorItems));
                } finally {
                    dashboardUnlock();
                }
                break;
            case 'zmac':
                // Z-80 Macro Cross-Assembler
                // NOTE: Call another action to get the tap using worker.
                yield put(getZmacTap());
                break;
            case 'sdcc':
                // SDCC - Small Device C Compiler
                // NOTE: Call another action to get the tap using worker.
                yield put(getSdccTap());
                break;
            default:
                // noinspection ExceptionCaughtLocallyJS
                throw `unexpected case: ${lang}`;
        }
    } catch (e) {
        handleException(e);
    }
}

function* handleGetSdccTapActions(_) {
    const code = yield select((state) => state.project.code);
    try {
        // Build a WorkerMessage and post it to the worker.
        const msg = {updates: [], buildsteps: []};

        // Add main source file.
        const mainFilename = 'source.c';
        msg.updates.push({path: mainFilename, data: code});

        msg.buildsteps.push({
            path: mainFilename,
            files: [mainFilename],
            tool: 'sdcc',
            mainfile: true
        });

        // postMessage({reset: true});
        postMessage(msg);
    } catch (e) {
        handleException(e);
    }
}

function* handleGetZmacTapActions(_) {
    const code = yield select((state) => state.project.code);
    try {
        // Build a WorkerMessage and post it to the worker.
        const msg = {updates: [], buildsteps: []};

        // Add main source file.
        const mainFilename = 'source.asm';
        msg.updates.push({path: mainFilename, data: code});

        msg.buildsteps.push({
            path: mainFilename,
            files: [mainFilename],
            tool: 'zmac',
            mainfile: true
        });

        // postMessage({reset: true});
        postMessage(msg);
    } catch (e) {
        handleException(e);
    }
}

function* handleBrowserTapDownloadActions(action) {
    const title = yield select((state) => state.project.title);
    try {
        // Cause the download of the tap file using browser download.
        const blob = new Blob([action.tap], {type: 'application/octet-stream'});
        const objURL = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.download = `${title}.tap`;
        link.href = objURL;
        link.click();
    } catch (e) {
        handleException(e);
    }
}

function* handleRunTapActions(action) {
    store.dispatch(loadTap(action.tap));
}

// -----------------------------------------------------------------------------
// Supporting code
// -----------------------------------------------------------------------------

// The 8bitworkshop worker compiles projects.
const worker = new Worker(`/dist/8bitworker.js?ver=${window.zxplay_ver}`);

// Preload tools.
console.log('Preloading 8bitworker tools');
worker.postMessage({preload: 'sdcc'});
worker.postMessage({preload: 'sdasz80'});
worker.postMessage({preload: 'zmac'});

function postMessage(msg) {
    worker.postMessage(msg);
}

function getWorkerMessagesEventChannel() {
    return eventChannel(emit => {

        // Emits data from worker message events.
        worker.onmessage = (e) => {
            emit({data: e.data});
        };

        // Must return an unsubscribe function.
        return () => {
            worker.onmessage = undefined;
        };
    })
}

async function getZXBasicTap(code, userId) {
    const query = gql`
        mutation ($basic: String!) {
            compile(basic: $basic) {
                base64_encoded
            }
        }
    `;

    const variables = {
        'basic': code
    };

    const response = await gqlFetch(userId, query, variables);
    console.assert(response?.data?.compile, response);

    // noinspection JSUnresolvedVariable
    const base64 = response.data.compile.base64_encoded;

    // noinspection JSDeprecatedSymbols
    return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
}

async function getZ88dkTap(code, userId) {
    const query = gql`
        mutation ($code: String!) {
            compileC(code: $code) {
                base64_encoded
            }
        }
    `;

    const variables = {
        'code': code
    };

    const response = await gqlFetch(userId, query, variables);

    // noinspection JSUnresolvedVariable
    console.assert(response?.data?.compileC, response);

    // noinspection JSUnresolvedVariable
    const base64 = response.data.compileC.base64_encoded;

    // noinspection JSDeprecatedSymbols
    return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
}
