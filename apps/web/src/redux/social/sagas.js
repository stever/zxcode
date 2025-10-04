import { takeLatest, put, select, call } from "redux-saga/effects";
import gql from "graphql-tag";
import { gqlFetch } from "../../graphql_fetch";
import { handleException } from "../../errors";
import {
    actionTypes,
    setFollowingStatus,
    setFollowers,
    setFollowing,
    setActivityFeed,
    setFollowCounts
} from "./actions";

// -----------------------------------------------------------------------------
// Action watchers
// -----------------------------------------------------------------------------

export function* watchForFollowUserActions() {
    yield takeLatest(actionTypes.followUser, handleFollowUserActions);
}

export function* watchForUnfollowUserActions() {
    yield takeLatest(actionTypes.unfollowUser, handleUnfollowUserActions);
}

export function* watchForFetchFollowersActions() {
    yield takeLatest(actionTypes.fetchFollowers, handleFetchFollowersActions);
}

export function* watchForFetchFollowingActions() {
    yield takeLatest(actionTypes.fetchFollowing, handleFetchFollowingActions);
}

export function* watchForFetchActivityFeedActions() {
    yield takeLatest(actionTypes.fetchActivityFeed, handleFetchActivityFeedActions);
}

// -----------------------------------------------------------------------------
// Action handlers
// -----------------------------------------------------------------------------

function* handleFollowUserActions(action) {
    try {
        const currentUserId = yield select((state) => state.identity.userId);

        const mutation = gql`
            mutation FollowUser($follower_id: uuid!, $following_id: uuid!) {
                insert_user_follows_one(object: {
                    follower_id: $follower_id,
                    following_id: $following_id
                }) {
                    created_at
                }
            }
        `;

        yield call(gqlFetch, currentUserId, mutation, {
            follower_id: currentUserId,
            following_id: action.userId
        });

        yield put(setFollowingStatus(action.userId, true));
    } catch (e) {
        handleException(e);
    }
}

function* handleUnfollowUserActions(action) {
    try {
        const currentUserId = yield select((state) => state.identity.userId);

        const mutation = gql`
            mutation UnfollowUser($follower_id: uuid!, $following_id: uuid!) {
                delete_user_follows(where: {
                    follower_id: {_eq: $follower_id},
                    following_id: {_eq: $following_id}
                }) {
                    affected_rows
                }
            }
        `;

        yield call(gqlFetch, currentUserId, mutation, {
            follower_id: currentUserId,
            following_id: action.userId
        });

        yield put(setFollowingStatus(action.userId, false));
    } catch (e) {
        handleException(e);
    }
}

function* handleFetchFollowersActions(action) {
    try {
        const currentUserId = yield select((state) => state.identity.userId);

        const query = gql`
            query GetFollowers($user_id: uuid!) {
                user_follows(where: {following_id: {_eq: $user_id}}) {
                    follower {
                        user_id
                        slug
                        email
                        profile_is_public
                        created_at
                    }
                }
            }
        `;

        const response = yield call(gqlFetch, currentUserId, query, {
            user_id: action.userId
        });

        const followers = response?.data?.user_follows?.map(f => f.follower) || [];
        yield put(setFollowers(followers));
    } catch (e) {
        handleException(e);
    }
}

function* handleFetchFollowingActions(action) {
    try {
        const currentUserId = yield select((state) => state.identity.userId);

        const query = gql`
            query GetFollowing($user_id: uuid!) {
                user_follows(where: {follower_id: {_eq: $user_id}}) {
                    following {
                        user_id
                        slug
                        email
                        profile_is_public
                        created_at
                    }
                }
            }
        `;

        const response = yield call(gqlFetch, currentUserId, query, {
            user_id: action.userId
        });

        const following = response?.data?.user_follows?.map(f => f.following) || [];
        yield put(setFollowing(following));
    } catch (e) {
        handleException(e);
    }
}

function* handleFetchActivityFeedActions(action) {
    try {
        const currentUserId = yield select((state) => state.identity.userId);
        const pageSize = yield select((state) => state.social.feedPageSize);
        const page = action.page !== undefined ? action.page : 0;

        // First get the list of users the current user is following
        const followingQuery = gql`
            query GetFollowingUsers($user_id: uuid!) {
                user_follows(where: {follower_id: {_eq: $user_id}}) {
                    following_id
                }
            }
        `;

        const followingResponse = yield call(gqlFetch, currentUserId, followingQuery, {
            user_id: currentUserId
        });

        const followingIds = followingResponse?.data?.user_follows?.map(f => f.following_id) || [];

        if (followingIds.length === 0) {
            yield put(setActivityFeed([], 0, page));
            return;
        }

        // Then fetch projects from those users with pagination
        const query = gql`
            query GetActivityFeed($user_ids: [uuid!], $limit: Int!, $offset: Int!) {
                project_aggregate(
                    where: {
                        owner_user_id: {_in: $user_ids},
                        is_public: {_eq: true}
                    }
                ) {
                    aggregate {
                        count
                    }
                }
                project(
                    where: {
                        owner_user_id: {_in: $user_ids},
                        is_public: {_eq: true}
                    },
                    order_by: {updated_at: desc},
                    limit: $limit,
                    offset: $offset
                ) {
                    project_id
                    title
                    slug
                    lang
                    is_public
                    created_at
                    updated_at
                    owner {
                        user_id
                        slug
                        greeting_name
                    }
                }
            }
        `;

        const response = yield call(gqlFetch, currentUserId, query, {
            user_ids: followingIds,
            limit: pageSize,
            offset: page * pageSize
        });

        const activities = response?.data?.project || [];
        const totalCount = response?.data?.project_aggregate?.aggregate?.count || 0;
        yield put(setActivityFeed(activities, totalCount, page));
    } catch (e) {
        handleException(e);
    }
}

