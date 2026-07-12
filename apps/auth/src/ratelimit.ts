// In-memory sliding-window rate limiter for the magic-link request endpoint.
// Fine for the single-instance deploy; counters move to the database if the
// auth service ever scales out.

const windows = new Map<string, number[]>();

const PRUNE_INTERVAL_MS = 60_000;
let lastPrune = 0;

function prune(now: number, windowMs: number): void {
    if (now - lastPrune < PRUNE_INTERVAL_MS) return;
    lastPrune = now;
    for (const [key, hits] of windows) {
        const live = hits.filter((t) => now - t < windowMs);
        if (live.length === 0) windows.delete(key);
        else windows.set(key, live);
    }
}

// Records the hit and reports whether it is within the limit.
export function allow(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    prune(now, windowMs);
    const hits = (windows.get(key) ?? []).filter((t) => now - t < windowMs);
    hits.push(now);
    windows.set(key, hits);
    return hits.length <= limit;
}

export function resetForTests(): void {
    windows.clear();
    lastPrune = 0;
}
