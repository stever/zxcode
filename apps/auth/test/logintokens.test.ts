import { describe, expect, it } from "vitest";
import { generateRawToken, hashToken, tokenExpiry } from "../src/logintokens.js";

describe("generateRawToken", () => {
    it("produces a 43-char base64url token", () => {
        const token = generateRawToken();
        expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it("produces unique tokens", () => {
        const tokens = new Set(Array.from({ length: 100 }, generateRawToken));
        expect(tokens.size).toBe(100);
    });
});

describe("hashToken", () => {
    it("is the SHA-256 hex digest", () => {
        // sha256("abc")
        expect(hashToken("abc")).toBe(
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        );
        expect(hashToken("abc")).toHaveLength(64);
    });

    it("differs for different tokens", () => {
        expect(hashToken("abc")).not.toBe(hashToken("abd"));
    });
});

describe("tokenExpiry", () => {
    it("is the configured minutes after the given time", () => {
        // Dev-mode default: 15 minutes.
        const from = new Date("2026-01-01T12:00:00Z");
        expect(tokenExpiry(from).toISOString()).toBe("2026-01-01T12:15:00.000Z");
    });
});
