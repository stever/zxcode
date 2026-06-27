import { actionTypes } from './actions';
import { viewportSize } from './sagas';

const mobileMaxWidth = 768;

// -----------------------------------------------------------------------------
// Initial state
// -----------------------------------------------------------------------------

const initial = viewportSize();

const initialState = {
    width: initial.width,
    height: initial.height,
    isMobile: initial.width <= mobileMaxWidth,
};

// -----------------------------------------------------------------------------
// Actions
// -----------------------------------------------------------------------------

function resized(state, action) {
    return {
        ...state,
        width: action.width,
        height: action.height,
        isMobile: action.width <= mobileMaxWidth,
    };
}

// -----------------------------------------------------------------------------
// Reducer
// -----------------------------------------------------------------------------

const actionsMap = {
    [actionTypes.resized]: resized,
};

export default function reducer(state = initialState, action) {
    const reducerFunction = actionsMap[action.type];
    return reducerFunction ? reducerFunction(state, action) : state;
}
