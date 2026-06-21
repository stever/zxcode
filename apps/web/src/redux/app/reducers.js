import {actionTypes} from "./actions";

// -----------------------------------------------------------------------------
// Initial state
// -----------------------------------------------------------------------------

// Load the persisted line numbers preference if available
const loadLineNumbers = () => {
    try {
        const saved = localStorage.getItem('lineNumbers');
        if (saved !== null) {
            return saved === 'true';
        }
    } catch (e) {
        console.error('Failed to load line numbers preference:', e);
    }
    return false;
};

const initialState = {
    privacyPolicy: undefined,
    termsOfUse: undefined,
    lineNumbers: loadLineNumbers()
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
    try {
        localStorage.setItem('lineNumbers', String(action.enabled));
    } catch (e) {
        console.error('Failed to save line numbers preference:', e);
    }
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
