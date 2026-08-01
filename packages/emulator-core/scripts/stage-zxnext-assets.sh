#!/usr/bin/env bash
# Stage the ZX Spectrum Next runtime assets into apps/*/public/next/, built
# entirely from an OFFICIAL SpecNext distro card image (specnext.com) — the
# project's only asset source; nothing is fetched from anywhere else.
#
#   stage-zxnext-assets.sh <pristine-distro.img>
#
# Steps:
#   1. trim-distro-card.sh builds tbblue.mmc (+ tbblue.mmc.zip): the
#      distro's full capacity with only the freely-redistributable system
#      tree, rebuilt contiguous at the staged geometry (see that script's
#      header for the rationale).
#   2. enNextZX.rom + enNxtmmc.rom — the two ROMs GoEmulator.js registers
#      before boot — are extracted from the built card's machines/next/
#      (byte-identical to the distro's loose copies).
#   3. All four files are staged into apps/web/public/next/ and
#      apps/play/public/next/ (gif-service's dev fallback reads the play
#      copy; its container is staged by the deploy repo).
#
# These files are NextZXOS system content, copyright Garry Lancaster /
# SpecNext Ltd (portions (c) Amstrad plc), distributed under The Next
# License — cost-free distribution permitted, no selling — not GPL, so they
# stay out of git and are staged locally. See ../LICENSES.md for the
# deployment rules (free access, bare bootable system, attribution).
#
# It does NOT build zx.wasm — that comes from zxplay_go via build-wasm.sh.
# After staging, re-verify per "Next boot modes" in ../README.md.
# Needs: GNU mtools, python3, a Go toolchain (for trim's prep step).
set -euo pipefail

SRC="${1:?usage: stage-zxnext-assets.sh <pristine-distro.img>}"
SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$SCRIPTS/../../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

"$SCRIPTS/trim-distro-card.sh" "$SRC" "$TMP/tbblue.mmc"

# Pull the boot ROMs out of the built card. Its partition sits at LBA 2048 —
# trim-distro-card.sh authored that MBR, so the offset is fixed.
OFF=$((2048 * 512))
mcopy -i "$TMP/tbblue.mmc@@$OFF" -p ::/machines/next/enNextZX.rom "$TMP/enNextZX.rom"
mcopy -i "$TMP/tbblue.mmc@@$OFF" -p ::/machines/next/enNxtmmc.rom "$TMP/enNxtmmc.rom"
[ "$(wc -c < "$TMP/enNextZX.rom")" -eq $((64 * 1024)) ] || { echo "enNextZX.rom: unexpected size" >&2; exit 1; }
[ "$(wc -c < "$TMP/enNxtmmc.rom")" -eq $((8 * 1024)) ] || { echo "enNxtmmc.rom: unexpected size" >&2; exit 1; }

for app in web play; do
  DEST="$REPO/apps/$app/public/next"
  mkdir -p "$DEST"
  cp "$TMP/tbblue.mmc" "$TMP/tbblue.mmc.zip" "$TMP/enNextZX.rom" "$TMP/enNxtmmc.rom" "$DEST/"
  echo "staged: $DEST"
done

echo "Done. Re-verify per 'Next boot modes' in ../README.md."
