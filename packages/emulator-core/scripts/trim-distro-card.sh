#!/usr/bin/env bash
# Build the staged tbblue.mmc from an OFFICIAL SpecNext distro card image:
# the distro's FULL capacity (so big self-streaming games — Atic Atac,
# TX-1696 — fit), with the per-title-licensed payload removed — the
# bare-bootable-system deployment posture in ../../LICENSES.md.
#
#   trim-distro-card.sh <pristine-distro.img> [out.mmc]
#
# Steps:
#   1. PREP the pristine card exactly as the browser's distro path does
#      (delete the first-boot welcome pager, seed config.ini) via
#      TestPrepDistroCard_OfficialImage — staged images mount untouched,
#      so the prep must be baked in.
#   2. KEEP only the system tree (see KEEP below); everything else on the
#      card (apps/demos/docs/extras/games/src) is per-title licensed and
#      never distributed by this project.
#   3. REBUILD the filesystem fresh (mformat + mcopy) instead of deleting
#      in place — for three reasons:
#      - deletions leave the payload bytes in freed clusters (a ~50 MB
#        zip instead of ~3 MB) and leave free space FRAGMENTED;
#        self-streaming games raw-stream their own .nex and hard-error
#        ("FILE FRAGMENTATION ERROR") unless free space is one
#        contiguous run;
#      - the OFFICIAL geometry (32 KB clusters) hits the known-gaps.md
#        faithful-firmware-boot gap ("Error opening 'menu.ini/.def'"), so
#        the rebuilt card uses the STAGED geometry both boot paths handle:
#        partition at LBA 2048, type 0x0C, 4 KB clusters, 32 reserved
#        sectors — the classic tbblue.mmc layout at the distro's size.
#      Capacity comes from the SOURCE image (1 GB for the 24.11 distro).
#   4. Zip via zip-sd-image.sh (the browser downloads the zip and streams
#      it into the sparse in-wasm card).
#
# After building, re-verify per "Next boot modes" in ../README.md (both
# boot paths) and stage the .mmc + .mmc.zip into apps/*/public/next/.
# Needs: GNU mtools, python3, a Go toolchain (for the prep test).
set -euo pipefail

SRC="${1:?usage: trim-distro-card.sh <pristine-distro.img> [out.mmc]}"
OUT="${2:-$(dirname "$SRC")/tbblue.mmc}"
SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
ZXGO="$SCRIPTS/../zx_go"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# The system tree that stays on the card. LICENSE/README travel with the
# copy per The Next License; home/tmp are part of the OS card layout.
KEEP=(dot home LICENSE.md machines nextzxos README.md sys TBBLUE.FW TBBLUE.TBU tmp)

echo "1/4 prep (welcome pager + config.ini) ..."
(cd "$ZXGO" && ZX_GO_DISTRO_IMG="$SRC" ZX_GO_DISTRO_IMG_OUT="$TMP/prepped.img" \
    go test -count=1 -run TestPrepDistroCard_OfficialImage ./cmd/zx_go/ >/dev/null)

# Source partition offset (for extraction) and total image size (for the
# rebuilt card's capacity).
read -r SRC_START TOT_SEC < <(python3 - "$TMP/prepped.img" <<'EOF'
import os, struct, sys
with open(sys.argv[1], 'rb') as f:
    start, = struct.unpack_from('<I', f.read(512), 0x1BE + 8)
print(start, os.path.getsize(sys.argv[1]) // 512)
EOF
)

echo "2/4 extract system tree ..."
mkdir "$TMP/tree"
for e in "${KEEP[@]}"; do
  mcopy -i "$TMP/prepped.img@@$((SRC_START * 512))" -s -p -m "::/$e" "$TMP/tree/"
done

# machines/ stays for the Next system files, but the Sinclair QL core + ROMs
# (machines/ql, ~2.8 MB) are a different machine, separately licensed and
# never used by this emulator — excluded content per ../LICENSES.md.
if [ -d "$TMP/tree/machines/ql" ]; then
  rm -rf "$TMP/tree/machines/ql"
  echo "  removed machines/ql (separately licensed, unused)"
fi

echo "3/4 rebuild at staged geometry (LBA 2048, 4 KB clusters) ..."
P_START=2048
P_SIZE=$((TOT_SEC - P_START))
python3 - "$TMP/out.img" "$TOT_SEC" "$P_START" "$P_SIZE" <<'EOF'
import struct, sys
path, tot, start, size = sys.argv[1], *map(int, sys.argv[2:])
mbr = bytearray(512)
e = 0x1BE
mbr[e+1:e+4] = bytes([0xFE, 0xFF, 0xFF])
mbr[e+4] = 0x0C
mbr[e+5:e+8] = bytes([0xFE, 0xFF, 0xFF])
struct.pack_into('<II', mbr, e+8, start, size)
mbr[510:512] = b'\x55\xAA'
with open(path, 'wb') as f:
    f.write(mbr)
    f.truncate(tot * 512)
EOF
mformat -i "$TMP/out.img@@$((P_START * 512))" -F -c 8 -R 32 -T "$P_SIZE" -h 255 -s 63 -H "$P_START" ::
for e in "${KEEP[@]}"; do
  mcopy -i "$TMP/out.img@@$((P_START * 512))" -s -p -m "$TMP/tree/$e" ::/
done
mdir -i "$TMP/out.img@@$((P_START * 512))" :: | tail -2

echo "4/4 zip ..."
mv "$TMP/out.img" "$OUT"
"$SCRIPTS/zip-sd-image.sh" "$OUT"
echo "done: $OUT (+ .zip) — re-verify per README 'Next boot modes', then stage into apps/*/public/next/ (stage-zxnext-assets.sh does build + staging in one step)"
