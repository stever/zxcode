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

function getWindowResizeEventChannel() {
    return eventChannel((emit) => {
        const emitter = () => {
            emit({
                width: window.innerWidth,
                height: window.innerHeight,
            });
        };

        window.addEventListener('resize', emitter);

        return () => {
            // Must return an unsubscribe function.
            window.removeEventListener('resize', emitter);
        };
    });
}
