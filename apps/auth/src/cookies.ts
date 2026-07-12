// Cookie handling, matching the .NET CookieRepository:
// - access_token: the SessionToken JWT. HttpOnly, SameSite=Lax, Secure in
//   production, expires with the session.
// - redirect_url: return URL surviving a redirect away and back. HttpOnly,
//   10 minutes, SameSite=None+Secure in production (third-party redirect),
//   Lax and insecure in dev. Only honoured on read when it starts with
//   AuthRedirect.

import type { Request, Response } from "express";
import { parse as parseCookies } from "cookie";
import { config } from "./config.js";
import { readSessionCookie } from "./tokens.js";
import { getSession, type Session } from "./sessions.js";

function requestCookie(req: Request, name: string): string | undefined {
    const header = req.headers.cookie;
    if (!header) return undefined;
    return parseCookies(header)[name];
}

export interface Authenticated {
    authToken: string;
    session: Session;
}

// Cookie → JWT → session token → live session row, or null at any failure.
export async function authenticate(req: Request): Promise<Authenticated | null> {
    const cookie = requestCookie(req, config.login.authCookieName);
    if (!cookie) return null;
    const authToken = await readSessionCookie(cookie);
    if (!authToken) return null;
    const session = await getSession(authToken);
    if (!session) return null;
    return { authToken, session };
}

export function setAuthCookie(res: Response, jwt: string, expires: Date): void {
    res.cookie(config.login.authCookieName, jwt, {
        sameSite: "lax",
        secure: !config.devMode,
        httpOnly: true,
        expires,
    });
}

export function storeReturnUrl(res: Response, returnUrl: string): void {
    res.cookie(config.login.returnUrlCookieName, returnUrl, {
        sameSite: config.devMode ? "lax" : "none",
        secure: !config.devMode,
        httpOnly: true,
        expires: new Date(Date.now() + 10 * 60_000),
    });
}

export function popReturnUrl(req: Request, res: Response): string {
    const value = requestCookie(req, config.login.returnUrlCookieName);
    res.clearCookie(config.login.returnUrlCookieName);
    if (value && value.startsWith(config.authRedirect)) return value;
    return config.authRedirect;
}

export function deleteAuthCookies(res: Response): void {
    res.clearCookie(config.login.authCookieName);
    res.clearCookie(config.login.returnUrlCookieName);
}
