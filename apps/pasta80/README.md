# ZX Play API for Pasta80

Compiles Turbo Pascal 3.0-compatible Pascal with
[Pasta80](https://github.com/pleumann/pasta80) and returns a base64-encoded
TAP file with a BASIC loader, as a Hasura Action webhook.

The optional `machine` argument selects the codegen target (`48`, `128` or
`next`; default `48`) — each links a different runtime, so features like the
Next colour routines only exist on their machine. Compiles run with the
author-recommended `--opt --dep` flags (peephole optimisation plus dependency
analysis, without which the full runtime is linked in).

Pasta80 supports Turbo Pascal 3 style embedded machine code:

```pascal
program Beep;
begin
  inline($3e/$07/  { ld a,7  }
         $d7);     { rst $10 }
end.
```

The compiler stops at the first error and reports it against the Pascal
source as `*** Error at LINE,COL: message`; that line is what the service
returns as the failure message.

Pasta80 generates Z80 assembly and drives a bundled
[sjasmplus](https://github.com/z00m128/sjasmplus) to produce the binary.
Unlike the standalone sjasmplus service, this build keeps sjasmplus's Lua
scripting enabled: Pasta80's runtime registers `rtl/helpers.lua` and its
output does not assemble without it. Users submit Pascal, not asm, so the
`LUA` directive is not directly reachable from input.

## Development start

### Initial project setup

```bash
cd apps/pasta80/
virtualenv venv
source ./venv/bin/activate
pip install -r requirements.txt
```

### Run app

```bash
uvicorn app.main:app --reload
```

Note the compile endpoint needs `pasta` and `sjasmplus` binaries plus the
Pasta80 runtime configured in `~/.pasta80.cfg`; without them, run the
service via Docker instead.

## Docker

Built and run as the `pasta80` service in the repo root
`docker-compose.yaml`:

```bash
docker compose up --build -d pasta80
```

Tests run against the real compiler inside the image:

```bash
docker build -t pasta80-api .
docker run --rm -v "$PWD/test:/app/test:ro" pasta80-api python -m pytest /app/test
```

## Hasura Deployment Configuration

### Compile Action Service

Tick option to "Forward client headers to webhook".

#### Action definition

```graphql
type Mutation {
  compilePascal (
    code: String!
    machine: String
  ): CompileResult
}
```

The `CompileResult` type (`base64_encoded: String!`) is shared with the other
compile actions.

#### Handler

```
http://pasta80/compile/
```
