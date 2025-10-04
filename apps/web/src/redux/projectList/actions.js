export const actionTypes = {
    reset: 'projectList/reset',
    subscribeToProjectList: 'projectList/subscribeToProjectList',
    subscribeToProjectListCallback: 'projectList/subscribeToProjectListCallback',
    unsubscribeFromProjectList: 'projectList/unsubscribeFromProjectList',
    receiveprojectListQueryResult: 'projectList/receiveprojectListQueryResult',
    setProjectListPreferences: 'projectList/setProjectListPreferences',
};

export const reset = () => ({
    type: actionTypes.reset
});

export const subscribeToProjectList = () => ({
    type: actionTypes.subscribeToProjectList
});

export const subscribeToProjectListCallback = (error, data) => ({
    type: actionTypes.subscribeToProjectListCallback,
    error, data
});

export const unsubscribeFromProjectList = () => ({
    type: actionTypes.unsubscribeFromProjectList
});

export const receiveprojectListQueryResult = (result) => ({
    type: actionTypes.receiveprojectListQueryResult,
    result
});

export const setProjectListPreferences = (preferences) => ({
    type: actionTypes.setProjectListPreferences,
    preferences
});
