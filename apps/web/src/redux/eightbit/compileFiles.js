// Adapters from the store's project files ({id, name, folder, content,
// savedContent, isBinary}) to what the compile back ends expect. Files are
// identified by their relative path (folder/name) everywhere downstream —
// compile workdirs, worker VFS, SD card — matching the project ZIP's layout,
// so code references them by the same path in every world. The current draft
// content is sent, matching the main source which also compiles unsaved.
import {joinProjectFilePath} from "../../lib/lang";

// Shape for the Hasura compile actions' ProjectFileInput. name carries the
// relative path; the services stage it under the workdir (creating folders)
// so INCLUDE/#include/{$I} resolve it against the main source's directory.
export function toActionFiles(files) {
    return (files || []).map((f) => ({
        name: joinProjectFilePath(f.folder, f.name),
        content: f.content,
        is_binary: Boolean(f.isBinary),
    }));
}

// Shape for the emulator's SD-card staging ({name, data: Uint8Array}) — the
// files a NextBASIC program LOADs at runtime. name is the path relative to
// the card root; the core creates the folders, so the card matches the
// project ZIP unzipped onto real hardware. Text files are encoded as UTF-8.
export function toSdFiles(files) {
    return (files || []).map((f) => ({
        name: joinProjectFilePath(f.folder, f.name),
        // noinspection JSDeprecatedSymbols
        data: f.isBinary
            ? Uint8Array.from(atob(f.content), (c) => c.charCodeAt(0))
            : new TextEncoder().encode(f.content),
    }));
}

// The Next's SD card is FAT: every segment of a staged file's path (folders
// included) must fit 8.3, or the card stores it under a ~ alias the
// program's literal LOAD path would never match. Path segments are already
// limited to [A-Za-z0-9._-] (all FAT-legal and case-insensitive on the
// card), so only the 8/3 lengths and the single dot need checking per
// segment. Returns the offending paths, empty when all fit.
const FAT_83_SEGMENT_RE = /^[^.]{1,8}(\.[^.]{1,3})?$/;

export function sdFileNameErrors(files) {
    return (files || [])
        .map((f) => joinProjectFilePath(f.folder, f.name))
        .filter((path) => !path.split("/").every((seg) => FAT_83_SEGMENT_RE.test(seg)));
}

// Shape for the 8bitworker's WorkerFileUpdate ({path, data}). Binary assets
// are decoded from base64 so the tool FS sees the raw bytes.
export function toWorkerUpdates(files) {
    return (files || []).map((f) => ({
        path: joinProjectFilePath(f.folder, f.name),
        // noinspection JSDeprecatedSymbols
        data: f.isBinary
            ? Uint8Array.from(atob(f.content), (c) => c.charCodeAt(0))
            : f.content,
    }));
}
