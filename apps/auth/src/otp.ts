// OTP enrolment state and recovery codes, over the admin GraphQL documents.
// One user_otp row per user: enabled NULL is a pending enrolment (secret
// issued, no valid code seen yet), enabled set means logins are challenged.
// Recovery codes are stored as SHA-256 hashes and consumed by an atomic
// conditional UPDATE, so each works exactly once.

import { createHash, randomBytes } from "node:crypto";
import { gql } from "./graphql.js";
import { base32Encode, generateTotpSecret } from "./totp.js";

export const RECOVERY_CODE_COUNT = 10;

export interface UserOtp {
    secret: string;
    enabled: string | null;
    last_used_step: number | null;
}

export async function getUserOtp(userId: string): Promise<UserOtp | null> {
    const data = await gql<{ user_otp: UserOtp[] }>(
        `query GetUserOtp($user_id: uuid!) {
            user_otp(where: {user_id: {_eq: $user_id}}) { secret enabled last_used_step }
        }`,
        { user_id: userId },
    );
    return data.user_otp[0] ?? null;
}

// RFC 6238 one-time use: atomically claims a TOTP time step, mirroring the
// recovery codes' conditional UPDATE. False when that step — or a later
// one — was already accepted, so a replayed code fails even when two
// requests race.
export async function consumeTotpStep(
    userId: string,
    step: number,
): Promise<boolean> {
    const data = await gql<{ update_user_otp: { affected_rows: number } }>(
        `mutation ConsumeTotpStep($user_id: uuid!, $step: Int!) {
            update_user_otp(where: {user_id: {_eq: $user_id}, _or: [{last_used_step: {_is_null: true}}, {last_used_step: {_lt: $step}}]}, _set: {last_used_step: $step}) {
                affected_rows
            }
        }`,
        { user_id: userId, step },
    );
    return data.update_user_otp.affected_rows === 1;
}

// Issue a fresh pending secret, replacing any earlier unconfirmed one. The
// caller guards against an already-enabled row (the PK would reject the
// insert anyway).
export async function createPendingOtp(userId: string): Promise<string> {
    await gql(
        `mutation DeletePendingOtp($user_id: uuid!) {
            delete_user_otp(where: {user_id: {_eq: $user_id}, enabled: {_is_null: true}}) {
                affected_rows
            }
        }`,
        { user_id: userId },
    );
    const secret = generateTotpSecret();
    await gql(
        `mutation CreateUserOtp($user_id: uuid!, $secret: String!, $created: timestamptz!) {
            insert_user_otp_one(object: {user_id: $user_id, secret: $secret, created: $created}) {
                user_id
            }
        }`,
        { user_id: userId, secret, created: new Date().toISOString() },
    );
    return secret;
}

// Flips the pending row to enabled; false when there was nothing pending.
export async function enableOtp(userId: string): Promise<boolean> {
    const data = await gql<{ update_user_otp: { affected_rows: number } }>(
        `mutation EnableUserOtp($user_id: uuid!, $now: timestamptz!) {
            update_user_otp(where: {user_id: {_eq: $user_id}, enabled: {_is_null: true}}, _set: {enabled: $now}) {
                affected_rows
            }
        }`,
        { user_id: userId, now: new Date().toISOString() },
    );
    return data.update_user_otp.affected_rows === 1;
}

export async function deleteOtp(userId: string): Promise<void> {
    await gql(
        `mutation DeleteUserOtp($user_id: uuid!) {
            delete_user_otp(where: {user_id: {_eq: $user_id}}) { affected_rows }
        }`,
        { user_id: userId },
    );
    await gql(
        `mutation DeleteOtpRecoveryCodes($user_id: uuid!) {
            delete_otp_recovery_code(where: {user_id: {_eq: $user_id}}) { affected_rows }
        }`,
        { user_id: userId },
    );
}

// XXXX-XXXX from 5 random bytes of base32.
function generateRecoveryCode(): string {
    const raw = base32Encode(randomBytes(5));
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
}

// Uppercase base32 with the dash dropped, so user input survives spacing
// and case differences.
function normalizeRecoveryCode(code: string): string {
    return code.toUpperCase().replace(/[^A-Z2-7]/g, "");
}

export function hashRecoveryCode(code: string): string {
    return createHash("sha256").update(normalizeRecoveryCode(code)).digest("hex");
}

// Replaces the user's codes with a fresh set and returns the plaintexts —
// shown once at enrolment, never again.
export async function replaceRecoveryCodes(userId: string): Promise<string[]> {
    await gql(
        `mutation DeleteOtpRecoveryCodes($user_id: uuid!) {
            delete_otp_recovery_code(where: {user_id: {_eq: $user_id}}) { affected_rows }
        }`,
        { user_id: userId },
    );
    const codes: string[] = [];
    const created = new Date().toISOString();
    while (codes.length < RECOVERY_CODE_COUNT) {
        const code = generateRecoveryCode();
        codes.push(code);
        await gql(
            `mutation CreateOtpRecoveryCode($user_id: uuid!, $code_hash: String!, $created: timestamptz!) {
                insert_otp_recovery_code_one(object: {user_id: $user_id, code_hash: $code_hash, created: $created}) {
                    recovery_code_id
                }
            }`,
            { user_id: userId, code_hash: hashRecoveryCode(code), created },
        );
    }
    return codes;
}

// Atomic single-use consumption; false when unknown, used, or another user's.
export async function consumeRecoveryCode(
    userId: string,
    code: string,
): Promise<boolean> {
    const data = await gql<{
        update_otp_recovery_code: { affected_rows: number };
    }>(
        `mutation ConsumeOtpRecoveryCode($user_id: uuid!, $code_hash: String!, $now: timestamptz!) {
            update_otp_recovery_code(where: {user_id: {_eq: $user_id}, code_hash: {_eq: $code_hash}, used: {_is_null: true}}, _set: {used: $now}) {
                affected_rows
            }
        }`,
        {
            user_id: userId,
            code_hash: hashRecoveryCode(code),
            now: new Date().toISOString(),
        },
    );
    return data.update_otp_recovery_code.affected_rows === 1;
}

export async function unusedRecoveryCodeCount(userId: string): Promise<number> {
    const data = await gql<{
        otp_recovery_code: Array<{ recovery_code_id: string }>;
    }>(
        `query GetUnusedRecoveryCodes($user_id: uuid!) {
            otp_recovery_code(where: {user_id: {_eq: $user_id}, used: {_is_null: true}}) {
                recovery_code_id
            }
        }`,
        { user_id: userId },
    );
    return data.otp_recovery_code.length;
}
