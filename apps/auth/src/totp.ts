// RFC 6238 TOTP (HMAC-SHA1, 6 digits, 30-second steps) and the RFC 4648
// base32 codec authenticator apps expect. Implemented on node:crypto rather
// than a dependency: the algorithm is ~40 lines and the RFC publishes test
// vectors (see totp.test.ts).

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;

// Codes one step either side of now still verify (clock skew).
const VERIFY_WINDOW_STEPS = 1;

export function base32Encode(bytes: Uint8Array): string {
    let bits = 0;
    let value = 0;
    let out = "";
    for (const byte of bytes) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
    return out;
}

export function base32Decode(encoded: string): Buffer {
    const clean = encoded.toUpperCase().replace(/[\s=]/g, "");
    let bits = 0;
    let value = 0;
    const out: number[] = [];
    for (const char of clean) {
        const index = BASE32_ALPHABET.indexOf(char);
        if (index === -1) throw new Error(`invalid base32 character: ${char}`);
        value = (value << 5) | index;
        bits += 5;
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return Buffer.from(out);
}

// 160-bit secret, the RFC 4226 recommended size.
export function generateTotpSecret(): string {
    return base32Encode(randomBytes(20));
}

export function hotp(key: Buffer, counter: number): string {
    const counterBytes = Buffer.alloc(8);
    counterBytes.writeBigUInt64BE(BigInt(counter));
    const digest = createHmac("sha1", key).update(counterBytes).digest();
    const offset = (digest[digest.length - 1] as number) & 0x0f;
    const binary =
        (((digest[offset] as number) & 0x7f) << 24) |
        ((digest[offset + 1] as number) << 16) |
        ((digest[offset + 2] as number) << 8) |
        (digest[offset + 3] as number);
    return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

export function totpAt(base32Secret: string, unixMillis: number): string {
    const counter = Math.floor(unixMillis / 1000 / TOTP_PERIOD_SECONDS);
    return hotp(base32Decode(base32Secret), counter);
}

// Returns the matched time-step counter, or null when the code doesn't
// verify. RFC 6238 §5.2 one-time use: callers record the accepted step
// (user_otp.last_used_step) and reject any step at or below it.
export function matchTotpStep(
    code: string,
    base32Secret: string,
    unixMillis = Date.now(),
): number | null {
    const trimmed = code.replace(/\s/g, "");
    if (!/^\d{6}$/.test(trimmed)) return null;
    const key = base32Decode(base32Secret);
    const counter = Math.floor(unixMillis / 1000 / TOTP_PERIOD_SECONDS);
    const given = Buffer.from(trimmed);
    for (let step = -VERIFY_WINDOW_STEPS; step <= VERIFY_WINDOW_STEPS; step++) {
        const expected = Buffer.from(hotp(key, counter + step));
        if (timingSafeEqual(given, expected)) return counter + step;
    }
    return null;
}

export function verifyTotp(
    code: string,
    base32Secret: string,
    unixMillis = Date.now(),
): boolean {
    return matchTotpStep(code, base32Secret, unixMillis) !== null;
}

// The otpauth:// URI encoded into the enrolment QR code.
export function otpauthUri(
    base32Secret: string,
    account: string,
    issuer: string,
): string {
    const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
    const params = new URLSearchParams({
        secret: base32Secret,
        issuer,
        algorithm: "SHA1",
        digits: String(TOTP_DIGITS),
        period: String(TOTP_PERIOD_SECONDS),
    });
    return `otpauth://totp/${label}?${params.toString()}`;
}
