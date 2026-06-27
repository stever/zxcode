import queryString from "query-string";
import {actionTypes} from "./actions";
import {parseKeyConfig} from "../../lib/layout";

// -----------------------------------------------------------------------------
// Initial state
// -----------------------------------------------------------------------------

const MACHINE_KEY = 'machine';
const KEYBOARD_SIDE_KEY = 'keyboardSide';

// Full ZX Spectrum keyboard. Games may override the keys (and rows) via the "k"
// query parameter.
const DEFAULT_KEYSTR = '1234567890,QWERTYUIOP,ASDFGHJKLe,cZXCVBNMs_';

// The "k" query parameter overrides the on-screen keys; otherwise the full
// keyboard is shown.
const loadKeyConfig = () => {
    try {
        const fromUrl = queryString.parse(location.search).k;
        if (typeof fromUrl === 'string' && fromUrl.length > 0) {
            return parseKeyConfig(fromUrl);
        }
    } catch (e) {
        console.error('Failed to read keys query parameter:', e);
    }
    return parseKeyConfig(DEFAULT_KEYSTR);
};

// Side the keyboard appears on in landscape: 'right' (right-handed, default) or
// 'left'. Persisted like the machine choice.
const loadKeyboardSide = () => {
    try {
        const saved = localStorage.getItem(KEYBOARD_SIDE_KEY);
        if (saved === 'left' || saved === 'right') return saved;
    } catch (e) {
        console.error('Failed to load keyboard side preference:', e);
    }
    return 'right';
};

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
    machine: machineState.machine,
    machineLocked: machineState.machineLocked,
    keyConfig: loadKeyConfig(),
    keyboardSide: loadKeyboardSide()
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

function setKeyboardSide(state, action) {
    if (action.side !== 'left' && action.side !== 'right') return state;
    try {
        localStorage.setItem(KEYBOARD_SIDE_KEY, action.side);
    } catch (e) {
        console.error('Failed to save keyboard side preference:', e);
    }
    return {
        ...state,
        keyboardSide: action.side
    }
}

// -----------------------------------------------------------------------------
// Reducer
// -----------------------------------------------------------------------------

const actionsMap = {
    [actionTypes.receivePrivacyPolicy]: receivePrivacyPolicy,
    [actionTypes.receiveTermsOfUse]: receiveTermsOfUse,
    [actionTypes.setMachine]: setMachine,
    [actionTypes.setKeyboardSide]: setKeyboardSide,
};

export default function reducer(state = initialState, action) {
    const reducerFunction = actionsMap[action.type];
    return reducerFunction ? reducerFunction(state, action) : state;
}
