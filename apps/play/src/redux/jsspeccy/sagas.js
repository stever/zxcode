import {take, takeLatest, put, call, select} from "redux-saga/effects";
import {eventChannel} from "redux-saga";
import queryString from "query-string";
import {JSSpeccy} from "@zxplay/emulator";
import {
    actionTypes,
    handleClick,
    openTAPFile,
    pause,
    reset,
    start
} from "./actions";
import {showActiveEmulator, actionTypes as appActionTypes} from "../app/actions";
import {handleException} from "../../errors";

// -----------------------------------------------------------------------------
// Action watchers
// -----------------------------------------------------------------------------

// noinspection JSUnusedGlobalSymbols
export function* watchForRenderEmulatorActions() {
    yield takeLatest(actionTypes.renderEmulator, handleRenderEmulatorActions);
}

// noinspection JSUnusedGlobalSymbols
export function* watchForLoadEmulatorActions() {
    yield takeLatest(actionTypes.loadEmulator, handleLoadEmulatorActions);
}

// noinspection JSUnusedGlobalSymbols
export function* watchForLoadTapActions() {
    yield takeLatest(actionTypes.loadTap, handleLoadTapActions);
}

// noinspection JSUnusedGlobalSymbols
export function* watchForClickEvents() {
    const chan = yield call(getClickEventChannel);
    try {
        while (true) {
            const e = yield take(chan);
            yield put(handleClick(e));
        }
    } finally {
        chan.close();
    }
}

// noinspection JSUnusedGlobalSymbols
export function* watchForHandleClickActions() {
    yield takeLatest(actionTypes.handleClick, handleClickActions);
}

// noinspection JSUnusedGlobalSymbols
export function* watchForResetActions() {
    yield takeLatest(actionTypes.reset, handleResetActions);
}

// noinspection JSUnusedGlobalSymbols
export function* watchForPauseActions() {
    yield takeLatest(actionTypes.pause, handlePauseActions);
}

// noinspection JSUnusedGlobalSymbols
export function* watchForStartActions() {
    yield takeLatest(actionTypes.start, handleStartActions);
}

// noinspection JSUnusedGlobalSymbols
export function* watchForExitActions() {
    yield takeLatest(actionTypes.exit, handleExitActions);
}

// noinspection JSUnusedGlobalSymbols
export function* watchForOpenFileDialogActions() {
    yield takeLatest(actionTypes.showOpenFileDialog, handleOpenFileDialogActions);
}

// noinspection JSUnusedGlobalSymbols
export function* watchForSetZoomActions() {
    yield takeLatest(actionTypes.setZoom, handleSetZoomActions);
}

// noinspection JSUnusedGlobalSymbols
export function* watchForViewFullScreenActions() {
    yield takeLatest(actionTypes.viewFullScreen, handleViewFullScreenActions);
}

// noinspection JSUnusedGlobalSymbols
export function* watchForOpenTAPFileActions() {
    yield takeLatest(actionTypes.openTAPFile, handleOpenTAPFileActions);
}

// noinspection JSUnusedGlobalSymbols
export function* watchForOpenUrlActions() {
    yield takeLatest(actionTypes.openUrl, handleOpenUrlActions);
}

// noinspection JSUnusedGlobalSymbols
export function* watchForLocationChanges() {
    yield takeLatest('@@router/ON_LOCATION_CHANGED', handleLocationChanges);
}

// noinspection JSUnusedGlobalSymbols
export function* watchForSetMachineActions() {
    yield takeLatest(appActionTypes.setMachine, handleSetMachineActions);
}

// -----------------------------------------------------------------------------
// Action handlers
// -----------------------------------------------------------------------------

function* handleRenderEmulatorActions(action) {
    try {
        const zoom = action.zoom || 2;
        const width = zoom * 320;

        console.assert(target === undefined);
        target = document.createElement('div');
        // Wrap the emulator's own (zoom-sized) container rather than pinning a
        // fixed width, so the responsive layout can size the screen via setZoom.
        target.style.width = 'fit-content';
        target.style.margin = '0px';
        target.style.backgroundColor = '#fff';

        // Boot with the selected machine: the "m" query parameter (incl. Pentagon
        // m=5) if present, otherwise the persisted menu choice, else the default.
        const machine = yield select((state) => state?.app.machine);

        const emuParams = {
            zoom,
            machine: machine || 48, // 48, 128 or 5 (Pentagon)
            autoLoadTapes: true,
            // Route fetches for allowlisted non-CORS hosts through our own origin
            // (Caddy in prod, webpack devServer.proxy in dev) so they aren't
            // blocked by the browser.
            corsProxyBase: '/cors'
        };

        let doFilter = false;

        const parsed = queryString.parse(location.search);

        if (parsed.u) {
            emuParams.openUrl = parsed.u;
        }

        if (parsed.f && parsed.f !== '0') {
            doFilter = true;
        }

        if (parsed.a && parsed.a === '0') {
            emuParams.autoLoadTapes = false;
        }

        console.assert(jsspeccy === undefined);
        jsspeccy = JSSpeccy(target, emuParams);
        jsspeccy.hideUI();

        if (doFilter) {
            // TODO: Investigate this option, and narrow the element selector.
            document.getElementsByTagName('canvas')[0].style.imageRendering = "auto";
        }
    } catch (e) {
        handleException(e);
    }
}

function* handleLoadEmulatorActions(action) {
    try {
        console.assert(action.target, 'no action target to append fragment to');
        console.assert(target, 'no target to append to fragment');
        const fragment = document.createDocumentFragment();
        fragment.appendChild(target);
        action.target.appendChild(fragment);
        // Apply any zoom requested before the emulator finished mounting.
        if (jsspeccy && currentZoom && !document.fullscreenElement) {
            jsspeccy.setZoom(currentZoom);
        }
    } catch (e) {
        handleException(e);
    }
}

function* handleLoadTapActions(action) {
    try {
        yield put(showActiveEmulator());
        yield put(reset());
        yield put(start());
        yield put(openTAPFile(action.tap.buffer));
    } catch (e) {
        handleException(e);
    }
}

function* handleClickActions(action) {
    try {
        const target = action.e.target;

        const screenElem = document.getElementById('jsspeccy-screen');
        if (screenElem?.contains(target)) {
            return;
        }

        const keysElem = document.getElementById('virtkeys');
        if (keysElem?.contains(target)) {
            return;
        }

        // Clicks anywhere except screen or keys to pause emulator.
        yield put(pause());
    } catch (e) {
        handleException(e);
    }
}

function* handleResetActions(_) {
    try {
        jsspeccy.reset();
        setTimeout(() => jsspeccy.start(), 100);
    } catch (e) {
        handleException(e);
    }
}

function* handlePauseActions(_) {
    try {
        jsspeccy.pause();
    } catch (e) {
        handleException(e);
    }
}

function* handleStartActions(_) {
    try {
        jsspeccy.start();
    } catch (e) {
        handleException(e);
    }
}

function* handleExitActions(_) {
    try {
        jsspeccy.exit();
    } catch (e) {
        handleException(e);
    }
}

function* handleOpenFileDialogActions(_) {
    try {
        yield put(showActiveEmulator());
        jsspeccy.openFileDialog();
    } catch (e) {
        handleException(e);
    }
}

function* handleSetZoomActions(action) {
    try {
        // Remember the requested zoom so it can be re-applied once the emulator
        // is mounted (loadEmulator), in case it isn't ready yet.
        currentZoom = action.zoom;
        if (!jsspeccy) return;
        // setZoom would drop out of fullscreen, so leave the size alone while the
        // user is in fullscreen mode.
        if (document.fullscreenElement) return;
        jsspeccy.setZoom(action.zoom);
    } catch (e) {
        handleException(e);
    }
}

function* handleViewFullScreenActions(_) {
    try {
        jsspeccy.start();
        jsspeccy.enterFullscreen();
    } catch (e) {
        handleException(e);
    }
}

function* handleOpenTAPFileActions(action) {
    try {
        jsspeccy.openTAPFile(action.buffer);
    } catch (e) {
        handleException(e);
    }
}

function* handleOpenUrlActions(action) {
    try {
        jsspeccy.reset();
        setTimeout(() => jsspeccy.start(), 100);
        setTimeout(() => jsspeccy.openUrl(action.url), 100);
    } catch (e) {
        handleException(e);
    }
}

function* handleSetMachineActions(action) {
    try {
        // jsspeccy may not be rendered yet; the redux state still records the
        // choice so the menu reflects it and the emulator boots with it later.
        if (!jsspeccy) return;
        jsspeccy.setMachine(action.machine);
        // Switching model leaves the machine running mid-execution under the new
        // ROM/paging, so cold-boot the selected machine like the menu-bar Reset.
        yield put(reset());
    } catch (e) {
        handleException(e);
    }
}

function* handleLocationChanges(action) {
    try {
        const path = action.payload.location.pathname;
        const match = typeof previousPath === 'undefined' || path === previousPath;

        if (!match || (path !== '/' && !path.startsWith('/projects/'))) {
            // NOTE: Using a timeout to pause to work around an issue where the emulator is
            // un-paused while on the new project screen entering the project.
            // TODO: There might be a better way to resolve this issue.
            // For example, avoiding start the emulator on clicking the menu/submenus.
            setTimeout(() => jsspeccy?.pause(), 100);
        }

        previousPath = path;
    } catch (e) {
        handleException(e);
    }
}

// -----------------------------------------------------------------------------
// Supporting code
// -----------------------------------------------------------------------------

let target = undefined;
let jsspeccy = undefined;
let previousPath = undefined;
let currentZoom = undefined;

function getClickEventChannel() {
    return eventChannel(emit => {
        const emitter = (e) => emit(e);
        window.addEventListener('click', emitter);
        return () => {
            // Must return an unsubscribe function.
            window.removeEventListener('click', emitter);
        }
    })
}
