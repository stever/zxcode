# Building zx.wasm from zxplay_go

`zx.wasm` is the ZX Spectrum Next emulator core, built from
[zx_go](https://github.com/conorarmstrong/zx_go) (MIT) with a small set of
changes that add a browser entry point and make it compile for `js/wasm`.

## Steps

The zxplay_go source is vendored at [`../zxplay_go`](../zxplay_go) with the wasm-port
changes already applied in-tree, so building is just:

    npm run build

(`../scripts/build-wasm.sh`: `GOOS=js GOARCH=wasm go build -o dist/zx.wasm
./cmd/zxplay_go`, plus the Go toolchain's `wasm_exec.js` copied into `dist/`,
where the apps' builds pick both up.)

The desktop build (`go build ./cmd/zxplay_go`) still works — the changes are
guarded by `//go:build js` / `!js` tags.

Pull upstream zxplay_go later with:

    git subtree pull --prefix=zxplay_go zxplay_go-upstream main --squash

## What the changes do

Full detail in `STATUS.md`. Summary:

- `wasm_js.go` — the js exports (`zxBootNext`, `zxFrame`, `zxRunNex`,
  `zxRegisterROM`, `zxKeyName`, `zxType`). Boot runs in a goroutine so oto's
  Web Audio "ready" can resolve; keyboard reuses `kbd.HandleKeyWithModifiers`.
- `entry_js.go` / `entry_desktop.go` — build-tagged `main()`.
- `tracedb_js.go` — sqlite-free trace ring for wasm.
- `pkg/next/install/inject.go` — in-memory ROM injection (no filesystem on wasm).
- `pkg/audio/ready_js.go` — don't block on oto's ready channel on wasm.

These live in-tree under `../zxplay_go` at their package paths (`cmd/zxplay_go/`,
`pkg/audio/`, `pkg/next/install/`).

Tested against zxplay_go at go 1.25; the changes touch `cmd/zxplay_go`,
`pkg/next/install`, and `pkg/audio`.
