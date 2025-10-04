import {select, takeLatest, put, call} from "redux-saga/effects";
import gql from "graphql-tag";
import {history} from "../store";
import {gqlFetch} from "../../graphql_fetch";
import {
    actionTypes,
    receivePrivacyPolicy,
    receiveTermsOfUse
} from "./actions";
import {setSelectedTabIndex as setDemoTabIndex} from "../demo/actions";
import {reset} from "../jsspeccy/actions";
import {handleException} from "../../errors";

// -----------------------------------------------------------------------------
// Action watchers
// -----------------------------------------------------------------------------

// noinspection JSUnusedGlobalSymbols
export function* watchForShowActiveEmulatorActions() {
    yield takeLatest(actionTypes.showActiveEmulator, handleShowActiveEmulatorActions);
}

// noinspection JSUnusedGlobalSymbols
export function* watchForResetEmulatorActions() {
    yield takeLatest(actionTypes.resetEmulator, handleResetEmulatorActions);
}

// noinspection JSUnusedGlobalSymbols
export function* watchForRequestTermsOfUseActions() {
    yield takeLatest(actionTypes.requestTermsOfUse, handleRequestTermsOfUseActions);
}

// noinspection JSUnusedGlobalSymbols
export function* watchForRequestPrivacyPolicyActions() {
    yield takeLatest(actionTypes.requestPrivacyPolicy, handleRequestPrivacyPolicyActions);
}

// -----------------------------------------------------------------------------
// Action handlers
// -----------------------------------------------------------------------------

function* handleShowActiveEmulatorActions(_) {
    try {
        const projectId = yield select((state) => state.project.id);
        const isProject = typeof projectId !== 'undefined';
        const currentPath = yield select((state) => state?.router?.location?.pathname);

        if (isProject) {
            const targetPath = `/projects/${projectId}`;
            // Only push to history if we're not already on this page
            if (currentPath !== targetPath) {
                history.push(targetPath);
            }
        } else {
            // Mobile view has emulator on a tab. Switch to the emulator tab when running code.
            const isMobile = yield select((state) => state.window.isMobile);
            if (isMobile) yield put(setDemoTabIndex(0));
            // Only push to history if we're not already on the home page
            if (currentPath !== '/') {
                history.push('/');
            }
        }
    } catch (e) {
        handleException(e);
    }
}

function* handleResetEmulatorActions(_) {
    try {
        const projectId = yield select((state) => state.project.id);
        const isProject = typeof projectId !== 'undefined';
        const currentPath = yield select((state) => state?.router?.location?.pathname);

        if (isProject) {
            const targetPath = `/projects/${projectId}`;
            // Only push to history if we're not already on this page
            if (currentPath !== targetPath) {
                history.push(targetPath);
            }
            yield put(reset());
        } else {
            // Mobile view has emulator on a tab. Switch to the emulator tab when running code.
            const isMobile = yield select((state) => state.window.isMobile);
            if (isMobile) yield put(setDemoTabIndex(0));
            // Only push to history if we're not already on the home page
            if (currentPath !== '/') {
                history.push('/');
            }
            yield put(reset());
        }
    } catch (e) {
        handleException(e);
    }
}

function* handleRequestTermsOfUseActions(_) {
    try {
        const query = gql`
            query {
                text(where: {name: {_eq: "terms-of-use"}, lang: {_eq: "en"}}) {
                    text
                }
            }
        `;

        const variables = {};
        const userId = yield select((state) => state.identity.userId);
        const response = yield call(gqlFetch, userId, query, variables);
        console.assert(response?.data?.text, response);
        console.assert(response?.data?.text.length === 1, response);
        console.assert(response?.data?.text[0]?.text, response);
        yield put(receiveTermsOfUse(response?.data?.text[0]?.text || '# Terms of Use\n\nTODO'));
    } catch (e) {
        handleException(e);
    }
}

function* handleRequestPrivacyPolicyActions(_) {
    try {
        const query = gql`
            query {
                text(where: {name: {_eq: "privacy-policy"}, lang: {_eq: "en"}}) {
                    text
                }
            }
        `;

        const variables = {};
        const userId = yield select((state) => state.identity.userId);
        const response = yield call(gqlFetch, userId, query, variables);
        console.assert(response?.data?.text, response);
        console.assert(response?.data?.text.length === 1, response);
        console.assert(response?.data?.text[0]?.text, response);
        yield put(receivePrivacyPolicy(response?.data?.text[0]?.text || '# Privacy Policy\n\nTODO'));
    } catch (e) {
        handleException(e);
    }
}
