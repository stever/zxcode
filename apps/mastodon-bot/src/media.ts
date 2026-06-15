import { config } from './config.js';
import { ProjectRef } from './project.js';

export type MediaResult =
    | { ok: true; data: Buffer; contentType: string; filename: string; altText: string }
    | { ok: false; error: string };

/** POST a render request to gif-service and shape the response into a MediaResult. */
async function requestMedia(
    path: string,
    body: unknown,
    altText: string,
    params: Record<string, string> = {},
): Promise<MediaResult> {
    const query = new URLSearchParams({ maxSeconds: String(config.maxSeconds), ...params });
    const res = await fetch(`${config.gifServiceUrl}${path}?${query}`, {
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

function machineParam(machineType?: number): Record<string, string> {
    return machineType ? { machineType: String(machineType) } : {};
}

/** Compile and run inline source (BASIC or asm) via gif-service. */
export function sourceToMedia(
    code: string,
    lang: string,
    machineType?: number,
): Promise<MediaResult> {
    return requestMedia('/api/source-to-mp4', { code, lang }, code, machineParam(machineType));
}

/** Compile and run Sinclair BASIC via gif-service. */
export function basicToMedia(code: string): Promise<MediaResult> {
    return sourceToMedia(code, 'basic');
}

/** Render a public code.zxplay.org project via gif-service. */
export function projectToMedia(ref: ProjectRef, machineType?: number): Promise<MediaResult> {
    return requestMedia(
        '/api/project-to-mp4',
        { userSlug: ref.userSlug, projectSlug: ref.projectSlug },
        `${config.projectHost}/u/${ref.userSlug}/${ref.projectSlug}`,
        machineParam(machineType),
    );
}
