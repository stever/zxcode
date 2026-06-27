export const actionTypes = {
    renderEmulator: 'jsspeccy/renderEmulator',
    loadEmulator: 'jsspeccy/loadEmulator',
    loadTap: 'jsspeccy/loadTap',
    handleClick: 'jsspeccy/handleClick',
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

export const loadTap = (tap) => ({
    type: actionTypes.loadTap,
    tap
});

export const handleClick = (e) => ({
    type: actionTypes.handleClick,
    e
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

export const openTAPFile = (buffer) => ({
    type: actionTypes.openTAPFile,
    buffer
});

export const openUrl = (url) => ({
    type: actionTypes.openUrl,
    url
});
