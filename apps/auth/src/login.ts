// The login orchestration, ported from the .NET UserLogin.PerformLoginAsync:
// find (or provision) the user, refresh their email, create a session row,
// set the auth cookie, redirect to the popped return URL.

import { randomInt } from "node:crypto";
import type { Request, Response } from "express";
import { config } from "./config.js";
import {
    createUser,
    getRoles,
    getUser,
    getUserByEmail,
    updateUserEmail,
} from "./users.js";
import { createSession } from "./sessions.js";
import { mintSessionToken } from "./tokens.js";
import { popReturnUrl, setAuthCookie } from "./cookies.js";

const TOKEN_ALPHABET =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

// 64 alphanumeric chars, like the .NET version — but from a CSPRNG rather
// than System.Random.
function randomToken(length: number): string {
    let out = "";
    for (let i = 0; i < length; i++) {
        out += TOKEN_ALPHABET[randomInt(TOKEN_ALPHABET.length)];
    }
    return out;
}

// redirectUrl (already validated by the caller) takes precedence over the
// return-URL cookie: a magic link may be opened in a browser that never
// carried the cookie.
export async function performLogin(
    username: string,
    expiry: Date,
    email: string | null,
    req: Request,
    res: Response,
    redirectUrl?: string | null,
): Promise<void> {
    if (!username) {
        res.status(400).end();
        return;
    }

    // Username is the stable key; email is a fallback for edge cases.
    let user = await getUser(username);
    if (!user && email) user = await getUserByEmail(email);

    if (!user) {
        if (!config.login.admitNewUsers) {
            res.status(401).end();
            return;
        }
        console.log(`New user: ${username} (${email ?? "no email"})`);
        await createUser(username, email);
        user = await getUser(username);
        if (!user) {
            res.status(400).end();
            return;
        }
    } else {
        console.log(`Returning user: ${user.username} (${email ?? "no email"})`);
        // Refresh the email in case it changed at the identity provider.
        if (email && user.username) await updateUserEmail(user.username, email);
    }

    const authToken = randomToken(64);
    await createSession(user.user_id, authToken, new Date(), expiry);

    const roles = await getRoles(user.user_id);
    const jwt = await mintSessionToken(authToken, roles);
    setAuthCookie(res, jwt, expiry);

    res.redirect(redirectUrl ?? popReturnUrl(req, res));
}
