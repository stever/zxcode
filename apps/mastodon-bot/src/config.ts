function trimSlash(url: string): string {
    return url.replace(/\/$/, '');
}

export const config = {
    instanceUrl: trimSlash(process.env.MASTODON_INSTANCE_URL ?? ''),
    accessToken: process.env.MASTODON_ACCESS_TOKEN ?? '',
    gifServiceUrl: trimSlash(process.env.GIF_SERVICE_URL ?? 'http://localhost:5001'),
    projectHost: (process.env.PROJECT_HOST ?? 'code.zxplay.org').replace(/^https?:\/\//, '').replace(/\/$/, ''),
    stateFile: process.env.STATE_FILE ?? './state.json',
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS ?? '15000', 10),
    maxSeconds: parseInt(process.env.MAX_SECONDS ?? '30', 10),
    maxMediaBytes: parseInt(process.env.MAX_MEDIA_BYTES ?? '8000000', 10),
    replyCaption: process.env.REPLY_CAPTION ?? '#ZXPlay',
    dryRun: process.env.DRY_RUN === 'true',
};

/** Throw early if the runtime credentials needed to talk to Mastodon are absent. */
export function assertRuntimeConfig(): void {
    if (!config.instanceUrl) throw new Error('MASTODON_INSTANCE_URL is required');
    if (!config.accessToken) throw new Error('MASTODON_ACCESS_TOKEN is required');
}
