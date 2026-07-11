import { describe, expect, it } from "vitest";
import { jwtVerify } from "jose";
import {
    mintHasuraToken,
    mintSessionToken,
    readSessionCookie,
} from "../src/tokens.js";

// Dev-mode default secret (vitest.config sets AUTH_DEV_MODE).
const SECRET = new TextEncoder().encode("XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX");

describe("session token", () => {
    it("carries roles and props.auth, aud caddy", async () => {
        const jwt = await mintSessionToken("session-token-123", ["zxplay-user"]);
        const { payload } = await jwtVerify(jwt, SECRET, {
            issuer: "zxplay",
            audience: "caddy",
        });
        expect(payload.roles).toEqual(["zxplay-user"]);
        expect(payload.props).toEqual({ auth: "session-token-123" });
        expect(payload.exp! - Math.floor(Date.now() / 1000)).toBeGreaterThan(28000);
    });

    it("round-trips through the cookie reader", async () => {
        const jwt = await mintSessionToken("abc", ["zxplay-user"]);
        expect(await readSessionCookie(jwt)).toBe("abc");
    });

    it("rejects tampered cookies", async () => {
        const jwt = await mintSessionToken("abc", ["zxplay-user"]);
        const [header, payload] = jwt.split(".");
        expect(await readSessionCookie(`${header}.${payload}.AAAA`)).toBeNull();
        expect(await readSessionCookie("garbage")).toBeNull();
    });
});

describe("hasura token", () => {
    it("carries the Hasura claims namespace, aud hasura", async () => {
        const jwt = await mintHasuraToken("user-1", ["zxplay-user", "admin"]);
        const { payload } = await jwtVerify(jwt, SECRET, {
            issuer: "zxplay",
            audience: "hasura",
        });
        expect(payload["https://hasura.io/jwt/claims"]).toEqual({
            "X-Hasura-User-Id": "user-1",
            "X-Hasura-Allowed-Roles": ["zxplay-user", "admin"],
            "X-Hasura-Default-Role": "zxplay-user",
        });
        expect(payload.exp! - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(900);
    });
});
