import { CompileError } from './errors.js';

// gif-service talks to Hasura as the unauthenticated `public` role: that role
// can read public projects (its select permission filters to is_public = true)
// and call the compile / compileC actions. No admin secret is sent, so the
// service keeps holding no secrets.
const HASURA_URL = process.env.HASURA_URL ?? 'http://hasura:8080/v1/graphql';
// Cap every Hasura call so a hung upstream compiler (zxbasic/z88dk) or a slow
// lookup can't tie up a request indefinitely.
const HASURA_TIMEOUT_MS = parseInt(process.env.HASURA_TIMEOUT_MS ?? '20000', 10);

interface GraphQLResponse<T> {
    data?: T;
    errors?: Array<{ message: string }>;
}

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HASURA_TIMEOUT_MS);
    try {
        const res = await fetch(HASURA_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, variables }),
            signal: controller.signal,
        });
        if (!res.ok) {
            throw new Error(`Hasura returned ${res.status}`);
        }
        const body = (await res.json()) as GraphQLResponse<T>;
        if (body.errors?.length) {
            throw new Error(body.errors.map((e) => e.message).join('; '));
        }
        if (!body.data) {
            throw new Error('Hasura returned no data');
        }
        return body.data;
    } catch (err) {
        if (controller.signal.aborted) {
            throw new Error(`Hasura request timed out after ${HASURA_TIMEOUT_MS}ms`);
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

// Additional project file (include source or base64 binary asset) forwarded
// to the compile actions so they can stage it next to the main source.
export interface ProjectFileRecord {
    name: string;
    content: string;
    is_binary: boolean;
}

const PROJECT_FILES_SELECTION = 'files(order_by: { name: asc }) { name content is_binary }';

export interface ProjectRecord {
    lang: string;
    code: string;
    title: string;
    files: ProjectFileRecord[];
}

export interface ProjectById {
    lang: string;
    code: string;
    machine: string;
    updated_at: string;
    files: ProjectFileRecord[];
}

/**
 * Look up a public project by id (for screenshots). Returns null when missing or
 * private (the `public` role filters to is_public). `updated_at` is the cache key
 * component so a screenshot self-invalidates when the project is edited.
 */
export async function fetchProjectById(projectId: string): Promise<ProjectById | null> {
    const query = `
        query ($id: uuid!) {
            project(where: { project_id: { _eq: $id } }, limit: 1) {
                lang
                code
                machine
                updated_at
                ${PROJECT_FILES_SELECTION}
            }
        }
    `;
    const data = await gql<{ project: ProjectById[] }>(query, { id: projectId });
    return data.project[0] ?? null;
}

/**
 * Look up a public project from its canonical /u/<userSlug>/<projectSlug> URL.
 *
 * Project slug is unique only per owner (user slug is globally unique), so the
 * lookup is scoped by the owner relationship rather than projectSlug alone.
 * Returns null when the project is missing or private: the `public` role's
 * select permission filters to is_public, so a private project is simply absent
 * rather than an error.
 */
export async function fetchProject(
    userSlug: string,
    projectSlug: string,
): Promise<ProjectRecord | null> {
    const query = `
        query ($userSlug: String!, $projectSlug: String!) {
            project(
                where: { slug: { _eq: $projectSlug }, owner: { slug: { _eq: $userSlug } } }
                limit: 1
            ) {
                lang
                code
                title
                ${PROJECT_FILES_SELECTION}
            }
        }
    `;
    const data = await gql<{ project: ProjectRecord[] }>(query, { userSlug, projectSlug });
    return data.project[0] ?? null;
}

export interface ProjectMeta {
    projectId: string;
    title: string;
    updatedAt: string;
}

/** Public project meta from a /u/<userSlug>/<projectSlug> URL (public profile + public project). */
export async function fetchProjectMetaBySlug(
    userSlug: string,
    projectSlug: string,
): Promise<ProjectMeta | null> {
    const query = `
        query ($userSlug: String!, $projectSlug: String!) {
            project(where: { slug: { _eq: $projectSlug }, owner: { slug: { _eq: $userSlug } } }, limit: 1) {
                project_id
                title
                updated_at
            }
        }
    `;
    const data = await gql<{ project: Array<{ project_id: string; title: string; updated_at: string }> }>(
        query,
        { userSlug, projectSlug },
    );
    const p = data.project[0];
    return p ? { projectId: p.project_id, title: p.title, updatedAt: p.updated_at } : null;
}

/** Public project meta by id (for /projects/<id> URLs). */
export async function fetchProjectMetaById(id: string): Promise<ProjectMeta | null> {
    const query = `
        query ($id: uuid!) {
            project(where: { project_id: { _eq: $id } }, limit: 1) {
                project_id
                title
                updated_at
            }
        }
    `;
    const data = await gql<{ project: Array<{ project_id: string; title: string; updated_at: string }> }>(
        query,
        { id },
    );
    const p = data.project[0];
    return p ? { projectId: p.project_id, title: p.title, updatedAt: p.updated_at } : null;
}

// One mutation per compile action; the Boriel action's input field is named
// differently (basic vs code) for historical reasons. compilePascal also
// takes the machine target, since Pasta80 links a different runtime per
// machine.
const ACTION_MUTATIONS = {
    compile: `mutation ($src: String!, $files: [ProjectFileInput!]) { compile(basic: $src, files: $files) { base64_encoded } }`,
    compileC: `mutation ($src: String!, $files: [ProjectFileInput!]) { compileC(code: $src, files: $files) { base64_encoded } }`,
    compileSjasmplus: `mutation ($src: String!, $files: [ProjectFileInput!]) { compileSjasmplus(code: $src, files: $files) { base64_encoded } }`,
    compilePascal: `mutation ($src: String!, $machine: String, $files: [ProjectFileInput!]) { compilePascal(code: $src, machine: $machine, files: $files) { base64_encoded } }`,
} as const;

/**
 * Compile through one of the Hasura compile actions (Boriel ZX BASIC, z88dk
 * C, sjasmplus), returning the output bytes (a TAP, or a NEX for sjasmplus
 * SAVENEX sources). A rejection here usually means the source did not
 * compile, so it surfaces as a CompileError (400) rather than a service
 * fault. A genuine outage of the upstream compiler also lands here; it is
 * logged either way.
 */
export async function compileViaAction(
    action: keyof typeof ACTION_MUTATIONS,
    code: string,
    machine?: string,
    files: ProjectFileRecord[] = [],
): Promise<Uint8Array> {
    const query = ACTION_MUTATIONS[action];
    try {
        // Only pass $machine when given — the other mutations don't declare
        // it, and an undeclared variable is a GraphQL error.
        const data = await gql<Record<string, { base64_encoded: string } | null>>(
            query,
            machine === undefined ? { src: code, files } : { src: code, machine, files },
        );
        const result = data[action];
        if (!result?.base64_encoded) {
            throw new CompileError(`${action} returned no output`);
        }
        return Uint8Array.from(Buffer.from(result.base64_encoded, 'base64'));
    } catch (err) {
        if (err instanceof CompileError) throw err;
        throw new CompileError(err instanceof Error ? err.message : String(err));
    }
}
