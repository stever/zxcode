# Authentication Service

Node.js (TypeScript) service providing passwordless email login: the user
enters their email address, receives a single-use magic link (sent through
Migadu SMTP), and clicking it establishes the session. It is the keeper of
the session cookie and the dispenser of the short-lived GraphQL bearer
tokens the frontend sends to apps/api. It replaced the earlier SAML service
provider (Auth0 IdP); the session and token contracts are unchanged.

## Endpoints (behind the proxy's `/auth` prefix)

| Route | What |
| --- | --- |
| `GET /` and `GET /login` | The email login form (or straight back when already authenticated). `?redirect_url=` must sit under `AuthRedirect`. Dev mode logs in `AUTH_DebugAutoLoginUsername` immediately with no email. |
| `POST /login/email` | Takes `email` + `redirect_url` (form-urlencoded), stores a hashed single-use token, emails the magic link, renders a neutral "check your email" page. Rate-limited per email and per IP; the response never reveals whether the address has an account. |
| `GET /verify?token=` | Consumes the token (single-use, expires after `MagicLinkExpiryMinutes`), provisions the user on first login, creates a session, sets the cookie, redirects. Invalid/expired/used tokens get a "request a new link" page. |
| `GET /me` | `{userId, roles}` for the session cookie, else 401. |
| `GET /token` | `{token}`: a 15-minute HS256 JWT (audience `hasura`, the Hasura claims namespace) that apps/api verifies. 401 without a live session. |
| `GET /logout` | Clears cookies, redirects to the validated `?redirect_url=` (or `AuthRedirect`). |
| `GET /logout/return` | Redirects to the popped, prefix-validated return-URL cookie. |
| `GET /healthz` | 200 OK. |

The login pages are server-rendered, JavaScript-free HTML with inline styles
and their own conservative CSP header (the production proxy's CSP does not
cover `/auth/*`).

## Sessions and cookies

- `access_token` cookie (HttpOnly, SameSite=Lax, Secure outside dev): an
  8-hour HS256 JWT (audience `caddy`) whose `props.auth` claim carries a
  64-char random token matching a `session` row in the database. Every
  authenticated request re-validates the row (and touches `updated`);
  session expiry is `AUTH_Login__DefaultExpirationMinutes` (default 480).
- `redirect_url` cookie (HttpOnly, 10 minutes, SameSite=None+Secure in
  production): only honoured when it starts with `AuthRedirect`. Magic links
  carry their own validated redirect in the `login_token` row, so a link
  works in a browser that never saw the cookie.

Database access goes through apps/api's GraphQL admin role
(`X-Hasura-Admin-Secret`).

## Magic-link tokens

32 random bytes, base64url in the link; the `login_token` row stores only
the SHA-256 hash, plus the validated redirect and an expiry (default 15
minutes). Consumption is one atomic conditional update, so a token can be
used exactly once, and requesting a new link invalidates the email's earlier
pending ones. Emails are lowercased before lookup and storage.

## First-login provisioning

Users are keyed by username, with an email fallback lookup — accounts
provisioned by the old SAML flow (username `auth0|...`) keep working through
their stored email address. New email-native users get the lowercased email
as username and a generated speccy handle (`pixel-wizard-123`) as their
public slug and display name. Returning users get their stored email
refreshed.

## Email (Migadu)

Outbound mail uses SMTP submission: `smtp.migadu.com`, port 465 (implicit
TLS, the default) or 587 (STARTTLS), authenticating with a full mailbox
address and password. The `From` must be that mailbox or an identity Migadu
permits on it, and the domain needs SPF/DKIM configured or the links land in
spam. When `AUTH_SMTP__*` is not configured — always the case in plain dev —
the link is logged to the console instead of sent.

## Configuration

Environment variables (`AUTH_` prefix, `__` nesting):

- `AUTH_AuthRedirect`, `AUTH_CorsOrigin` (JSON array string)
- `AUTH_GraphQL__Endpoint`, `AUTH_GraphQL__AdminSecret`
- `AUTH_SMTP__{Host,Port,Username,Password,From}` (port default 465; From
  default `ZX Play <noreply@zxplay.org>`)
- `AUTH_Login__{AdmitNewUsers,AuthCookieName,ReturnUrlCookieName,DefaultExpirationMinutes,MagicLinkExpiryMinutes}`
  (defaults: true, `access_token`, `redirect_url`, 480, 15). The first four
  fall back to the legacy `AUTH_SAML__*` names so an unmodified deploy
  compose keeps working; migrate the names and drop the retired
  `AUTH_SAML__{AppId,ResponseCertificate,AssertionConsumer,SsoEndpoint,LogoutLink}`
  when convenient.
- `AUTH_JWT__DefaultRole`, `AUTH_JWT__AddDefaultRole`,
  `AUTH_JWT__SessionToken__{Secret,Issuer,Audience,ExpirationSeconds}`,
  `AUTH_JWT__HasuraToken__{Secret,Issuer,Audience,ExpirationSeconds}`
- `PORT` (default 8080; the dev script uses 5000)
- `AUTH_DEV_MODE=true`: dev defaults (localhost endpoints, placeholder
  secrets, insecure cookies) plus auto-login as
  `AUTH_DebugAutoLoginUsername` (default `dev`; set to `off` to exercise
  the real login form in dev)

## Tests

```bash
npm test                    # unit (handles, tokens, logintokens, ratelimit, mailer)
npm run test:integration    # needs the dev api on localhost:4000; covers the
                            # full magic-link flow (link captured via the
                            # mailer's dev hook), single-use/expiry/rate-limit
                            # behaviour, and the session/token surface
```
