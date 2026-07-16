#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h:h}"
NODE="/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node"
PORT="${HEIGE_CODEX_SKIN_PORT:-9341}"

IMAGE=$(osascript -e 'POSIX path of (choose file with prompt "选择一张皮肤主图" of type {"public.image"})') || exit 0
NAME=$(osascript -e 'text returned of (display dialog "给皮肤起个名字" default answer "我的 Codex 皮肤")') || exit 0
RESULT=$("$NODE" "$ROOT/src/cli.mjs" create --image "$IMAGE" --name "$NAME")
THEME=$(printf '%s' "$RESULT" | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).id))')

source "$ROOT/scripts/lib/launch-codex.zsh" "$PORT"
"$NODE" "$ROOT/src/cli.mjs" apply --theme "$THEME" --port "$PORT"
echo "新皮肤已创建并应用：$THEME"
