import {takeLatest, select, call, put, take} from "redux-saga/effects";
import {eventChannel} from "redux-saga";
import getZmakebasTap from "zmakebas";
import getBas2Tap from "bas2tap";
import getPasmoTap, {bin2tap} from "pasmo";
import getNextBasicProgram from "../../lib/nextbas";
import {assetUrl} from "@zxplay/emulator";
import {tapDownloadFile} from "./tapDownload";
import {getZXBasicTap} from "./zxbasicCompile";
import {getZ88dkTap} from "./z88dkCompile";
import {getSjasmplusTap} from "./sjasmplusCompile";
import {getPascalTap} from "./pascalCompile";
import {toActionFiles, toWorkerUpdates, toSdFiles, sdFileNameErrors} from "./compileFiles";
import {expandPasmoIncludes} from "./pasmoIncludes";
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
import {sourceMapLoaded, sourceMapCleared} from "../debugger/actions";
import {parseSld} from "../../lib/debugger/sld";
import {parseBasicMap} from "../../lib/debugger/basicMap";
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
            console.error('[worker] dispatching setErrorItems', data.errors);
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
    // Additional project files (includes, INCBIN assets) ride along to the
    // compile services so they can be staged next to the main source.
    const files = toActionFiles(yield select((state) => state.project.files));
    const machine = yield select((state) => state.app.machine);
    const followTapAction = yield select((state) => state.eightbit.followTapAction);
    try {
        // Any other toolchain replacing the program invalidates the
        // debugger's source map; the sjasmplus and nextbas branches
        // reload their own (SLD and BASIC line map respectively).
        if (lang !== 'sjasmplus' && lang !== 'nextbas') {
            yield put(sourceMapCleared());
        }
        let tap;
        switch (lang) {
            case 'asm':
                // Pasmo — its emscripten FS only ever holds the main source,
                // so project INCLUDE/INCBIN files are inlined first
                // (pasmoIncludes.js).
                try {
                    const projectFiles = yield select((state) => state.project.files);
                    tap = yield call(getPasmoTap, expandPasmoIncludes(code, projectFiles));
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
            case 'nextbas':
                // NextBASIC (txt2bas) — tokenised to a PLUS3DOS program rather
                // than a TAP. The Next delivery (GoEmulator.openTapeBytes)
                // detects the PLUS3DOS magic and runs it via zxRunBas, so it
                // rides the same followTapAction path as the TAP compilers.
                // Extra project files (sprite sheets etc.) ride along too:
                // they are staged onto the SD card, folders included, so the
                // program can LOAD them at runtime by the same relative path
                // as the project ZIP unzipped onto a real card — which is
                // why every path segment must fit FAT 8.3 (a ~ alias would
                // never match the LOADed path).
                try {
                    const projectFiles = yield select((state) => state.project.files);
                    const badNames = sdFileNameErrors(projectFiles);
                    if (badNames.length > 0) {
                        // noinspection ExceptionCaughtLocallyJS
                        throw badNames.map((name) => ({
                            type: "err",
                            text: `"${name}" cannot go on the Next's SD card: every folder and file name must fit 8.3 (up to 8 characters, then a dot and up to 3). Rename it so the program can LOAD it.`,
                        }));
                    }
                    tap = yield call(getNextBasicProgram, code);
                    // The debugger's line map comes straight from the
                    // source: BASIC lines are numbered, so no toolchain
                    // artifact is needed (kind: "basic" — armed via the
                    // engine's PPC watch, see lib/debugger/basicMap.js).
                    // A failed tokenise keeps the previous map, like a
                    // failed sjasmplus compile: the machine still runs
                    // the previous build.
                    const basicMap = parseBasicMap(code);
                    if (basicMap) {
                        // Stale on arrival if the editor moved on while
                        // this handler was in flight.
                        const codeNow = yield select((state) => state.project.code);
                        yield put(sourceMapLoaded(basicMap, codeNow !== code));
                    } else {
                        yield put(sourceMapCleared());
                    }
                    yield put(followTapAction(tap, toSdFiles(projectFiles)));
                    yield put(setFollowTapAction(undefined));
                } catch (errorItems) {
                    console.error('[nextbas] dispatching setErrorItems', errorItems);
                    yield put(setErrorItems(errorItems));
                } finally {
                    dashboardUnlock();
                }
                break;
            case 'zxbasic':
                // Boriel ZX BASIC
                try {
                    tap = yield call(getZXBasicTap, code, userId, files);
                    yield put(followTapAction(tap));
                    yield put(setFollowTapAction(undefined));
                } catch (errorItems) {
                    console.error('[zxbasic] dispatching setErrorItems', errorItems);
                    yield put(setErrorItems(errorItems));
                } finally {
                    dashboardUnlock();
                }
                break;
            case 'c':
                // Z88DK
                try {
                    tap = yield call(getZ88dkTap, code, userId, files);
                    yield put(followTapAction(tap));
                    yield put(setFollowTapAction(undefined));
                } catch (errorItems) {
                    console.error('[z88dk] dispatching setErrorItems', errorItems);
                    yield put(setErrorItems(errorItems));
                } finally {
                    dashboardUnlock();
                }
                break;
            case 'pascal':
                // Pasta80 Turbo Pascal — the codegen target follows the
                // emulator machine (48/128/next link different runtimes), so
                // the program is compiled for what it is about to run on.
                try {
                    tap = yield call(getPascalTap, code, String(machine), userId, files);
                    yield put(followTapAction(tap));
                    yield put(setFollowTapAction(undefined));
                } catch (errorItems) {
                    console.error('[pasta80] dispatching setErrorItems', errorItems);
                    yield put(setErrorItems(errorItems));
                } finally {
                    dashboardUnlock();
                }
                break;
            case 'sjasmplus':
                // sjasmplus — returns a TAP, or a NEX image when the source
                // uses SAVENEX (the emulator sniffs the signature at load),
                // plus the SLD source map the debugger arms line breakpoints
                // with. A failed compile keeps the previous map: the machine
                // still runs the previous build.
                try {
                    const result = yield call(getSjasmplusTap, code, userId, files);
                    const map = parseSld(result.sld);
                    if (map) {
                        // Stale on arrival when the editor moved on while
                        // the compile was in flight — in the main source or
                        // in any additional file the assembly consumed.
                        const codeNow = yield select((state) => state.project.code);
                        const filesNow = toActionFiles(
                            yield select((state) => state.project.files));
                        const filesMoved = filesNow.length !== files.length
                            || filesNow.some((f, i) =>
                                f.name !== files[i].name || f.content !== files[i].content);
                        yield put(sourceMapLoaded(map, codeNow !== code || filesMoved));
                    } else {
                        yield put(sourceMapCleared());
                    }
                    yield put(followTapAction(result.tap));
                    yield put(setFollowTapAction(undefined));
                } catch (errorItems) {
                    console.error('[sjasmplus] dispatching setErrorItems', errorItems);
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
    const projectFiles = yield select((state) => state.project.files);
    try {
        // Build a WorkerMessage and post it to the worker.
        const msg = {updates: [], buildsteps: []};

        // Add main source file.
        const mainFilename = 'source.c';
        msg.updates.push({path: mainFilename, data: code});

        // Additional project files go into the worker VFS and the build
        // step's file list, so #include resolves them; only source.c is
        // compiled.
        const extraUpdates = toWorkerUpdates(projectFiles);
        msg.updates.push(...extraUpdates);

        msg.buildsteps.push({
            path: mainFilename,
            files: [mainFilename, ...extraUpdates.map((u) => u.path)],
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
    const projectFiles = yield select((state) => state.project.files);
    try {
        // Build a WorkerMessage and post it to the worker.
        const msg = {updates: [], buildsteps: []};

        // Add main source file.
        const mainFilename = 'source.asm';
        msg.updates.push({path: mainFilename, data: code});

        // Additional project files go into the worker VFS and the build
        // step's file list, so include resolves them; only source.asm is
        // assembled.
        const extraUpdates = toWorkerUpdates(projectFiles);
        msg.updates.push(...extraUpdates);

        msg.buildsteps.push({
            path: mainFilename,
            files: [mainFilename, ...extraUpdates.map((u) => u.path)],
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
    const machine = yield select((state) => state.app.machine);
    try {
        const data = action.tap instanceof Uint8Array
            ? action.tap
            : new Uint8Array(action.tap);

        // Name the file for what the payload actually is; on the Next the
        // TAP is translated to the artifact the emulator runs (tapDownload.js).
        const {bytes, ext} = tapDownloadFile(data, machine);

        const blob = new Blob([bytes], {type: 'application/octet-stream'});
        const objURL = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.download = `${title}.${ext}`;
        link.href = objURL;
        link.click();
    } catch (e) {
        // e.g. a program the Next translator cannot convert — same surfacing
        // as the run path (jsspeccy handleOpenTAPFileActions).
        alert(e && e.message ? e.message : String(e));
    }
}

function* handleRunTapActions(action) {
    store.dispatch(loadTap(action.tap, action.sdFiles));
}

// -----------------------------------------------------------------------------
// Supporting code
// -----------------------------------------------------------------------------

// The 8bitworkshop worker compiles projects. Its URL is content-versioned via
// the asset manifest (resolved async), so the worker is created behind a
// promise; consumers await workerReady before touching it. A module-level
// message handler lets the event channel (below) subscribe before the worker
// exists.
let worker = null;
let onWorkerMessage = null;
const workerReady = assetUrl('/dist/8bitworker.js').then((url) => {
    worker = new Worker(url);
    worker.onmessage = (e) => { if (onWorkerMessage) onWorkerMessage(e); };
    // Preload tools.
    console.log('Preloading 8bitworker tools');
    worker.postMessage({preload: 'sdcc'});
    worker.postMessage({preload: 'sdasz80'});
    worker.postMessage({preload: 'zmac'});
    return worker;
});

function postMessage(msg) {
    workerReady.then((w) => w.postMessage(msg));
}

function getWorkerMessagesEventChannel() {
    return eventChannel(emit => {

        // Emits data from worker message events (routed through workerReady's
        // handler so this works whether or not the worker exists yet).
        onWorkerMessage = (e) => {
            emit({data: e.data});
        };

        // Must return an unsubscribe function.
        return () => {
            onWorkerMessage = null;
        };
    })
}
