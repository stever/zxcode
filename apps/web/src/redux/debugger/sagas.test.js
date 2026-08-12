// The pause-follow saga switches the editor to the file a debug pause
// landed in. Files are identified by their full folder/name path — the
// same key the source maps and breakpoints use — so files living in
// folders (lib/util.h) must match on the joined path, not the bare name.
// errors.jsx drags in the whole store (router, browser history), which
// jsdom-less jest can't load; the saga only uses its handleException.
jest.mock("../../errors", () => ({handleException: jest.fn()}));

import {watchForPausedFileFollow} from "./sagas";
import {debugSnapshot} from "./actions";
import {setActiveFile} from "../project/actions";

// The handler is deliberately unexported (store.js runs every export of a
// sagas module as a root saga); pull it out of the watcher's takeEvery.
const handlePausedFileFollow =
    watchForPausedFileFollow().next().value.payload.args[1];

const FILES = [
    {id: "f1", folder: "lib", name: "util.h", isBinary: false},
    {id: "f2", folder: null, name: "util.h", isBinary: false},
    {id: "f3", folder: "lib", name: "data.bin", isBinary: true},
];

// Drive the generator by hand: it yields two selects (files, activeFileId)
// and then optionally a put.
function run(snapshot, {files = FILES, activeFileId = null} = {}) {
    const gen = handlePausedFileFollow(debugSnapshot(snapshot));
    const effects = [];
    let step = gen.next();
    if (step.done) return effects;
    step = gen.next(files);          // first select -> project files
    if (step.done) return effects;
    step = gen.next(activeFileId);   // second select -> active file id
    while (!step.done) {
        effects.push(step.value);
        step = gen.next();
    }
    return effects;
}

describe("handlePausedFileFollow", () => {
    test("switches to a foldered file by its joined path", () => {
        const effects = run({pausedLine: 5, pausedFile: "lib/util.h"});
        expect(effects).toEqual([expect.objectContaining({
            payload: expect.objectContaining({action: setActiveFile("f1")}),
        })]);
    });

    test("a root-level file with the same name is not mistaken for it", () => {
        const effects = run({pausedLine: 5, pausedFile: "util.h"});
        expect(effects).toEqual([expect.objectContaining({
            payload: expect.objectContaining({action: setActiveFile("f2")}),
        })]);
    });

    test("returns to the main source on pausedFile null", () => {
        const effects = run(
            {pausedLine: 3, pausedFile: null}, {activeFileId: "f1"});
        expect(effects).toEqual([expect.objectContaining({
            payload: expect.objectContaining({action: setActiveFile(null)}),
        })]);
    });

    test("no-op when the paused file is already active (joined comparison)", () => {
        const effects = run(
            {pausedLine: 5, pausedFile: "lib/util.h"}, {activeFileId: "f1"});
        expect(effects).toEqual([]);
    });

    test("no-op for unknown files, binaries and unmapped pauses", () => {
        expect(run({pausedLine: 5, pausedFile: "other/none.h"})).toEqual([]);
        expect(run({pausedLine: 5, pausedFile: "lib/data.bin"})).toEqual([]);
        expect(run({pausedLine: null, pausedFile: null})).toEqual([]);
    });
});
