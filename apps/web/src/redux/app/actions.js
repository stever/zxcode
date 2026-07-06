export const actionTypes = {
    showActiveEmulator: 'app/showActiveEmulator',
    resetEmulator: 'app/resetEmulator',
    requestTermsOfUse: 'app/requestTermsOfUse',
    receiveTermsOfUse: 'app/receiveTermsOfUse',
    requestPrivacyPolicy: 'app/requestPrivacyPolicy',
    receivePrivacyPolicy: 'app/receivePrivacyPolicy',
    toggleLineNumbers: 'app/toggleLineNumbers',
    setMachine: 'app/setMachine',
    machineChanged: 'app/machineChanged',
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
