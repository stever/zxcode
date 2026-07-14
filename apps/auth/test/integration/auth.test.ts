// Integration suite: boots the auth service against the dev api
// (localhost:4000) and exercises the session surface — dev auto-login, /me,
// /token (verified against the api), logout, expired sessions and the
// return-URL cookie logic. The magic-link login flow has its own suite in
// magiclink.test.ts (a separate file so it can load the config module with
// auto-login disabled).

import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const API_URL = process.env.TEST_API_URL ?? "http://localhost:4000/v1/graphql";
const ADMIN_SECRET = process.env.TEST_ADMIN_SECRET ?? "hasurapassword";
const AUTH_REDIRECT = "http://localhost:8080/";

let baseUrl = "";
let server: Server;

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
    process.env.AUTH_GraphQL__Endpoint = API_URL;
    process.env.AUTH_GraphQL__AdminSecret = ADMIN_SECRET;
    process.env.AUTH_AuthRedirect = AUTH_REDIRECT;

    const { createApp } = await import("../../src/app.js");
    server = createApp().listen(0);
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://localhost:${port}`;
});

afterAll(() => {
    server?.close();
});

describe("dev auto-login flow", () => {
    let authCookie = "";

    it("logs in, sets the session cookie, redirects to base", async () => {
        const res = await get("/login");
        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe(AUTH_REDIRECT);
        const jwt = cookieValue(res.headers, "access_token");
        expect(jwt).toBeTruthy();
        authCookie = `access_token=${jwt}`;

        const raw = res.headers.getSetCookie().find((c) => c.startsWith("access_token="));
        expect(raw).toContain("HttpOnly");
        expect(raw).toContain("SameSite=Lax");
        expect(raw).not.toContain("Secure"); // dev mode
    });

    it("GET /me returns userId and roles", async () => {
        const res = await get("/me", authCookie);
        expect(res.status).toBe(200);
        const body = JSON.parse(res.body) as { userId: string; roles: string[] };
        expect(body.userId).toMatch(/^[0-9a-f-]{36}$/);
        expect(body.roles).toContain("zxplay-user");
    });

    it("GET /token mints a JWT the api accepts", async () => {
        const res = await get("/token", authCookie);
        expect(res.status).toBe(200);
        const { token } = JSON.parse(res.body) as { token: string };

        const me = JSON.parse((await get("/me", authCookie)).body) as { userId: string };
        const apiRes = await fetch(API_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
                query: `query ($id: uuid!) { user_by_pk(user_id: $id) { user_id email_address } }`,
                variables: { id: me.userId },
            }),
        });
        const apiBody = (await apiRes.json()) as {
            data: { user_by_pk: { user_id: string } };
            errors?: unknown;
        };
        expect(apiBody.errors).toBeUndefined();
        expect(apiBody.data.user_by_pk.user_id).toBe(me.userId);
    });

    it("401s without a cookie and with a tampered cookie", async () => {
        expect((await get("/me")).status).toBe(401);
        expect((await get("/token")).status).toBe(401);
        const tampered = authCookie.slice(0, -6) + "AAAAAA";
        expect((await get("/me", tampered)).status).toBe(401);
    });

    it("logout clears cookies and revokes the session server-side", async () => {
        const res = await get("/logout", authCookie);
        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe(AUTH_REDIRECT);
        const cleared = res.headers.getSetCookie().find((c) => c.startsWith("access_token="));
        expect(cleared).toContain("Expires=Thu, 01 Jan 1970");
        // The session row is deleted, so a captured cookie stops working at
        // logout rather than at expiry.
        expect((await get("/me", authCookie)).status).toBe(401);
    });
});

describe("session expiry", () => {
    it("rejects a cookie whose session row has expired", async () => {
        const me = await get("/login").then((r) =>
            get("/me", `access_token=${cookieValue(r.headers, "access_token")}`),
        );
        const { userId } = JSON.parse(me.body) as { userId: string };

        const expiredToken = `expired-${process.hrtime.bigint()}`;
        await adminGql(
            `mutation ($user_id: uuid!, $auth_token: String!, $created: timestamptz!, $expires: timestamptz!, $absolute_expires: timestamptz!) {
                insert_session_one(object: {user_id: $user_id, auth_token: $auth_token, created: $created, expires: $expires, absolute_expires: $absolute_expires}) { session_id }
            }`,
            {
                user_id: userId,
                auth_token: expiredToken,
                created: new Date(Date.now() - 3600_000).toISOString(),
                expires: new Date(Date.now() - 60_000).toISOString(),
                absolute_expires: new Date(Date.now() + 3600_000).toISOString(),
            },
        );
        // The cookie JWT itself is still valid: only the session row lapsed.
        const { mintSessionToken } = await import("../../src/tokens.js");
        const jwt = await mintSessionToken(
            expiredToken,
            ["zxplay-user"],
            new Date(Date.now() + 3600_000),
        );
        expect((await get("/me", `access_token=${jwt}`)).status).toBe(401);
    });

    it("slides the idle deadline on access, clamped to the absolute cap", async () => {
        const login = await get("/login");
        const cookie = `access_token=${cookieValue(login.headers, "access_token")}`;
        const { userId } = JSON.parse((await get("/me", cookie)).body) as {
            userId: string;
        };

        // Pull the session row created moments ago and shrink its idle
        // deadline, then hit /token: expires must be pushed back out.
        const found = await adminGql<{
            session: Array<{ session_id: string; expires: string; absolute_expires: string }>;
        }>(
            `query ($user_id: uuid!) {
                session(where: {user_id: {_eq: $user_id}}, order_by: {created: desc}) {
                    session_id expires absolute_expires
                }
            }`,
            { user_id: userId },
        );
        const session = found.session[0]!;
        const shrunk = new Date(Date.now() + 60_000).toISOString();
        await adminGql(
            `mutation ($session_id: uuid!, $expires: timestamptz!) {
                update_session_by_pk(pk_columns: {session_id: $session_id}, _set: {expires: $expires}) { session_id }
            }`,
            { session_id: session.session_id, expires: shrunk },
        );

        const tokenRes = await get("/token", cookie);
        expect(tokenRes.status).toBe(200);
        // /token re-issues the session cookie alongside the bearer token.
        expect(cookieValue(tokenRes.headers, "access_token")).toBeTruthy();

        const after = await adminGql<{
            session: Array<{ expires: string }>;
        }>(
            `query ($session_id: uuid!) {
                session(where: {session_id: {_eq: $session_id}}) { expires }
            }`,
            { session_id: session.session_id },
        );
        const slid = new Date(after.session[0]!.expires).getTime();
        expect(slid).toBeGreaterThan(new Date(shrunk).getTime());
        expect(slid).toBeLessThanOrEqual(
            new Date(session.absolute_expires).getTime(),
        );
    });
});

describe("return-url cookie", () => {
    it("honours values under AuthRedirect and falls back otherwise", async () => {
        const good = await get("/logout/return", `redirect_url=${AUTH_REDIRECT}projects/x`);
        expect(good.status).toBe(302);
        expect(good.headers.get("location")).toBe(`${AUTH_REDIRECT}projects/x`);

        const evil = await get("/logout/return", "redirect_url=https://evil.example/");
        expect(evil.status).toBe(302);
        expect(evil.headers.get("location")).toBe(AUTH_REDIRECT);
    });
});
