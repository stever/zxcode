export const actionTypes = {
    // Follow/Unfollow actions
    followUser: 'social/followUser',
    unfollowUser: 'social/unfollowUser',
    setFollowingStatus: 'social/setFollowingStatus',

    // Followers/Following lists
    fetchFollowers: 'social/fetchFollowers',
    fetchFollowing: 'social/fetchFollowing',
    setFollowers: 'social/setFollowers',
    setFollowing: 'social/setFollowing',

    // Activity feed
    fetchActivityFeed: 'social/fetchActivityFeed',
    setActivityFeed: 'social/setActivityFeed',
    refreshActivityFeed: 'social/refreshActivityFeed',

    // Counts
    setFollowCounts: 'social/setFollowCounts',
};

// Follow/Unfollow actions
export const followUser = (userId) => ({
    type: actionTypes.followUser,
    userId
});

export const unfollowUser = (userId) => ({
    type: actionTypes.unfollowUser,
    userId
});

export const setFollowingStatus = (userId, isFollowing) => ({
    type: actionTypes.setFollowingStatus,
    userId,
    isFollowing
});

// Followers/Following lists
export const fetchFollowers = (userId) => ({
    type: actionTypes.fetchFollowers,
    userId
});

export const fetchFollowing = (userId) => ({
    type: actionTypes.fetchFollowing,
    userId
});

export const setFollowers = (followers) => ({
    type: actionTypes.setFollowers,
    followers
});

export const setFollowing = (following) => ({
    type: actionTypes.setFollowing,
    following
});

// Activity feed
export const fetchActivityFeed = () => ({
    type: actionTypes.fetchActivityFeed
});

export const setActivityFeed = (activities) => ({
    type: actionTypes.setActivityFeed,
    activities
});

export const refreshActivityFeed = () => ({
    type: actionTypes.refreshActivityFeed
});

// Counts
export const setFollowCounts = (userId, followersCount, followingCount) => ({
    type: actionTypes.setFollowCounts,
    userId,
    followersCount,
    followingCount
});