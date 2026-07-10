// Adapters from the store's project files ({id, name, content, savedContent,
// isBinary}) to what the compile back ends expect. The current draft content
// is sent, matching the main source which also compiles unsaved.

// Shape for the Hasura compile actions' ProjectFileInput.
export function toActionFiles(files) {
    return (files || []).map((f) => ({
        name: f.name,
        content: f.content,
        is_binary: Boolean(f.isBinary),
    }));
}

// Shape for the emulator's SD-card staging ({name, data: Uint8Array}) — the
// files a NextBASIC program LOADs at runtime, written to the card root next
// to the program itself (/zx.bas). Text files are encoded as UTF-8 bytes.
export function toSdFiles(files) {
    return (files || []).map((f) => ({
        name: f.name,
        // noinspection JSDeprecatedSymbols
        data: f.isBinary
            ? Uint8Array.from(atob(f.content), (c) => c.charCodeAt(0))
            : new TextEncoder().encode(f.content),
    }));
}

// The Next's SD card is FAT: a staged file's name must fit 8.3 or the card
// stores it under a ~ alias the program's literal LOAD name would never
// match. Project names are already limited to [A-Za-z0-9._-] (all FAT-legal
// and case-insensitive on the card), so only the 8/3 lengths and the single
// dot need checking. Returns the offending names, empty when all fit.
export function sdFileNameErrors(files) {
    return (files || [])
        .map((f) => f.name)
        .filter((name) => !/^[^.]{1,8}(\.[^.]{1,3})?$/.test(name));
}

// Shape for the 8bitworker's WorkerFileUpdate ({path, data}). Binary assets
// are decoded from base64 so the tool FS sees the raw bytes.
export function toWorkerUpdates(files) {
    return (files || []).map((f) => ({
        path: f.name,
        // noinspection JSDeprecatedSymbols
        data: f.isBinary
            ? Uint8Array.from(atob(f.content), (c) => c.charCodeAt(0))
            : f.content,
    }));
}
