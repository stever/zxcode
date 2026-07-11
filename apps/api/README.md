# GraphQL API

Node.js + Prisma backend replacing the Hasura graphql-engine. It serves the
exact GraphQL surface the three consumers already spoke — apps/web, apps/auth
(admin role) and apps/gif-service (public role) — so none of them changed:
same endpoint (`/v1/graphql`, host port 4000, `/api` behind the proxy), same
Hasura dialect (`*_by_pk`, `insert_*_one`, `_set`/`pk_columns`, `_eq`/`_in`
boolean expressions, `*_aggregate { aggregate { count } }`, nested inserts,
`affected_rows`), same auth model, same compile actions, and the one live
query over websocket.

## Layout

- `prisma/schema.prisma` — models mirroring the database (snake_case names on
  purpose: the GraphQL layer maps selections straight onto Prisma).
- `prisma/migrations/` — Prisma migrations. The baseline replicates the net
  schema the old Hasura migrations built, including the SQL trigger functions
  (updated_at stamps, the 32-files-per-project cap, file-change → parent
  project touch).
- `src/migrate.ts` — migration runner for the one-shot `api-migrate` compose
  service: baselines a Hasura-era database (tables present, no
  `_prisma_migrations`) with `prisma migrate resolve`, then runs
  `prisma migrate deploy`. Runs on every `docker compose up`, so schema
  updates ship with the application image.
- `src/sdl.ts` — the schema, hand-written to match Hasura's generated names.
- `src/tables.ts` — per-table Prisma mapping plus the role permission rules
  carried over from the old Hasura metadata (row filters, column allowlists,
  insert presets like `owner_user_id = session user`).
- `src/select.ts` / `src/where.ts` / `src/order.ts` — GraphQL selection set →
  a single Prisma query (with permission filters at every nesting level), and
  the bool_exp / order_by translators. Ordering by a relation aggregate max
  (public profiles "recently active") uses a groupBy fallback in
  `src/resolvers.ts`.
- `src/actions.ts` — the four compile mutations, proxied to the compiler
  services with the unchanged Hasura action-webhook envelope and forwarded
  client headers (rate limiting).
- `src/subscription.ts` — websocket server speaking the legacy
  subscriptions-transport-ws dialect the hand-rolled client in apps/web uses
  (subprotocol name `graphql-ws`, `connection_init`/`start`/`data` frames).
  Live queries re-execute on project/project_file mutations for the owner;
  the socket closes with a non-1000 code at JWT expiry so the client
  reconnects with a fresh token.

## Roles

- `admin` — `X-Hasura-Admin-Secret` header (the auth service's GraphQL client).
- `zxplay-user` — `Authorization: Bearer` JWT minted by apps/auth (HS256,
  issuer/audience configurable via `JWT_ISSUER`/`JWT_AUDIENCE`, user id in the
  `https://hasura.io/jwt/claims` namespace).
- `public` — no credentials (the old `HASURA_GRAPHQL_UNAUTHORIZED_ROLE`).

## Environment

- `DATABASE_URL` — Postgres connection string.
- `ADMIN_SECRET` — admin header secret.
- `JWT_SECRET`, `JWT_AUDIENCE` (default `hasura`), `JWT_ISSUER` (default `zxplay`).
- `ZXBASIC_URL`, `Z88DK_URL`, `SJASMPLUS_URL`, `PASTA80_URL` — compile action
  handlers (default to the compose service names).
- `PORT` (default 8080), `ACTION_TIMEOUT_MS` (default 120000).

## Tests

```bash
npm test                    # unit tests (translators, selection walker)
npm run test:integration    # needs the compose Postgres on localhost:5432
```

The integration suite creates its own `zxplay_api_test` database, applies the
real migrations, boots the server, and executes every GraphQL document used by
apps/web, apps/auth and apps/gif-service under each role — including the
compile-action envelope against a stub handler and the websocket subscription
push.
