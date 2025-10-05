import {put, takeLatest, select} from "redux-saga/effects";
import gql from "graphql-tag";
import {
    actionTypes,
    receiveprojectListQueryResult,
    subscribeToProjectList,
    subscribeToProjectListCallback,
} from "./actions";
import {
    subscribe,
    subscribeAction,
    unsubscribeAction
} from "../subscriber/actions";
import {handleError, handleException} from "../../errors";

// -----------------------------------------------------------------------------
// Action watchers
// -----------------------------------------------------------------------------

// noinspection JSUnusedGlobalSymbols
export function* watchSubscribeToProjectListActions() {
    yield takeLatest(actionTypes.subscribeToProjectList, handleSubscribeToProjectList);
}

// noinspection JSUnusedGlobalSymbols
export function* watchSubscribeToProjectListCallbackActions() {
    yield takeLatest(actionTypes.subscribeToProjectListCallback, handleSubscribeToProjectListCallback);
}

// noinspection JSUnusedGlobalSymbols
export function* watchUnsubscribeFromProjectListActions() {
    yield takeLatest(actionTypes.unsubscribeFromProjectList, handleUnsubscribeFromProjectList);
}

// -----------------------------------------------------------------------------
// Action handlers
// -----------------------------------------------------------------------------

function* handleSubscribeToProjectList(action) {
    try {
        const userId = yield select((state) => state.identity.userId);

        const query = gql`
            subscription($user_id: uuid!) {
                project(
                    where: {owner_user_id: {_eq: $user_id}},
                    order_by: {created_at: asc}
                ) {
                    project_id
                    title
                    lang
                    created_at
                    updated_at
                    slug
                }
            }
        `;

        const variables = {
            user_id: userId
        };

        yield put(subscribe(action, query, variables, subscribeToProjectListCallback));
        yield put(subscribeAction(action));
    } catch (e) {
        handleException(e);
    }
}

function* handleSubscribeToProjectListCallback(action) {
    try {
        const {error, data} = action;

        if (!error && !data) {
            return; // Normal exit.
        }

        if (error) {
            handleError('Websocket Callback Error', error);
            return;
        }

        yield put(receiveprojectListQueryResult(data));
    } catch (e) {
        handleException(e);
    }
}

function* handleUnsubscribeFromProjectList() {
    yield put(unsubscribeAction(subscribeToProjectList()));
}
