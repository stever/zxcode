import { CompileError } from './errors.js';

// gif-service talks to Hasura as the unauthenticated `public` role: that role
// can read public projects (its select permission filters to is_public = true)
// and call the compile / compileC actions. No admin secret is sent, so the
// service keeps holding no secrets.
const HASURA_URL = process.env.HASURA_URL ?? 'http://hasura:8080/v1/graphql';

interface GraphQLResponse<T> {
    data?: T;
    errors?: Array<{ message: string }>;
}

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await fetch(HASURA_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
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
}

export interface ProjectRecord {
    lang: string;
    code: string;
    title: string;
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
            }
        }
    `;
    const data = await gql<{ project: ProjectRecord[] }>(query, { userSlug, projectSlug });
    return data.project[0] ?? null;
}

/**
 * Compile ZX BASIC (Boriel) or C (z88dk) through the Hasura actions, returning
 * the TAP bytes. A rejection here usually means the source did not compile, so
 * it surfaces as a CompileError (400) rather than a service fault. A genuine
 * outage of the upstream compiler also lands here; it is logged either way.
 */
export async function compileViaAction(
    action: 'compile' | 'compileC',
    code: string,
): Promise<Uint8Array> {
    const query =
        action === 'compile'
            ? `mutation ($src: String!) { compile(basic: $src) { base64_encoded } }`
            : `mutation ($src: String!) { compileC(code: $src) { base64_encoded } }`;
    try {
        const data = await gql<Record<string, { base64_encoded: string } | null>>(query, {
            src: code,
        });
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
