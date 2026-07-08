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

## Next boot modes — MAINTENANCE GOTCHA

The core's default Next boot is the hardware-faithful path: FPGA bootrom →
TBBLUE.FW → NextZXOS. The BROWSER opts out of it for speed:
`@zxplay/emulator` sets `ZX_GO_NO_FPGA_BOOTROM=1` +
`ZX_GO_NEXT_DIRECT_BOOT=1` via `go.env` in `GoEmulator.js` (loadGoRuntime),
which resets the CPU straight into the NextZXOS ROM with the post-firmware
NextReg personality seeded from `cmd/zx_go/next_directboot.go`. On top of
that, the page fast-forwards emulation until the NextZXOS menu wait loop
(`cmd/zx_go/fastboot.go`, polled through the `zxFastBoot()` export). Boot
drops from ~384 to ~80 frames, all of it time-compressed.

Two things are coupled to the exact SD distro version and both fail on a
future `tbblue.mmc` / NextZXOS update:

1. **The `next_directboot.go` NextReg seed table** — captured from a live
   NextZXOS boot. If it drifts the failure mode is a boot hang, not an error.
2. **The compile-run menu navigation** (`nexload_macro.go`) — it drives the
   NextZXOS main menu to "Command Line" by holding cursor-down until the live
   cursor index at `$F700` reaches `menuItemCommandLine` (= 1 on this distro).
   A menu reorder makes it select the wrong item.

After restaging Next assets, re-run (covers both, in both boot modes):

    ZX_GO_NEXT_SD_IMG=<staged tbblue.mmc> \
      go test ./cmd/zx_go/ -run 'TestDirectBootSurvivesReboot|TestImportAndRun|TestMenuCursorNavigation'
    ZX_GO_NEXT_SD_IMG=<staged tbblue.mmc> ZX_GO_NO_FPGA_BOOTROM=1 \
      ZX_GO_NEXT_DIRECT_BOOT=1 go test ./cmd/zx_go/ \
      -run 'TestDirectBootSurvivesReboot|TestImportAndRun|TestMenuCursorNavigation'

If the boot tests fail, either recapture the seeds (see the comments in
`next_directboot.go`) or delete the two `go.env` lines in `GoEmulator.js` —
the browser then falls back to the faithful bootrom path, still
fast-forwarded, just ~300 frames slower. If `TestMenuCursorNavigation` fails,
update `menuItemCommandLine` to the new index (the test message reports where
the cursor actually landed). The desktop build always uses the faithful path
and is unaffected.
