// Configured-SMTP behaviour with nodemailer mocked out: the transport is
// built from the AUTH_SMTP__* settings and the message carries the link.
// Separate from mailer.test.ts because the config module reads the
// environment once per worker.

import { beforeAll, describe, expect, it, vi } from "vitest";

const sendMail = vi.fn().mockResolvedValue(undefined);
const createTransport = vi.fn().mockReturnValue({ sendMail });

vi.mock("nodemailer", () => ({
    default: { createTransport },
}));

let mailer: typeof import("../src/mailer.js");

beforeAll(async () => {
    process.env.AUTH_SMTP__Host = "smtp.migadu.com";
    process.env.AUTH_SMTP__Port = "465";
    process.env.AUTH_SMTP__Username = "noreply@zxplay.org";
    process.env.AUTH_SMTP__Password = "secret";
    process.env.AUTH_SMTP__From = "ZX Play <noreply@zxplay.org>";
    mailer = await import("../src/mailer.js");
});

describe("sendMagicLink with SMTP configured", () => {
    it("sends through a transport built from the settings", async () => {
        await mailer.sendMagicLink(
            "user@example.com",
            "https://code.zxplay.org/auth/verify?token=abc",
        );

        expect(createTransport).toHaveBeenCalledWith({
            host: "smtp.migadu.com",
            port: 465,
            secure: true,
            auth: { user: "noreply@zxplay.org", pass: "secret" },
        });
        expect(sendMail).toHaveBeenCalledTimes(1);
        const message = sendMail.mock.calls[0]?.[0] as {
            from: string;
            to: string;
            subject: string;
            text: string;
            html: string;
        };
        expect(message.from).toBe("ZX Play <noreply@zxplay.org>");
        expect(message.to).toBe("user@example.com");
        expect(message.text).toContain("https://code.zxplay.org/auth/verify?token=abc");
        expect(message.html).toContain("https://code.zxplay.org/auth/verify?token=abc");
        expect(mailer.lastMessage).toBeNull();

        // The transport is built once and reused.
        await mailer.sendMagicLink("user@example.com", "https://x/");
        expect(createTransport).toHaveBeenCalledTimes(1);
    });
});
