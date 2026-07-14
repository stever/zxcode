// Session repository. Sessions live in the database (created here, read on
// every authenticated request); the browser holds a JWT cookie that embeds
// the session's random auth_token.

import { config } from "./config.js";
import { gql } from "./graphql.js";

export interface Session {
    session_id: string;
    expires: string;
    absolute_expires: string;
    user: { user_id: string };
}

export async function createSession(
    userId: string,
    authToken: string,
    created: Date,
    expires: Date,
    absoluteExpires: Date,
): Promise<void> {
    await gql(
        `mutation CreateSession($user_id: uuid!, $auth_token: String!, $created: timestamptz!, $expires: timestamptz!, $absolute_expires: timestamptz!) {
            insert_session_one(object: {user_id: $user_id, auth_token: $auth_token, created: $created, expires: $expires, absolute_expires: $absolute_expires}) {
                session_id
            }
        }`,
        {
            user_id: userId,
            auth_token: authToken,
            created: created.toISOString(),
            expires: expires.toISOString(),
            absolute_expires: absoluteExpires.toISOString(),
        },
    );
}

// Returns the session when it exists and has not expired. Expiry is sliding:
// each access pushes `expires` out by the idle window, clamped to the
// session's absolute cap, and touches the `updated` timestamp. The returned
// session carries the extended expiry, so callers can re-issue the cookie
// to match.
export async function getSession(authToken: string): Promise<Session | null> {
    if (!authToken) return null;
    const data = await gql<{ session: Session[] }>(
        `query GetSession($auth_token: String!) {
            session(where: {auth_token: {_eq: $auth_token}}) {
                session_id
                expires
                absolute_expires
                user { user_id }
            }
        }`,
        { auth_token: authToken },
    );
    if (data.session.length === 0) return null;
    if (data.session.length > 1) throw new Error("multiple sessions for token");
    const session = data.session[0] as Session;

    const now = new Date();
    if (!session.expires || new Date(session.expires) <= now) {
        return null;
    }

    const slid = Math.min(
        now.getTime() + config.login.idleExpirationMinutes * 60_000,
        new Date(session.absolute_expires).getTime(),
    );
    if (slid > new Date(session.expires).getTime()) {
        session.expires = new Date(slid).toISOString();
    }

    await gql(
        `mutation UpdateSessionTimestamp($session_id: uuid!, $updated: timestamptz!, $expires: timestamptz!) {
            update_session_by_pk(pk_columns: {session_id: $session_id}, _set: {updated: $updated, expires: $expires}) {
                updated
            }
        }`,
        {
            session_id: session.session_id,
            updated: now.toISOString(),
            expires: session.expires,
        },
    );
    return session;
}

// Logout revokes the row, so a captured cookie stops working immediately
// rather than at expiry.
export async function deleteSession(authToken: string): Promise<void> {
    await gql(
        `mutation DeleteSession($auth_token: String!) {
            delete_session(where: {auth_token: {_eq: $auth_token}}) { affected_rows }
        }`,
        { auth_token: authToken },
    );
}

// Ends every session but the caller's own — run when OTP is enabled, so a
// pre-2FA hijacked session doesn't survive the user turning 2FA on.
export async function deleteOtherSessions(
    userId: string,
    keepAuthToken: string,
): Promise<void> {
    await gql(
        `mutation DeleteOtherSessions($user_id: uuid!, $auth_token: String!) {
            delete_session(where: {user_id: {_eq: $user_id}, auth_token: {_neq: $auth_token}}) { affected_rows }
        }`,
        { user_id: userId, auth_token: keepAuthToken },
    );
}
