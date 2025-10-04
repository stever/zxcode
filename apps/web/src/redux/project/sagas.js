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
        let slug = generateSlug(action.title);

        // Check if slug already exists and find a unique one
        const checkSlugQuery = gql`
            query CheckProjectSlug($slug: String!) {
                project(where: {slug: {_eq: $slug}}) {
                    slug
                }
            }
        `;

        // Keep checking and incrementing until we find a unique slug
        let finalSlug = slug;
        let counter = 1;

        while (true) {
            const checkResponse = yield call(gqlFetch, userId, checkSlugQuery, {
                slug: finalSlug
            });

            // If no project exists with this slug, we can use it
            if (!checkResponse?.data?.project?.length) {
                break;
            }

            // Otherwise, try with a suffix
            finalSlug = `${slug}-${counter}`;
            counter++;
        }

        slug = finalSlug;

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

        // For newly created projects, use the UUID URL to avoid race conditions
        // The project might not be immediately queryable through the slug-based nested query
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
        const currentSlug = yield select((state) => state.project.slug);

        // Determine the desired slug:
        // - If slug is provided and not empty, use it (lightly sanitized)
        // - Otherwise, generate from title
        let slug;
        if (action.slug && action.slug.trim()) {
            // User provided a custom slug - do minimal sanitization to preserve intent
            slug = action.slug.trim().toLowerCase()
                // Only replace spaces with hyphens (preserve underscores and existing hyphens)
                .replace(/\s+/g, '-')
                // Remove any truly invalid characters (but keep underscores, hyphens, letters, numbers)
                .replace(/[^a-z0-9_-]/g, '')
                // Collapse multiple hyphens/underscores
                .replace(/[-_]+/g, (match) => match[0]);
        } else {
            // No slug provided, generate from title using standard rules
            slug = generateSlug(action.title);
        }

        // If the slug hasn't changed, skip the uniqueness check
        if (slug === currentSlug) {
            // Only update the title, keep the same slug
            const query = gql`
                mutation ($project_id: uuid!, $title: String!) {
                    update_project_by_pk(pk_columns: {project_id: $project_id}, _set: {title: $title}) {
                        project_id
                        slug
                    }
                }
            `;

            const variables = {
                'project_id': projectId,
                'title': action.title
            };

            const response = yield call(gqlFetch, userId, query, variables);
            console.assert(response?.data?.update_project_by_pk?.project_id, response);

            yield put(setProjectTitle(action.title));
            const lang = yield select((state) => state.project.lang);
            const code = yield select((state) => state.project.code);
            const isPublic = yield select((state) => state.project.isPublic);
            yield put(receiveLoadedProject(projectId, action.title, lang, code, isPublic, currentSlug));
            return;
        }

        // Check if slug already exists for other projects (not this one)
        const checkSlugQuery = gql`
            query CheckProjectSlugForRename($slug: String!, $project_id: uuid!) {
                project(where: {
                    slug: {_eq: $slug},
                    project_id: {_neq: $project_id}
                }) {
                    slug
                }
            }
        `;

        // Keep checking and incrementing until we find a unique slug
        let finalSlug = slug;
        let counter = 1;

        while (true) {
            const checkResponse = yield call(gqlFetch, userId, checkSlugQuery, {
                slug: finalSlug,
                project_id: projectId
            });

            // If no other project exists with this slug, we can use it
            if (!checkResponse?.data?.project?.length) {
                break;
            }

            // Otherwise, try with a suffix
            finalSlug = `${slug}-${counter}`;
            counter++;
        }

        slug = finalSlug;

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

        if (!response?.data?.update_project_by_pk) {
            console.error('Failed to update project:', response);
            throw new Error('Failed to update project');
        }

        // noinspection JSUnresolvedVariable
        console.assert(response?.data?.update_project_by_pk?.project_id, response);

        const newSlug = response?.data?.update_project_by_pk?.slug;
        yield put(setProjectTitle(action.title));

        // Update project with new slug
        const lang = yield select((state) => state.project.lang);
        const code = yield select((state) => state.project.code);
        const isPublic = yield select((state) => state.project.isPublic);
        yield put(receiveLoadedProject(projectId, action.title, lang, code, isPublic, newSlug));

        // If the slug changed, update the URL
        if (newSlug !== currentSlug) {
            const userSlug = yield select((state) => state?.identity.userSlug);
            const currentPath = yield select((state) => state?.router?.location?.pathname);

            // Only update URL if we're currently on a slug-based URL
            if (currentPath && currentPath.includes(`/${currentSlug}`)) {
                const newPath = `/u/${userSlug}/${newSlug}`;
                history.replace(newPath);
            }
        }
    } catch (e) {
        handleException(e);
    }
}
