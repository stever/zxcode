import { takeEvery, put, select, call } from "redux-saga/effects";
import gql from "graphql-tag";
import { gqlFetch } from "../../graphql_fetch";
import { handleException } from "../../errors";
import { actionTypes, setStarredStatus } from "./actions";

// -----------------------------------------------------------------------------
// Action watchers
// -----------------------------------------------------------------------------

export function* watchForStarProjectActions() {
    yield takeEvery(actionTypes.starProject, handleStarProjectActions);
}

export function* watchForUnstarProjectActions() {
    yield takeEvery(actionTypes.unstarProject, handleUnstarProjectActions);
}

// -----------------------------------------------------------------------------
// Action handlers
// -----------------------------------------------------------------------------

function* handleStarProjectActions(action) {
    try {
        const currentUserId = yield select((state) => state.identity.userId);

        const mutation = gql`
            mutation StarProject($project_id: uuid!) {
                insert_project_star_one(object: {project_id: $project_id}) {
                    project_id
                }
            }
        `;

        yield call(gqlFetch, currentUserId, mutation, {
            project_id: action.projectId
        });

        yield put(setStarredStatus(action.projectId, true));
    } catch (e) {
        handleException(e);
    }
}

function* handleUnstarProjectActions(action) {
    try {
        const currentUserId = yield select((state) => state.identity.userId);

        const mutation = gql`
            mutation UnstarProject($user_id: uuid!, $project_id: uuid!) {
                delete_project_star(where: {
                    user_id: {_eq: $user_id},
                    project_id: {_eq: $project_id}
                }) {
                    affected_rows
                }
            }
        `;

        yield call(gqlFetch, currentUserId, mutation, {
            user_id: currentUserId,
            project_id: action.projectId
        });

        yield put(setStarredStatus(action.projectId, false));
    } catch (e) {
        handleException(e);
    }
}
