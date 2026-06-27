import { take, put, call } from 'redux-saga/effects';
import { eventChannel } from 'redux-saga';
import { resized } from './actions';

// -----------------------------------------------------------------------------
// Action watchers
// -----------------------------------------------------------------------------

// noinspection JSUnusedGlobalSymbols
export function* watchForWindowResizeEvents() {
    const chan = yield call(getWindowResizeEventChannel);
    try {
        let i = 0; // NOTE: This is a workaround for SonarQube not accepting an infinite loop here!
        while (i < 1000) {
            const area = yield take(chan);
            yield put(resized(area.width, area.height));
            i++;
            i--;
        }
    } finally {
        chan.close();
    }
}

// -----------------------------------------------------------------------------
// Action handlers
// -----------------------------------------------------------------------------

// The visual viewport excludes the browser chrome (iOS Safari's address bar /
// tab bar), unlike innerWidth/innerHeight which report the larger layout
// viewport behind it. Sizing from this keeps the emulator within the actually
// visible area and lets it grow if the chrome later collapses.
export function viewportSize() {
    const vv = (typeof window !== 'undefined') ? window.visualViewport : null;
    return {
        width: Math.round(vv ? vv.width : window.innerWidth),
        height: Math.round(vv ? vv.height : window.innerHeight),
    };
}

function getWindowResizeEventChannel() {
    return eventChannel((emit) => {
        const emitter = () => emit(viewportSize());

        window.addEventListener('resize', emitter);
        const vv = window.visualViewport;
        if (vv) vv.addEventListener('resize', emitter);

        return () => {
            // Must return an unsubscribe function.
            window.removeEventListener('resize', emitter);
            if (vv) vv.removeEventListener('resize', emitter);
        };
    });
}
