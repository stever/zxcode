import { config } from './config.js';
import { MachineType } from './directives.js';
import { ProjectRef } from './project.js';

export type MediaResult =
    | { ok: true; data: Buffer; contentType: string; filename: string; altText: string }
    | { ok: false; error: string };

/**
 * POST a render request to gif-service and shape the response into a MediaResult.
 *
 * Bounded by an AbortController: a hung or unreachable renderer becomes an
 * ok:false result (caller replies) rather than an unbounded await that wedges
 * the poll loop. The timer covers the body download too, not just the headers.
 */
async function requestMedia(
    path: string,
    body: unknown,
    altText: string,
    params: Record<string, string> = {},
): Promise<MediaResult> {
    const query = new URLSearchParams({ maxSeconds: String(config.maxSeconds), ...params });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.gifServiceTimeoutMs);
    try {
        const res = await fetch(`${config.gifServiceUrl}${path}?${query}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
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
    } catch (err) {
        if (controller.signal.aborted) {
            return { ok: false, error: `Renderer timed out after ${config.gifServiceTimeoutMs / 1000}s` };
        }
        return { ok: false, error: 'Could not reach the renderer' };
    } finally {
        clearTimeout(timer);
    }
}

// Serialise the machine into the gif-service query. String(128) → "128",
// String('next') → "next" — exactly the values the render routes expect.
function machineParam(machineType?: MachineType): Record<string, string> {
    return machineType ? { machineType: String(machineType) } : {};
}

/** Compile and run inline source (BASIC, Boriel, asm, …) via gif-service. */
export function sourceToMedia(
    code: string,
    lang: string,
    machineType?: MachineType,
): Promise<MediaResult> {
    return requestMedia('/api/source-to-mp4', { code, lang }, code, machineParam(machineType));
}

/** Compile and run Sinclair BASIC via gif-service. */
export function basicToMedia(code: string): Promise<MediaResult> {
    return sourceToMedia(code, 'basic');
}

/** Render a public code.zxplay.org project via gif-service. */
export function projectToMedia(ref: ProjectRef, machineType?: MachineType): Promise<MediaResult> {
    return requestMedia(
        '/api/project-to-mp4',
        { userSlug: ref.userSlug, projectSlug: ref.projectSlug },
        `${config.projectHost}/u/${ref.userSlug}/${ref.projectSlug}`,
        machineParam(machineType),
    );
}
