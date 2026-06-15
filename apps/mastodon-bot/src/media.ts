import { config } from './config.js';
import { ProjectRef } from './project.js';

export type MediaResult =
    | { ok: true; data: Buffer; contentType: string; filename: string; altText: string }
    | { ok: false; error: string };

/** POST a render request to gif-service and shape the response into a MediaResult. */
async function requestMedia(path: string, body: unknown, altText: string): Promise<MediaResult> {
    const url = `${config.gifServiceUrl}${path}?maxSeconds=${config.maxSeconds}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    if (res.ok) {
        return {
            ok: true,
            data: Buffer.from(await res.arrayBuffer()),
            contentType: 'video/mp4',
            filename: 'program.mp4',
            altText,
        };
    }

    let detail = '';
    try {
        const errorBody = (await res.json()) as { error?: string; detail?: string };
        detail = errorBody.detail || errorBody.error || '';
    } catch {
        detail = '';
    }
    return { ok: false, error: detail || `gif-service returned ${res.status}` };
}

/** Compile and run BASIC via gif-service, returning an MP4 or a user-facing error. */
export function basicToMedia(code: string): Promise<MediaResult> {
    return requestMedia('/api/basic-to-mp4', { code }, code);
}

/** Render a public code.zxplay.org project via gif-service, returning an MP4 or an error. */
export function projectToMedia(ref: ProjectRef): Promise<MediaResult> {
    return requestMedia(
        '/api/project-to-mp4',
        ref,
        `${config.projectHost}/u/${ref.userSlug}/${ref.projectSlug}`,
    );
}
