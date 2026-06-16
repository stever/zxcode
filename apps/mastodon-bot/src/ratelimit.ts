// In-memory sliding-window rate limiter, keyed by account. State is per-process
// (resets on restart), which is fine: the bot is a single instance and this only
// needs to blunt a flood of mentions from one account, not enforce hard quotas.
const hits = new Map<string, number[]>();
const WINDOW_MS = 3_600_000; // one hour

/**
 * Record an attempt for `key` and report whether it is within `limit` over the
 * past hour. Returns false (and does not record) once the limit is reached.
 */
export function allowRequest(key: string, limit: number): boolean {
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
    if (recent.length >= limit) {
        hits.set(key, recent);
        return false;
    }
    recent.push(now);
    hits.set(key, recent);
    return true;
}
