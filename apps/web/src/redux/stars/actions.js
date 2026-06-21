export const actionTypes = {
    starProject: 'stars/starProject',
    unstarProject: 'stars/unstarProject',
    setStarredStatus: 'stars/setStarredStatus',
};

export const starProject = (projectId) => ({
    type: actionTypes.starProject,
    projectId
});

export const unstarProject = (projectId) => ({
    type: actionTypes.unstarProject,
    projectId
});

export const setStarredStatus = (projectId, isStarred) => ({
    type: actionTypes.setStarredStatus,
    projectId,
    isStarred
});
