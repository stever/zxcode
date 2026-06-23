import queryString from "query-string";
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

const MACHINE_KEY = 'machine';

const parseMachine = (value) => {
    if (value === '128' || value === 128) return 128;
    if (value === '5' || value === 5) return 5;
    if (value === '48' || value === 48) return 48;
    return undefined;
};

// The "m" query parameter overrides and locks the choice; otherwise use the
// persisted preference, falling back to the 48K default.
const loadMachineState = () => {
    try {
        const fromUrl = parseMachine(queryString.parse(location.search).m);
        if (fromUrl !== undefined) {
            return {machine: fromUrl, machineLocked: true};
        }
    } catch (e) {
        console.error('Failed to read machine query parameter:', e);
    }
    try {
        const saved = parseMachine(localStorage.getItem(MACHINE_KEY));
        if (saved !== undefined) {
            return {machine: saved, machineLocked: false};
        }
    } catch (e) {
        console.error('Failed to load machine preference:', e);
    }
    return {machine: 48, machineLocked: false};
};

const machineState = loadMachineState();

const initialState = {
    privacyPolicy: undefined,
    termsOfUse: undefined,
    lineNumbers: loadLineNumbers(),
    machine: machineState.machine,
    machineLocked: machineState.machineLocked
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

function setMachine(state, action) {
    if (state.machineLocked) return state;
    try {
        localStorage.setItem(MACHINE_KEY, String(action.machine));
    } catch (e) {
        console.error('Failed to save machine preference:', e);
    }
    return {
        ...state,
        machine: action.machine
    }
}

// -----------------------------------------------------------------------------
// Reducer
// -----------------------------------------------------------------------------

const actionsMap = {
    [actionTypes.receivePrivacyPolicy]: receivePrivacyPolicy,
    [actionTypes.receiveTermsOfUse]: receiveTermsOfUse,
    [actionTypes.toggleLineNumbers]: toggleLineNumbers,
    [actionTypes.setMachine]: setMachine,
};

export default function reducer(state = initialState, action) {
    const reducerFunction = actionsMap[action.type];
    return reducerFunction ? reducerFunction(state, action) : state;
}
