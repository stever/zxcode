// Integration suite for the OTP second factor, against the dev api
// (localhost:4000). Own file so this worker's config module loads with dev
// auto-login disabled and SMTP unconfigured; codes are computed with the
// service's own RFC-vector-tested totp module.

import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const API_URL = process.env.TEST_API_URL ?? "http://localhost:4000/v1/graphql";
const ADMIN_SECRET = process.env.TEST_ADMIN_SECRET ?? "hasurapassword";
const AUTH_REDIRECT = "http://localhost:8080/";

const runId = process.hrtime.bigint();
const EMAIL = `otp-${runId}@test.invalid`;

let baseUrl = "";
let server: Server;
let mailer: typeof import("../../src/mailer.js");
let ratelimit: typeof import("../../src/ratelimit.js");
let totp: typeof import("../../src/totp.js");

// State threaded through the ordered flow below.
let sessionCookie = "";
let otpSecret = "";
let recoveryCodes: string[] = [];

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

async function post(
    path: string,
    fields: Record<string, string>,
    cookie?: string,
): Promise<FetchResult> {
    const res = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        redirect: "manual",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            ...(cookie ? { Cookie: cookie } : {}),
        },
        body: new URLSearchParams(fields).toString(),
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

// Runs the magic-link flow and returns what /verify produced: either a full
// session or an OTP challenge, depending on the account's OTP state.
async function followMagicLink(): Promise<FetchResult> {
    await post("/login/email", { email: EMAIL, redirect_url: AUTH_REDIRECT });
    const link = mailer.lastMessage?.link ?? "";
    const token = new URL(link).searchParams.get("token") ?? "";
    return get(`/verify?token=${token}`);
}

function currentCode(): string {
    return totp.totpAt(otpSecret, Date.now());
}

beforeAll(async () => {
    process.env.AUTH_DEV_MODE = "true";
    process.env.AUTH_DebugAutoLoginUsername = "off";
    process.env.AUTH_GraphQL__Endpoint = API_URL;
    process.env.AUTH_GraphQL__AdminSecret = ADMIN_SECRET;
    process.env.AUTH_AuthRedirect = AUTH_REDIRECT;

    const { createApp } = await import("../../src/app.js");
    mailer = await import("../../src/mailer.js");
    ratelimit = await import("../../src/ratelimit.js");
    totp = await import("../../src/totp.js");
    server = createApp().listen(0);
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://localhost:${port}`;

    // Establish the session the enrolment tests manage OTP with.
    const verified = await followMagicLink();
    expect(verified.status).toBe(302);
    sessionCookie = `access_token=${cookieValue(verified.headers, "access_token")}`;
});

afterAll(async () => {
    server?.close();
    await adminGql(
        `mutation ($email: String!) {
            delete_login_token(where: {email: {_eq: $email}}) { affected_rows }
        }`,
        { email: EMAIL },
    ).catch(() => console.warn("could not clean up login tokens"));
    // Deleting the user cascades sessions, user_otp and otp_recovery_code.
    try {
        execFileSync("docker", [
            "exec", "zxcode-postgres-1", "psql", "-U", "zxplay", "-d", "zxplay",
            "-c", `DELETE FROM "user" WHERE username LIKE 'otp-%@test.invalid'`,
        ], { stdio: "pipe" });
    } catch {
        console.warn("could not clean up otp test users");
    }
});

beforeEach(() => {
    ratelimit.resetForTests();
});

describe("management pages", () => {
    it("redirects anonymous visitors through login", async () => {
        const res = await get("/otp");
        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toContain("auth/login?redirect_url=");
    });

    it("shows OTP off for a fresh account", async () => {
        const res = await get("/otp", sessionCookie);
        expect(res.status).toBe(200);
        expect(res.body).toContain("Set up authenticator");
    });
});

describe("enrolment", () => {
    it("setup issues a secret and a QR code", async () => {
        const res = await post("/otp/setup", {}, sessionCookie);
        expect(res.status).toBe(200);
        const match = res.body.match(/<div class="secret">([A-Z2-7]{32})<\/div>/);
        expect(match).toBeTruthy();
        otpSecret = match?.[1] ?? "";
        expect(res.body).toContain("<svg");
        expect(res.body).not.toContain("<script");
    });

    it("rejects a wrong confirmation code and keeps the same secret", async () => {
        const res = await post("/otp/enable", { code: "000000" }, sessionCookie);
        expect(res.status).toBe(400);
        expect(res.body).toContain(otpSecret);
    });

    it("enables on the current code and hands out recovery codes once", async () => {
        const res = await post("/otp/enable", { code: currentCode() }, sessionCookie);
        expect(res.status).toBe(200);
        recoveryCodes = [...res.body.matchAll(/<div>([A-Z2-7]{4}-[A-Z2-7]{4})<\/div>/g)]
            .map((m) => m[1] as string);
        expect(recoveryCodes.length).toBe(10);

        const status = await get("/otp", sessionCookie);
        expect(status.body).toContain("10 unused recovery codes");
    });
});

describe("login challenge", () => {
    let challengeCookie = "";

    it("a magic link no longer logs straight in", async () => {
        const res = await followMagicLink();
        expect(res.status).toBe(200);
        expect(res.body).toContain("Enter your code");
        expect(cookieValue(res.headers, "access_token")).toBeNull();
        challengeCookie = `otp_challenge=${cookieValue(res.headers, "otp_challenge")}`;
        expect(challengeCookie).not.toContain("null");
    });

    it("rejects a wrong code", async () => {
        const res = await post("/otp/login", { code: "000000" }, challengeCookie);
        expect(res.status).toBe(400);
        expect(res.body).toContain("try the current one");
    });

    it("accepts the current authenticator code", async () => {
        const res = await post("/otp/login", { code: currentCode() }, challengeCookie);
        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe(AUTH_REDIRECT);
        const jwt = cookieValue(res.headers, "access_token");
        expect(jwt).toBeTruthy();
        expect((await get("/me", `access_token=${jwt}`)).status).toBe(200);
    });

    it("rejects a request with no challenge cookie", async () => {
        const res = await post("/otp/login", { code: currentCode() });
        expect(res.status).toBe(400);
    });

    it("accepts a recovery code exactly once", async () => {
        const first = await followMagicLink();
        const cookie1 = `otp_challenge=${cookieValue(first.headers, "otp_challenge")}`;
        const code = recoveryCodes[0] as string;
        const used = await post("/otp/login", { code }, cookie1);
        expect(used.status).toBe(302);

        const second = await followMagicLink();
        const cookie2 = `otp_challenge=${cookieValue(second.headers, "otp_challenge")}`;
        const reused = await post("/otp/login", { code }, cookie2);
        expect(reused.status).toBe(400);

        const status = await get("/otp", sessionCookie);
        expect(status.body).toContain("9 unused recovery codes");
    });
});

describe("disable", () => {
    it("keeps OTP on for a wrong code", async () => {
        const res = await post("/otp/disable", { code: "000000" }, sessionCookie);
        expect(res.status).toBe(400);
        expect(res.body).toContain("stays on");
    });

    it("turns OTP off with a valid code, and links log straight in again", async () => {
        const res = await post("/otp/disable", { code: currentCode() }, sessionCookie);
        expect(res.status).toBe(302);

        const status = await get("/otp", sessionCookie);
        expect(status.body).toContain("Set up authenticator");

        const verified = await followMagicLink();
        expect(verified.status).toBe(302);
        expect(cookieValue(verified.headers, "access_token")).toBeTruthy();
    });
});
