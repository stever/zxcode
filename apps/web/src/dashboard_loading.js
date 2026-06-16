export function showLoading() {
    const elems = document.getElementsByClassName('dashboard-loading-screen');
    for (let i = 0; i < elems.length; i++) {
        const elem = elems[i];
        elem.style.visibility = 'visible';
        elem.style.opacity = '1';
    }
}

export function hideLoading() {
    const elems = document.getElementsByClassName('dashboard-loading-screen');
    for (let i = 0; i < elems.length; i++) {
        const elem = elems[i];
        elem.style.opacity = '0';
        setTimeout(() => elem.style.visibility = '', 400);
    }
}
