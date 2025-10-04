import axios from "axios";
import {put, takeLatest, call} from "redux-saga/effects";
import {handleRequestException} from "../../errors";
import {actionTypes, setUserInfo} from "./actions";
import Constants from "../../constants";
import gql from "graphql-tag";
import {gqlFetch} from "../../graphql_fetch";

// -----------------------------------------------------------------------------
// Action watchers
// -----------------------------------------------------------------------------

// noinspection JSUnusedGlobalSymbols
export function* watchForGetUserInfoActions() {
    yield takeLatest(actionTypes.getUserInfo, handleGetUserInfo);
}

// -----------------------------------------------------------------------------
// Action handlers
// -----------------------------------------------------------------------------

const GET_USER_SLUG = gql`
    query GetUserSlug($user_id: uuid!) {
        user_by_pk(user_id: $user_id) {
            slug
        }
    }
`;

function* handleGetUserInfo() {
    try {

        // NOTE: The following request uses an HTTP-only cookie server-side.
        const response = yield axios.get(`${Constants.authBase}/me`, {withCredentials: true});

        // Fetch additional user info including slug from Hasura
        if (response.data && response.data.userId) {
            try {
                const userDataResponse = yield call(gqlFetch, response.data.userId, GET_USER_SLUG, {
                    user_id: response.data.userId
                });

                if (userDataResponse?.data?.user_by_pk) {
                    const userData = userDataResponse.data.user_by_pk;
                    yield put(setUserInfo({
                        ...response.data,
                        userSlug: userData.slug
                    }));
                } else {
                    yield put(setUserInfo(response.data));
                }
            } catch (gqlError) {
                // If GraphQL query fails, still set the basic user info
                yield put(setUserInfo(response.data));
            }
        } else {
            yield put(setUserInfo(response.data));
        }

    } catch (e) {
        if (e.response && e.response.status === 401) {
            return;
        }

        handleRequestException(e);
    }
}
