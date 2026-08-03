// The merged strip's positions are derived from the region and the active file
// on every render rather than stored, which is what makes the debug tab's
// arrival and departure - and files being added or deleted - safe. These pin
// that derivation, since getting it wrong shows up as the wrong panel.

import {PROJECT_TAB, stripActiveIndex, stripLayout, stripTarget} from "./projectTabs";

const EMULATOR = {key: 'emulator', tabIndex: PROJECT_TAB.emulator};
const DEBUG = {key: 'debug', tabIndex: PROJECT_TAB.debug};

// Tab mode: emulator, the main source, the extra files, "+", the debugger.
const merged = ({fileCount, hasAdd = true, debug = false}) => ({
    layout: stripLayout({leadingCount: 1, fileCount, hasAdd}),
    leading: [EMULATOR],
    trailing: debug ? [DEBUG] : [],
});

describe("the file strip on its own (split mode)", () => {
    // No outer tabs: every expression has to collapse to what the strip did
    // before the two were merged.
    const bare = (fileCount) => ({layout: stripLayout({fileCount, hasAdd: true})});

    it("puts the main source first and the files after it", () => {
        expect(stripActiveIndex({...bare(3), region: PROJECT_TAB.editor, activeFileIndex: -1}))
            .toBe(0);
        expect(stripActiveIndex({...bare(3), region: PROJECT_TAB.editor, activeFileIndex: 2}))
            .toBe(3);
    });

    it("ignores the region it is not showing", () => {
        // Split mode renders the strip whatever the region says, so a stale
        // region must not move it off the file the editor is showing.
        expect(stripActiveIndex({...bare(2), region: PROJECT_TAB.emulator, activeFileIndex: 1}))
            .toBe(2);
    });

    it("maps clicks back to files", () => {
        expect(stripTarget({...bare(2), index: 0})).toEqual({kind: 'file', fileIndex: -1});
        expect(stripTarget({...bare(2), index: 2})).toEqual({kind: 'file', fileIndex: 1});
        expect(stripTarget({...bare(2), index: 3})).toEqual({kind: 'add'});
    });
});

describe("the merged strip (tab mode)", () => {
    it("selects the emulator, the file, and the debugger by region", () => {
        const strip = merged({fileCount: 2, debug: true});
        expect(stripActiveIndex({...strip, region: PROJECT_TAB.emulator, activeFileIndex: -1}))
            .toBe(0);
        expect(stripActiveIndex({...strip, region: PROJECT_TAB.editor, activeFileIndex: -1}))
            .toBe(1);
        expect(stripActiveIndex({...strip, region: PROJECT_TAB.editor, activeFileIndex: 1}))
            .toBe(3);
        // emulator, main, 2 files, "+", debug
        expect(stripActiveIndex({...strip, region: PROJECT_TAB.debug, activeFileIndex: 1}))
            .toBe(5);
    });

    // The dock's tab appears a beat after the session starts and vanishes with
    // it, so the debug region can be set while the tab is not there.
    it("falls back to the active file when the debug tab is gone", () => {
        const strip = merged({fileCount: 1, debug: false});
        expect(stripActiveIndex({...strip, region: PROJECT_TAB.debug, activeFileIndex: 0}))
            .toBe(2);
    });

    it("keeps the debugger's position as files come and go", () => {
        for (const fileCount of [0, 1, 5]) {
            const strip = merged({fileCount, debug: true});
            const index = stripActiveIndex({
                ...strip, region: PROJECT_TAB.debug, activeFileIndex: -1,
            });
            expect(stripTarget({...strip, index}))
                .toEqual({kind: 'region', region: PROJECT_TAB.debug});
        }
    });

    it("maps clicks to the region or the file they landed on", () => {
        const strip = merged({fileCount: 2, debug: true});
        expect(stripTarget({...strip, index: 0}))
            .toEqual({kind: 'region', region: PROJECT_TAB.emulator});
        expect(stripTarget({...strip, index: 1})).toEqual({kind: 'file', fileIndex: -1});
        expect(stripTarget({...strip, index: 3})).toEqual({kind: 'file', fileIndex: 1});
        expect(stripTarget({...strip, index: 4})).toEqual({kind: 'add'});
        expect(stripTarget({...strip, index: 5}))
            .toEqual({kind: 'region', region: PROJECT_TAB.debug});
    });

    // A visitor, or a project at the file limit, has no "+": the debugger moves
    // down one and nothing else may shift with it.
    it("closes the gap when there is no add tab", () => {
        const strip = merged({fileCount: 2, hasAdd: false, debug: true});
        expect(stripTarget({...strip, index: 3})).toEqual({kind: 'file', fileIndex: 1});
        expect(stripTarget({...strip, index: 4}))
            .toEqual({kind: 'region', region: PROJECT_TAB.debug});
    });

    // Switching source files must not report a region: dispatching one pauses
    // the emulator, which is not what clicking a file tab means.
    it("reports a file, not a region, for every file tab", () => {
        const strip = merged({fileCount: 3, debug: true});
        for (const index of [1, 2, 3, 4]) {
            expect(stripTarget({...strip, index}).kind).toBe('file');
        }
    });
});
