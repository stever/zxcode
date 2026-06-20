# Build context is the repo root, because the emulator loads the WASM core and
# ROMs from apps/web/public (see emulator.ts paths relative to apps/gif-service).
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

# Emulator assets, sourced from the shared @zxplay/emulator package (the single
# source of truth) but placed at the relative location the code expects
# (apps/gif-service/src -> ../../.. -> /app -> apps/web/public/...).
COPY packages/emulator/dist/jsspeccy-core.wasm /app/apps/web/public/dist/jsspeccy-core.wasm
COPY packages/emulator/roms/ /app/apps/web/public/roms/

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
