# SAML Authentication Service

Node.js (TypeScript) service replacing the original .NET implementation with
identical behaviour. It is the SAML service provider for login, the keeper of
the session cookie, and the dispenser of the short-lived GraphQL bearer
tokens the frontend sends to apps/api.

## Endpoints (behind the proxy's `/auth` prefix)

| Route | What |
| --- | --- |
| `GET /` and `GET /login` | Redirect to the SAML IdP (or straight back when already authenticated). `?redirect_url=` must sit under `AuthRedirect`. Dev mode logs in `AUTH_DebugAutoLoginUsername` with no SAML. |
| `POST /assertion-consumer` | SAML ACS: validates the signed response, provisions the user on first login, creates a session, sets the cookie, redirects. |
| `GET /me` | `{userId, roles}` for the session cookie, else 401. |
| `GET /token` | `{token}`: a 15-minute HS256 JWT (audience `hasura`, the Hasura claims namespace) that apps/api verifies. 401 without a live session. |
| `GET /logout` | Clears cookies, redirects to the IdP logout link (or `AuthRedirect`). |
| `GET /logout/return` | Redirects to the popped, prefix-validated return-URL cookie. |
| `GET /healthz` | 200 OK. |

## Sessions and cookies

- `access_token` cookie (HttpOnly, SameSite=Lax, Secure outside dev): an
  8-hour HS256 JWT (audience `caddy`) whose `props.auth` claim carries a
  64-char random token matching a `session` row in the database. Every
  authenticated request re-validates the row (and touches `updated`);
  session expiry comes from the SAML `SessionNotOnOrAfter` or a 480-minute
  default.
- `redirect_url` cookie (HttpOnly, 10 minutes, SameSite=None+Secure in
  production): survives the IdP round trip; only honoured when it starts
  with `AuthRedirect`.

Database access goes through apps/api's GraphQL admin role
(`X-Hasura-Admin-Secret`), using the same documents as the .NET service.

## First-login provisioning

Users are keyed by SAML NameID (username), with an email fallback lookup.
Opaque provider ids (`auth0|...`) get a generated speccy handle
(`pixel-wizard-123`) and matching display name; other usernames slugify
directly. Returning users get their stored email refreshed.

## SAML

`@node-saml/node-saml` as SP: unsigned AuthnRequest over HTTP-Redirect,
response signature verified against `AUTH_SAML__ResponseCertificate`
(PEM, literal `\n` tolerated), accepting a signed Response or a signed
Assertion. Matching the previous implementation, audience and InResponseTo
are not validated.

## Configuration

Environment variables, unchanged from the .NET service (`AUTH_` prefix, `__`
nesting):

- `AUTH_AuthRedirect`, `AUTH_CorsOrigin` (JSON array string)
- `AUTH_GraphQL__Endpoint`, `AUTH_GraphQL__AdminSecret`
- `AUTH_SAML__AppId`, `AUTH_SAML__ResponseCertificate`,
  `AUTH_SAML__AssertionConsumer`, `AUTH_SAML__SsoEndpoint`,
  `AUTH_SAML__LogoutLink`, `AUTH_SAML__AdmitNewUsers` (default true)
- `AUTH_JWT__DefaultRole`, `AUTH_JWT__AddDefaultRole`,
  `AUTH_JWT__SessionToken__{Secret,Issuer,Audience,ExpirationSeconds}`,
  `AUTH_JWT__HasuraToken__{Secret,Issuer,Audience,ExpirationSeconds}`
- `PORT` (default 8080; the dev script uses 5000)
- `AUTH_DEV_MODE=true`: dev defaults (localhost endpoints, placeholder
  secrets, insecure cookies) plus auto-login as
  `AUTH_DebugAutoLoginUsername` (default `dev`)

## Tests

```bash
npm test                    # unit (handles, tokens)
npm run test:integration    # needs the dev api on localhost:4000; includes a
                            # forged signed SAML response through the real
                            # assertion-consumer (self-signed IdP cert)
```
