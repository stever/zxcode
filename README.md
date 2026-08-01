# Code · ZX Play

A ZX Spectrum emulator & programming environment for the browser.

## Documentation

The published documentation site is at
<https://stever.dev/zxcode/> — how to use
[code.zxplay.org](https://code.zxplay.org) and its ten toolchains, how to
use [zxplay.org](https://zxplay.org), how to automate the zxplay_go emulator
when developing a game locally, the emulator's own manuals and architecture
docs, and the live conformance dashboard.

It is generated from markdown in this repository; the site map and the
conventions for adding to it are in [docs/README.md](docs/README.md).

## Development Notes

### Local Development

Minimum pre-requisites:

- Docker with Docker Compose (https://docs.docker.com/get-docker/)
- Caddy web server (https://caddyserver.com/) caddy command installed and in PATH

```bash
# Create .env files from example .env-dist files
cp .env-dist .env
cp apps/proxy/.env-dist apps/proxy/.env

# Start up containers
docker compose up --build -d

# Wait for the GraphQL api to start
bash -c 'while [[ "$(curl -s -o /dev/null -w ''%{http_code}'' localhost:4000/healthz)" != "200" ]]; do sleep 5; done'
```

```bash
npm install
npm run dev
```

Launch the URL for the proxied web server on port 8080 (http://localhost:8080).

### Docker Commands

Remove docker compose deployment to start over:

```bash
docker compose stop && docker compose rm -f
docker volume rm zxcoder_pg_data
```

Refresh and restart docker-compose deployment:

```bash
docker compose pull
docker compose up --build -d
```

### HTTP Local Ports Used

| Port | Purpose        | Protocol |
| ---- | -------------- | -------- |
| 4000 | GraphQL api    | HTTP     |
| 5000 | Auth           | HTTP     |
| 8000 | React          | HTTP     |
| 8080 | Proxy          | HTTP     |

## Emulation engine

The emulator core is zxplay_go — this repository's fork of
[zx_go](https://github.com/conorarmstrong/zx_go) by Conor Armstrong — a
ZX Spectrum 48K/128K and Spectrum Next emulator written in Go — compiled to
WebAssembly. It is vendored (with the wasm-port changes applied in-tree) at
packages/emulator-core, and consumed through the JSSpeccy(container, opts)
handle in packages/emulator, whose UI chrome and keyboard handling descend
from [JSSpeccy3](https://github.com/gasman/jsspeccy3) (GPLv3) — the engine
this project used before the zxplay_go migration.

Engine highlights:

- 48K and 128K boot from ROMs embedded in zx.wasm; the Spectrum Next boots
  real NextZXOS from the official SpecNext distro, relayed byte-for-byte
  through a same-origin proxy route — this project distributes no NextZXOS
  content itself. Locally staged ROMs + SD image are the offline dev/CI
  fallback, never committed (policy and self-hosting conditions:
  packages/emulator-core/LICENSES.md).
- Audio streams from the core into an AudioWorklet (served as
  /dist/zx-feeder.worklet.js: CSP script-src 'self' compatible); the machine
  is paced off the audio clock, so producer and consumer cannot drift.
- Every machine and video mode composites into a fixed 640x512 canvas.
- .nex files run via NextZXOS's own .nexload; the IDE's compiled TAPs are
  translated for the Next (packages/emulator/src/zxgo/tapToNext.js).

## Acknowledgements

This software uses code from, or is based on the work of, the following open source projects:

- zxplay_go, the emulator core — this repository's fork of zxplay_go by Conor Armstrong. Upstream is licensed under terms of the MIT License; the fork's modifications are licensed under terms of the GPL version 3.
- JSSpeccy3 & JSSpeccy3-mobile. These are licensed under terms of the GPL version 3.
- Pasmo by Julián Albo García, alias "NotFound". Licensed under terms of the GPL version 3.
- Boriel ZX BASIC by Jose Rodriguez. Licensed under terms of the GPL version 3.
- zmakebas by Russell Marks. This tool is public domain.
- txt2bas by Remy Sharp, the in-browser NextBASIC tokeniser. Licensed under terms of the MIT License.
- zx-tools by Remy Sharp. The IDE's sprite, palette and tile map editors are original code modelled on his zx-tools suite: the .spr/.pal/.map file handling, drawing tools and key bindings follow it. zx-tools is licensed under terms of the MIT License.
- 8bitworkshop by Steven Hugg. Licensed under terms of the GPL version 3.
