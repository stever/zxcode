FROM caddy:2 AS base
COPY apps/web/Caddyfile /etc/caddy/Caddyfile

# zx_go emulator core -> WebAssembly (see apps/play/Dockerfile for detail).
FROM golang:1.25 AS wasmbuild
WORKDIR /src
COPY packages/emulator-core/zx_go ./zx_go
RUN mkdir /out \
 && cd zx_go && GOOS=js GOARCH=wasm go build -trimpath -ldflags="-s -w" -o /out/zx.wasm ./cmd/zx_go \
 && cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" /out/wasm_exec.js

FROM node:22 AS npmbuild
WORKDIR /project
COPY . .
COPY --from=wasmbuild /out/ packages/emulator-core/dist/
RUN npm install --legacy-peer-deps
RUN npm run build

FROM base AS final
COPY --from=npmbuild /project/apps/web/public /srv
# Precompressed sidecars for the ~30MB emulator wasm; the Caddyfile's
# file_server `precompressed` serves them, cutting transfer ~5x.
RUN apk add --no-cache brotli \
 && find /srv -name '*.wasm' -exec brotli -q 11 -f -k {} \; -exec gzip -9 -f -k {} \;
