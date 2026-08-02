export const actionTypes = {
    showActiveEmulator: 'app/showActiveEmulator',
    resetEmulator: 'app/resetEmulator',
    requestTermsOfUse: 'app/requestTermsOfUse',
    receiveTermsOfUse: 'app/receiveTermsOfUse',
    requestPrivacyPolicy: 'app/requestPrivacyPolicy',
    receivePrivacyPolicy: 'app/receivePrivacyPolicy',
    setMachine: 'app/setMachine',
    machineChanged: 'app/machineChanged',
    setKeyboardSide: 'app/setKeyboardSide',
    setKeyboardLayout: 'app/setKeyboardLayout',
    setJoystick: 'app/setJoystick',
    joystickChanged: 'app/joystickChanged',
};

export const showActiveEmulator = () => ({
    type: actionTypes.showActiveEmulator
})

export const resetEmulator = () => ({
    type: actionTypes.resetEmulator
})

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

export const setKeyboardSide = (side) => ({
    type: actionTypes.setKeyboardSide,
    side
})

// Which on-screen keyboard is drawn: 'auto' follows the machine, and the three
// layout names pin one. A machine can be running something its own keyboard
// does not suit, so the choice stays with the player.
export const setKeyboardLayout = (layout) => ({
    type: actionTypes.setKeyboardLayout,
    layout
})

// Which joystick interface the host gamepad drives. Games read exactly one
// and there is no way to detect which, so it is the player's choice.
export const setJoystick = (joystick) => ({
    type: actionTypes.setJoystick,
    joystick
});

// State-only mirror of an engine-initiated change, matching machineChanged:
// updates the menu checkmark without driving the emulator back.
export const joystickChanged = (joystick) => ({
    type: actionTypes.joystickChanged,
    joystick
})
