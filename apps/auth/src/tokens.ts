// JWT minting and cookie-JWT reading, matching the .NET dispensers:
// - SessionToken (aud caddy, 8h): claims `roles` + `props.auth` (the 64-char
//   session token). This is the value of the access_token cookie.
// - HasuraToken (aud hasura, 15 min): the Hasura claims namespace the api
//   verifies. Fetched by the frontend from /token.

import { SignJWT, jwtVerify } from "jose";
import { config } from "./config.js";

const HASURA_CLAIMS_NAMESPACE = "https://hasura.io/jwt/claims";

const sessionKey = new TextEncoder().encode(config.jwt.sessionToken.secret);
const hasuraKey = new TextEncoder().encode(config.jwt.hasuraToken.secret);

export async function mintSessionToken(
    authToken: string,
    roles: string[],
): Promise<string> {
    const { issuer, audience, expirationSeconds } = config.jwt.sessionToken;
    return new SignJWT({ roles, props: { auth: authToken } })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer(issuer)
        .setAudience(audience)
        .setExpirationTime(Math.floor(Date.now() / 1000) + expirationSeconds)
        .sign(sessionKey);
}

export async function mintHasuraToken(
    userId: string,
    roles: string[],
): Promise<string> {
    const { issuer, audience, expirationSeconds } = config.jwt.hasuraToken;
    return new SignJWT({
        [HASURA_CLAIMS_NAMESPACE]: {
            "X-Hasura-User-Id": userId,
            "X-Hasura-Allowed-Roles": roles,
            "X-Hasura-Default-Role": config.jwt.defaultRole,
        },
    })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer(issuer)
        .setAudience(audience)
        .setExpirationTime(Math.floor(Date.now() / 1000) + expirationSeconds)
        .sign(hasuraKey);
}

// The half-logged-in state between a verified magic link and a passed OTP
// challenge: a short-lived JWT carried in its own cookie. Signed with the
// session-token key but a distinct audience, so neither token verifies as
// the other.

const OTP_CHALLENGE_AUDIENCE = "otp-challenge";
const OTP_CHALLENGE_SECONDS = 600;

export interface OtpChallenge {
    userId: string;
    redirectUrl: string | null;
}

export async function mintOtpChallenge(
    userId: string,
    redirectUrl: string | null,
): Promise<string> {
    return new SignJWT({ props: { user: userId, redirect: redirectUrl } })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer(config.jwt.sessionToken.issuer)
        .setAudience(OTP_CHALLENGE_AUDIENCE)
        .setExpirationTime(Math.floor(Date.now() / 1000) + OTP_CHALLENGE_SECONDS)
        .sign(sessionKey);
}

export async function readOtpChallenge(jwt: string): Promise<OtpChallenge | null> {
    try {
        const { payload } = await jwtVerify(jwt, sessionKey, {
            algorithms: ["HS256"],
            audience: OTP_CHALLENGE_AUDIENCE,
        });
        const props = payload.props as
            | { user?: unknown; redirect?: unknown }
            | undefined;
        if (typeof props?.user !== "string") return null;
        return {
            userId: props.user,
            redirectUrl: typeof props.redirect === "string" ? props.redirect : null,
        };
    } catch {
        return null;
    }
}

// Extracts props.auth from the session cookie JWT. Returns null on any
// verification failure (bad signature, expired) — the .NET reader threw a
// 500 on an expired cookie JWT; a null here becomes the 401 the frontend
// actually handles.
export async function readSessionCookie(jwt: string): Promise<string | null> {
    try {
        const { payload } = await jwtVerify(jwt, sessionKey, {
            algorithms: ["HS256"],
        });
        const props = payload.props as { auth?: unknown } | undefined;
        return typeof props?.auth === "string" ? props.auth : null;
    } catch {
        return null;
    }
}
