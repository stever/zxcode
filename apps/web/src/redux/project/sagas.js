import {takeLatest, put, select, call} from "redux-saga/effects";
import gql from "graphql-tag";
import {history} from "../store";
import {gqlFetch} from "../../graphql_fetch";
import {
    actionTypes,
    reset,
    receiveLoadedProject,
    setSavedCode,
    setSelectedTabIndex,
    setProjectTitle,
    markFilesSaved,
    receiveAddedFile,
    receiveRenamedFile,
    receiveDeletedFile
} from "./actions";
import {pause, reset as resetMachine} from "../jsspeccy/actions";
import {setMachine} from "../app/actions";
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

// noinspection JSUnusedGlobalSymbols
export function* watchForCopyProjectActions() {
    yield takeLatest(actionTypes.copyProject, handleCopyProjectActions);
}

// noinspection JSUnusedGlobalSymbols
export function* watchForAddFileActions() {
    yield takeLatest(actionTypes.addFile, handleAddFileActions);
}

// noinspection JSUnusedGlobalSymbols
export function* watchForRenameFileActions() {
    yield takeLatest(actionTypes.renameFile, handleRenameFileActions);
}

// noinspection JSUnusedGlobalSymbols
export function* watchForDeleteFileActions() {
    yield takeLatest(actionTypes.deleteFile, handleDeleteFileActions);
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

        const machine = yield select((state) => state.app.machine);

        const query = gql`
            mutation ($title: String!, $lang: String!, $slug: String!, $machine: String!) {
                insert_project_one(object: {title: $title, lang: $lang, slug: $slug, machine: $machine}) {
                    project_id
                    slug
                }
            }
        `;

        const variables = {
            'title': action.title,
            'lang': action.lang,
            'slug': slug,
            'machine': String(machine)
        };

        // noinspection JSCheckFunctionSignatures
        const response = yield call(gqlFetch, userId, query, variables);

        // noinspection JSUnresolvedVariable
        console.assert(response?.data?.insert_project_one?.project_id, response);

        // noinspection JSUnresolvedVariable
        const id = response?.data?.insert_project_one?.project_id;
        const projectSlug = response?.data?.insert_project_one?.slug;

        const currentUserId = yield select((state) => state.identity.userId);
        const currentUserSlug = yield select((state) => state.identity.userSlug);
        const currentUserName = yield select((state) => state.identity.greetingName);

        yield put(receiveLoadedProject(id, action.title, action.lang, '', false, projectSlug, currentUserSlug, currentUserId, currentUserName, true));

        // For newly created projects, use the UUID URL to avoid race conditions
        // The project might not be immediately queryable through the slug-based nested query
        history.push(`/projects/${id}`);
    } catch (e) {
        handleException(e);
    }
}

function* handleLoadProjectActions(action) {
    try {
        // The reducer keeps the state (instead of resetting) when this project
        // is already loaded with unsaved changes. Skip the refetch too, so the
        // draft isn't overwritten with the server copy.
        const currentId = yield select((state) => state.project.id);
        const code = yield select((state) => state.project.code);
        const savedCode = yield select((state) => state.project.savedCode);
        const filesDirty = yield select((state) =>
            state.project.files.some((f) => f.content !== f.savedContent));
        if (currentId === action.id && (code !== savedCode || filesDirty)) {
            return;
        }

        const userId = yield select((state) => state.identity.userId);

        const query = gql`
            query ($project_id: uuid!) {
                project_by_pk(project_id: $project_id) {
                    title
                    lang
                    code
                    machine
                    is_public
                    slug
                    owner_user_id
                    user {
                        slug
                        greeting_name
                        profile_is_public
                    }
                    files(order_by: {name: asc}) {
                        file_id
                        name
                        content
                        is_binary
                    }
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

        // If ownerSlug is not passed in the action, try to get it from the user data
        const finalOwnerSlug = action.ownerSlug || proj.user?.slug;
        const ownerId = proj.owner_user_id;
        const ownerName = proj.user?.greeting_name;
        const ownerProfileIsPublic = proj.user?.profile_is_public || false;

        const machine = proj.machine || '48';

        yield put(receiveLoadedProject(
            action.id,
            proj.title,
            proj.lang,
            proj.code,
            proj.is_public,
            proj.slug,
            finalOwnerSlug,
            ownerId,
            ownerName,
            ownerProfileIsPublic,
            machine,
            proj.files || []
        ));

        // Boot the emulator to the machine the project targets, so a Next
        // program actually runs (and its screenshot matches the editor). The
        // "m" query param locks the machine; respect that. Skip when already
        // correct to avoid a needless cold-boot on the common 48K case.
        const machineLocked = yield select((state) => state.app.machineLocked);
        const currentMachine = yield select((state) => state.app.machine);
        const target = machine === 'next' ? 'next' : machine === '128' ? 128 : 48;
        if (!machineLocked && target !== currentMachine) {
            yield put(setMachine(target));
        }

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
        const files = yield select((state) => state.project.files);

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

        // Persist every additional file with a dirty draft.
        const fileQuery = gql`
            mutation ($file_id: uuid!, $content: String!) {
                update_project_file_by_pk(pk_columns: {file_id: $file_id}, _set: {content: $content}) {
                    file_id
                }
            }
        `;
        for (const file of files.filter((f) => f.content !== f.savedContent)) {
            const fileResponse = yield call(gqlFetch, userId, fileQuery, {
                'file_id': file.id,
                'content': file.content
            });
            // noinspection JSUnresolvedVariable
            console.assert(fileResponse?.data?.update_project_file_by_pk?.file_id, fileResponse);
        }

        yield put(setSavedCode(code));
        yield put(markFilesSaved());
    } catch (e) {
        handleException(e);
    }
}

function* handleAddFileActions(action) {
    try {
        const userId = yield select((state) => state.identity.userId);
        const projectId = yield select((state) => state.project.id);

        const query = gql`
            mutation ($project_id: uuid!, $name: String!, $content: String!, $is_binary: Boolean!) {
                insert_project_file_one(object: {project_id: $project_id, name: $name, content: $content, is_binary: $is_binary}) {
                    file_id
                }
            }
        `;

        const variables = {
            'project_id': projectId,
            'name': action.name,
            'content': action.content,
            'is_binary': action.isBinary
        };

        // noinspection JSCheckFunctionSignatures
        const response = yield call(gqlFetch, userId, query, variables);

        // noinspection JSUnresolvedVariable
        const fileId = response?.data?.insert_project_file_one?.file_id;
        if (!fileId) {
            return;
        }

        yield put(receiveAddedFile(fileId, action.name, action.content, action.isBinary));
    } catch (e) {
        handleException(e);
    }
}

function* handleRenameFileActions(action) {
    try {
        const userId = yield select((state) => state.identity.userId);

        const query = gql`
            mutation ($file_id: uuid!, $name: String!) {
                update_project_file_by_pk(pk_columns: {file_id: $file_id}, _set: {name: $name}) {
                    file_id
                }
            }
        `;

        const variables = {
            'file_id': action.fileId,
            'name': action.name
        };

        // noinspection JSCheckFunctionSignatures
        const response = yield call(gqlFetch, userId, query, variables);

        // noinspection JSUnresolvedVariable
        if (!response?.data?.update_project_file_by_pk?.file_id) {
            return;
        }

        yield put(receiveRenamedFile(action.fileId, action.name));
    } catch (e) {
        handleException(e);
    }
}

function* handleDeleteFileActions(action) {
    try {
        const userId = yield select((state) => state.identity.userId);

        const query = gql`
            mutation ($file_id: uuid!) {
                delete_project_file_by_pk(file_id: $file_id) {
                    file_id
                }
            }
        `;

        const variables = {
            'file_id': action.fileId
        };

        // noinspection JSCheckFunctionSignatures
        const response = yield call(gqlFetch, userId, query, variables);

        // noinspection JSUnresolvedVariable
        if (!response?.data?.delete_project_file_by_pk?.file_id) {
            return;
        }

        yield put(receiveDeletedFile(action.fileId));
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
            const ownerId = yield select((state) => state.project.ownerId);
            const ownerSlug = yield select((state) => state.project.ownerSlug);
            const ownerName = yield select((state) => state.project.ownerName);
            const ownerProfileIsPublic = yield select((state) => state.project.ownerProfileIsPublic);
            yield put(receiveLoadedProject(projectId, action.title, lang, code, isPublic, currentSlug, ownerSlug, ownerId, ownerName, ownerProfileIsPublic));
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
        const ownerId = yield select((state) => state.project.ownerId);
        const ownerSlug = yield select((state) => state.project.ownerSlug);
        const ownerName = yield select((state) => state.project.ownerName);
        const ownerProfileIsPublic = yield select((state) => state.project.ownerProfileIsPublic);
        yield put(receiveLoadedProject(projectId, action.title, lang, code, isPublic, newSlug, ownerSlug, ownerId, ownerName, ownerProfileIsPublic));

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

function* handleCopyProjectActions(action) {
    try {
        const userId = yield select((state) => state.identity.userId);
        const userSlug = yield select((state) => state.identity.userSlug);

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

        const machine = yield select((state) => state.app.machine);

        const query = gql`
            mutation ($title: String!, $lang: String!, $code: String!, $slug: String!, $machine: String!, $files: [project_file_insert_input!]!) {
                insert_project_one(object: {title: $title, lang: $lang, code: $code, slug: $slug, machine: $machine, files: {data: $files}}) {
                    project_id
                    slug
                    files(order_by: {name: asc}) {
                        file_id
                        name
                        content
                        is_binary
                    }
                }
            }
        `;

        const variables = {
            'title': action.title,
            'lang': action.lang,
            'code': action.code,
            'slug': slug,
            'machine': String(machine),
            // Duplicate the source project's files (current drafts included).
            'files': (action.files || []).map((f) => ({
                name: f.name,
                content: f.content,
                is_binary: f.isBinary
            }))
        };

        // noinspection JSCheckFunctionSignatures
        const response = yield call(gqlFetch, userId, query, variables);

        // noinspection JSUnresolvedVariable
        console.assert(response?.data?.insert_project_one?.project_id, response);

        // noinspection JSUnresolvedVariable
        const id = response?.data?.insert_project_one?.project_id;
        const projectSlug = response?.data?.insert_project_one?.slug;
        const copiedFiles = response?.data?.insert_project_one?.files || [];

        const currentUserName = yield select((state) => state.identity.greetingName);

        yield put(receiveLoadedProject(id, action.title, action.lang, action.code, false, projectSlug, userSlug, userId, currentUserName, true, String(machine), copiedFiles));

        // Navigate to the new project using the slug-based URL
        if (userSlug && projectSlug) {
            history.push(`/u/${userSlug}/${projectSlug}`);
        } else {
            // Fallback to UUID URL if slug is not available
            history.push(`/projects/${id}`);
        }
    } catch (e) {
        handleException(e);
    }
}
