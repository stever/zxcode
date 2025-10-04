import {actionTypes} from "./actions";

// -----------------------------------------------------------------------------
// Initial state
// -----------------------------------------------------------------------------

const initialState = {
    userId: undefined,
    userSlug: undefined,
};

// -----------------------------------------------------------------------------
// Actions
// -----------------------------------------------------------------------------

function setUserInfo(state, action) {
    return {
        ...state,
        userId: action.userInfo.userId,
        userSlug: action.userInfo.userSlug,
    };
}

// -----------------------------------------------------------------------------
// Reducer
// -----------------------------------------------------------------------------

const actionsMap = {
    [actionTypes.setUserInfo]: setUserInfo,
};

export default function reducer(state = initialState, action) {
    const reducerFunction = actionsMap[action.type];
    return reducerFunction ? reducerFunction(state, action) : state;
}
