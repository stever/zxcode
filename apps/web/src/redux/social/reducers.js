import { actionTypes } from "./actions";

// -----------------------------------------------------------------------------
// Initial state
// -----------------------------------------------------------------------------

const initialState = {
    // Following status for users (keyed by userId)
    followingStatus: {},

    // Follow counts for users (keyed by userId)
    followCounts: {},

    // Lists
    followers: [],
    following: [],

    // Activity feed
    activityFeed: [],
    feedLoading: false,
    feedPage: 0,
    feedTotalCount: 0,
    feedPageSize: 20,
};

// -----------------------------------------------------------------------------
// Actions
// -----------------------------------------------------------------------------

function setFollowingStatus(state, action) {
    return {
        ...state,
        followingStatus: {
            ...state.followingStatus,
            [action.userId]: action.isFollowing
        }
    };
}

function setFollowers(state, action) {
    return {
        ...state,
        followers: action.followers
    };
}

function setFollowing(state, action) {
    return {
        ...state,
        following: action.following
    };
}

function setActivityFeed(state, action) {
    return {
        ...state,
        activityFeed: action.activities,
        feedLoading: false,
        feedTotalCount: action.totalCount || 0,
        feedPage: action.page !== undefined ? action.page : state.feedPage
    };
}

function setFollowCounts(state, action) {
    return {
        ...state,
        followCounts: {
            ...state.followCounts,
            [action.userId]: {
                followers: action.followersCount,
                following: action.followingCount
            }
        }
    };
}

function setFeedPage(state, action) {
    return {
        ...state,
        feedPage: action.page
    };
}

function setFeedLoading(state, action) {
    return {
        ...state,
        feedLoading: action.loading
    };
}

// -----------------------------------------------------------------------------
// Reducer
// -----------------------------------------------------------------------------

const actionsMap = {
    [actionTypes.setFollowingStatus]: setFollowingStatus,
    [actionTypes.setFollowers]: setFollowers,
    [actionTypes.setFollowing]: setFollowing,
    [actionTypes.setActivityFeed]: setActivityFeed,
    [actionTypes.setFollowCounts]: setFollowCounts,
    [actionTypes.setFeedPage]: setFeedPage,
    [actionTypes.setFeedLoading]: setFeedLoading,
    [actionTypes.fetchActivityFeed]: (state) => ({ ...state, feedLoading: true }),
};

export default function reducer(state = initialState, action) {
    const reducerFunction = actionsMap[action.type];
    return reducerFunction ? reducerFunction(state, action) : state;
}