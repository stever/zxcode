FROM caddy:2 AS base
COPY apps/play/Caddyfile /etc/caddy/Caddyfile

# zx_go emulator core -> WebAssembly. Built in a Go stage because the node
# stage has no Go toolchain; emulator-core's build script detects that and
# uses this prebuilt dist/ (packages/emulator-core/scripts/build-wasm.sh).
FROM golang:1.25 AS wasmbuild
WORKDIR /src
COPY packages/emulator-core/zx_go ./zx_go
RUN mkdir /out \
 && cd zx_go && GOOS=js GOARCH=wasm go build -trimpath -ldflags="-s -w" -o /out/zx.wasm ./cmd/zx_go \
 && cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" /out/wasm_exec.js

FROM node:22 AS npmbuild
WORKDIR /project
# Build context is the repo root so the workspace + @zxplay/emulator are present.
COPY . .
COPY --from=wasmbuild /out/ packages/emulator-core/dist/
RUN npm install --legacy-peer-deps
# Builds @zxplay/emulator then apps/play (its build script chains both).
RUN npm run build -w play

FROM base AS final
COPY --from=npmbuild /project/apps/play/public /srv
# Cache-bust the static bundle reference per build.
RUN sed -i "s|ver=0|ver=$(date +%s)|g" /srv/index.html
# Precompressed sidecars for the ~30MB emulator wasm; the Caddyfile's
# file_server `precompressed` serves them, cutting transfer ~5x.
RUN apk add --no-cache brotli \
 && find /srv -name '*.wasm' -exec brotli -q 11 -f -k {} \; -exec gzip -9 -f -k {} \;
