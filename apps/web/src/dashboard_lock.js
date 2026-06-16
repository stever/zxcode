import {hideLoading} from "./dashboard_loading";

export function dashboardLock() {
    const elems = document.getElementsByClassName('dashboard-lock-screen');
    for (let i = 0; i < elems.length; i++) {
        const elem = elems[i];
        elem.style.display = '';
    }
}

export function dashboardUnlock() {
    const elems = document.getElementsByClassName('dashboard-lock-screen');
    for (let i = 0; i < elems.length; i++) {
        const elem = elems[i];
        elem.style.display = 'none';
    }

    // The run-program overlay (with spinner) is shown only on run paths, but is
    // torn down here so it can't be stranded by any lock-release site.
    hideLoading();
}
