// The HTTP surface. The proxy strips the /auth prefix, so paths here are
// /login, /me, etc. Login is a passwordless magic-link flow: the login page
// takes an email address, /login/email mails a single-use link, /verify
// consumes it and establishes the session.

import express, { type Request, type Response } from "express";
import QRCode from "qrcode-svg";
import { config } from "./config.js";
import {
    authenticate,
    deleteAuthCookies,
    popReturnUrl,
    requestCookie,
    type Authenticated,
} from "./cookies.js";
import { establishSession, performLogin } from "./login.js";
import { getRoles, getUser, getUserByEmail, getUserById } from "./users.js";
import {
    mintHasuraToken,
    mintOtpChallenge,
    readOtpChallenge,
} from "./tokens.js";
import { consumeToken, issueToken } from "./logintokens.js";
import {
    consumeRecoveryCode,
    createPendingOtp,
    deleteOtp,
    enableOtp,
    getUserOtp,
    replaceRecoveryCodes,
    unusedRecoveryCodeCount,
} from "./otp.js";
import { otpauthUri, verifyTotp } from "./totp.js";
import { sendMagicLink } from "./mailer.js";
import { allow } from "./ratelimit.js";
import {
    checkEmailPage,
    linkInvalidPage,
    loginPage,
    otpChallengePage,
    otpRecoveryCodesPage,
    otpSetupPage,
    otpStatusPage,
    sendPage,
} from "./pages.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const EMAIL_RATE_LIMIT = 3;
const IP_RATE_LIMIT = 10;
const OTP_ATTEMPT_LIMIT = 10;
const RATE_WINDOW_MS = 15 * 60_000;

const OTP_CHALLENGE_COOKIE = "otp_challenge";
const OTP_ISSUER = "ZX Play";

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

// Absolute public URL of a route on this service (the proxy mounts it under
// /auth). Redirects use these rather than relative paths, which would
// resolve against the POST target's URL.
function publicUrl(route: string): string {
    let base = config.authRedirect;
    if (!base.endsWith("/")) base = `${base}/`;
    return `${base}auth/${route}`;
}

function magicLinkUrl(rawToken: string): string {
    return `${publicUrl("verify")}?token=${rawToken}`;
}

function sessionExpiry(): Date {
    return new Date(Date.now() + config.login.defaultExpirationMinutes * 60_000);
}

function otpSetupQr(secret: string, account: string): string {
    return new QRCode({
        content: otpauthUri(secret, account, OTP_ISSUER),
        width: 180,
        height: 180,
        padding: 0,
        color: "#000000",
        background: "#ffffff",
        ecl: "M",
        join: true,
        container: "svg-viewbox",
    }).svg();
}

function setOtpChallengeCookie(res: Response, jwt: string): void {
    res.cookie(OTP_CHALLENGE_COOKIE, jwt, {
        sameSite: "lax",
        secure: !config.devMode,
        httpOnly: true,
        maxAge: 10 * 60_000,
    });
}

// The OTP management pages need a live session; anonymous visitors go
// through the login flow and return here.
async function requireSession(
    req: Request,
    res: Response,
): Promise<Authenticated | null> {
    const auth = await authenticate(req);
    if (!auth) {
        res.redirect(
            `${publicUrl("login")}?redirect_url=${encodeURIComponent(publicUrl("otp"))}`,
        );
        return null;
    }
    return auth;
}

// Six digits reads as an authenticator code; anything else is tried as a
// recovery code.
async function verifyOtpCode(
    userId: string,
    secret: string,
    code: string,
): Promise<boolean> {
    if (/^\d{6}$/.test(code.replace(/\s/g, ""))) {
        return verifyTotp(code, secret);
    }
    return consumeRecoveryCode(userId, code);
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

        // An OTP-enabled account is only half authenticated by the link:
        // park the verified identity in a short-lived challenge cookie and
        // ask for the code. New or OTP-less accounts log straight in.
        const user =
            (await getUser(consumed.email)) ??
            (await getUserByEmail(consumed.email));
        if (user) {
            const otp = await getUserOtp(user.user_id);
            if (otp?.enabled) {
                setOtpChallengeCookie(
                    res,
                    await mintOtpChallenge(user.user_id, redirect),
                );
                sendPage(res, 200, otpChallengePage());
                return;
            }
        }
        await performLogin(
            consumed.email,
            sessionExpiry(),
            consumed.email,
            req,
            res,
            redirect,
        );
    });

    app.post("/otp/login", async (req, res) => {
        const body = req.body as Record<string, unknown>;
        const code = typeof body.code === "string" ? body.code : "";
        const cookie = requestCookie(req, OTP_CHALLENGE_COOKIE);
        const challenge = cookie ? await readOtpChallenge(cookie) : null;
        if (!challenge) {
            sendPage(res, 400, linkInvalidPage());
            return;
        }

        if (!allow(`otp:${challenge.userId}`, OTP_ATTEMPT_LIMIT, RATE_WINDOW_MS)) {
            sendPage(res, 429, otpChallengePage("Too many attempts. Wait a while, then request a new sign-in link."));
            return;
        }

        // OTP switched off between the link and the code: no factor left to
        // check, the verified link suffices.
        const otp = await getUserOtp(challenge.userId);
        const passed = !otp?.enabled
            ? true
            : await verifyOtpCode(challenge.userId, otp.secret, code);
        if (!passed) {
            sendPage(res, 400, otpChallengePage("That code didn't work. Codes expire quickly — try the current one."));
            return;
        }

        res.clearCookie(OTP_CHALLENGE_COOKIE);
        await establishSession(
            challenge.userId,
            sessionExpiry(),
            req,
            res,
            safeReturnUrl(challenge.redirectUrl ?? undefined),
        );
    });

    app.get("/otp", async (req, res) => {
        const auth = await requireSession(req, res);
        if (!auth) return;
        const userId = auth.session.user.user_id;
        const otp = await getUserOtp(userId);
        if (otp?.enabled) {
            sendPage(res, 200, otpStatusPage(true, await unusedRecoveryCodeCount(userId)));
        } else {
            sendPage(res, 200, otpStatusPage(false));
        }
    });

    app.post("/otp/setup", async (req, res) => {
        const auth = await requireSession(req, res);
        if (!auth) return;
        const userId = auth.session.user.user_id;
        if ((await getUserOtp(userId))?.enabled) {
            res.redirect(publicUrl("otp"));
            return;
        }
        const secret = await createPendingOtp(userId);
        const user = await getUserById(userId);
        const account = user?.email_address ?? user?.username ?? "account";
        sendPage(res, 200, otpSetupPage(otpSetupQr(secret, account), secret));
    });

    app.post("/otp/enable", async (req, res) => {
        const auth = await requireSession(req, res);
        if (!auth) return;
        const userId = auth.session.user.user_id;
        const body = req.body as Record<string, unknown>;
        const code = typeof body.code === "string" ? body.code : "";

        const otp = await getUserOtp(userId);
        if (!otp || otp.enabled) {
            res.redirect(publicUrl("otp"));
            return;
        }
        if (
            !allow(`otp:${userId}`, OTP_ATTEMPT_LIMIT, RATE_WINDOW_MS) ||
            !verifyTotp(code, otp.secret)
        ) {
            const user = await getUserById(userId);
            const account = user?.email_address ?? user?.username ?? "account";
            sendPage(
                res,
                400,
                otpSetupPage(
                    otpSetupQr(otp.secret, account),
                    otp.secret,
                    "That code didn't match. Enter the current code from your app.",
                ),
            );
            return;
        }
        await enableOtp(userId);
        const codes = await replaceRecoveryCodes(userId);
        sendPage(res, 200, otpRecoveryCodesPage(codes));
    });

    app.post("/otp/disable", async (req, res) => {
        const auth = await requireSession(req, res);
        if (!auth) return;
        const userId = auth.session.user.user_id;
        const body = req.body as Record<string, unknown>;
        const code = typeof body.code === "string" ? body.code : "";

        const otp = await getUserOtp(userId);
        if (!otp?.enabled) {
            res.redirect(publicUrl("otp"));
            return;
        }
        if (
            !allow(`otp:${userId}`, OTP_ATTEMPT_LIMIT, RATE_WINDOW_MS) ||
            !(await verifyOtpCode(userId, otp.secret, code))
        ) {
            sendPage(
                res,
                400,
                otpStatusPage(
                    true,
                    await unusedRecoveryCodeCount(userId),
                    "That code didn't work, so two-factor stays on.",
                ),
            );
            return;
        }
        await deleteOtp(userId);
        res.redirect(publicUrl("otp"));
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
