export const actionTypes = {
    showActiveEmulator: 'app/showActiveEmulator',
    resetEmulator: 'app/resetEmulator',
    requestTermsOfUse: 'app/requestTermsOfUse',
    receiveTermsOfUse: 'app/receiveTermsOfUse',
    requestPrivacyPolicy: 'app/requestPrivacyPolicy',
    receivePrivacyPolicy: 'app/receivePrivacyPolicy',
    toggleLineNumbers: 'app/toggleLineNumbers',
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
