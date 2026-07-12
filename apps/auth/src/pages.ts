// Server-rendered pages for the magic-link flow: plain HTML, no JavaScript,
// inline styles only. In production the proxy's CSP does not cover /auth/*,
// so each page carries its own conservative policy; the dev proxy's site-wide
// CSP also permits inline styles.
//
// The look mirrors the @zxplay/ui theme (packages/ui/theme.scss and the nav's
// brand mark in Nav.scss): the ZX token values are copied here because the
// CSP forbids fetching the shared stylesheet. Update these if the theme's
// tokens change.

import type { Response } from "express";

const PAGE_CSP =
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

function escapeHtml(value: string): string {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

function page(title: string, body: string): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
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
input[type="email"] {
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
input[type="email"]:focus {
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
.error {
    color: var(--zx-red);
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

// The form's relative action resolves under the proxy's /auth prefix and
// when the service is addressed directly.
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

export function sendPage(res: Response, status: number, html: string): void {
    res.status(status)
        .header("Content-Security-Policy", PAGE_CSP)
        .type("text/html")
        .send(html);
}
