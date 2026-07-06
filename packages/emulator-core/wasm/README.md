# Building zx.wasm from zx_go

`zx.wasm` is the ZX Spectrum Next emulator core, built from
[zx_go](https://github.com/conorarmstrong/zx_go) (MIT) with a small set of
changes that add a browser entry point and make it compile for `js/wasm`.

## Steps

The zx_go source is vendored at [`../zx_go`](../zx_go) with the wasm-port
changes already applied in-tree, so building is just:

1. Build for WebAssembly, output straight into the web host:

       cd zx_go
       GOOS=js GOARCH=wasm go build -o ../web/res/zxnext/zx.wasm ./cmd/zx_go
       cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" ../web/res/zxnext/wasm_exec.js

   The desktop build (`go build ./cmd/zx_go`) still works — the changes are
   guarded by `//go:build js` / `!js` tags.

2. Bump `web/res/zxnext/assets.ver` so the browser Cache API fetches the new
   binary instead of a stale one.

Pull upstream zx_go later with:

    git subtree pull --prefix=zx_go zx_go-upstream main --squash

## What the changes do

Full detail in `STATUS.md`. Summary:

- `wasm_js.go` — the js exports (`zxBootNext`, `zxFrame`, `zxRunNex`,
  `zxRegisterROM`, `zxKeyName`, `zxType`). Boot runs in a goroutine so oto's
  Web Audio "ready" can resolve; keyboard reuses `kbd.HandleKeyWithModifiers`.
- `entry_js.go` / `entry_desktop.go` — build-tagged `main()`.
- `tracedb_js.go` — sqlite-free trace ring for wasm.
- `pkg/next/install/inject.go` — in-memory ROM injection (no filesystem on wasm).
- `pkg/audio/ready_js.go` — don't block on oto's ready channel on wasm.

These live in-tree under `../zx_go` at their package paths (`cmd/zx_go/`,
`pkg/audio/`, `pkg/next/install/`).

Tested against zx_go at go 1.25; the changes touch `cmd/zx_go`,
`pkg/next/install`, and `pkg/audio`.
