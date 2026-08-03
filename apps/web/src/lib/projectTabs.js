// Tab mode shows ONE strip -- emulator, the project's files, and the debugger --
// where it used to stack a page-level strip on top of the file strip, costing
// ~92px of height before any code was visible. Split mode still shows the file
// strip alone.
//
// Two pieces of state decide what is selected, and neither changes here:
// selectedTabIndex names the REGION (emulator / editor / debug) and activeFileId
// names the file within the editor region. The strip position is derived from
// the pair on every render and never stored, so a file being added or the
// debugger's tab appearing cannot strand a stale index.

export const PROJECT_TAB = {emulator: 0, editor: 1, debug: 2};

/**
 * Where each group of headers starts in the merged strip.
 * @param {{leadingCount?:Number, fileCount:Number, hasAdd?:Boolean}} params
 * @returns {{fileStart:Number, addIndex:Number, trailStart:Number}}
 */
export function stripLayout({leadingCount = 0, fileCount, hasAdd = false}) {
    const fileStart = leadingCount;
    // The main source is the first file header, then one per additional file.
    const afterFiles = fileStart + fileCount + 1;
    return {
        fileStart,
        addIndex: hasAdd ? afterFiles : -1,
        trailStart: hasAdd ? afterFiles + 1 : afterFiles,
    };
}

/**
 * The strip position showing right now.
 *
 * An outer tab is showing only when the region names one that is actually
 * present; otherwise the strip shows the active file, which is what makes the
 * debug tab's arrival and departure safe.
 *
 * @param {{layout:Object, leading:Array, trailing:Array, region:Number,
 *          activeFileIndex:Number}} params
 * @returns {Number}
 */
export function stripActiveIndex({layout, leading = [], trailing = [], region, activeFileIndex}) {
    const leadAt = leading.findIndex((tab) => tab.tabIndex === region);
    if (leadAt >= 0) return leadAt;
    const trailAt = trailing.findIndex((tab) => tab.tabIndex === region);
    if (trailAt >= 0) return layout.trailStart + trailAt;
    return layout.fileStart + (activeFileIndex < 0 ? 0 : activeFileIndex + 1);
}

/**
 * What a click on a strip position means.
 *
 * The caller must dispatch the region only when it actually CHANGES: setting it
 * pauses the emulator (redux/project/sagas.js), so doing it on every file-tab
 * click would silently stop the machine when you switch source files.
 *
 * @param {{layout:Object, leading:Array, trailing:Array, index:Number}} params
 * @returns {{kind:'add'|'region'|'file', region?:Number, fileIndex?:Number}}
 *          fileIndex is -1 for the main source.
 */
export function stripTarget({layout, leading = [], trailing = [], index}) {
    if (index === layout.addIndex) return {kind: 'add'};
    if (index < layout.fileStart) {
        return {kind: 'region', region: leading[index].tabIndex};
    }
    if (index >= layout.trailStart && trailing.length > 0) {
        return {kind: 'region', region: trailing[index - layout.trailStart].tabIndex};
    }
    // Within the files: the first header is the main source.
    return {kind: 'file', fileIndex: index - layout.fileStart - 1};
}
