// Cap concurrent renders. A profile grid requests many screenshots at once;
// without this, N simultaneous compile+emulate+ffmpeg pipelines blow the
// container's memory limit and it gets OOM-killed (clients see 502s). Queuing
// keeps peak memory bounded — the cache makes the wait a one-time cost.
const MAX = parseInt(process.env.MAX_CONCURRENT_RENDERS ?? '2', 10);

let active = 0;
const waiters: Array<() => void> = [];

export async function withRenderSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= MAX) {
        await new Promise<void>((resolve) => waiters.push(resolve));
    }
    active++;
    try {
        return await fn();
    } finally {
        active--;
        waiters.shift()?.();
    }
}
