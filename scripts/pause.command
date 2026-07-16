#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h:h}"
NODE="/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node"
PORT="${HEIGE_CODEX_SKIN_PORT:-9341}"

if ! curl --silent --fail --max-time 1 "http://127.0.0.1:${PORT}/json/list" >/dev/null 2>&1; then
  echo "当前没有可移除的实时皮肤。"
  exit 0
fi
"$NODE" "$ROOT/src/cli.mjs" pause --port "$PORT"
echo "皮肤已暂停，Codex 原文件从未被修改。"
