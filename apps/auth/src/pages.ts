// Server-rendered pages for the magic-link and OTP flows: plain HTML, no
// JavaScript, inline styles only. In production the proxy's CSP does not
// cover /auth/*, so each page carries its own conservative policy; the dev
// proxy's site-wide CSP also permits inline styles.
//
// The look mirrors the @zxplay/ui theme (packages/ui/theme.scss and the nav's
// brand mark in Nav.scss): the ZX token values are copied here because the
// CSP forbids fetching the shared stylesheet. Update these if the theme's
// tokens change.

import type { Response } from "express";
import { config } from "./config.js";

const PAGE_CSP =
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'self'; frame-ancestors 'none'";

function escapeHtml(value: string): string {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

// The public base of this service (the proxy serves it under /auth). Form
// actions and links are relative and resolve against a <base> tag pointing
// here, so they work from any page URL — including error re-renders, whose
// page URL is the POST target itself.
function publicBase(): string {
    let base = config.authRedirect;
    if (!base.endsWith("/")) base = `${base}/`;
    return `${base}auth/`;
}

function page(title: string, body: string): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<base href="${escapeHtml(publicBase())}">
<title>${escapeHtml(title)} · ZX Play</title>
<style>
:root {
    --zx-ground: #14110F;
    --zx-surface: #1E1A17;
    --zx-text: #E8E2D9;
    --zx-muted: #8C857B;
    --zx-line-2: rgba(232, 226, 217, 0.16);
    --zx-cyan: #2BD4D4;
    --zx-red: #D8222A;
    --zx-rainbow: linear-gradient(90deg,
        #D8222A 0 25%, #E8C400 25% 50%,
        #2FC04B 50% 75%, #2BD4D4 75% 100%);
    --zx-mono: ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace;
    color-scheme: dark;
}
* {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
}
body {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--zx-ground);
    color: var(--zx-text);
    font-family: system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    padding: 1rem;
}
main {
    width: 100%;
    max-width: 24rem;
    background: var(--zx-surface);
    border: 1px solid var(--zx-line-2);
    border-radius: 8px;
    overflow: hidden;
}
.zx-rule {
    height: 3px;
    background: var(--zx-rainbow);
    opacity: 0.9;
}
.zx-inner {
    padding: 1.75rem;
}
.zx-brand {
    display: inline-flex;
    align-items: center;
    gap: 0.7rem;
    margin-bottom: 1.5rem;
}
.zx-mark {
    width: 30px;
    height: 22px;
    border-radius: 3px;
    overflow: hidden;
    background: #000;
    flex: none;
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.08);
}
.zx-mark i {
    display: block;
    height: 100%;
    transform: skewX(-22deg) scale(1.4);
    background: var(--zx-rainbow);
}
.zx-wordmark {
    font-weight: 800;
    font-size: 0.95rem;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    white-space: nowrap;
}
h1 {
    font-size: 1.15rem;
    font-weight: 600;
    margin-bottom: 0.75rem;
}
p {
    margin: 0.75rem 0;
    line-height: 1.5;
    font-size: 0.9rem;
    color: var(--zx-muted);
}
a {
    color: var(--zx-cyan);
}
input[type="email"],
input[type="text"] {
    width: 100%;
    padding: 0.6rem 0.75rem;
    margin: 0.75rem 0;
    border: 1px solid var(--zx-line-2);
    border-radius: 6px;
    background: var(--zx-ground);
    color: var(--zx-text);
    font-size: 1rem;
    font-family: inherit;
}
input[type="email"]:focus,
input[type="text"]:focus {
    outline: none;
    border-color: var(--zx-cyan);
    box-shadow: 0 0 0 2px rgba(43, 212, 212, 0.25);
}
button, a.button {
    display: inline-block;
    padding: 0.6rem 1.5rem;
    border: 0;
    border-radius: 6px;
    background: var(--zx-cyan);
    color: #08110F;
    font-size: 0.95rem;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
    text-decoration: none;
}
button:hover, a.button:hover {
    background: #4BE0E0;
}
button:focus-visible, a.button:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--zx-ground), 0 0 0 4px rgba(43, 212, 212, 0.55);
}
button.zx-danger {
    background: var(--zx-red);
    color: #fff;
}
button.zx-danger:hover {
    background: #E8404A;
}
.error {
    color: var(--zx-red);
}
.qr {
    display: inline-block;
    padding: 0.6rem;
    margin: 0.75rem 0 0;
    background: #fff;
    border-radius: 6px;
}
.qr svg {
    display: block;
    width: 180px;
    height: 180px;
}
.secret {
    font-family: var(--zx-mono);
    font-size: 0.85rem;
    letter-spacing: 0.05em;
    word-break: break-all;
    background: var(--zx-ground);
    border: 1px solid var(--zx-line-2);
    border-radius: 6px;
    padding: 0.5rem 0.75rem;
    margin: 0.75rem 0;
}
.codes {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 0.5rem;
    margin: 1rem 0;
    font-family: var(--zx-mono);
    font-size: 0.95rem;
}
.footer-link {
    margin-top: 1.25rem;
    font-size: 0.85rem;
}
</style>
</head>
<body>
<main>
<div class="zx-rule"></div>
<div class="zx-inner">
<div class="zx-brand"><span class="zx-mark"><i></i></span><span class="zx-wordmark">ZX Play</span></div>
${body}
</div>
</main>
</body>
</html>
`;
}

// Form actions and hrefs are relative and resolve against the page's <base>
// (the public /auth/ prefix).
export function loginPage(redirectUrl: string, error?: string): string {
    const errorHtml = error ? `<p class="error">${escapeHtml(error)}</p>` : "";
    return page(
        "Sign in",
        `<h1>Sign in</h1>
<p>Enter your email address and we&#39;ll send you a sign-in link. No password needed.</p>
${errorHtml}
<form method="post" action="login/email">
<input type="email" name="email" placeholder="you@example.com" required autofocus>
<input type="hidden" name="redirect_url" value="${escapeHtml(redirectUrl)}">
<button type="submit">Email me a link</button>
</form>`,
    );
}

export function checkEmailPage(): string {
    return page(
        "Check your email",
        `<h1>Check your email</h1>
<p>If the address is valid, a sign-in link is on its way. It can be used once and expires shortly.</p>
<p>You can close this page.</p>`,
    );
}

export function linkInvalidPage(): string {
    return page(
        "Link expired",
        `<h1>That link didn&#39;t work</h1>
<p>The sign-in link has expired or was already used.</p>
<a class="button" href="login">Request a new link</a>`,
    );
}

export function otpStatusPage(
    enabled: boolean,
    recoveryCodesLeft = 0,
    error?: string,
): string {
    const errorHtml = error ? `<p class="error">${escapeHtml(error)}</p>` : "";
    const body = enabled
        ? `<h1>Two-factor authentication</h1>
<p>Two-factor authentication is <strong>on</strong>. Signing in by email link also asks for a code from your authenticator app.</p>
<p>${recoveryCodesLeft} unused recovery ${recoveryCodesLeft === 1 ? "code" : "codes"} left. For a fresh set, turn two-factor off and set it up again.</p>
${errorHtml}
<form method="post" action="otp/disable">
<input type="text" name="code" placeholder="Authenticator or recovery code" inputmode="numeric" autocomplete="one-time-code" required>
<button type="submit" class="zx-danger">Turn off</button>
</form>
<p class="footer-link"><a href="${escapeHtml(config.authRedirect)}">Back to ZX Play</a></p>`
        : `<h1>Two-factor authentication</h1>
<p>Two-factor authentication is <strong>off</strong>. Turn it on and signing in will need a code from an authenticator app as well as your email link.</p>
${errorHtml}
<form method="post" action="otp/setup">
<button type="submit">Set up authenticator</button>
</form>
<p class="footer-link"><a href="${escapeHtml(config.authRedirect)}">Back to ZX Play</a></p>`;
    return page("Two-factor authentication", body);
}

export function otpSetupPage(
    qrSvg: string,
    secret: string,
    error?: string,
): string {
    const errorHtml = error ? `<p class="error">${escapeHtml(error)}</p>` : "";
    return page(
        "Set up authenticator",
        `<h1>Set up authenticator</h1>
<p>Scan the QR code with your authenticator app, or enter the secret by hand. Then enter the 6-digit code the app shows to finish.</p>
<div class="qr">${qrSvg}</div>
<div class="secret">${escapeHtml(secret)}</div>
${errorHtml}
<form method="post" action="otp/enable">
<input type="text" name="code" placeholder="123456" inputmode="numeric" autocomplete="one-time-code" required autofocus>
<button type="submit">Turn on</button>
</form>`,
    );
}

export function otpRecoveryCodesPage(codes: string[]): string {
    const items = codes
        .map((code) => `<div>${escapeHtml(code)}</div>`)
        .join("\n");
    return page(
        "Recovery codes",
        `<h1>Recovery codes</h1>
<p>Two-factor authentication is now on. Store these codes somewhere safe — each one signs you in once if you lose your authenticator, and they are shown only now.</p>
<div class="codes">
${items}
</div>
<a class="button" href="${escapeHtml(config.authRedirect)}">Done</a>`,
    );
}

export function otpChallengePage(error?: string): string {
    const errorHtml = error ? `<p class="error">${escapeHtml(error)}</p>` : "";
    return page(
        "Enter your code",
        `<h1>Enter your code</h1>
<p>This account is protected by two-factor authentication. Enter the 6-digit code from your authenticator app, or one of your recovery codes.</p>
${errorHtml}
<form method="post" action="otp/login">
<input type="text" name="code" placeholder="123456" inputmode="numeric" autocomplete="one-time-code" required autofocus>
<button type="submit">Sign in</button>
</form>`,
    );
}

export function sendPage(res: Response, status: number, html: string): void {
    res.status(status)
        .header("Content-Security-Policy", PAGE_CSP)
        .type("text/html")
        .send(html);
}
