// The HTTP surface, route for route with the .NET controllers. The proxy
// strips the /auth prefix, so paths here are /login, /me, etc.

import express, { type Request, type Response } from "express";
import { config } from "./config.js";
import { authenticate, deleteAuthCookies, popReturnUrl, storeReturnUrl } from "./cookies.js";
import { performLogin } from "./login.js";
import { getRoles } from "./users.js";
import { mintHasuraToken } from "./tokens.js";
import { loginUrl, samlEnabled, validateSamlResponse } from "./saml.js";

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

// Logout's variant appends a route to the normalised base (no validation —
// the value only ends up in the prefix-checked redirect_url cookie).
function logoutReturnUrl(route: string | undefined): string {
    let base = config.authRedirect;
    if (!base.endsWith("/")) base = `${base}/`;
    if (!route) return base;
    return base + (route.startsWith("/") ? route.slice(1) : route);
}

async function handleLogin(req: Request, res: Response): Promise<void> {
    const redirect =
        typeof req.query.redirect_url === "string" ? req.query.redirect_url : undefined;

    // Dev mode: skip SAML entirely and log in the configured user.
    if (config.debugAutoLoginUsername) {
        const expiry = new Date(
            Date.now() + config.saml.defaultExpirationMinutes * 60_000,
        );
        await performLogin(config.debugAutoLoginUsername, expiry, null, req, res);
        return;
    }

    if (await authenticate(req)) {
        res.redirect(loginReturnUrl(redirect));
        return;
    }

    if (!samlEnabled()) {
        res.status(500).send("SAML is not configured");
        return;
    }
    storeReturnUrl(res, redirect ?? "");
    res.redirect(await loginUrl());
}

export function createApp(): express.Express {
    const app = express();
    app.disable("x-powered-by");
    app.use(corsMiddleware);
    app.use(express.urlencoded({ extended: false }));

    app.get("/healthz", (_req, res) => {
        res.type("text/plain").send("OK");
    });

    app.get("/", handleLogin);
    app.get("/login", handleLogin);

    app.post("/assertion-consumer", async (req, res) => {
        const samlResponse = (req.body as Record<string, unknown>).SAMLResponse;
        if (typeof samlResponse !== "string" || !samlResponse) {
            res.status(400).end();
            return;
        }
        let result;
        try {
            result = await validateSamlResponse(samlResponse);
        } catch (err) {
            console.error("SAML response rejected:", err);
            res.status(400).end();
            return;
        }
        await performLogin(
            result.username,
            result.sessionExpiry,
            result.email,
            req,
            res,
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
        if (config.saml.logoutLink) {
            storeReturnUrl(res, logoutReturnUrl(redirect));
            res.redirect(config.saml.logoutLink);
            return;
        }
        res.redirect(config.authRedirect);
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
