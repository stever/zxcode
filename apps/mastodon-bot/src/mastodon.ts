import { config } from './config.js';

export type Visibility = 'public' | 'unlisted' | 'private' | 'direct';

export interface MastodonAccount {
    id: string;
    acct: string;
    username: string;
    bot?: boolean;
}

export interface MastodonStatus {
    id: string;
    content: string;
    visibility: Visibility;
    account: MastodonAccount;
}

export interface MastodonNotification {
    id: string;
    type: string;
    status?: MastodonStatus;
    account: MastodonAccount;
}

interface MediaAttachment {
    id: string;
    url: string | null;
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${config.accessToken}` };
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${config.instanceUrl}${path}`, init);
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`${init?.method ?? 'GET'} ${path} -> ${res.status} ${body.slice(0, 200)}`);
    }
    return res.json() as Promise<T>;
}

export async function verifyCredentials(): Promise<MastodonAccount> {
    return api<MastodonAccount>('/api/v1/accounts/verify_credentials', { headers: authHeaders() });
}

/**
 * Fetch mention notifications newer than `sinceId`, oldest first so the caller
 * can advance its high-water mark safely as it processes each one.
 */
export async function fetchMentions(sinceId: string | null): Promise<MastodonNotification[]> {
    const params = new URLSearchParams({ limit: '20' });
    params.append('types[]', 'mention');
    if (sinceId) params.set('since_id', sinceId);
    const notifications = await api<MastodonNotification[]>(
        `/api/v1/notifications?${params.toString()}`,
        { headers: authHeaders() },
    );
    return notifications.reverse();
}

/** Upload media, waiting for server-side processing, and return its media id. */
export async function uploadMedia(
    data: Buffer,
    contentType: string,
    filename: string,
    description: string,
): Promise<string> {
    const form = new FormData();
    form.append('file', new Blob([data], { type: contentType }), filename);
    if (description) {
        form.append('description', description.slice(0, 1400));
    }
    const created = await api<MediaAttachment>('/api/v2/media', {
        method: 'POST',
        headers: authHeaders(),
        body: form,
    });
    // v2 media may return with url=null while the server processes it. Video
    // transcoding can take longer than images, so allow up to ~60s.
    let media = created;
    for (let i = 0; i < 60 && !media.url; i++) {
        await sleep(1000);
        media = await api<MediaAttachment>(`/api/v1/media/${created.id}`, { headers: authHeaders() });
    }
    return created.id;
}

export interface PostReplyParams {
    inReplyToId: string;
    statusText: string;
    mediaIds?: string[];
    visibility: Visibility;
}

export async function postReply(params: PostReplyParams): Promise<MastodonStatus> {
    return api<MastodonStatus>('/api/v1/statuses', {
        method: 'POST',
        headers: {
            ...authHeaders(),
            'Content-Type': 'application/json',
            // Guards against duplicate replies if a retry happens after a partial failure.
            'Idempotency-Key': `reply-${params.inReplyToId}`,
        },
        body: JSON.stringify({
            status: params.statusText,
            in_reply_to_id: params.inReplyToId,
            media_ids: params.mediaIds,
            visibility: params.visibility,
        }),
    });
}
