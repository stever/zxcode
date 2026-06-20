export const actionTypes = {
    showActiveEmulator: 'app/showActiveEmulator',
    resetEmulator: 'app/resetEmulator',
    requestTermsOfUse: 'app/requestTermsOfUse',
    receiveTermsOfUse: 'app/receiveTermsOfUse',
    requestPrivacyPolicy: 'app/requestPrivacyPolicy',
    receivePrivacyPolicy: 'app/receivePrivacyPolicy',
};

export const showActiveEmulator = () => ({
    type: actionTypes.showActiveEmulator
})

export const resetEmulator = () => ({
    type: actionTypes.resetEmulator
})
