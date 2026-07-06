# Build context is the repo root (for the wasm CLI toolchains copied below);
# the emulator core + ROMs are vendored in this service's engine/ directory.
# zx_go core -> WebAssembly for the Spectrum Next render path (the classic
# path uses the frozen JSSpeccy3 core vendored in engine/).
FROM golang:1.25 AS wasmbuild
WORKDIR /src
COPY packages/emulator-core/zx_go ./zx_go
RUN mkdir /out \
 && cd zx_go && GOOS=js GOARCH=wasm go build -o /out/zx.wasm ./cmd/zx_go \
 && cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" /out/wasm_exec.js

FROM node:22-slim

# ffmpeg is required for MP4 output.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/apps/gif-service

# Install this service's own dependencies (not workspace-hoisted).
COPY apps/gif-service/package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm install tsx typescript

# Service source.
COPY apps/gif-service/ ./

# Emulator cores: engine/ (frozen JSSpeccy3 build for 48K/128K, vendored,
# comes with the service COPY above) and engine/zxgo (zx_go for the Next,
# from the golang stage). The Next also needs the licensed NextZXOS assets
# staged into next-assets/ in the build context (never committed — see
# packages/emulator-core/LICENSES.md); they ride along with the COPY above
# when present, or set NEXT_ASSETS_DIR at runtime.
COPY --from=wasmbuild /out/ ./engine/zxgo/

# Emscripten/asm.js CLI toolchains for rendering zmac and sdcc projects, plus
# the sdcc bundled filesystem (fssdcc.data: crt0, z80 stdlib, headers) and the
# ZX crt0 object. Resolved via TOOLS_BASE (defaults to this dir, next to src/).
COPY apps/web/public/8bitworker/wasm/ ./wasm/
COPY apps/web/public/8bitworker/asmjs/ ./asmjs/
COPY apps/web/public/8bitworker/fs/ ./fs/
COPY apps/web/public/8bitworker/zx/ ./zx/

# Screenshot cache mount point, pre-owned by `node` so the named volume
# initialises writable for the non-root user under a read-only root FS.
RUN mkdir -p /cache && chown node:node /cache

ENV PORT=5001 \
    SCREENSHOT_CACHE_DIR=/cache
EXPOSE 5001
CMD ["npx", "tsx", "src/index.ts"]
