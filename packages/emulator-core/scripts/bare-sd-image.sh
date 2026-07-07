#!/usr/bin/env bash
# Strip non-system payload from a staged tbblue.mmc so the served image is a
# bare bootable NextZXOS system — the deployment posture in ../../LICENSES.md
# (ship the OS, never the distro's per-title-licensed extras). Removes:
#   /machines/ql   Sinclair QL core + ROMs: a different machine, separately
#                  licensed, never used by this emulator (~2.8 MB)
# Needs GNU mtools; called by stage-zxnext-assets.sh when available.
# Verified: the trimmed image boots NextZXOS to the main menu byte-identically
# to the full one (zx_go --headless --next, identical insn count and screen).
set -euo pipefail

IMG="${1:-$(cd "$(dirname "$0")/.." && pwd)/res/zxnext/tbblue.mmc}"
OFFSET=$((2048 * 512)) # partition 1 start: MBR, FAT32 (LBA) at sector 2048

if ! command -v mdeltree >/dev/null 2>&1; then
  echo "bare-sd-image: mtools not found - image left untrimmed" >&2
  exit 0
fi
[ -f "$IMG" ] || { echo "bare-sd-image: $IMG not found" >&2; exit 1; }

if mdir -i "$IMG@@$OFFSET" ::/machines/ql >/dev/null 2>&1; then
  mdeltree -i "$IMG@@$OFFSET" ::/machines/ql
  echo "bare-sd-image: removed /machines/ql from $(basename "$IMG")"
else
  echo "bare-sd-image: $(basename "$IMG") is already bare"
fi
