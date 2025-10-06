import {actionTypes} from "./actions";

// -----------------------------------------------------------------------------
// Initial state
// -----------------------------------------------------------------------------

const initialState = {
    privacyPolicy: undefined,
    termsOfUse: undefined,
    lineNumbers: false
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

function toggleLineNumbers(state, action) {
    return {
        ...state,
        lineNumbers: action.enabled
    }
}

// -----------------------------------------------------------------------------
// Reducer
// -----------------------------------------------------------------------------

const actionsMap = {
    [actionTypes.receivePrivacyPolicy]: receivePrivacyPolicy,
    [actionTypes.receiveTermsOfUse]: receiveTermsOfUse,
    [actionTypes.toggleLineNumbers]: toggleLineNumbers,
};

export default function reducer(state = initialState, action) {
    const reducerFunction = actionsMap[action.type];
    return reducerFunction ? reducerFunction(state, action) : state;
}
