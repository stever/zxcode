import {put, takeLatest, select, call} from "redux-saga/effects";
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
import {gqlFetch} from "../../graphql_fetch";
import {generateSlug} from "../../utils/slug";
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

// noinspection JSUnusedGlobalSymbols
export function* watchRenameListProjectActions() {
    yield takeLatest(actionTypes.renameListProject, handleRenameListProjectActions);
}

// noinspection JSUnusedGlobalSymbols
export function* watchCopyListProjectActions() {
    yield takeLatest(actionTypes.copyListProject, handleCopyListProjectActions);
}

// noinspection JSUnusedGlobalSymbols
export function* watchDeleteListProjectActions() {
    yield takeLatest(actionTypes.deleteListProject, handleDeleteListProjectActions);
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
                    order_by: {updated_at: desc}
                ) {
                    project_id
                    title
                    lang
                    machine
                    is_public
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

// The handlers below mutate projects directly from the browser list. Unlike
// their editor counterparts in redux/project/sagas.js they don't update any
// loaded-project state and never navigate: the list's live subscription
// delivers the new rows, so the change appears in place.

// Nothing matches this id, so passing it as the exclusion makes the
// uniqueness check consider every project (used when inserting a copy).
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

// Suffix baseSlug with -1, -2, ... until no project other than
// excludeProjectId uses it.
function* findUniqueSlug(userId, baseSlug, excludeProjectId) {
    const query = gql`
        query CheckProjectSlug($slug: String!, $project_id: uuid!) {
            project(where: {slug: {_eq: $slug}, project_id: {_neq: $project_id}}) {
                slug
            }
        }
    `;

    let slug = baseSlug;
    let counter = 1;

    while (true) {
        const response = yield call(gqlFetch, userId, query, {
            slug,
            project_id: excludeProjectId
        });

        if (!response?.data?.project?.length) {
            return slug;
        }

        slug = `${baseSlug}-${counter}`;
        counter++;
    }
}

function* handleRenameListProjectActions(action) {
    try {
        const userId = yield select((state) => state.identity.userId);

        // Same slug rules as the editor's rename: a provided slug is lightly
        // sanitized to preserve intent, an empty one is generated from the
        // title.
        let slug;
        if (action.slug && action.slug.trim()) {
            slug = action.slug.trim().toLowerCase()
                .replace(/\s+/g, '-')
                .replace(/[^a-z0-9_-]/g, '')
                .replace(/[-_]+/g, (match) => match[0]);
        } else {
            slug = generateSlug(action.title);
        }

        if (slug !== action.currentSlug) {
            slug = yield* findUniqueSlug(userId, slug, action.projectId);
        }

        const query = gql`
            mutation ($project_id: uuid!, $title: String!, $slug: String!) {
                update_project_by_pk(pk_columns: {project_id: $project_id}, _set: {title: $title, slug: $slug}) {
                    project_id
                }
            }
        `;

        const response = yield call(gqlFetch, userId, query, {
            'project_id': action.projectId,
            'title': action.title,
            'slug': slug
        });

        console.assert(response?.data?.update_project_by_pk?.project_id, response);
    } catch (e) {
        handleException(e);
    }
}

function* handleCopyListProjectActions(action) {
    try {
        const userId = yield select((state) => state.identity.userId);

        // The list subscription doesn't carry code or files; fetch the full
        // source project first.
        const sourceQuery = gql`
            query ($project_id: uuid!) {
                project_by_pk(project_id: $project_id) {
                    lang
                    code
                    machine
                    files {
                        name
                        content
                        is_binary
                    }
                }
            }
        `;

        const sourceResponse = yield call(gqlFetch, userId, sourceQuery, {
            'project_id': action.projectId
        });

        const source = sourceResponse?.data?.project_by_pk;
        if (!source) {
            console.error('Failed to load project to copy:', sourceResponse);
            return;
        }

        const slug = yield* findUniqueSlug(userId, generateSlug(action.title), NIL_UUID);

        const query = gql`
            mutation ($title: String!, $lang: String!, $code: String!, $slug: String!, $machine: String!, $files: [project_file_insert_input!]!) {
                insert_project_one(object: {title: $title, lang: $lang, code: $code, slug: $slug, machine: $machine, files: {data: $files}}) {
                    project_id
                }
            }
        `;

        const response = yield call(gqlFetch, userId, query, {
            'title': action.title,
            'lang': source.lang,
            'code': source.code,
            'slug': slug,
            // Unlike the editor's copy this keeps the source project's stored
            // machine rather than whatever machine is currently selected.
            'machine': source.machine,
            'files': (source.files || []).map((f) => ({
                name: f.name,
                content: f.content,
                is_binary: f.is_binary
            }))
        });

        console.assert(response?.data?.insert_project_one?.project_id, response);
    } catch (e) {
        handleException(e);
    }
}

function* handleDeleteListProjectActions(action) {
    try {
        const userId = yield select((state) => state.identity.userId);

        const query = gql`
            mutation ($project_id: uuid!) {
                delete_project_by_pk(project_id: $project_id) {
                    project_id
                }
            }
        `;

        const response = yield call(gqlFetch, userId, query, {
            'project_id': action.projectId
        });

        console.assert(response?.data?.delete_project_by_pk?.project_id, response);
    } catch (e) {
        handleException(e);
    }
}
