export const actionTypes = {
    reset: 'project/reset',
    setSelectedTabIndex: 'project/setSelectedTabIndex',
    createNewProject: 'project/createNewProject',
    loadProject: 'project/loadProject',
    receiveLoadedProject: 'project/receiveLoadedProject',
    setCode: 'project/setCode',
    setSavedCode: 'project/setSavedCode',
    saveCodeChanges: 'project/saveCodeChanges',
    setActiveFile: 'project/setActiveFile',
    setFileContent: 'project/setFileContent',
    markFilesSaved: 'project/markFilesSaved',
    revertUnsavedChanges: 'project/revertUnsavedChanges',
    addFile: 'project/addFile',
    receiveAddedFile: 'project/receiveAddedFile',
    renameFile: 'project/renameFile',
    receiveRenamedFile: 'project/receiveRenamedFile',
    deleteFile: 'project/deleteFile',
    receiveDeletedFile: 'project/receiveDeletedFile',
    deleteProject: 'project/deleteProject',
    renameProject: 'project/renameProject',
    setProjectTitle: 'project/setProjectTitle',
    setErrorItems: 'project/setErrorItems',
    copyProject: 'project/copyProject',
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

export const receiveLoadedProject = (id, title, lang, code, isPublic = false, slug = null, ownerSlug = null, ownerId = null, ownerName = null, ownerProfileIsPublic = false, machine = '48', files = []) => ({
    type: actionTypes.receiveLoadedProject,
    id, title, lang, code, isPublic, slug, ownerSlug, ownerId, ownerName, ownerProfileIsPublic, machine, files
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

// fileId null selects the main source file (project.code).
export const setActiveFile = (fileId) => ({
    type: actionTypes.setActiveFile,
    fileId
});

export const setFileContent = (fileId, content) => ({
    type: actionTypes.setFileContent,
    fileId,
    content
});

export const markFilesSaved = () => ({
    type: actionTypes.markFilesSaved
});

export const revertUnsavedChanges = () => ({
    type: actionTypes.revertUnsavedChanges
});

export const addFile = (name, content = '', isBinary = false) => ({
    type: actionTypes.addFile,
    name,
    content,
    isBinary
});

export const receiveAddedFile = (fileId, name, content, isBinary) => ({
    type: actionTypes.receiveAddedFile,
    fileId,
    name,
    content,
    isBinary
});

export const renameFile = (fileId, name) => ({
    type: actionTypes.renameFile,
    fileId,
    name
});

export const receiveRenamedFile = (fileId, name) => ({
    type: actionTypes.receiveRenamedFile,
    fileId,
    name
});

export const deleteFile = (fileId) => ({
    type: actionTypes.deleteFile,
    fileId
});

export const receiveDeletedFile = (fileId) => ({
    type: actionTypes.receiveDeletedFile,
    fileId
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

// The saga catches pass through whatever the compiler threw: the in-browser
// compilers (pasmo, zmakebas, bas2tap) reject with arrays of build-error
// items, but others (txt2bas) throw raw Errors. Normalise here so
// state.project.errorItems is always either undefined or an array of items -
// the shape the toast renderer needs - and a compile failure can never be
// silently dropped.
function toErrorItems(value) {
    if (value === undefined || value === null) return undefined;
    if (Array.isArray(value)) return value;
    return [{type: 'err', text: value?.message || String(value)}];
}

export const setErrorItems = (errorItems) => ({
    type: actionTypes.setErrorItems,
    errorItems: toErrorItems(errorItems)
});

export const copyProject = (title, lang, code, files = []) => ({
    type: actionTypes.copyProject,
    title,
    lang,
    code,
    files
});
