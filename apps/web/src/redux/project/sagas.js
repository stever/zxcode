import {takeLatest, put, select, call} from "redux-saga/effects";
import gql from "graphql-tag";
import {history} from "../store";
import {gqlFetch} from "../../graphql_fetch";
import {actionTypes, reset, receiveLoadedProject, setSavedCode, setSelectedTabIndex, setProjectTitle} from "./actions";
import {pause, reset as resetMachine} from "../jsspeccy/actions";
import {handleException} from "../../errors";
import {generateSlug} from "../../utils/slug";

// -----------------------------------------------------------------------------
// Action watchers
// -----------------------------------------------------------------------------

// noinspection JSUnusedGlobalSymbols
export function* watchForSetSelectedTabIndexActions() {
    yield takeLatest(actionTypes.setSelectedTabIndex, handleSetSelectedTabIndexActions);
}

// noinspection JSUnusedGlobalSymbols
export function* watchForCreateNewProjectActions() {
    yield takeLatest(actionTypes.createNewProject, handleCreateNewProjectActions);
}

// noinspection JSUnusedGlobalSymbols
export function* watchForLoadProjectActions() {
    yield takeLatest(actionTypes.loadProject, handleLoadProjectActions);
}

// noinspection JSUnusedGlobalSymbols
export function* watchForSaveCodeChangesActions() {
    yield takeLatest(actionTypes.saveCodeChanges, handleSaveCodeChangesActions);
}

// noinspection JSUnusedGlobalSymbols
export function* watchForDeleteProjectActions() {
    yield takeLatest(actionTypes.deleteProject, handleDeleteProjectActions);
}

// noinspection JSUnusedGlobalSymbols
export function* watchForRenameProjectActions() {
    yield takeLatest(actionTypes.renameProject, handleRenameProjectActions);
}

// -----------------------------------------------------------------------------
// Action handlers
// -----------------------------------------------------------------------------

function* handleSetSelectedTabIndexActions(_) {
    yield put(pause());
}

function* handleCreateNewProjectActions(action) {
    try {
        const userId = yield select((state) => state.identity.userId);

        // Generate slug from the title
        const slug = generateSlug(action.title);

        const query = gql`
            mutation ($title: String!, $lang: String!, $slug: String!) {
                insert_project_one(object: {title: $title, lang: $lang, slug: $slug}) {
                    project_id
                    slug
                }
            }
        `;

        const variables = {
            'title': action.title,
            'lang': action.lang,
            'slug': slug
        };

        // noinspection JSCheckFunctionSignatures
        const response = yield call(gqlFetch, userId, query, variables);

        // noinspection JSUnresolvedVariable
        console.assert(response?.data?.insert_project_one?.project_id, response);

        // noinspection JSUnresolvedVariable
        const id = response?.data?.insert_project_one?.project_id;
        const projectSlug = response?.data?.insert_project_one?.slug;

        yield put(receiveLoadedProject(id, action.title, action.lang, '', false, projectSlug));
        history.push(`/projects/${id}`);
    } catch (e) {
        handleException(e);
    }
}

function* handleLoadProjectActions(action) {
    try {
        const userId = yield select((state) => state.identity.userId);

        const query = gql`
            query ($project_id: uuid!) {
                project_by_pk(project_id: $project_id) {
                    title
                    lang
                    code
                    is_public
                    slug
                }
            }
        `;

        const variables = {
            'project_id': action.id
        };

        // noinspection JSCheckFunctionSignatures
        const response = yield call(gqlFetch, userId, query, variables);

        if (!response) {
            return;
        }

        // noinspection JSUnresolvedVariable
        const proj = response.data.project_by_pk;

        if (!proj) {
            return;
        }

        yield put(receiveLoadedProject(action.id, proj.title, proj.lang, proj.code, proj.is_public, proj.slug));

        // Mobile view has emulator on a tab. Switch to the emulator tab when running code.
        const isMobile = yield select((state) => state.window.isMobile);
        console.log('handleRunProjectCodeActions', isMobile);
        if (isMobile) yield put(setSelectedTabIndex(1));
    } catch (e) {
        handleException(e);
    }
}

function* handleSaveCodeChangesActions(_) {
    try {
        const userId = yield select((state) => state.identity.userId);
        const projectId = yield select((state) => state.project.id);
        const code = yield select((state) => state.project.code);

        const query = gql`
            mutation ($project_id: uuid!, $code: String!) {
                update_project_by_pk(pk_columns: {project_id: $project_id}, _set: {code: $code}) {
                    project_id
                }
            }
        `;

        const variables = {
            'project_id': projectId,
            'code': code
        };

        // noinspection JSCheckFunctionSignatures
        const response = yield call(gqlFetch, userId, query, variables);

        // noinspection JSUnresolvedVariable
        console.assert(response?.data?.update_project_by_pk?.project_id, response);

        yield put(setSavedCode(code));
    } catch (e) {
        handleException(e);
    }
}

function* handleDeleteProjectActions(_) {
    try {
        const userId = yield select((state) => state.identity.userId);
        const userSlug = yield select((state) => state.identity.userSlug);
        const projectId = yield select((state) => state.project.id);

        const query = gql`
            mutation ($project_id: uuid!) {
                delete_project_by_pk(project_id: $project_id) {
                    project_id
                }
            }
        `;

        const variables = {
            'project_id': projectId
        };

        // noinspection JSCheckFunctionSignatures
        const response = yield call(gqlFetch, userId, query, variables);

        // noinspection JSUnresolvedVariable
        console.assert(response?.data?.delete_project_by_pk?.project_id, response);

        yield put(reset());
        yield put(resetMachine());
        // Use slug if available, otherwise fallback to userId
        history.push(`/u/${userSlug || userId}/projects`);
    } catch (e) {
        handleException(e);
    }
}

function* handleRenameProjectActions(action) {
    try {
        const userId = yield select((state) => state.identity.userId);
        const projectId = yield select((state) => state.project.id);

        // Generate new slug from the new title
        const slug = generateSlug(action.title);

        const query = gql`
            mutation ($project_id: uuid!, $title: String!, $slug: String!) {
                update_project_by_pk(pk_columns: {project_id: $project_id}, _set: {title: $title, slug: $slug}) {
                    project_id
                    slug
                }
            }
        `;

        const variables = {
            'project_id': projectId,
            'title': action.title,
            'slug': slug
        };

        // noinspection JSCheckFunctionSignatures
        const response = yield call(gqlFetch, userId, query, variables);

        // noinspection JSUnresolvedVariable
        console.assert(response?.data?.update_project_by_pk?.project_id, response);

        yield put(setProjectTitle(action.title));
    } catch (e) {
        handleException(e);
    }
}
