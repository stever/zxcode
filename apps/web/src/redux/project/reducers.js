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
    errorItems: undefined,
    isPublic: false,
    slug: undefined,
    ownerSlug: undefined,
    ownerId: undefined,
    ownerName: undefined,
    ownerProfileIsPublic: false,
    machine: '48'
};

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
    if (action.id && action.id === state.id && state.code !== state.savedCode) {
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
        selectedTabIndex: 0,
        isPublic: action.isPublic,
        slug: action.slug,
        ownerSlug: action.ownerSlug,
        ownerId: action.ownerId,
        ownerName: action.ownerName,
        ownerProfileIsPublic: action.ownerProfileIsPublic,
        machine: action.machine
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

function setProjectTitle(state, action) {
    return {
        ...state,
        title: action.title,
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
    [actionTypes.setProjectTitle]: setProjectTitle,
};

export default function reducer(state = initialState, action) {
    const reducerFunction = actionsMap[action.type];
    return reducerFunction ? reducerFunction(state, action) : state;
}
