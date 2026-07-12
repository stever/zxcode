// Outbound mail for the magic links. With AUTH_SMTP__* configured this sends
// through the SMTP submission service (Migadu); otherwise — always the case
// in plain dev — the "sent" message is logged so the link can be followed by
// hand, and recorded on lastMessage for the integration tests.

import nodemailer, { type Transporter } from "nodemailer";
import { config } from "./config.js";

export interface MagicLinkMessage {
    to: string;
    link: string;
}

// The most recent unsent message; only populated when SMTP is unconfigured.
export let lastMessage: MagicLinkMessage | null = null;

let transporter: Transporter | null = null;

function transport(): Transporter {
    if (!transporter) {
        transporter = nodemailer.createTransport({
            host: config.smtp.host,
            port: config.smtp.port,
            secure: config.smtp.secure,
            auth: {
                user: config.smtp.username,
                pass: config.smtp.password,
            },
        });
    }
    return transporter;
}

export async function sendMagicLink(email: string, link: string): Promise<void> {
    if (!config.smtp.configured) {
        lastMessage = { to: email, link };
        console.log(`SMTP not configured; magic link for ${email}: ${link}`);
        return;
    }
    await transport().sendMail({
        from: config.smtp.from,
        to: email,
        subject: "Sign in to ZX Play",
        text:
            `Follow this link to sign in:\n\n${link}\n\n` +
            `The link can be used once and expires in ${config.login.magicLinkExpiryMinutes} minutes. ` +
            "If you didn't request it, you can ignore this email.",
        html:
            `<p>Follow this link to sign in:</p>` +
            `<p><a href="${link}">${link}</a></p>` +
            `<p>The link can be used once and expires in ${config.login.magicLinkExpiryMinutes} minutes. ` +
            "If you didn't request it, you can ignore this email.</p>",
    });
}
