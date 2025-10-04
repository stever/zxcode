import {actionTypes} from "./actions";

// -----------------------------------------------------------------------------
// Initial state
// -----------------------------------------------------------------------------

// Load preferences from localStorage if available
const loadPreferences = () => {
    try {
        const saved = localStorage.getItem('projectListPreferences');
        if (saved) {
            return JSON.parse(saved);
        }
    } catch (e) {
        console.error('Failed to load project list preferences:', e);
    }
    return {
        rowsPerPage: 10,
        currentPage: 0,
        sortField: null,
        sortOrder: null
    };
};

const savedPreferences = loadPreferences();

const initialState = {
    projectList: undefined,
    // Pagination preferences
    rowsPerPage: savedPreferences.rowsPerPage,
    currentPage: savedPreferences.currentPage,
    // Sorting preferences
    sortField: savedPreferences.sortField,
    sortOrder: savedPreferences.sortOrder
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
            sortOrder: newState.sortOrder
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
    [actionTypes.setProjectListPreferences]: setProjectListPreferences,
};

export default function reducer(state = initialState, action) {
    const reducerFunction = actionsMap[action.type];
    return reducerFunction ? reducerFunction(state, action) : state;
}
