export const actionTypes = {
    showActiveEmulator: 'app/showActiveEmulator',
    resetEmulator: 'app/resetEmulator',
    requestTermsOfUse: 'app/requestTermsOfUse',
    receiveTermsOfUse: 'app/receiveTermsOfUse',
    requestPrivacyPolicy: 'app/requestPrivacyPolicy',
    receivePrivacyPolicy: 'app/receivePrivacyPolicy',
    setMachine: 'app/setMachine',
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
})

export const setKeyboardSide = (side) => ({
    type: actionTypes.setKeyboardSide,
    side
})
