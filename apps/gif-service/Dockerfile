# Build context is the repo root, because the emulator loads the WASM core and
# ROMs from apps/web/public (see emulator.ts paths relative to apps/gif-service).
FROM node:22-slim

WORKDIR /app/apps/gif-service

# Install this service's own dependencies (not workspace-hoisted).
COPY apps/gif-service/package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm install tsx typescript

# Service source.
COPY apps/gif-service/ ./

# Emulator assets, kept at the same relative location the code expects
# (apps/gif-service/src -> ../../.. -> /app -> apps/web/public/...).
COPY apps/web/public/dist/jsspeccy-core.wasm /app/apps/web/public/dist/jsspeccy-core.wasm
COPY apps/web/public/roms/ /app/apps/web/public/roms/

ENV PORT=5001
EXPOSE 5001
CMD ["npx", "tsx", "src/index.ts"]
