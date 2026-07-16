#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h:h}"
NODE="/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node"
THEME="${1:-miku-488137}"
PORT="${HEIGE_CODEX_SKIN_PORT:-9341}"

source "$ROOT/scripts/lib/launch-codex.zsh" "$PORT"
"$NODE" "$ROOT/src/cli.mjs" apply --theme "$THEME" --port "$PORT"
echo "皮肤已应用：$THEME"
