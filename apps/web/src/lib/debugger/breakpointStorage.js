// Per-project breakpoint persistence (#104): one localStorage key holds a
// JSON map of project id → {breakpoints, addrBreakpoints}, so dots survive a
// page refresh. The debugger reducer restores a project's entry when the
// project loads and rewrites it on every breakpoint change; an entry with no
// breakpoints left is deleted rather than stored empty. Saved dots need no
// migration on rename/delete of files: the next compile's source map
// re-anchors them and drops orphans, exactly as it does for live dots.

const STORAGE_KEY = 'projectBreakpoints';

function readAll() {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
            const parsed = JSON.parse(saved);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return parsed;
            }
        }
    } catch (e) {
        console.error('Failed to load saved breakpoints:', e);
    }
    return {};
}

// The stored shape is trusted no further than its types: anything that is
// not a {file: string|null, line: positive int} or a positive-int address
// is dropped, and both lists come back in the reducer's sort order.
function sanitize(entry) {
    const breakpoints = (Array.isArray(entry?.breakpoints) ? entry.breakpoints : [])
        .filter((bp) => bp && typeof bp === 'object'
            && Number.isInteger(bp.line) && bp.line >= 1
            && (bp.file === null || typeof bp.file === 'string'))
        .map((bp) => ({file: bp.file, line: bp.line}))
        .sort((a, b) => (a.file ?? '').localeCompare(b.file ?? '') || a.line - b.line);
    const addrBreakpoints = (Array.isArray(entry?.addrBreakpoints) ? entry.addrBreakpoints : [])
        .filter((a) => Number.isInteger(a) && a >= 0)
        .sort((a, b) => a - b);
    return {breakpoints, addrBreakpoints};
}

export function loadProjectBreakpoints(projectId) {
    return sanitize(readAll()[projectId]);
}

export function saveProjectBreakpoints(projectId, breakpoints, addrBreakpoints) {
    if (!projectId) return;
    try {
        const all = readAll();
        if (breakpoints.length === 0 && addrBreakpoints.length === 0) {
            if (!(projectId in all)) return;
            delete all[projectId];
        } else {
            all[projectId] = {
                breakpoints: breakpoints.map((bp) => ({file: bp.file, line: bp.line})),
                addrBreakpoints: [...addrBreakpoints],
            };
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    } catch (e) {
        console.error('Failed to save breakpoints:', e);
    }
}
