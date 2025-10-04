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
        feedLoading: false
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

// -----------------------------------------------------------------------------
// Reducer
// -----------------------------------------------------------------------------

const actionsMap = {
    [actionTypes.setFollowingStatus]: setFollowingStatus,
    [actionTypes.setFollowers]: setFollowers,
    [actionTypes.setFollowing]: setFollowing,
    [actionTypes.setActivityFeed]: setActivityFeed,
    [actionTypes.setFollowCounts]: setFollowCounts,
};

export default function reducer(state = initialState, action) {
    const reducerFunction = actionsMap[action.type];
    return reducerFunction ? reducerFunction(state, action) : state;
}