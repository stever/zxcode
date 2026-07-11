#!/usr/bin/env bash
# Stage the ZX Spectrum Next runtime assets into res/zxnext/.
#
# These three files are NextZXOS system content, copyright Garry Lancaster /
# SpecNext Ltd (portions (c) Amstrad plc). They are distributed under The Next
# License — cost-free distribution permitted, no selling — not GPL, so they
# stay out of git and are staged locally. See ../../LICENSES.md for the
# deployment rules (free access, bare bootable system, attribution). This
# script pulls them from a running retrogamecoders IDE deploy as a
# convenience; the canonical source is the official distribution
# (https://www.specnext.com/).
#
# It does NOT fetch zx.wasm — that is built from zx_go (see ../../wasm/), and
# wasm_exec.js is committed (BSD, from the Go toolchain).
set -euo pipefail

BASE="${ZXNEXT_ASSET_BASE:-https://ide.retrogamecoders.com/res/zxnext}"
SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
DIR="$(cd "$SCRIPTS/.." && pwd)/res/zxnext"
mkdir -p "$DIR"
echo "Staging Next system assets into $DIR"

# Fetch, transparently using the server's gzip variant when present.
fetch() {
  local name="$1" out="$DIR/$1"
  if curl -fsS -o "$out.gz" "$BASE/$name.gz" 2>/dev/null && gzip -t "$out.gz" 2>/dev/null; then
    gunzip -f "$out.gz"; echo "  $name (from .gz)"
  else
    rm -f "$out.gz"
    curl -fsS -o "$out" "$BASE/$name"; echo "  $name"
  fi
}

fetch enNextZX.rom   # NextZXOS boot ROM (64K)
fetch enNxtmmc.rom   # divMMC / esxDOS ROM (8K)
fetch tbblue.mmc     # FAT32 SD image with NextZXOS (64M)

# Trim the image to the bare bootable system (no-op without mtools).
"$SCRIPTS/bare-sd-image.sh" "$DIR/tbblue.mmc"

# Zip the trimmed image next to it: the browser fetches tbblue.mmc.zip (a few
# MB — the 64MB image is mostly empty space) and inflates it client-side,
# falling back to the raw image only on deployments staged before the zip
# existed. Keep the raw image too: desktop/Go tests point ZX_GO_NEXT_SD_IMG
# at it, and previously-deployed bundles still fetch it.
"$SCRIPTS/zip-sd-image.sh" "$DIR/tbblue.mmc"

echo "Done. Build zx.wasm (see ../../wasm/), then: python3 -m http.server 8080"
