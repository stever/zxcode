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
