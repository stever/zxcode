# mastodon-bot

A Mastodon bot that runs ZX Spectrum BASIC from mentions and replies with an
animated GIF of the program running. The analog of BBC Micro Bot.

## How it fits together

Three containers, split so the credential-holding piece never runs untrusted code:

- **gotosocial**: the bot's federated identity, served at `social.zxplay.org`
  with handles presented as `@bot@zxplay.org`. The only publicly exposed piece.
- **mastodon-bot** (this app): holds the access token, polls mentions, calls
  gif-service, posts replies. Runs no untrusted code.
- **gif-service**: compiles BASIC to `.tap` and renders the running program to a
  GIF. Does all untrusted execution; holds no secrets.

Flow:

```
mention -> htmlToBasic -> gif-service /api/basic-to-gif -> upload media -> reply
```

## Local testing without a Mastodon account

Run gif-service, then drive the same BASIC-to-GIF chain the bot uses through the
CLI:

```bash
# terminal 1
cd apps/gif-service && PORT=5001 npx tsx src/index.ts

# terminal 2
cd apps/mastodon-bot
echo '10 BORDER 1: PAPER 1: CLS
20 FOR n=1 TO 100: PLOT RND*255,RND*175: NEXT n' \
  | GIF_SERVICE_URL=http://localhost:5001 OUT=out.gif npm run cli
```

A compile error prints the zmakebas message instead of writing a GIF.

## First-time GoToSocial setup

1. Point DNS `A`/`AAAA` records for `social.zxplay.org` at the host, and make
   sure `zxplay.org` apex serves through the same Caddy proxy.
2. Bring the stack up: `docker compose up --build -d`.
3. Create the bot account (registrations are closed by config):

   ```bash
   docker compose exec gotosocial \
     /gotosocial/gotosocial admin account create \
     --username bot --email bot@zxplay.org --password '<strong-password>'
   docker compose exec gotosocial \
     /gotosocial/gotosocial admin account confirm --username bot
   ```

4. Log in to `https://social.zxplay.org` as the bot, open Settings, and create
   an application (or token) with scopes `read` and `write`. Copy the access
   token.
5. Put the token in the stack `.env` as `MASTODON_ACCESS_TOKEN`, then restart the
   bot: `docker compose up -d mastodon-bot`.
6. Mark the account as automated in its profile, and announce the handle once so
   people can mention it. Federation delivers mentions directly, so the instance
   does not need a relay.

## Configuration

See `.env-dist`. Key variables:

| Variable                | Default                      | Meaning                                  |
| ----------------------- | ---------------------------- | ---------------------------------------- |
| `MASTODON_INSTANCE_URL` | `https://social.zxplay.org`  | Public host (must match `GTS_HOST`).     |
| `MASTODON_ACCESS_TOKEN` | none                         | Bot account token (required).            |
| `GIF_SERVICE_URL`       | `http://gif-service:5001`    | Internal gif-service URL.                |
| `STATE_FILE`            | `/data/state.json`           | Persists the last-processed mention id.  |
| `POLL_INTERVAL_MS`      | `15000`                      | Mention polling interval.                |
| `MAX_SECONDS`           | `30`                         | Capture length cap.                      |
| `MAX_GIF_BYTES`         | `8000000`                    | Replies above this size are refused.     |
| `DRY_RUN`               | `false`                      | Log what would run without posting.      |

## Operational notes

- **Moderation.** The bot republishes arbitrary user text as an image under its
  own account. Keep a kill switch (`DRY_RUN=true` and restart), be ready to block
  users, and watch what it posts.
- **Visibility.** Replies are never more public than the mention; public mentions
  are answered as unlisted to avoid spamming timelines.
- **Idempotency.** Replies use an `Idempotency-Key`, and the bot advances past a
  mention even if it fails, so a poison message will not loop.
- **Polling, not streaming.** GoToSocial's streaming support is partial, so the
  bot polls notifications.
- **Limits.** BASIC compatibility matches gif-service: standard auto-running
  programs work, turbo-loader games do not. Programs that never `CLS` will show
  the loader footer in the first frames.
