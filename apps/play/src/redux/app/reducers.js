import {actionTypes} from "./actions";

// -----------------------------------------------------------------------------
// Initial state
// -----------------------------------------------------------------------------

const initialState = {
    privacyPolicy: undefined,
    termsOfUse: undefined
};

// -----------------------------------------------------------------------------
// Actions
// -----------------------------------------------------------------------------

function receivePrivacyPolicy(state, action) {
    return {
        ...state,
        privacyPolicy: action.text
    }
}

function receiveTermsOfUse(state, action) {
    return {
        ...state,
        termsOfUse: action.text
    }
}

// -----------------------------------------------------------------------------
// Reducer
// -----------------------------------------------------------------------------

const actionsMap = {
    [actionTypes.receivePrivacyPolicy]: receivePrivacyPolicy,
    [actionTypes.receiveTermsOfUse]: receiveTermsOfUse,
};

export default function reducer(state = initialState, action) {
    const reducerFunction = actionsMap[action.type];
    return reducerFunction ? reducerFunction(state, action) : state;
}
