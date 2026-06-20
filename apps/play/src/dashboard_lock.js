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
}
