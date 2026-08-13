import {actionTypes} from "./actions";

// -----------------------------------------------------------------------------
// Initial state
// -----------------------------------------------------------------------------

const initialState = {
    selectedTabIndex: 0,
    lang: undefined,
    id: undefined,
    title: undefined,
    code: '',
    savedCode: '',
    // Additional project files: {id, name, folder, content, savedContent,
    // isBinary}. Binary asset content is base64; folder is '' for root files.
    // The main source stays in code above.
    files: [],
    // null selects the main source file.
    activeFileId: null,
    errorItems: undefined,
    // Last failed build's classified output for the build-output dialog:
    // [{severity, text, line?, path?}] or undefined. Survives the toast
    // display (errorItems does not); replaced/cleared per compile.
    buildOutput: undefined,
    buildOutputVisible: false,
    isPublic: false,
    slug: undefined,
    ownerSlug: undefined,
    ownerId: undefined,
    ownerName: undefined,
    ownerProfileIsPublic: false,
    machine: '48',
    // "About this program" (markdown): saved value only — the About dialog
    // edits a local draft and writes back through its own mutation.
    instructions: ''
};

function filesDirty(state) {
    return state.files.some((f) => f.content !== f.savedContent);
}

// -----------------------------------------------------------------------------
// Actions
// -----------------------------------------------------------------------------

function reset() {
    return {...initialState};
}

function loadProject(state, action) {
    // Returning to the already-loaded project with unsaved changes (e.g. after
    // visiting About or profile settings) must keep the in-memory draft; the
    // matching saga skips the server refetch in this case. Everything else
    // starts from a clean slate as before.
    if (action.id && action.id === state.id
        && (state.code !== state.savedCode || filesDirty(state))) {
        return state;
    }
    return {...initialState};
}

function setSelectedTabIndex(state, action) {
    return {
        ...state,
        selectedTabIndex: action.index
    };
}

function createNewProject(state, action) {
    return {
        ...state,
        title: action.title,
        selectedTabIndex: 0
    };
}

function receiveLoadedProject(state, action) {
    return {
        ...state,
        id: action.id,
        title: action.title,
        lang: action.lang,
        code: action.code,
        savedCode: action.code,
        files: (action.files || []).map((f) => ({
            id: f.file_id,
            name: f.name,
            folder: f.folder || '',
            content: f.content,
            savedContent: f.content,
            isBinary: f.is_binary
        })),
        activeFileId: null,
        selectedTabIndex: 0,
        isPublic: action.isPublic,
        slug: action.slug,
        ownerSlug: action.ownerSlug,
        ownerId: action.ownerId,
        ownerName: action.ownerName,
        ownerProfileIsPublic: action.ownerProfileIsPublic,
        machine: action.machine,
        instructions: action.instructions || ''
    };
}

function setProjectSlug(state, action) {
    return {
        ...state,
        slug: action.slug,
    };
}

function setProjectInstructions(state, action) {
    return {
        ...state,
        instructions: action.instructions,
    };
}

function setCode(state, action) {
    return {
        ...state,
        code: action.code,
    };
}

function setSavedCode(state, action) {
    return {
        ...state,
        savedCode: action.code,
    };
}

function setErrorItems(state, action) {
    return {
        ...state,
        errorItems: action.errorItems,
    };
}

function setBuildOutput(state, action) {
    return {
        ...state,
        buildOutput: action.units,
        // A cleared output takes the dialog down with it; new output does not
        // fling the dialog open (the summary toast's button does that).
        buildOutputVisible: action.units ? state.buildOutputVisible : false,
    };
}

function setBuildOutputVisible(state, action) {
    return {
        ...state,
        buildOutputVisible: action.visible,
    };
}

function setProjectTitle(state, action) {
    return {
        ...state,
        title: action.title,
    };
}

function setActiveFile(state, action) {
    return {
        ...state,
        activeFileId: action.fileId,
    };
}

function setFileContent(state, action) {
    return {
        ...state,
        files: state.files.map((f) =>
            f.id === action.fileId ? {...f, content: action.content} : f),
    };
}

function markFilesSaved(state) {
    return {
        ...state,
        files: state.files.map((f) =>
            f.content === f.savedContent ? f : {...f, savedContent: f.content}),
    };
}

function revertUnsavedChanges(state) {
    return {
        ...state,
        code: state.savedCode,
        files: state.files.map((f) =>
            f.content === f.savedContent ? f : {...f, content: f.savedContent}),
    };
}

function receiveAddedFile(state, action) {
    return {
        ...state,
        files: [...state.files, {
            id: action.fileId,
            name: action.name,
            folder: action.folder || '',
            content: action.content,
            savedContent: action.content,
            isBinary: action.isBinary
        }],
        activeFileId: action.fileId,
    };
}

function receiveRenamedFile(state, action) {
    return {
        ...state,
        files: state.files.map((f) =>
            f.id === action.fileId
                ? {...f, name: action.name, folder: action.folder || ''}
                : f),
    };
}

function receiveDeletedFile(state, action) {
    return {
        ...state,
        files: state.files.filter((f) => f.id !== action.fileId),
        activeFileId: state.activeFileId === action.fileId ? null : state.activeFileId,
    };
}

// -----------------------------------------------------------------------------
// Reducer
// -----------------------------------------------------------------------------

const actionsMap = {
    [actionTypes.reset]: reset,
    [actionTypes.loadProject]: loadProject,
    [actionTypes.setSelectedTabIndex]: setSelectedTabIndex,
    [actionTypes.createNewProject]: createNewProject,
    [actionTypes.receiveLoadedProject]: receiveLoadedProject,
    [actionTypes.setCode]: setCode,
    [actionTypes.setSavedCode]: setSavedCode,
    [actionTypes.setErrorItems]: setErrorItems,
    [actionTypes.setBuildOutput]: setBuildOutput,
    [actionTypes.setBuildOutputVisible]: setBuildOutputVisible,
    [actionTypes.setProjectTitle]: setProjectTitle,
    [actionTypes.setProjectSlug]: setProjectSlug,
    [actionTypes.setProjectInstructions]: setProjectInstructions,
    [actionTypes.setActiveFile]: setActiveFile,
    [actionTypes.setFileContent]: setFileContent,
    [actionTypes.markFilesSaved]: markFilesSaved,
    [actionTypes.revertUnsavedChanges]: revertUnsavedChanges,
    [actionTypes.receiveAddedFile]: receiveAddedFile,
    [actionTypes.receiveRenamedFile]: receiveRenamedFile,
    [actionTypes.receiveDeletedFile]: receiveDeletedFile,
};

export default function reducer(state = initialState, action) {
    const reducerFunction = actionsMap[action.type];
    return reducerFunction ? reducerFunction(state, action) : state;
}
