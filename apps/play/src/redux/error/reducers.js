import {actionTypes} from "./actions";

// -----------------------------------------------------------------------------
// Initial state
// -----------------------------------------------------------------------------

/**
 * @type {{
 * msg: string,
 * }}
 */
const initialState = {
    msg: undefined
};

// -----------------------------------------------------------------------------
// Actions
// -----------------------------------------------------------------------------

function reset() {
    return {...initialState};
}

function error(state, action) {
    return {
        ...state,
        msg: action.msg
    };
}

// -----------------------------------------------------------------------------
// Reducer
// -----------------------------------------------------------------------------

const actionsMap = {
    [actionTypes.reset]: reset,
    [actionTypes.error]: error,
    ['@@router/ON_LOCATION_CHANGED']: reset,
};

export default function reducer(state = initialState, action) {
    const reducerFunction = actionsMap[action.type];
    return reducerFunction ? reducerFunction(state, action) : state;
}
