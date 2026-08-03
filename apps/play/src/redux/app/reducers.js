import queryString from "query-string";
import {KEYBOARD_CHOICES} from "@zxplay/ui/keyboard";
import {actionTypes} from "./actions";
import {parseKeyConfig} from "../../lib/layout";

// -----------------------------------------------------------------------------
// Initial state
// -----------------------------------------------------------------------------

const MACHINE_KEY = 'machine';
const KEYBOARD_SIDE_KEY = 'keyboardSide';
const KEYBOARD_LAYOUT_KEY = 'keyboardLayout';
const PIXEL_PERFECT_KEY = 'pixelPerfect';
const JOYSTICK_KEY = 'joystick';

// Joystick interfaces the host gamepad can drive. A game reads exactly one
// and there is no way to detect which, so the player picks. Kempston is the
// default: it is the commonest interface, and the emulator fits the
// interface on every machine so it is never a wrong-but-harmful choice.
const JOYSTICK_TYPES = ['Kempston', 'Sinclair1', 'Sinclair2', 'Cursor'];

// Full ZX Spectrum keyboard. Games may override the keys (and rows) via the "k"
// query parameter.
const DEFAULT_KEYSTR = '1234567890,QWERTYUIOP,ASDFGHJKLe,cZXCVBNMs_';

// The "k" query parameter overrides the on-screen keys; otherwise the full
// keyboard is shown. `override` records which it was: a game's own key subset
// is kept whatever machine is selected, while the default keyboard follows the
// machine (see resolveKeyboard).
const loadKeyConfig = () => {
    try {
        const fromUrl = queryString.parse(location.search).k;
        if (typeof fromUrl === 'string' && fromUrl.length > 0) {
            return {...parseKeyConfig(fromUrl), override: true};
        }
    } catch (e) {
        console.error('Failed to read keys query parameter:', e);
    }
    return {...parseKeyConfig(DEFAULT_KEYSTR), override: false};
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

// Which keyboard is drawn: 'auto' (the machine's own) or one named outright.
// Persisted like the side it appears on.
const loadKeyboardLayout = () => {
    try {
        const saved = localStorage.getItem(KEYBOARD_LAYOUT_KEY);
        if (KEYBOARD_CHOICES.includes(saved)) return saved;
    } catch (e) {
        console.error('Failed to load keyboard layout preference:', e);
    }
    return 'auto';
};

// Draw the screen only at a whole scale of the display. Off unless it was
// turned on: filling the space is the better default for most screens, and
// this trades some of that space for pixels that are all the same size.
const loadPixelPerfect = () => {
    try {
        return localStorage.getItem(PIXEL_PERFECT_KEY) === 'true';
    } catch (e) {
        console.error('Failed to load pixel perfect preference:', e);
    }
    return false;
};

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
    machine: machineState.machine,
    machineLocked: machineState.machineLocked,
    keyConfig: loadKeyConfig(),
    keyboardSide: loadKeyboardSide(),
    keyboardLayout: loadKeyboardLayout(),
    pixelPerfect: loadPixelPerfect(),
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

function setKeyboardLayout(state, action) {
    if (!KEYBOARD_CHOICES.includes(action.layout)) return state;
    try {
        localStorage.setItem(KEYBOARD_LAYOUT_KEY, action.layout);
    } catch (e) {
        console.error('Failed to save keyboard layout preference:', e);
    }
    return {
        ...state,
        keyboardLayout: action.layout
    }
}

function setPixelPerfect(state, action) {
    const pixelPerfect = !!action.pixelPerfect;
    try {
        localStorage.setItem(PIXEL_PERFECT_KEY, String(pixelPerfect));
    } catch (e) {
        console.error('Failed to save pixel perfect preference:', e);
    }
    return {
        ...state,
        pixelPerfect
    }
}

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

// -----------------------------------------------------------------------------
// Reducer
// -----------------------------------------------------------------------------

const actionsMap = {
    [actionTypes.receivePrivacyPolicy]: receivePrivacyPolicy,
    [actionTypes.receiveTermsOfUse]: receiveTermsOfUse,
    [actionTypes.setMachine]: setMachine,
    [actionTypes.machineChanged]: setMachine,
    [actionTypes.setKeyboardSide]: setKeyboardSide,
    [actionTypes.setKeyboardLayout]: setKeyboardLayout,
    [actionTypes.setPixelPerfect]: setPixelPerfect,
    [actionTypes.setJoystick]: setJoystick,
    [actionTypes.joystickChanged]: setJoystick,
};

export default function reducer(state = initialState, action) {
    const reducerFunction = actionsMap[action.type];
    return reducerFunction ? reducerFunction(state, action) : state;
}
