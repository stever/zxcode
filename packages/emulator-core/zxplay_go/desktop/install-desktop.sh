#!/usr/bin/env bash
# Install zxplay_go as a desktop application with Spectrum file associations
# (per-user, no root: ~/.local). After this, double-clicking a
# .tap/.tzx/.z80/.sna/.szx/.rzx/.trd/.nex/.81/.80 file boots straight
# into it (the CLI also takes any of these as `zxplay_go FILE`).
#
#   install-desktop.sh [path/to/zxplay_go]     install (builds if no binary given)
#   install-desktop.sh --uninstall         remove everything it installed
#
# Installs: ~/.local/bin/zxplay_go, the .desktop entry, the MIME definitions
# for the types shared-mime-info lacks (.nex/.81/.80 — the classic
# Spectrum types already exist system-wide), and the app icon (exported
# from the binary itself via --export-icon).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BIN_DIR="$HOME/.local/bin"
APP_DIR="$HOME/.local/share/applications"
MIME_DIR="$HOME/.local/share/mime"
ICON_DIR="$HOME/.local/share/icons/hicolor/256x256/apps"

MIME_TYPES=(
  application/x-spectrum-tap application/x-spectrum-tzx
  application/x-spectrum-z80 application/x-spectrum-sna
  application/x-spectrum-szx application/x-spectrum-rzx
  application/x-spectrum-trd application/x-spectrum-next-nex
  application/x-zx81-p application/x-zx80-o
)

refresh_databases() {
  command -v update-mime-database >/dev/null && update-mime-database "$MIME_DIR" >/dev/null
  command -v update-desktop-database >/dev/null && update-desktop-database "$APP_DIR" || true
  command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q -t "$HOME/.local/share/icons/hicolor" 2>/dev/null || true
}

if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$BIN_DIR/zxplay_go" "$APP_DIR/zxplay_go.desktop" \
        "$MIME_DIR/packages/zxplay_go-mime.xml" "$ICON_DIR/zxplay_go.png"
  refresh_databases
  echo "zxplay_go desktop integration removed."
  exit 0
fi

# The binary: use the argument, or build from the repo this script sits in.
SRC_BIN="${1:-}"
if [ -z "$SRC_BIN" ]; then
  echo "building zxplay_go ..."
  (cd "$HERE/.." && go build -o "$HERE/../zxplay_go.bin" ./cmd/zxplay_go)
  SRC_BIN="$HERE/../zxplay_go.bin"
  trap 'rm -f "$HERE/../zxplay_go.bin"' EXIT
fi
[ -x "$SRC_BIN" ] || { echo "not an executable: $SRC_BIN" >&2; exit 1; }

mkdir -p "$BIN_DIR" "$APP_DIR" "$MIME_DIR/packages" "$ICON_DIR"
install -m 755 "$SRC_BIN" "$BIN_DIR/zxplay_go"

# Icon straight from the binary (icon.go draws it; no asset to track).
"$BIN_DIR/zxplay_go" --export-icon "$ICON_DIR/zxplay_go.png"

# Desktop entry with an absolute Exec so it works even when
# ~/.local/bin is not on the session PATH, and Path=$HOME so the
# cwd-relative Next ROM resolution (install.Path -> ./roms/next)
# lands on ~/roms/next no matter how the file manager spawns it.
{
  sed -e "s|^Exec=zxplay_go|Exec=$BIN_DIR/zxplay_go|" \
      -e "s|^TryExec=zxplay_go|TryExec=$BIN_DIR/zxplay_go|" \
      "$HERE/zxplay_go.desktop"
  echo "Path=$HOME"
} > "$APP_DIR/zxplay_go.desktop"

install -m 644 "$HERE/zxplay_go-mime.xml" "$MIME_DIR/packages/zxplay_go-mime.xml"
refresh_databases

for t in "${MIME_TYPES[@]}"; do
  xdg-mime default zxplay_go.desktop "$t" 2>/dev/null || true
done

echo "Installed: $BIN_DIR/zxplay_go + desktop entry + file associations."
echo "Note: Spectrum Next boots need the NextZXOS assets — run zxplay_go once"
echo "and use Machine -> ZX Spectrum Next to install them, or set the"
echo "SD paths in the config."
