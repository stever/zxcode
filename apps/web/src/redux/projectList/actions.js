export const actionTypes = {
    reset: 'projectList/reset',
    subscribeToProjectList: 'projectList/subscribeToProjectList',
    subscribeToProjectListCallback: 'projectList/subscribeToProjectListCallback',
    unsubscribeFromProjectList: 'projectList/unsubscribeFromProjectList',
    receiveprojectListQueryResult: 'projectList/receiveprojectListQueryResult',
    setProjectListPreferences: 'projectList/setProjectListPreferences',
    renameListProject: 'projectList/renameListProject',
    copyListProject: 'projectList/copyListProject',
    deleteListProject: 'projectList/deleteListProject',
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

// List-scoped project actions. These deliberately do NOT touch the editor's
// project state or navigate anywhere: the browser's live subscription
// reflects the change, so the user stays where they are.

export const renameListProject = (projectId, currentSlug, title, slug) => ({
    type: actionTypes.renameListProject,
    projectId, currentSlug, title, slug
});

export const copyListProject = (projectId, title) => ({
    type: actionTypes.copyListProject,
    projectId, title
});

export const deleteListProject = (projectId) => ({
    type: actionTypes.deleteListProject,
    projectId
});
