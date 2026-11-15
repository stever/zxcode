# Licensing

This package combines code under several licences. Respect each.

## nex.js — GPLv3

`nex.js` (`makeNEX`) is a port of `src/platform/zxnext.ts` from the
retrogamecoders fork of Steven Hugg's 8bitworkshop, which is **GPLv3**, and is
distributed under GPLv3 with corresponding source available (this repo).

## zxplay_go emulator tree — MIT upstream, GPLv3 modifications

`zxplay_go/` vendors [zx_go](https://github.com/conorarmstrong/zx_go)
(now developed as the zxplay_go fork), which is
**MIT** (Conor Armstrong). The modifications and additions made in this
repository — the wasm port and every in-tree change since the vendored
import — are **GPLv3** (Steven Robertson), so the modified tree as a whole is
distributed under GPLv3; the dual notice is in `zxplay_go/LICENSE`. A *compiled*
`zx.wasm` also embeds the GPLv3 `tbblue_loader.rom` FPGA loader, so the built
binary is GPLv3 either way — which is why it is not committed here (build it
yourself; source is available).

## Bundled libraries

- **txt2bas** by Remy Sharp, **MIT** — the BASIC tokeniser, an npm
  dependency of the web app.
- `dist/wasm_exec.js` — the Go WebAssembly runtime shim, **BSD-3-Clause**
  (The Go Authors), copied from the Go toolchain by `scripts/build-wasm.sh`.

## ZX Spectrum Next ROMs & SD image

- `enNextZX.rom`, `enNxtmmc.rom` — **NextZXOS** system ROMs.
- `tbblue.mmc` — FAT32 SD image containing the NextZXOS system files.

These are copyright **Garry Lancaster / SpecNext Ltd**, with portions
**(c) Amstrad plc**. They are NOT GPL and are not part of this repository.
They are covered by their own terms,
[The Next License](https://gitlab.com/thesmog358/tbblue/-/blob/master/LICENSE.md).

**The official deployment (zxplay.org, code.zxplay.org) does not distribute,
stage, serve, proxy or relay any NextZXOS or SpecNext content.** The websites
run with the Next disabled (`opts.nextEnabled` off in `@zxplay/emulator`):
the app Caddyfiles answer 404 on `/next/*`, the `/specnext/` proxy route has
been removed, `public/next` is kept out of the container images, and the
deploy repo stages and mounts no Next assets. gif-service in production has
no Next assets mounted.

The Next support code stays in the repository, and so does the tooling that
builds a staged card for **local development only**:
`scripts/trim-distro-card.sh` (builds a trimmed card from an official distro
image), `scripts/stage-zxnext-assets.sh` (extracts the ROMs and stages
everything into the apps' gitignored `public/next/`) and
`scripts/zip-sd-image.sh`. `next-licenses/` holds the Next License and
related notices that accompany such a local copy. Staged content is
gitignored and never committed. Serving a staged copy publicly is not
something this project does or endorses.

The CI workflow (`.github/workflows/pages.yml`) fetches the Next ROMs from
specnext.com at build time to run the conformance tests; they are not
published.

The desktop and headless zxplay_go builds run the Next from ROMs and SD-card
content the user obtains and installs themselves (see
`zxplay_go/docs/spectrum-next.md`).

"ZX Spectrum Next" is a trademark of others.
