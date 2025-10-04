export const actionTypes = {
    reset: 'project/reset',
    setSelectedTabIndex: 'project/setSelectedTabIndex',
    createNewProject: 'project/createNewProject',
    loadProject: 'project/loadProject',
    receiveLoadedProject: 'project/receiveLoadedProject',
    setCode: 'project/setCode',
    setSavedCode: 'project/setSavedCode',
    saveCodeChanges: 'project/saveCodeChanges',
    deleteProject: 'project/deleteProject',
    renameProject: 'project/renameProject',
    setProjectTitle: 'project/setProjectTitle',
    setErrorItems: 'project/setErrorItems',
};

export const reset = () => ({
    type: actionTypes.reset
});

export const setSelectedTabIndex = (index) => ({
    type: actionTypes.setSelectedTabIndex,
    index
});

export const createNewProject = (lang, title) => ({
    type: actionTypes.createNewProject,
    lang, title
});

export const loadProject = (id, ownerSlug = null) => ({
    type: actionTypes.loadProject,
    id,
    ownerSlug
});

export const receiveLoadedProject = (id, title, lang, code, isPublic = false, slug = null, ownerSlug = null) => ({
    type: actionTypes.receiveLoadedProject,
    id, title, lang, code, isPublic, slug, ownerSlug
});

export const setCode = (code) => ({
    type: actionTypes.setCode,
    code
});

export const setSavedCode = (code) => ({
    type: actionTypes.setSavedCode,
    code
});

export const saveCodeChanges = () => ({
    type: actionTypes.saveCodeChanges
});

export const deleteProject = () => ({
    type: actionTypes.deleteProject
});

export const renameProject = (title, slug = null) => ({
    type: actionTypes.renameProject,
    title,
    slug
});

export const setProjectTitle = (title) => ({
    type: actionTypes.setProjectTitle,
    title
});

export const setErrorItems = (errorItems) => ({
    type: actionTypes.setErrorItems,
    errorItems
});
