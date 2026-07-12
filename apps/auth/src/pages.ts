// Server-rendered pages for the magic-link flow: plain HTML, no JavaScript,
// inline styles only. In production the proxy's CSP does not cover /auth/*,
// so each page carries its own conservative policy; the dev proxy's site-wide
// CSP also permits inline styles.

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
<title>${escapeHtml(title)}</title>
<style>
body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #1a1a2e;
    color: #eee;
    font-family: system-ui, sans-serif;
}
main {
    max-width: 22rem;
    padding: 2rem;
    background: #16213e;
    border-radius: 0.5rem;
    text-align: center;
}
h1 {
    font-size: 1.25rem;
    margin: 0 0 1rem;
}
p {
    margin: 0.75rem 0;
    line-height: 1.4;
    color: #ccc;
}
input[type="email"] {
    width: 100%;
    box-sizing: border-box;
    padding: 0.6rem;
    margin: 0.75rem 0;
    border: 1px solid #444;
    border-radius: 0.25rem;
    background: #1a1a2e;
    color: #eee;
    font-size: 1rem;
}
button, a.button {
    display: inline-block;
    padding: 0.6rem 1.5rem;
    border: 0;
    border-radius: 0.25rem;
    background: #e94560;
    color: #fff;
    font-size: 1rem;
    cursor: pointer;
    text-decoration: none;
}
.error {
    color: #e94560;
}
</style>
</head>
<body>
<main>
${body}
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
        `<h1>Sign in to ZX Play</h1>
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
