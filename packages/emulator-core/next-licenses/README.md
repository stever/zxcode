# Next runtime-asset license bundle

Canonical, committable license texts that must be **served alongside** the
NextZXOS runtime assets (`enNextZX.rom`, `enNxtmmc.rom`, `tbblue.mmc`).

The Next License requires its copyright and permission notice to travel with
every copy of the distribution, "together with ALL individual licenses of all
constituent parts". The assets themselves are not committed (they are not
open-licensed and are staged at deploy time), but these license texts are freely
distributable, so they live in git and are copied next to the assets wherever
they are served.

## Files

| File | Purpose |
|------|---------|
| `THE-NEXT-LICENSE.txt` | The umbrella license (permission notice) for the assets. |
| `NOTICES.txt` | Copyright, per-constituent license mapping, corresponding-source links. |
| `AMSTRAD-ROM-PERMISSION.txt` | Amstrad's permission covering the Spectrum ROM images. |
| `GPL-3.0.txt` | Full GPLv3 text, for the FPGA core/firmware on the SD image. |

## Where these are served

The bundle is served at `/next/licenses/`, next to the binaries served at
`/next/`:

- **Dev / published images:** committed into `apps/web/public/next/licenses/` and
  `apps/play/public/next/licenses/`.
- **Production:** the deploy host serves only `/opt/zxplay/next-assets/` (it
  bind-mounts over the image's `/srv/next`), so the deploy repo's
  `scripts/stage-next-assets.sh` copies this bundle into
  `/opt/zxplay/next-assets/licenses/` when staging the binaries.

Keep the three serving copies in sync with this canonical source when it changes.
See also the deployment rules in `../LICENSES.md`.
