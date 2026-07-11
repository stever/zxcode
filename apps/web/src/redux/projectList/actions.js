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
    subscribeToFolderList: 'projectList/subscribeToFolderList',
    subscribeToFolderListCallback: 'projectList/subscribeToFolderListCallback',
    unsubscribeFromFolderList: 'projectList/unsubscribeFromFolderList',
    receiveFolderListQueryResult: 'projectList/receiveFolderListQueryResult',
    createFolder: 'projectList/createFolder',
    updateFolder: 'projectList/updateFolder',
    deleteFolder: 'projectList/deleteFolder',
    moveProjectToFolder: 'projectList/moveProjectToFolder',
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

// The folder subscription mirrors the project list one: the server pushes a
// fresh folder list whenever any of the caller's projects or folders change.

export const subscribeToFolderList = () => ({
    type: actionTypes.subscribeToFolderList
});

export const subscribeToFolderListCallback = (error, data) => ({
    type: actionTypes.subscribeToFolderListCallback,
    error, data
});

export const unsubscribeFromFolderList = () => ({
    type: actionTypes.unsubscribeFromFolderList
});

export const receiveFolderListQueryResult = (result) => ({
    type: actionTypes.receiveFolderListQueryResult,
    result
});

export const createFolder = (name, isPublic) => ({
    type: actionTypes.createFolder,
    name, isPublic
});

// changes: {name?, is_public?} — only the provided fields are updated.
export const updateFolder = (folderId, changes) => ({
    type: actionTypes.updateFolder,
    folderId, changes
});

export const deleteFolder = (folderId) => ({
    type: actionTypes.deleteFolder,
    folderId
});

// folderId null unfiles the project.
export const moveProjectToFolder = (projectId, folderId) => ({
    type: actionTypes.moveProjectToFolder,
    projectId, folderId
});
