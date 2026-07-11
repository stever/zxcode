import {actionTypes} from "./actions";

// -----------------------------------------------------------------------------
// Initial state
// -----------------------------------------------------------------------------

// Load preferences from localStorage if available. Saved preferences are
// merged over the defaults so entries saved before a preference existed
// (e.g. viewMode) still pick up its default.
const defaultPreferences = {
    rowsPerPage: 10,
    currentPage: 0,
    sortField: null,
    sortOrder: null,
    viewMode: 'grid'
};

const loadPreferences = () => {
    try {
        const saved = localStorage.getItem('projectListPreferences');
        if (saved) {
            return {...defaultPreferences, ...JSON.parse(saved)};
        }
    } catch (e) {
        console.error('Failed to load project list preferences:', e);
    }
    return {...defaultPreferences};
};

const savedPreferences = loadPreferences();

const initialState = {
    projectList: undefined,
    folderList: undefined,
    // Pagination preferences
    rowsPerPage: savedPreferences.rowsPerPage,
    currentPage: savedPreferences.currentPage,
    // Sorting preferences
    sortField: savedPreferences.sortField,
    sortOrder: savedPreferences.sortOrder,
    // Grid or table presentation
    viewMode: savedPreferences.viewMode
};

// -----------------------------------------------------------------------------
// Actions
// -----------------------------------------------------------------------------

function reset() {
    return {...initialState}
}

function receiveprojectListQueryResult(state, action) {
    return {
        ...state,
        projectList: action.result.project
    }
}

function receiveFolderListQueryResult(state, action) {
    return {
        ...state,
        folderList: action.result.project_folder
    }
}

function setProjectListPreferences(state, action) {
    const newState = {
        ...state,
        ...action.preferences
    };

    // Save to localStorage
    try {
        const preferences = {
            rowsPerPage: newState.rowsPerPage,
            currentPage: newState.currentPage,
            sortField: newState.sortField,
            sortOrder: newState.sortOrder,
            viewMode: newState.viewMode
        };
        localStorage.setItem('projectListPreferences', JSON.stringify(preferences));
    } catch (e) {
        console.error('Failed to save project list preferences:', e);
    }

    return newState;
}

// -----------------------------------------------------------------------------
// Reducer
// -----------------------------------------------------------------------------

const actionsMap = {
    [actionTypes.reset]: reset,
    [actionTypes.receiveprojectListQueryResult]: receiveprojectListQueryResult,
    [actionTypes.receiveFolderListQueryResult]: receiveFolderListQueryResult,
    [actionTypes.setProjectListPreferences]: setProjectListPreferences,
};

export default function reducer(state = initialState, action) {
    const reducerFunction = actionsMap[action.type];
    return reducerFunction ? reducerFunction(state, action) : state;
}
