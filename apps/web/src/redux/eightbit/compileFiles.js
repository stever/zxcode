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
