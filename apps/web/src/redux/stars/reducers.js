import { actionTypes } from "./actions";

// -----------------------------------------------------------------------------
// Initial state
// -----------------------------------------------------------------------------

const initialState = {
    // Starred status for projects (keyed by projectId)
    starredStatus: {},
};

// -----------------------------------------------------------------------------
// Actions
// -----------------------------------------------------------------------------

function setStarredStatus(state, action) {
    return {
        ...state,
        starredStatus: {
            ...state.starredStatus,
            [action.projectId]: action.isStarred
        }
    };
}

// -----------------------------------------------------------------------------
// Reducer
// -----------------------------------------------------------------------------

const actionsMap = {
    [actionTypes.setStarredStatus]: setStarredStatus,
};

export default function reducer(state = initialState, action) {
    const reducerFunction = actionsMap[action.type];
    return reducerFunction ? reducerFunction(state, action) : state;
}
