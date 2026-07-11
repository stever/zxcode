# ZX Play API for sjasmplus

Assembles Z80 code with [sjasmplus](https://github.com/z00m128/sjasmplus) and
returns a base64-encoded TAP or NEX file, as a compile-action webhook behind apps/api.

Output is driven by directives in the source, which must produce exactly one
TAP or NEX file:

```asm
    DEVICE ZXSPECTRUM48
    ORG $8000
start:
    ; ... code ...
    SAVETAP "out.tap",start
```

or, for a ZX Spectrum Next native program:

```asm
    DEVICE ZXSPECTRUMNEXT
    ORG $8000
start:
    ; ... code ...
    SAVENEX OPEN "out.nex",start,$FF40
    SAVENEX AUTO
    SAVENEX CLOSE
```

The bundled assembler is built with `USE_LUA=0`, so the `LUA` scripting
directive is unavailable.

## Development start

### Initial project setup

```bash
cd apps/sjasmplus/
virtualenv venv
source ./venv/bin/activate
pip install -r requirements.txt
```

### Run app

```bash
uvicorn app.main:app --reload
```

Note the compile endpoint needs `sjasmplus` on PATH; without it, run the
service via Docker instead.

## Docker

Built and run as the `sjasmplus` service in the repo root
`docker-compose.yaml`:

```bash
docker compose up --build -d sjasmplus
```

Tests run against the real assembler inside the image:

```bash
docker build -t sjasmplus-api .
docker run --rm -v "$PWD/test:/app/test:ro" sjasmplus-api python -m pytest /app/test
```

## API Integration

Reached through the `compileSjasmplus` mutation on apps/api, which forwards the
Hasura-style action-webhook envelope (`input` + `session_variables` +
forwarded client headers for rate limiting) to this service's handler at:

```
http://sjasmplus/compile/
```
