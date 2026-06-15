import { config } from './config.js';

export type GifResult =
    | { ok: true; gif: Buffer }
    | { ok: false; error: string };

/** Compile and run BASIC via gif-service, returning the GIF or a user-facing error. */
export async function basicToGif(code: string): Promise<GifResult> {
    const url = `${config.gifServiceUrl}/api/basic-to-gif?maxSeconds=${config.maxSeconds}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
    });

    if (res.ok) {
        return { ok: true, gif: Buffer.from(await res.arrayBuffer()) };
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
