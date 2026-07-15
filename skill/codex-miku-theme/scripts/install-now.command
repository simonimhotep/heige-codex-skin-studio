#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h:h}"
PATCHER="$ROOT/payload/src/theme-patch.mjs"
node "$PATCHER" check
node "$PATCHER" install
echo "主题与宠物已安装，正在重新打开 Codex。"
open /Applications/ChatGPT.app

