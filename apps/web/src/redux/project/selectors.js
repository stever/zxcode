// Shared selectors for project state. Dirty-tracking must consider both the
// main source (code vs savedCode) and every additional file's draft content,
// so all "unsaved changes" checks go through here.

export const selectHasUnsavedChanges = (state) =>
    state?.project.code !== state?.project.savedCode ||
    (state?.project.files || []).some((f) => f.content !== f.savedContent);

export const selectFiles = (state) => state?.project.files || [];

// The active editor buffer: null activeFileId means the main source file.
export const selectActiveFile = (state) => {
    const fileId = state?.project.activeFileId;
    if (fileId === null || fileId === undefined) return null;
    return selectFiles(state).find((f) => f.id === fileId) || null;
};
