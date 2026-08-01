#!/usr/bin/env bash
# Build dist/zx.wasm from the vendored zxplay_go source. When no Go toolchain is
# available (the node-only Docker build stage), fall back to a prebuilt dist/
# — the app Dockerfiles' golang stage compiles one and copies it in before
# the npm builds run.
set -euo pipefail
cd "$(dirname "$0")/.."

if command -v go >/dev/null 2>&1; then
  mkdir -p dist
  (cd zxplay_go && GOOS=js GOARCH=wasm go build -trimpath -ldflags="-s -w" -o ../dist/zx.wasm ./cmd/zxplay_go)
  cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" dist/wasm_exec.js
  echo "emulator-core: built dist/zx.wasm"
elif [[ -f dist/zx.wasm && -f dist/wasm_exec.js ]]; then
  echo "emulator-core: no Go toolchain — using prebuilt dist/"
else
  echo "emulator-core: no Go toolchain and no prebuilt dist/zx.wasm" >&2
  exit 1
fi
