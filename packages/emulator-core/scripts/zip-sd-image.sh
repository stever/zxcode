#!/usr/bin/env bash
# Zip a staged tbblue.mmc as tbblue.mmc.zip alongside it, entry name
# "tbblue.mmc". The browser (GoEmulator.bootNext) fetches the zip and inflates
# it with JSZip — the 64MB image is mostly empty space and deflates to a few
# MB — falling back to the raw image when the zip is absent. A plain zip (not
# .gz) keeps the download transport-agnostic: it needs no server encoding
# support and the browser caches the small file.
# Called by stage-zxnext-assets.sh; uses the zip CLI or python3, whichever is
# present.
set -euo pipefail

IMG="${1:-$(cd "$(dirname "$0")/.." && pwd)/res/zxnext/tbblue.mmc}"
[ -f "$IMG" ] || { echo "zip-sd-image: $IMG not found" >&2; exit 1; }
OUT="$IMG.zip"

if command -v zip >/dev/null 2>&1; then
  rm -f "$OUT"
  (cd "$(dirname "$IMG")" && zip -q -9 "$(basename "$OUT")" "$(basename "$IMG")")
elif command -v python3 >/dev/null 2>&1; then
  python3 - "$IMG" "$OUT" <<'EOF'
import sys, zipfile, os
img, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    z.write(img, os.path.basename(img))
EOF
else
  echo "zip-sd-image: neither zip nor python3 found - zip not created" >&2
  exit 0
fi
echo "zip-sd-image: $(basename "$OUT") ($(du -h "$OUT" | cut -f1)) from $(basename "$IMG")"
