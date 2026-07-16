#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h:h}"
SOURCE="$ROOT/payload"
TARGET="$HOME/.codex/heige-codex-skin-studio"
TEMP="${TARGET}.tmp.$$"

test -s "$SOURCE/src/cli.mjs"
test -s "$SOURCE/themes/miku-488137/theme.json"
rm -rf "$TEMP"
mkdir -p "$TEMP"
cp -R "$SOURCE/." "$TEMP/"
rm -rf "$TARGET"
mv "$TEMP" "$TARGET"

echo "HeiGe Codex Skin Studio 已安装到：$TARGET"
if [[ "${HEIGE_SKIP_APPLY:-0}" != "1" ]]; then
  open "$TARGET/scripts/apply.command"
fi
