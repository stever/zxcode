# zenv Forth Compile API

FastAPI service that turns a Forth program into a ZX Spectrum TAP using
[zenv](https://github.com/Veltas/zenv) (Forth for the ZX Spectrum, MIT,
(C) Christopher Leonard), assembled by sjasmplus. Reached through the
GraphQL `compileForth` action mutation (apps/api).

## How it works

zenv is an interactive Forth environment built from assembly. The image
vendors it at a pinned commit with a small patch (`zenv-boot.patch`): the
`main` word runs a generated `user_boot` word before falling into the
interpreter loop, and the image includes a generated `user.asm` before
`h_init:` so the runtime dictionary starts after the embedded program.

Per compile, the service generates `user.asm` — the user's program as
data-byte blobs plus one threaded `literal/literal/EVALUATE` sequence per
source line (per-line because zenv's `\` comment skips to the end of the
current input source) — and assembles the whole image with sjasmplus
(`DEVICE ZXSPECTRUM48` + `SAVETAP`, replacing upstream's bin2tap). On
boot the program runs and the user lands at the interactive `ok` prompt
with their words defined.

Forth errors surface at runtime on the Spectrum screen; the only
user-facing compile error is an oversized program (the build wrapper's
`ASSERT` keeps the image below the zenv workspace at `$FB00`, with
dictionary headroom).

## Development

```bash
virtualenv venv && source ./venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```

## Testing

```bash
# Generator unit tests run anywhere:
pytest test/

# The endpoint tests need the real toolchain — run inside the image:
docker build -t zenv-api .
docker run --rm -v "$PWD/test:/app/test:ro" zenv-api python -m pytest /app/test
```

## Docker

```bash
# From the repo root, as the compose service:
docker compose up --build -d zenv
```
