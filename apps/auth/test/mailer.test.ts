// Unconfigured-SMTP behaviour (the dev default): nothing is sent, the link
// is logged and captured on the lastMessage hook. The configured path is in
// mailer-smtp.test.ts — a separate file, because the config module reads the
// environment once per worker.

import { describe, expect, it } from "vitest";
import { lastMessage, sendMagicLink } from "../src/mailer.js";
import * as mailer from "../src/mailer.js";

describe("sendMagicLink without SMTP configured", () => {
    it("records the message instead of sending", async () => {
        expect(lastMessage).toBeNull();
        await sendMagicLink("dev@example.com", "http://localhost:8080/auth/verify?token=abc");
        expect(mailer.lastMessage).toEqual({
            to: "dev@example.com",
            link: "http://localhost:8080/auth/verify?token=abc",
        });
    });
});
