# Licensing

This PoC combines code under several licences plus non-redistributable runtime
assets. Respect each.

## Web host — GPLv3

`web/index.html`, `web/zxnext-iframe.html`, and `web/nex.js` derive from the
retrogamecoders fork of Steven Hugg's 8bitworkshop, which is **GPLv3**. `makeNEX`
in `nex.js` is a port of that fork's `src/platform/zxnext.ts`. Distribution of the
web host is therefore GPLv3, with corresponding source available (this repo).

## zx_go emulator tree — MIT upstream, GPLv3 modifications

`zx_go/` vendors [zx_go](https://github.com/conorarmstrong/zx_go), which is
**MIT** (Conor Armstrong). The modifications and additions made in this
repository — the wasm port and every in-tree change since the vendored
import — are **GPLv3** (Steven Robertson), so the modified tree as a whole is
distributed under GPLv3; the dual notice is in `zx_go/LICENSE`. A *compiled*
`zx.wasm` also embeds the GPLv3 `tbblue_loader.rom` FPGA loader, so the built
binary is GPLv3 either way — which is why it is not committed here (build it
yourself; source is available).

## Bundled libraries

- `web/vendor/txt2bas.bundle.mjs` — bundled from **txt2bas** by Remy Sharp, **MIT**.
- `web/res/zxnext/wasm_exec.js` — the Go WebAssembly runtime shim, **BSD-3-Clause**
  (The Go Authors).

## Runtime ROMs & SD image — The Next License (cost-free distribution only)

- `enNextZX.rom`, `enNxtmmc.rom` — **NextZXOS** system ROMs.
- `tbblue.mmc` — FAT32 SD image containing the NextZXOS system files.

These are copyright **Garry Lancaster / SpecNext Ltd**, with portions
**(c) Amstrad plc**. They are NOT GPL. They are covered by
[The Next License](https://gitlab.com/thesmog358/tbblue/-/blob/master/LICENSE.md):
cost-free distribution is permitted (no selling, no duplication fee), copyright
notices must be retained, and component licenses supersede the umbrella terms.

**POLICY: this project keeps the licensed Next content out of git and out
of the published container images.** The long-term shape is that the
deployment serves no copy of it as its source — the browser gets the
content from SpecNext Ltd's own server (route 1 below). INTERIM (current):
route 1 is disabled (`SPECNEXT_DISTRO_PATH` = null in `GoEmulator.js`)
until SpecNext host a small emulator-targeted image, so the deployment
serves the staged bare-system assets (route 2) as the browser's source —
cost-free distribution of the trimmed system under the Next License, on
the "free parts" basis analysed below, with the required license texts
served alongside at `/next/licenses/`. The routes:

1. **Official distro pass-through (browser primary at r60–r96; currently
   disabled, to be restored).** The sites relay the OFFICIAL SpecNext
   emulator distro zip byte-for-byte through a same-origin proxy route
   (`/specnext/distro/…` → `www.specnext.com/distro/…`). The route exists
   only because specnext.com sends no CORS headers and the sites' CSP pins
   connect-src to 'self'; the content comes from SpecNext Ltd's own
   server, exactly as they publish it — nothing is hosted, trimmed, added,
   or modified here. The emulator's boot-time normalisation (deleting the
   first-boot welcome `autoexec.1st`, seeding `config.ini` —
   `zxSdPrepDistro`) happens in RAM on the user's machine after download,
   the same mutations NextZXOS/the firmware perform on a real
   first-configured card. SWITCHOVER PENDING: a minimal ("supersmall")
   distro provided by SpecNext (Phoebus Dokos) is expected on this route —
   relaying the full 52 MB / 1 GB-card zip in production is not wanted, so
   the route stays off until it lands; then set `SPECNEXT_DISTRO_PATH` in
   `GoEmulator.js` to its path and follow the re-verification steps in the
   emulator-core README ("Next boot modes").
2. **Staged bare system (browser source during the interim; also offline
   dev, CI, gif-service's renderer).** `scripts/stage-zxnext-assets.sh`
   fetches the trimmed assets onto a developer's machine, and
   `scripts/trim-distro-card.sh` builds the staged card from an official
   distro image (full capacity, system tree only — every per-title item
   removed); the deploy host stages them for the sites' `/next/` route
   (served to users during the interim) and for gif-service's
   server-side renderer. The "free parts"
   analysis below is the basis for serving this staged copy — it applies
   to the official deployment while route 1 is disabled, and to any
   self-host that chooses to serve a staged copy.

The Next License requires its notice and the constituent-part licenses to travel
with every copy. Those texts live in `next-licenses/` (freely distributable, so
committed) and are served at `/next/licenses/` wherever staged assets are
actually served (the official deployment during the interim above, a dev
checkout, or a self-host that chooses to distribute):
committed into `apps/*/public/next/licenses/`, and copied by the deploy repo's
stage script next to gif-service's private staging. Keep the copies in sync
with `next-licenses/`.

Basis per component, for a staged copy that IS served (dev / self-host):

- **ROM images** (`enNextZX.rom`, `enNxtmmc.rom`, `machines/next/*.rom` on the
  image) — Amstrad's long-standing permission for distribution with emulators,
  which the Next License incorporates ("cases already permitted by them (i.e.
  emulators)"). This app is an emulator.
- **`TBBLUE.FW` / `TBBLUE.TBU`** (firmware + FPGA core on the image) — GPLv3;
  sources published in the distribution's `src/firmware` and `src/vhdl`.
- **Dot commands** (`/dot`, including `.nexload`) — sources published in the
  distribution's `src/asm`, which the Next License deems MIT (individual
  in-tree licenses supersede; observe each).
- **NextZXOS / NextBASIC system files** (`/nextzxos`, `/sys`) — closed-source
  components carried by the umbrella grant's free-distribution terms, served as
  exact, unmodified copies.

The "entirety" question. The Next License's "usage on hardware other than
intended" bullet asks for the distribution "in its entirety", but the same
bullet expressly permits the alternative: "you could distribute only the free
parts of this Distribution for another system". That is the route a staged
copy takes when it is served. "Free parts" here means the
freely-redistributable parts: the
NextZXOS system is redistributable under the umbrella grant, so it ships; the
excluded content (per-title games, demos, tools, the QL core) is NOT freely
redistributable — each is licensed per-title by its own author — so it is
omitted. Distributing only the free parts needs no further permission precisely
because the non-free parts are not distributed at all. The umbrella grant's own
opening words back this: it grants the right to "distribute exact copies", and
what is served here are exact, unmodified copies of the NextZXOS system files.
This is the load-bearing argument if a staged serving is ever challenged: ship
only the freely-redistributable system, serve it unmodified, and never add a
per-title-licensed part. The official deployment sidesteps the question
entirely by not distributing the content at all.

Rules for any deployment that serves a staged copy (self-hosting):

- Keep the app free to access. No paywall, no fee — that is the condition the
  Next License hangs on.
- Ship the bare bootable system only. `scripts/bare-sd-image.sh` (run by
  the stage script) trims the SD image to the NextZXOS system files. Never add
  the distribution's bundled games, demos or third-party tools: each is
  licensed per-title by its own author.
- Retain attribution: NextZXOS (c) Garry Lancaster / SpecNext Ltd; Spectrum
  ROMs (c) Amstrad plc. (NextZXOS itself displays this on boot.)
- "ZX Spectrum Next" is a trademark of others. Name any public deployment
  distinctly and describe it as *an emulator for* the ZX Spectrum Next; do not
  imply it is official.
