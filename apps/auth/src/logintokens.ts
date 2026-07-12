// Pending magic-link tokens. The raw token travels only in the emailed link;
// the database holds a SHA-256 hash, so a database read does not yield usable
// links. A token is single-use: consumption is one atomic conditional UPDATE
// (consumed still null, not expired) — under a race exactly one request wins.

import { createHash, randomBytes } from "node:crypto";
import { config } from "./config.js";
import { gql } from "./graphql.js";

export function generateRawToken(): string {
    return randomBytes(32).toString("base64url");
}

export function hashToken(rawToken: string): string {
    return createHash("sha256").update(rawToken).digest("hex");
}

export function tokenExpiry(from: Date): Date {
    return new Date(from.getTime() + config.login.magicLinkExpiryMinutes * 60_000);
}

// Invalidate the email's earlier pending tokens, then store the new hash.
// Returns the raw token for the emailed link.
export async function issueToken(
    email: string,
    redirectUrl: string | null,
): Promise<string> {
    const now = new Date();
    await gql(
        `mutation InvalidatePendingLoginTokens($email: String!, $now: timestamptz!) {
            update_login_token(where: {email: {_eq: $email}, consumed: {_is_null: true}}, _set: {consumed: $now}) {
                affected_rows
            }
        }`,
        { email, now: now.toISOString() },
    );

    const rawToken = generateRawToken();
    await gql(
        `mutation CreateLoginToken($email: String!, $token_hash: String!, $redirect_url: String, $created: timestamptz!, $expires: timestamptz!) {
            insert_login_token_one(object: {email: $email, token_hash: $token_hash, redirect_url: $redirect_url, created: $created, expires: $expires}) {
                login_token_id
            }
        }`,
        {
            email,
            token_hash: hashToken(rawToken),
            redirect_url: redirectUrl,
            created: now.toISOString(),
            expires: tokenExpiry(now).toISOString(),
        },
    );
    return rawToken;
}

export interface ConsumedToken {
    email: string;
    redirectUrl: string | null;
}

// Null when the token is unknown, expired, or already used.
export async function consumeToken(
    rawToken: string,
): Promise<ConsumedToken | null> {
    const tokenHash = hashToken(rawToken);
    const now = new Date().toISOString();

    const consumed = await gql<{
        update_login_token: { affected_rows: number };
    }>(
        `mutation ConsumeLoginToken($token_hash: String!, $now: timestamptz!) {
            update_login_token(where: {token_hash: {_eq: $token_hash}, consumed: {_is_null: true}, expires: {_gt: $now}}, _set: {consumed: $now}) {
                affected_rows
            }
        }`,
        { token_hash: tokenHash, now },
    );
    if (consumed.update_login_token.affected_rows !== 1) return null;

    const fetched = await gql<{
        login_token: Array<{ email: string; redirect_url: string | null }>;
    }>(
        `query GetLoginToken($token_hash: String!) {
            login_token(where: {token_hash: {_eq: $token_hash}}) {
                email
                redirect_url
            }
        }`,
        { token_hash: tokenHash },
    );
    const row = fetched.login_token[0];
    if (!row) return null;
    return { email: row.email, redirectUrl: row.redirect_url };
}
