import queryString from "query-string";
import {actionTypes} from "./actions";

// -----------------------------------------------------------------------------
// Initial state
// -----------------------------------------------------------------------------

// Gutters (line numbers, breakpoints) are on by default; the toggles are
// opt-outs, so absence of a saved preference means visible.
const loadLineNumbers = () => {
    try {
        const saved = localStorage.getItem('lineNumbers');
        if (saved !== null) {
            return saved === 'true';
        }
    } catch (e) {
        console.error('Failed to load line numbers preference:', e);
    }
    return true;
};

const loadBreakpointGutter = () => {
    try {
        const saved = localStorage.getItem('breakpointGutter');
        if (saved !== null) {
            return saved === 'true';
        }
    } catch (e) {
        console.error('Failed to load breakpoint gutter preference:', e);
    }
    return true;
};

const MACHINE_KEY = 'machine';
const JOYSTICK_KEY = 'joystick';

// Joystick interfaces the host gamepad can drive. A game reads exactly one
// and there is no way to detect which, so the user picks. Kempston is the
// default: it is the commonest interface, and the emulator fits it on every
// machine, so it is never a wrong-but-harmful choice.
const JOYSTICK_TYPES = ['Kempston', 'Sinclair1', 'Sinclair2', 'Cursor'];

const loadJoystick = () => {
    try {
        const saved = localStorage.getItem(JOYSTICK_KEY);
        if (JOYSTICK_TYPES.includes(saved)) return saved;
    } catch (e) {
        console.error('Failed to load joystick preference:', e);
    }
    return 'Kempston';
};

const parseMachine = (value) => {
    if (value === '128' || value === 128) return 128;
    if (value === 'next') return 'next';
    // Pentagon (5) support was dropped with the JSSpeccy3 engine; treat old
    // saved/linked values as the closest supported machine.
    if (value === '5' || value === 5) return 128;
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
    breakpointGutter: loadBreakpointGutter(),
    machine: machineState.machine,
    machineLocked: machineState.machineLocked,
    joystick: loadJoystick()
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

function toggleBreakpointGutter(state, action) {
    try {
        localStorage.setItem('breakpointGutter', String(action.enabled));
    } catch (e) {
        console.error('Failed to save breakpoint gutter preference:', e);
    }
    return {
        ...state,
        breakpointGutter: action.enabled
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

function setJoystick(state, action) {
    if (!JOYSTICK_TYPES.includes(action.joystick)) return state;
    try {
        localStorage.setItem(JOYSTICK_KEY, action.joystick);
    } catch (e) {
        console.error('Failed to save joystick preference:', e);
    }
    return {
        ...state,
        joystick: action.joystick
    }
}

const actionsMap = {
    [actionTypes.receivePrivacyPolicy]: receivePrivacyPolicy,
    [actionTypes.receiveTermsOfUse]: receiveTermsOfUse,
    [actionTypes.toggleLineNumbers]: toggleLineNumbers,
    [actionTypes.toggleBreakpointGutter]: toggleBreakpointGutter,
    [actionTypes.setMachine]: setMachine,
    [actionTypes.machineChanged]: setMachine,
    [actionTypes.setJoystick]: setJoystick,
    [actionTypes.joystickChanged]: setJoystick,
};

export default function reducer(state = initialState, action) {
    const reducerFunction = actionsMap[action.type];
    return reducerFunction ? reducerFunction(state, action) : state;
}
