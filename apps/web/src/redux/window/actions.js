export const actionTypes = {
    resized: 'window/resized',
};

export const resized = (width, height) => ({
    type: actionTypes.resized,
    width,
    height,
});
