# @zxplay/emulator-core

The zx_go emulator (Go; MIT upstream, this repository's modifications
GPLv3 — see LICENSES.md) compiled to WebAssembly — the engine that
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
               bare-sd-image.sh (trim the image to the bare bootable system),
               zip-sd-image.sh (zip the image for the browser: it fetches
               tbblue.mmc.zip, a few MB instead of the raw 64MB, and falls
               back to the raw image when the zip is absent)
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
real NextZXOS. The BROWSER's primary source (r60) is the official SpecNext
distro zip (`sn-emulator-24.11.zip`: both NextZXOS ROMs + the full 1 GB
card image), fetched through the same-origin `/specnext/` Caddy proxy route
(specnext.com sends no CORS headers; the sites' CSP pins connect-src to
'self') and kept in the browser Cache API. The version is PINNED in
`GoEmulator.js` (`SPECNEXT_DISTRO_PATH`) because the boot accelerators are
verified per distro version — see "Next boot modes" below. Before boot the
pristine card is normalised in-RAM by the `zxSdPrepDistro` export
(`cmd/zx_go/distro_prep.go`): the first-boot welcome pager
(`nextzxos/autoexec.1st`) is deleted and `machines/next/config.ini` seeded
when absent — the shape a once-configured card has on real hardware.

ROMs + an SD image staged by `scripts/` remain the fallback (offline dev,
CI, and gif-service's Node harness) — licensed content served under The
Next License; see `LICENSES.md` for the distribution basis and its
conditions (free access, bare bootable system, attribution).

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
future distro update (the pinned `SPECNEXT_DISTRO_PATH` in `GoEmulator.js`
or a restaged `tbblue.mmc`):

1. **The `next_directboot.go` NextReg seed table** — captured from a live
   NextZXOS boot. If it drifts the failure mode is a boot hang, not an error.
2. **The compile-run menu navigation** (`nexload_macro.go`) — it drives the
   NextZXOS main menu to "Command Line" by holding cursor-down until the live
   cursor index at `$F700` reaches `menuItemCommandLine` (= 1 on this distro).
   A menu reorder makes it select the wrong item.

After bumping the pinned distro version (or restaging), verify against the
image the browser will actually boot. For the official distro path, first
produce the PREPPED card (what `zxSdPrepDistro` mounts):

    unzip sn-emulator-<ver>.zip cspect-next-1gb.img
    ZX_GO_DISTRO_IMG=cspect-next-1gb.img ZX_GO_DISTRO_IMG_OUT=prepped.img \
      go test ./cmd/zx_go/ -run 'TestPrepDistroCard_OfficialImage' -v

then re-run (covers seeds + menu navigation, in both boot modes):

    ZX_GO_NEXT_SD_IMG=<prepped.img or staged tbblue.mmc> \
      go test ./cmd/zx_go/ -run 'TestDirectBootSurvivesReboot|TestImportAndRun|TestMenuCursorNavigation'
    ZX_GO_NEXT_SD_IMG=<prepped.img or staged tbblue.mmc> ZX_GO_NO_FPGA_BOOTROM=1 \
      ZX_GO_NEXT_DIRECT_BOOT=1 go test ./cmd/zx_go/ \
      -run 'TestDirectBootSurvivesReboot|TestImportAndRun|TestMenuCursorNavigation'

If the boot tests fail, either recapture the seeds (see the comments in
`next_directboot.go`) or delete the two `go.env` lines in `GoEmulator.js` —
the browser then falls back to the faithful bootrom path, still
fast-forwarded, just ~300 frames slower. If `TestMenuCursorNavigation` fails,
update `menuItemCommandLine` to the new index (the test message reports where
the cursor actually landed). The desktop build always uses the faithful path
and is unaffected.

Known gap (r60, see docs/architecture/known-gaps.md): the faithful firmware
path currently does NOT boot the official distro card geometry to the menu
in our emulation (it lands in the config tool with "Error opening
'menu.ini/.def'" — every firmware file open fails on that card, while
NextZXOS itself reads it fine; not the partition offset, firmware bytes or
config.ini, all ruled out). Direct boot — the only mode the browser uses —
passes all the tests above against the prepped 24.11 image. Consequence:
the faithful-path leg of the verification only applies to staged
tbblue.mmc-geometry cards, and the "delete the go.env lines" fallback is
not currently available while the official distro is the browser's source.
