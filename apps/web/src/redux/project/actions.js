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
    setProjectSlug: 'project/setProjectSlug',
    setErrorItems: 'project/setErrorItems',
    setBuildOutput: 'project/setBuildOutput',
    setBuildOutputVisible: 'project/setBuildOutputVisible',
    downloadProjectZip: 'project/downloadProjectZip',
    renumberBasic: 'project/renumberBasic',
    setProjectInstructions: 'project/setProjectInstructions',
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

export const receiveLoadedProject = (id, title, lang, code, isPublic = false, slug = null, ownerSlug = null, ownerId = null, ownerName = null, ownerProfileIsPublic = false, machine = '48', files = [], instructions = '') => ({
    type: actionTypes.receiveLoadedProject,
    id, title, lang, code, isPublic, slug, ownerSlug, ownerId, ownerName, ownerProfileIsPublic, machine, files, instructions
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

export const addFile = (name, content = '', isBinary = false, folder = '') => ({
    type: actionTypes.addFile,
    name,
    content,
    isBinary,
    folder
});

export const receiveAddedFile = (fileId, name, content, isBinary, folder = '') => ({
    type: actionTypes.receiveAddedFile,
    fileId,
    name,
    content,
    isBinary,
    folder
});

// Rename covers moving between folders too: the dialog edits the full
// "folder/name" path in one field.
export const renameFile = (fileId, name, folder = '') => ({
    type: actionTypes.renameFile,
    fileId,
    name,
    folder
});

export const receiveRenamedFile = (fileId, name, folder = '') => ({
    type: actionTypes.receiveRenamedFile,
    fileId,
    name,
    folder
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

export const setProjectSlug = (slug) => ({
    type: actionTypes.setProjectSlug,
    slug
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

// The last build's full classified output ([{severity, text, line?, path?}],
// lib/buildDiagnostics.js) — unlike errorItems it is NOT cleared once the
// toasts have shown, so the build-output dialog can present it for as long as
// the failure is the latest result. Cleared when the next compile starts.
export const setBuildOutput = (units) => ({
    type: actionTypes.setBuildOutput,
    units
});

export const setBuildOutputVisible = (visible) => ({
    type: actionTypes.setBuildOutputVisible,
    visible
});

export const downloadProjectZip = () => ({
    type: actionTypes.downloadProjectZip
});

// The saved "About this program" text (instructions/commentary, markdown).
// Dispatched after the About dialog's own mutation succeeds — the field
// saves independently of the code draft.
export const setProjectInstructions = (instructions) => ({
    type: actionTypes.setProjectInstructions,
    instructions
});

// Renumber the main source's BASIC lines (interpreted dialects only) —
// see lib/basicRenumber.js. Applies to the draft in the store; saving
// stays the user's explicit act.
export const renumberBasic = () => ({
    type: actionTypes.renumberBasic
});
