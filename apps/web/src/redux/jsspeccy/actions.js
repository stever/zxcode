export const actionTypes = {
    renderEmulator: 'jsspeccy/renderEmulator',
    loadEmulator: 'jsspeccy/loadEmulator',
    loadTap: 'jsspeccy/loadTap',
    loadUrl: 'jsspeccy/loadUrl',
    reset: 'jsspeccy/reset',
    pause: 'jsspeccy/pause',
    start: 'jsspeccy/start',
    exit: 'jsspeccy/exit',
    showOpenFileDialog: 'jsspeccy/openFileDialog',
    setZoom: 'jsspeccy/setZoom',
    viewFullScreen: 'jsspeccy/viewFullScreen',
    openTAPFile: 'jsspeccy/openTAPFile',
    openUrl: 'jsspeccy/openUrl',
};

export const renderEmulator = (zoom) => ({
    type: actionTypes.renderEmulator,
    zoom
});

export const loadEmulator = (target) => ({
    type: actionTypes.loadEmulator,
    target
});

// sdFiles ([{name, data: Uint8Array}], optional) are project asset files
// staged onto the Next's SD card before the program runs, so it can LOAD
// them at runtime (see GoEmulator.stageSdFiles).
export const loadTap = (tap, sdFiles) => ({
    type: actionTypes.loadTap,
    tap,
    sdFiles
});

export const loadUrl = (url) => ({
    type: actionTypes.loadUrl,
    url
});

export const reset = () => ({
    type: actionTypes.reset
});

export const pause = () => ({
    type: actionTypes.pause
});

export const start = () => ({
    type: actionTypes.start
});

export const exit = () => ({
    type: actionTypes.exit
});

export const showOpenFileDialog = () => ({
    type: actionTypes.showOpenFileDialog
});

export const setZoom = (zoom) => ({
    type: actionTypes.setZoom,
    zoom
});

export const viewFullScreen = () => ({
    type: actionTypes.viewFullScreen
});

export const openTAPFile = (buffer, sdFiles) => ({
    type: actionTypes.openTAPFile,
    buffer,
    sdFiles
});

export const openUrl = (url) => ({
    type: actionTypes.openUrl,
    url
});
