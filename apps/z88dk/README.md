# ZX Play API for Z88DK

Compiles C for the ZX Spectrum with [z88dk](https://z88dk.org/) and returns a
base64-encoded TAP, as a compile-action webhook behind apps/api.

Sources build against the newlib (`-clib=sdcc_iy`, `<arch/zx.h>`) by default.
A source that includes `<spectrum.h>` is detected as classic-library code and
built with the classic clib and `-lndos` instead. The two libraries are
mutually exclusive per source file.

## Development start

### Initial project setup

```bash
cd apps/z88dk/
virtualenv venv
source ./venv/bin/activate
pip install -r requirements.txt
```

### Run app

```bash
uvicorn app.main:app --reload
```

Note the compile endpoint needs the z88dk tools (`zcc` etc.) on PATH; without
them, run the service via Docker instead.

## Docker

Built and run as the `z88dk` service in the repo root `docker-compose.yaml`:

```bash
docker compose up --build -d z88dk
```

Tests run against the real toolchain inside the image:

```bash
docker build -t z88dk-api .
docker run --rm -v "$PWD/test:/app/test:ro" z88dk-api python -m pytest /app/test
```

## API Integration

Reached through the `compileC` mutation on apps/api, which forwards the
Hasura-style action-webhook envelope (`input` + `session_variables` +
forwarded client headers for rate limiting) to this service's handler at:

```
http://z88dk/compile/
```
