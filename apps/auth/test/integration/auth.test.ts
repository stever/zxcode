// Integration suite: boots the auth service against the dev api
// (localhost:4000) and exercises the full surface — dev auto-login, /me,
// /token (verified against the api), logout, expired sessions, the
// return-URL cookie logic, and a forged signed SAML response through
// /assertion-consumer (self-signed IdP certificate, assertion signed with
// xml-crypto, same shape Auth0 emits).

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SignedXml } from "xml-crypto";

const API_URL = process.env.TEST_API_URL ?? "http://localhost:4000/v1/graphql";
const ADMIN_SECRET = process.env.TEST_ADMIN_SECRET ?? "hasurapassword";
const AUTH_REDIRECT = "http://localhost:8080/";
const ACS_URL = "http://localhost:8080/auth/assertion-consumer";

let baseUrl = "";
let server: Server;
let certDir = "";
let idpKeyPem = "";
const forgedUsername = `auth0|forged-${process.hrtime.bigint()}`;

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
    // Self-signed IdP certificate for the forged-response test.
    certDir = mkdtempSync(join(tmpdir(), "auth-idp-"));
    execFileSync("openssl", [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
        "-keyout", join(certDir, "key.pem"),
        "-out", join(certDir, "cert.pem"),
        "-subj", "/CN=test-idp",
    ], { stdio: "pipe" });
    idpKeyPem = readFileSync(join(certDir, "key.pem"), "utf8");
    const certPem = readFileSync(join(certDir, "cert.pem"), "utf8");

    // Environment must be set before the config module loads.
    process.env.AUTH_DEV_MODE = "true";
    process.env.AUTH_GraphQL__Endpoint = API_URL;
    process.env.AUTH_GraphQL__AdminSecret = ADMIN_SECRET;
    process.env.AUTH_AuthRedirect = AUTH_REDIRECT;
    process.env.AUTH_SAML__SsoEndpoint = "https://idp.example/sso";
    process.env.AUTH_SAML__AssertionConsumer = ACS_URL;
    process.env.AUTH_SAML__ResponseCertificate = certPem;

    const { createApp } = await import("../../src/app.js");
    server = createApp().listen(0);
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://localhost:${port}`;
});

afterAll(async () => {
    server?.close();
    rmSync(certDir, { recursive: true, force: true });
    // The api exposes no user delete; clean the forged fixture directly.
    try {
        execFileSync("docker", [
            "exec", "zxcode-postgres-1", "psql", "-U", "zxplay", "-d", "zxplay",
            "-c", `DELETE FROM "user" WHERE username LIKE 'auth0|forged-%'`,
        ], { stdio: "pipe" });
    } catch {
        console.warn("could not clean up forged test users");
    }
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

    it("logout clears cookies and redirects", async () => {
        const res = await get("/logout", authCookie);
        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe(AUTH_REDIRECT);
        const cleared = res.headers.getSetCookie().find((c) => c.startsWith("access_token="));
        expect(cleared).toContain("Expires=Thu, 01 Jan 1970");
        // The session row is still live server-side (parity with .NET, which
        // only cleared cookies), so re-login for later tests is fine.
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
            `mutation ($user_id: uuid!, $auth_token: String!, $created: timestamptz!, $expires: timestamptz!) {
                insert_session_one(object: {user_id: $user_id, auth_token: $auth_token, created: $created, expires: $expires}) { session_id }
            }`,
            {
                user_id: userId,
                auth_token: expiredToken,
                created: new Date(Date.now() - 3600_000).toISOString(),
                expires: new Date(Date.now() - 60_000).toISOString(),
            },
        );
        const { mintSessionToken } = await import("../../src/tokens.js");
        const jwt = await mintSessionToken(expiredToken, ["zxplay-user"]);
        expect((await get("/me", `access_token=${jwt}`)).status).toBe(401);
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

// ------------------------------------------------------------- forged IdP

function buildSignedSamlResponse(options: {
    username: string;
    email: string;
    keyPem: string;
}): string {
    const now = new Date();
    const notBefore = new Date(now.getTime() - 60_000).toISOString();
    const notOnOrAfter = new Date(now.getTime() + 5 * 60_000).toISOString();
    const sessionExpiry = new Date(now.getTime() + 60 * 60_000).toISOString();
    const assertionId = "_assert1";

    const xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_resp1" Version="2.0" IssueInstant="${now.toISOString()}" Destination="${ACS_URL}">` +
        `<saml:Issuer>urn:test-idp</saml:Issuer>` +
        `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
        `<saml:Assertion ID="${assertionId}" Version="2.0" IssueInstant="${now.toISOString()}">` +
        `<saml:Issuer>urn:test-idp</saml:Issuer>` +
        `<saml:Subject>` +
        `<saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified">${options.username}</saml:NameID>` +
        `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">` +
        `<saml:SubjectConfirmationData NotOnOrAfter="${notOnOrAfter}" Recipient="${ACS_URL}"/>` +
        `</saml:SubjectConfirmation>` +
        `</saml:Subject>` +
        `<saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}">` +
        `<saml:AudienceRestriction><saml:Audience>zxplay</saml:Audience></saml:AudienceRestriction>` +
        `</saml:Conditions>` +
        `<saml:AuthnStatement AuthnInstant="${now.toISOString()}" SessionNotOnOrAfter="${sessionExpiry}">` +
        `<saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:unspecified</saml:AuthnContextClassRef></saml:AuthnContext>` +
        `</saml:AuthnStatement>` +
        `<saml:AttributeStatement>` +
        `<saml:Attribute Name="email"><saml:AttributeValue>${options.email}</saml:AttributeValue></saml:Attribute>` +
        `</saml:AttributeStatement>` +
        `</saml:Assertion>` +
        `</samlp:Response>`;

    const signer = new SignedXml({ privateKey: options.keyPem });
    signer.canonicalizationAlgorithm = "http://www.w3.org/2001/10/xml-exc-c14n#";
    signer.signatureAlgorithm = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
    signer.addReference({
        xpath: `//*[local-name(.)='Assertion']`,
        digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
        transforms: [
            "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
            "http://www.w3.org/2001/10/xml-exc-c14n#",
        ],
    });
    signer.computeSignature(xml, {
        location: {
            reference: `//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']`,
            action: "after",
        },
    });
    return Buffer.from(signer.getSignedXml(), "utf8").toString("base64");
}

describe("assertion-consumer with a signed IdP response", () => {
    it("provisions the user with a friendly handle and logs in", async () => {
        const samlResponse = buildSignedSamlResponse({
            username: forgedUsername,
            email: "forged@example.com",
            keyPem: idpKeyPem,
        });
        const res = await fetch(`${baseUrl}/assertion-consumer`, {
            method: "POST",
            redirect: "manual",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: `SAMLResponse=${encodeURIComponent(samlResponse)}`,
        });
        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe(AUTH_REDIRECT);
        const jwt = cookieValue(res.headers, "access_token");
        expect(jwt).toBeTruthy();

        // Provisioned with a generated speccy handle and the email attribute.
        const data = await adminGql<{
            user: Array<{ slug: string; greeting_name: string; email_address: string }>;
        }>(
            `query ($username: String!) {
                user(where: {username: {_eq: $username}}) { slug greeting_name email_address }
            }`,
            { username: forgedUsername },
        );
        const user = data.user[0];
        expect(user).toBeDefined();
        expect(user?.slug).toMatch(/^[a-z]+-[a-z]+-\d{2,4}$/);
        expect(user?.greeting_name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
        expect(user?.email_address).toBe("forged@example.com");

        // And the cookie works against /me.
        const me = await get("/me", `access_token=${jwt}`);
        expect(me.status).toBe(200);
    });

    it("rejects an unsigned response", async () => {
        const unsigned = Buffer.from(
            `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_r" Version="2.0" IssueInstant="${new Date().toISOString()}"><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status></samlp:Response>`,
        ).toString("base64");
        const res = await fetch(`${baseUrl}/assertion-consumer`, {
            method: "POST",
            redirect: "manual",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: `SAMLResponse=${encodeURIComponent(unsigned)}`,
        });
        expect(res.status).toBe(400);
    });

    it("rejects a response signed with the wrong key", async () => {
        const otherDir = mkdtempSync(join(tmpdir(), "auth-idp2-"));
        execFileSync("openssl", [
            "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
            "-keyout", join(otherDir, "key.pem"),
            "-out", join(otherDir, "cert.pem"),
            "-subj", "/CN=rogue-idp",
        ], { stdio: "pipe" });
        const rogueKey = readFileSync(join(otherDir, "key.pem"), "utf8");
        rmSync(otherDir, { recursive: true, force: true });

        const samlResponse = buildSignedSamlResponse({
            username: `auth0|forged-rogue`,
            email: "rogue@example.com",
            keyPem: rogueKey,
        });
        const res = await fetch(`${baseUrl}/assertion-consumer`, {
            method: "POST",
            redirect: "manual",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: `SAMLResponse=${encodeURIComponent(samlResponse)}`,
        });
        expect(res.status).toBe(400);
    });
});
