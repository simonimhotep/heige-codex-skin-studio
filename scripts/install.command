#!/bin/zsh
set -euo pipefail

SOURCE="${0:A:h:h}"
TARGET="$HOME/.codex/heige-codex-skin-studio"
TEMP="${TARGET}.tmp.$$"

rm -rf "$TEMP"
mkdir -p "$TEMP"
cp "$SOURCE/package.json" "$TEMP/"
cp -R "$SOURCE/src" "$TEMP/"
cp -R "$SOURCE/themes" "$TEMP/"
cp -R "$SOURCE/scripts" "$TEMP/"
cp -R "$SOURCE/custom-pet" "$TEMP/"
rm -rf "$TARGET"
mv "$TEMP" "$TARGET"

echo "HeiGe Codex Skin Studio 已安装到：$TARGET"
open "$TARGET/scripts/apply.command"
