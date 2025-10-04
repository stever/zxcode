import {actionTypes} from "./actions";

// -----------------------------------------------------------------------------
// Initial state
// -----------------------------------------------------------------------------

const initialState = {
    projectList: undefined,
    // Pagination preferences
    rowsPerPage: 10,
    currentPage: 0,
    // Sorting preferences
    sortField: null,
    sortOrder: null
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
    return {
        ...state,
        ...action.preferences
    }
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
