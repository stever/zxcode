// The HTTP surface. The proxy strips the /auth prefix, so paths here are
// /login, /me, etc. Login is a passwordless magic-link flow: the login page
// takes an email address, /login/email mails a single-use link, /verify
// consumes it and establishes the session.

import express, { type Request, type Response } from "express";
import { config } from "./config.js";
import { authenticate, deleteAuthCookies, popReturnUrl } from "./cookies.js";
import { performLogin } from "./login.js";
import { getRoles } from "./users.js";
import { mintHasuraToken } from "./tokens.js";
import { consumeToken, issueToken } from "./logintokens.js";
import { sendMagicLink } from "./mailer.js";
import { allow } from "./ratelimit.js";
import { checkEmailPage, linkInvalidPage, loginPage, sendPage } from "./pages.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const EMAIL_RATE_LIMIT = 3;
const IP_RATE_LIMIT = 10;
const RATE_WINDOW_MS = 15 * 60_000;

function corsMiddleware(
    req: Request,
    res: Response,
    next: () => void,
): void {
    const origin = req.headers.origin;
    if (origin && config.corsOrigins?.includes(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") {
        res.status(204).end();
        return;
    }
    next();
}

// Login's return-URL guard: only URLs under AuthRedirect may be redirected
// to (open-redirect protection).
function loginReturnUrl(redirect: string | undefined): string {
    const base = config.authRedirect;
    if (!redirect) return base;
    if (!redirect.startsWith(base)) {
        throw new Error(`invalid redirect_url: ${redirect}`);
    }
    return redirect;
}

// Lenient variant for values that only steer where a page or emailed link
// eventually redirects: anything invalid falls back to the base.
function safeReturnUrl(redirect: string | undefined): string {
    try {
        return loginReturnUrl(redirect);
    } catch {
        return config.authRedirect;
    }
}

function magicLinkUrl(rawToken: string): string {
    let base = config.authRedirect;
    if (!base.endsWith("/")) base = `${base}/`;
    return `${base}auth/verify?token=${rawToken}`;
}

function sessionExpiry(): Date {
    return new Date(Date.now() + config.login.defaultExpirationMinutes * 60_000);
}

async function handleLogin(req: Request, res: Response): Promise<void> {
    const redirect =
        typeof req.query.redirect_url === "string" ? req.query.redirect_url : undefined;

    // Dev mode: skip the magic-link flow entirely and log in the configured
    // user.
    if (config.debugAutoLoginUsername) {
        await performLogin(
            config.debugAutoLoginUsername,
            sessionExpiry(),
            null,
            req,
            res,
        );
        return;
    }

    if (await authenticate(req)) {
        res.redirect(loginReturnUrl(redirect));
        return;
    }

    sendPage(res, 200, loginPage(safeReturnUrl(redirect)));
}

export function createApp(): express.Express {
    const app = express();
    app.disable("x-powered-by");
    app.set("trust proxy", true);
    app.use(corsMiddleware);
    app.use(express.urlencoded({ extended: false }));

    app.get("/healthz", (_req, res) => {
        res.type("text/plain").send("OK");
    });

    app.get("/", handleLogin);
    app.get("/login", handleLogin);

    app.post("/login/email", async (req, res) => {
        const body = req.body as Record<string, unknown>;
        const rawEmail = typeof body.email === "string" ? body.email : "";
        const email = rawEmail.trim().toLowerCase();
        const redirect = safeReturnUrl(
            typeof body.redirect_url === "string" ? body.redirect_url : undefined,
        );

        if (!EMAIL_PATTERN.test(email)) {
            sendPage(res, 400, loginPage(redirect, "That doesn't look like an email address."));
            return;
        }

        // Over the limit the response is indistinguishable from success; the
        // page never reveals whether an email maps to an account either way.
        const withinLimits =
            allow(`email:${email}`, EMAIL_RATE_LIMIT, RATE_WINDOW_MS) &&
            allow(`ip:${req.ip}`, IP_RATE_LIMIT, RATE_WINDOW_MS);
        if (withinLimits) {
            const rawToken = await issueToken(email, redirect);
            await sendMagicLink(email, magicLinkUrl(rawToken));
        } else {
            console.log(`rate limit hit for ${email} (${req.ip})`);
        }
        sendPage(res, 200, checkEmailPage());
    });

    app.get("/verify", async (req, res) => {
        const rawToken =
            typeof req.query.token === "string" ? req.query.token : "";
        const consumed = rawToken ? await consumeToken(rawToken) : null;
        if (!consumed) {
            sendPage(res, 400, linkInvalidPage());
            return;
        }
        // The stored redirect was validated at issuance; re-check anyway.
        const redirect = safeReturnUrl(consumed.redirectUrl ?? undefined);
        await performLogin(
            consumed.email,
            sessionExpiry(),
            consumed.email,
            req,
            res,
            redirect,
        );
    });

    app.get("/me", async (req, res) => {
        const auth = await authenticate(req);
        if (!auth) {
            res.status(401).end();
            return;
        }
        const roles = await getRoles(auth.session.user.user_id);
        res.json({ userId: auth.session.user.user_id, roles });
    });

    app.get("/token", async (req, res) => {
        const auth = await authenticate(req);
        if (!auth) {
            res.status(401).end();
            return;
        }
        const userId = auth.session.user.user_id;
        const roles = await getRoles(userId);
        res.json({ token: await mintHasuraToken(userId, roles) });
    });

    app.get("/logout", async (req, res) => {
        const redirect =
            typeof req.query.redirect_url === "string"
                ? req.query.redirect_url
                : undefined;
        const auth = await authenticate(req);
        if (!auth) {
            res.status(401).end();
            return;
        }
        deleteAuthCookies(res);
        res.redirect(safeReturnUrl(redirect));
    });

    app.get("/logout/return", (req, res) => {
        res.redirect(popReturnUrl(req, res));
    });

    // Unhandled errors → 500, logged (the .NET service behaved the same).
    app.use(
        (
            err: unknown,
            _req: Request,
            res: Response,
            _next: (err?: unknown) => void,
        ) => {
            console.error("unhandled error:", err);
            res.status(500).end();
        },
    );

    return app;
}
