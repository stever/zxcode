import { describe, expect, it } from "vitest";
import {
    base32Decode,
    base32Encode,
    generateTotpSecret,
    hotp,
    otpauthUri,
    totpAt,
    verifyTotp,
} from "../src/totp.js";

// The RFC 4226 / 6238 test secret: ASCII "12345678901234567890".
const RFC_KEY = Buffer.from("12345678901234567890");
const RFC_SECRET_BASE32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("base32", () => {
    it("matches the RFC 4648 test vectors (unpadded)", () => {
        expect(base32Encode(Buffer.from(""))).toBe("");
        expect(base32Encode(Buffer.from("f"))).toBe("MY");
        expect(base32Encode(Buffer.from("fo"))).toBe("MZXQ");
        expect(base32Encode(Buffer.from("foo"))).toBe("MZXW6");
        expect(base32Encode(Buffer.from("foob"))).toBe("MZXW6YQ");
        expect(base32Encode(Buffer.from("fooba"))).toBe("MZXW6YTB");
        expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
    });

    it("round-trips and tolerates case, whitespace and padding", () => {
        expect(base32Encode(RFC_KEY)).toBe(RFC_SECRET_BASE32);
        expect(base32Decode(RFC_SECRET_BASE32)).toEqual(RFC_KEY);
        expect(base32Decode("mzxw6ytb oi==")).toEqual(Buffer.from("foobar"));
    });

    it("rejects invalid characters", () => {
        expect(() => base32Decode("MZXW1")).toThrow(/invalid base32/);
    });
});

describe("hotp", () => {
    it("matches the RFC 4226 Appendix D vectors", () => {
        const expected = [
            "755224", "287082", "359152", "969429", "338314",
            "254676", "287922", "162583", "399871", "520489",
        ];
        for (let counter = 0; counter < expected.length; counter++) {
            expect(hotp(RFC_KEY, counter)).toBe(expected[counter]);
        }
    });
});

describe("totp", () => {
    // RFC 6238 Appendix B times with the SHA-1 secret; the published 8-digit
    // codes truncated to this module's 6 digits.
    const vectors: Array<[number, string]> = [
        [59, "287082"],
        [1111111109, "081804"],
        [1111111111, "050471"],
        [1234567890, "005924"],
        [2000000000, "279037"],
        [20000000000, "353130"],
    ];

    it("matches the RFC 6238 Appendix B vectors", () => {
        for (const [seconds, code] of vectors) {
            expect(totpAt(RFC_SECRET_BASE32, seconds * 1000)).toBe(code);
        }
    });

    it("verifies the current code and one step either side", () => {
        const now = 1111111111 * 1000;
        expect(verifyTotp("050471", RFC_SECRET_BASE32, now)).toBe(true);
        // 1111111109 is the previous 30s step.
        expect(verifyTotp("081804", RFC_SECRET_BASE32, now)).toBe(true);
        expect(verifyTotp(totpAt(RFC_SECRET_BASE32, now + 30_000), RFC_SECRET_BASE32, now)).toBe(true);
        expect(verifyTotp(totpAt(RFC_SECRET_BASE32, now + 90_000), RFC_SECRET_BASE32, now)).toBe(false);
    });

    it("tolerates spaces and rejects malformed codes", () => {
        const now = 1111111111 * 1000;
        expect(verifyTotp("050 471", RFC_SECRET_BASE32, now)).toBe(true);
        expect(verifyTotp("", RFC_SECRET_BASE32, now)).toBe(false);
        expect(verifyTotp("12345", RFC_SECRET_BASE32, now)).toBe(false);
        expect(verifyTotp("abcdef", RFC_SECRET_BASE32, now)).toBe(false);
    });
});

describe("generateTotpSecret", () => {
    it("is 160 bits of base32", () => {
        const secret = generateTotpSecret();
        expect(secret).toMatch(/^[A-Z2-7]{32}$/);
        expect(generateTotpSecret()).not.toBe(secret);
    });
});

describe("otpauthUri", () => {
    it("encodes issuer, account and parameters", () => {
        const uri = otpauthUri(RFC_SECRET_BASE32, "user@example.com", "ZX Play");
        expect(uri).toBe(
            `otpauth://totp/ZX%20Play:user%40example.com?secret=${RFC_SECRET_BASE32}&issuer=ZX+Play&algorithm=SHA1&digits=6&period=30`,
        );
    });
});
