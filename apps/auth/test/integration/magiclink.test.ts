// Integration suite for the magic-link login flow, against the dev api
// (localhost:4000). Lives in its own file so this worker's config module can
// load with dev auto-login disabled and SMTP unconfigured (links are captured
// via the mailer's lastMessage hook instead of sent).

import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const API_URL = process.env.TEST_API_URL ?? "http://localhost:4000/v1/graphql";
const ADMIN_SECRET = process.env.TEST_ADMIN_SECRET ?? "hasurapassword";
const AUTH_REDIRECT = "http://localhost:8080/";

// Unique per run; the emails double as usernames, cleaned up in afterAll.
const runId = process.hrtime.bigint();
const emailFor = (name: string): string => `magic-${name}-${runId}@test.invalid`;

let baseUrl = "";
let server: Server;
let mailer: typeof import("../../src/mailer.js");
let ratelimit: typeof import("../../src/ratelimit.js");
let logintokens: typeof import("../../src/logintokens.js");

async function adminGql<T>(
    query: string,
    variables: Record<string, unknown> = {},
): Promise<T> {
    const res = await fetch(API_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Hasura-Admin-Secret": ADMIN_SECRET,
        },
        body: JSON.stringify({ query, variables }),
    });
    const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (body.errors?.length) throw new Error(body.errors[0]?.message);
    return body.data as T;
}

interface FetchResult {
    status: number;
    headers: Headers;
    body: string;
}

async function get(path: string, cookie?: string): Promise<FetchResult> {
    const res = await fetch(`${baseUrl}${path}`, {
        redirect: "manual",
        headers: cookie ? { Cookie: cookie } : {},
    });
    return { status: res.status, headers: res.headers, body: await res.text() };
}

async function postLoginEmail(
    email: string,
    redirectUrl?: string,
): Promise<FetchResult> {
    const params = new URLSearchParams({ email });
    if (redirectUrl !== undefined) params.set("redirect_url", redirectUrl);
    const res = await fetch(`${baseUrl}/login/email`, {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
    });
    return { status: res.status, headers: res.headers, body: await res.text() };
}

// The emailed link targets the proxy origin; extract the token and follow it
// against this in-process server instead.
function tokenFromLink(link: string): string {
    const token = new URL(link).searchParams.get("token");
    expect(token).toBeTruthy();
    return token as string;
}

function cookieValue(headers: Headers, name: string): string | null {
    for (const value of headers.getSetCookie()) {
        if (value.startsWith(`${name}=`)) {
            return value.split(";")[0]?.slice(name.length + 1) ?? null;
        }
    }
    return null;
}

beforeAll(async () => {
    // Environment must be set before the config module loads.
    process.env.AUTH_DEV_MODE = "true";
    process.env.AUTH_DebugAutoLoginUsername = "off";
    process.env.AUTH_GraphQL__Endpoint = API_URL;
    process.env.AUTH_GraphQL__AdminSecret = ADMIN_SECRET;
    process.env.AUTH_AuthRedirect = AUTH_REDIRECT;

    const { createApp } = await import("../../src/app.js");
    mailer = await import("../../src/mailer.js");
    ratelimit = await import("../../src/ratelimit.js");
    logintokens = await import("../../src/logintokens.js");
    server = createApp().listen(0);
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://localhost:${port}`;
});

afterAll(async () => {
    server?.close();
    const fixtureEmails = ["flow", "case", "reuse", "expired", "stale", "legacy", "ratelimit"].map(emailFor);
    await adminGql(
        `mutation ($emails: [String!]) {
            delete_login_token(where: {email: {_in: $emails}}) { affected_rows }
        }`,
        { emails: fixtureEmails },
    ).catch(() => console.warn("could not clean up login tokens"));
    // The api exposes no user delete; clean the provisioned fixtures directly.
    try {
        execFileSync("docker", [
            "exec", "zxcode-postgres-1", "psql", "-U", "zxplay", "-d", "zxplay",
            "-c", `DELETE FROM "user" WHERE username LIKE 'magic-%@test.invalid'`,
        ], { stdio: "pipe" });
    } catch {
        console.warn("could not clean up magic-link test users");
    }
});

// All requests share the test runner's IP, so give every test a fresh window.
beforeEach(() => {
    ratelimit.resetForTests();
});

describe("login page", () => {
    it("renders the email form with its own CSP", async () => {
        const res = await get(`/login?redirect_url=${AUTH_REDIRECT}projects/x`);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-security-policy")).toContain("form-action 'self'");
        expect(res.body).toContain(`action="login/email"`);
        expect(res.body).toContain(`value="${AUTH_REDIRECT}projects/x"`);
        // Only the shared external script — nothing inline (the CSP allows
        // script-src 'self' only).
        expect(res.body).toContain(`<script src="form.js" defer></script>`);
        expect(res.body).not.toMatch(/<script(?![^>]*\bsrc=)/);
    });

    it("serves the shared form script the pages reference", async () => {
        const res = await get("/form.js");
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("javascript");
        expect(res.body).toContain("zx-busy");
    });

    it("drops a redirect_url outside AuthRedirect", async () => {
        const res = await get("/login?redirect_url=https://evil.example/");
        expect(res.status).toBe(200);
        expect(res.body).not.toContain("evil.example");
    });

    it("rejects a syntactically invalid email", async () => {
        const res = await postLoginEmail("not-an-email");
        expect(res.status).toBe(400);
        expect(res.body).toContain("email address");
    });
});

describe("magic-link flow", () => {
    it("logs in end to end, provisioning a user with a friendly handle", async () => {
        const email = emailFor("flow");
        const redirect = `${AUTH_REDIRECT}projects/x`;

        const requested = await postLoginEmail(email, redirect);
        expect(requested.status).toBe(200);
        expect(requested.body).toContain("Check your email");

        expect(mailer.lastMessage?.to).toBe(email);
        const token = tokenFromLink(mailer.lastMessage?.link ?? "");

        const verified = await get(`/verify?token=${token}`);
        expect(verified.status).toBe(302);
        expect(verified.headers.get("location")).toBe(redirect);
        const jwt = cookieValue(verified.headers, "access_token");
        expect(jwt).toBeTruthy();

        const me = await get("/me", `access_token=${jwt}`);
        expect(me.status).toBe(200);
        const body = JSON.parse(me.body) as { userId: string; roles: string[] };
        expect(body.roles).toContain("zxplay-user");

        // Provisioned with the email as username and a generated speccy
        // handle — the email must not leak into the public slug.
        const data = await adminGql<{
            user: Array<{ slug: string; greeting_name: string; email_address: string }>;
        }>(
            `query ($username: String!) {
                user(where: {username: {_eq: $username}}) { slug greeting_name email_address }
            }`,
            { username: email },
        );
        const user = data.user[0];
        expect(user).toBeDefined();
        expect(user?.slug).toMatch(/^[a-z]+-[a-z]+-\d{2,4}$/);
        expect(user?.greeting_name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
        expect(user?.email_address).toBe(email);
    });

    it("lowercases the submitted email", async () => {
        const email = emailFor("case");
        await postLoginEmail(email.toUpperCase());
        expect(mailer.lastMessage?.to).toBe(email);
    });

    it("rejects a reused link", async () => {
        const email = emailFor("reuse");
        await postLoginEmail(email);
        const token = tokenFromLink(mailer.lastMessage?.link ?? "");

        expect((await get(`/verify?token=${token}`)).status).toBe(302);
        const again = await get(`/verify?token=${token}`);
        expect(again.status).toBe(400);
        expect(again.body).toContain("expired or was already used");
    });

    it("rejects an unknown or missing token", async () => {
        expect((await get("/verify?token=nonsense")).status).toBe(400);
        expect((await get("/verify")).status).toBe(400);
    });

    it("rejects an expired token", async () => {
        const email = emailFor("expired");
        const rawToken = logintokens.generateRawToken();
        await adminGql(
            `mutation ($email: String!, $token_hash: String!, $created: timestamptz!, $expires: timestamptz!) {
                insert_login_token_one(object: {email: $email, token_hash: $token_hash, created: $created, expires: $expires}) { login_token_id }
            }`,
            {
                email,
                token_hash: logintokens.hashToken(rawToken),
                created: new Date(Date.now() - 3600_000).toISOString(),
                expires: new Date(Date.now() - 60_000).toISOString(),
            },
        );
        expect((await get(`/verify?token=${rawToken}`)).status).toBe(400);
    });

    it("invalidates earlier pending links when a new one is requested", async () => {
        const email = emailFor("stale");
        await postLoginEmail(email);
        const staleToken = tokenFromLink(mailer.lastMessage?.link ?? "");
        await postLoginEmail(email);
        const freshToken = tokenFromLink(mailer.lastMessage?.link ?? "");
        expect(freshToken).not.toBe(staleToken);

        expect((await get(`/verify?token=${staleToken}`)).status).toBe(400);
        expect((await get(`/verify?token=${freshToken}`)).status).toBe(302);
    });

    it("matches an existing user by email, keeping their username", async () => {
        // Simulate a legacy provider account whose email requests a link.
        const email = emailFor("legacy");
        const legacyUsername = `auth0|magic-legacy-${runId}`;
        await adminGql(
            `mutation ($username: String!, $email: String, $slug: String!) {
                insert_user_one(object: {username: $username, email_address: $email, slug: $slug}) { user_id }
            }`,
            { username: legacyUsername, email, slug: `magic-legacy-${runId}` },
        );

        await postLoginEmail(email);
        const token = tokenFromLink(mailer.lastMessage?.link ?? "");
        expect((await get(`/verify?token=${token}`)).status).toBe(302);

        // No second account was provisioned for the email-as-username.
        const data = await adminGql<{ user: unknown[] }>(
            `query ($username: String!) {
                user(where: {username: {_eq: $username}}) { user_id }
            }`,
            { username: email },
        );
        expect(data.user.length).toBe(0);
    });
});

describe("rate limiting", () => {
    it("stops sending after the per-email limit, with an identical response", async () => {
        const email = emailFor("ratelimit");
        for (let i = 0; i < 3; i++) {
            const res = await postLoginEmail(email);
            expect(res.status).toBe(200);
        }
        const linkBefore = mailer.lastMessage?.link;

        const over = await postLoginEmail(email);
        expect(over.status).toBe(200);
        expect(over.body).toContain("Check your email");
        expect(mailer.lastMessage?.link).toBe(linkBefore); // nothing new sent
    });
});
