# @zxplay/emulator-core

The zx_go emulator (Go, MIT) compiled to WebAssembly — the engine that
replaces the JSSpeccy3 AssemblyScript core. Vendored from
[zx_go](https://github.com/conorarmstrong/zx_go) with the wasm-port changes
applied in-tree (see `wasm/STATUS.md` for the port design and
`wasm/README.md` for build detail). Migrated here from the
stever/zxnext-inbrowser-poc repository.

## Layout

    zx_go/     vendored emulator source (Go module); wasm exports live in
               zx_go/cmd/zx_go/wasm_js.go
    wasm/      design notes for the wasm port (read STATUS.md before touching)
    scripts/   stage-zxnext-assets.sh (fetch NextZXOS ROMs + SD image),
               bare-sd-image.sh (trim the image to the bare bootable system)
    nex.js     makeNEX — wraps a raw $8000 binary into a .NEX container
    dist/      build output: zx.wasm + wasm_exec.js (gitignored)

## Build

Requires a Go toolchain (see zx_go/go.mod for the version).

    npm run build     # GOOS=js GOARCH=wasm go build -> dist/zx.wasm
    npm run test      # zx_go's own Go test suite

Test note: with the licensed Next ROMs staged in `zx_go/roms/next/`, the
classic→Next switch tests activate and need an SD image too — point
`ZX_GO_NEXT_SD_IMG` at a staged tbblue.mmc, or unstage the ROMs (the tests
then skip). Full suite passes either way.

The desktop build (`cd zx_go && go build ./cmd/zx_go`) must keep working —
the wasm port is gated behind `//go:build js` / `!js` tags.

## Machines

48K and 128K boot from ROMs embedded in the binary. The Spectrum Next boots
real NextZXOS from ROMs + an SD image staged by `scripts/` — licensed content
served under The Next License; see `LICENSES.md` for the distribution basis
and its conditions (free access, bare bootable system, attribution).
