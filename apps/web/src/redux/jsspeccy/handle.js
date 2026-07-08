// The mounted JSSpeccy emulator handle, for modules that drive it directly
// (the debugger session adapter). Lives outside sagas.js because store.js
// calls every export of a sagas module as a saga.

let handle = undefined;

export function setJsspeccy(jsspeccy) {
    handle = jsspeccy;
}

export function getJsspeccy() {
    return handle;
}
