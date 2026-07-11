// Session repository. Sessions live in the database (created here, read on
// every authenticated request); the browser holds a JWT cookie that embeds
// the session's random auth_token.

import { gql } from "./graphql.js";

export interface Session {
    session_id: string;
    expires: string;
    user: { user_id: string };
}

export async function createSession(
    userId: string,
    authToken: string,
    created: Date,
    expires: Date,
): Promise<void> {
    await gql(
        `mutation CreateSession($user_id: uuid!, $auth_token: String!, $created: timestamptz!, $expires: timestamptz!) {
            insert_session_one(object: {user_id: $user_id, auth_token: $auth_token, created: $created, expires: $expires}) {
                session_id
            }
        }`,
        {
            user_id: userId,
            auth_token: authToken,
            created: created.toISOString(),
            expires: expires.toISOString(),
        },
    );
}

// Returns the session when it exists and has not expired, touching its
// `updated` timestamp (touch-on-access; expiry itself is not extended, same
// as the .NET service).
export async function getSession(authToken: string): Promise<Session | null> {
    if (!authToken) return null;
    const data = await gql<{ session: Session[] }>(
        `query GetSession($auth_token: String!) {
            session(where: {auth_token: {_eq: $auth_token}}) {
                session_id
                expires
                user { user_id }
            }
        }`,
        { auth_token: authToken },
    );
    if (data.session.length === 0) return null;
    if (data.session.length > 1) throw new Error("multiple sessions for token");
    const session = data.session[0] as Session;

    if (!session.expires || new Date(session.expires) <= new Date()) {
        return null;
    }

    await gql(
        `mutation UpdateSessionTimestamp($session_id: uuid!, $updated: timestamptz!) {
            update_session_by_pk(pk_columns: {session_id: $session_id}, _set: {updated: $updated}) {
                updated
            }
        }`,
        { session_id: session.session_id, updated: new Date().toISOString() },
    );
    return session;
}
