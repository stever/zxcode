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
    setFeedPage: 'social/setFeedPage',
    setFeedLoading: 'social/setFeedLoading',

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
export const fetchActivityFeed = (page = 0) => ({
    type: actionTypes.fetchActivityFeed,
    page
});

export const setActivityFeed = (activities, totalCount, page) => ({
    type: actionTypes.setActivityFeed,
    activities,
    totalCount,
    page
});

export const refreshActivityFeed = () => ({
    type: actionTypes.refreshActivityFeed
});

export const setFeedPage = (page) => ({
    type: actionTypes.setFeedPage,
    page
});

export const setFeedLoading = (loading) => ({
    type: actionTypes.setFeedLoading,
    loading
});

// Counts
export const setFollowCounts = (userId, followersCount, followingCount) => ({
    type: actionTypes.setFollowCounts,
    userId,
    followersCount,
    followingCount
});