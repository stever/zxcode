export const actionTypes = {
    showActiveEmulator: 'app/showActiveEmulator',
    resetEmulator: 'app/resetEmulator',
    requestTermsOfUse: 'app/requestTermsOfUse',
    receiveTermsOfUse: 'app/receiveTermsOfUse',
    requestPrivacyPolicy: 'app/requestPrivacyPolicy',
    receivePrivacyPolicy: 'app/receivePrivacyPolicy',
    toggleLineNumbers: 'app/toggleLineNumbers',
    toggleBreakpointGutter: 'app/toggleBreakpointGutter',
    setKeyboardLayout: 'app/setKeyboardLayout',
    setMachine: 'app/setMachine',
    machineChanged: 'app/machineChanged',
    setJoystick: 'app/setJoystick',
    joystickChanged: 'app/joystickChanged',
};

export const showActiveEmulator = () => ({
    type: actionTypes.showActiveEmulator
})

export const resetEmulator = () => ({
    type: actionTypes.resetEmulator
})

export const requestTermsOfUse = () => ({
    type: actionTypes.requestTermsOfUse
})

export const receiveTermsOfUse = (text) => ({
    type: actionTypes.receiveTermsOfUse,
    text
})

export const requestPrivacyPolicy = () => ({
    type: actionTypes.requestPrivacyPolicy
})

export const receivePrivacyPolicy = (text) => ({
    type: actionTypes.receivePrivacyPolicy,
    text
})

export const toggleLineNumbers = (enabled) => ({
    type: actionTypes.toggleLineNumbers,
    enabled
})

export const toggleBreakpointGutter = (enabled) => ({
    type: actionTypes.toggleBreakpointGutter,
    enabled
})

// Which on-screen keyboard is drawn: 'auto' follows the machine, and the three
// layout names pin one. What you are building for and what the program you are
// running expects are not always the same keyboard.
export const setKeyboardLayout = (layout) => ({
    type: actionTypes.setKeyboardLayout,
    layout
});

export const setMachine = (machine) => ({
    type: actionTypes.setMachine,
    machine
});

// State-only mirror of an engine-initiated machine switch (e.g. opening a
// .tap on the Next auto-switches to the 128K): updates the menu checkmark
// and persisted choice WITHOUT re-triggering the boot saga.
export const machineChanged = (machine) => ({
    type: actionTypes.machineChanged,
    machine
})

// Which joystick interface the host gamepad drives. Games read exactly one
// and there is no way to detect which, so it is the user's choice.
export const setJoystick = (joystick) => ({
    type: actionTypes.setJoystick,
    joystick
});

// State-only mirror of an engine-initiated change, matching machineChanged.
export const joystickChanged = (joystick) => ({
    type: actionTypes.joystickChanged,
    joystick
})
