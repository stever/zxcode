// Role resolution, matching the Hasura setup exactly:
// - X-Hasura-Admin-Secret header  -> admin (used by apps/auth)
// - Authorization: Bearer <JWT>   -> zxplay-user (HS256, issuer zxplay,
//   audience hasura, user id in the Hasura claims namespace)
// - neither                       -> public (the old unauthorized role)

import { jwtVerify } from "jose";
import type { Session } from "./tables.js";

const CLAIMS_NAMESPACE = "https://hasura.io/jwt/claims";

const ADMIN_SECRET = process.env.ADMIN_SECRET ?? "";
const JWT_SECRET = process.env.JWT_SECRET ?? "";
const JWT_AUDIENCE = process.env.JWT_AUDIENCE || "hasura";
const JWT_ISSUER = process.env.JWT_ISSUER || "zxplay";
const jwtKey = new TextEncoder().encode(JWT_SECRET);

export class AuthError extends Error {}

export interface AuthResult {
    session: Session;
    // JWT expiry (ms since epoch); used to close subscription sockets when
    // the token lapses, prompting the client's reconnect-with-fresh-token.
    expiresAt: number | null;
}

type Headers = Record<string, string | string[] | undefined>;

function headerValue(headers: Headers, name: string): string | undefined {
    const value = headers[name];
    return Array.isArray(value) ? value[0] : value;
}

export async function authenticate(headers: Headers): Promise<AuthResult> {
    const adminSecret = headerValue(headers, "x-hasura-admin-secret");
    if (adminSecret !== undefined) {
        if (ADMIN_SECRET === "" || adminSecret !== ADMIN_SECRET) {
            throw new AuthError("invalid x-hasura-admin-secret");
        }
        return { session: { role: "admin", userId: null }, expiresAt: null };
    }

    const authorization = headerValue(headers, "authorization");
    if (!authorization) {
        return { session: { role: "public", userId: null }, expiresAt: null };
    }

    const match = /^Bearer\s+(.+)$/i.exec(authorization);
    if (!match) throw new AuthError("Could not verify JWT: malformed header");

    try {
        const { payload } = await jwtVerify(match[1] as string, jwtKey, {
            algorithms: ["HS256"],
            audience: JWT_AUDIENCE,
            issuer: JWT_ISSUER,
        });
        const claims = payload[CLAIMS_NAMESPACE] as
            | Record<string, unknown>
            | undefined;
        const userId =
            (claims?.["X-Hasura-User-Id"] as string | undefined) ??
            (claims?.["x-hasura-user-id"] as string | undefined);
        if (!userId) throw new AuthError("Could not verify JWT: missing user id claim");
        return {
            session: { role: "zxplay-user", userId },
            expiresAt: typeof payload.exp === "number" ? payload.exp * 1000 : null,
        };
    } catch (err) {
        if (err instanceof AuthError) throw err;
        const reason = err instanceof Error ? err.message : String(err);
        throw new AuthError(`Could not verify JWT: ${reason}`);
    }
}
