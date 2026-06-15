import { config } from './config.js';

export type MediaResult =
    | { ok: true; data: Buffer; contentType: string; filename: string }
    | { ok: false; error: string };

/** Compile and run BASIC via gif-service, returning an MP4 or a user-facing error. */
export async function basicToMedia(code: string): Promise<MediaResult> {
    const url = `${config.gifServiceUrl}/api/basic-to-mp4?maxSeconds=${config.maxSeconds}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
    });

    if (res.ok) {
        return {
            ok: true,
            data: Buffer.from(await res.arrayBuffer()),
            contentType: 'video/mp4',
            filename: 'program.mp4',
        };
    }

    let detail = '';
    try {
        const body = (await res.json()) as { error?: string; detail?: string };
        detail = body.detail || body.error || '';
    } catch {
        detail = '';
    }
    return { ok: false, error: detail || `gif-service returned ${res.status}` };
}
