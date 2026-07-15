#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h:h}"
PATCHER="$ROOT/payload/src/theme-patch.mjs"
RUNNER="$ROOT/scripts/lib/run-after-quit.zsh"
LOG_DIR="$HOME/Library/Logs/Codex Miku Theme"
LOG_PATH="$LOG_DIR/install.log"

node "$PATCHER" check
mkdir -p "$LOG_DIR"
nohup /bin/zsh "$RUNNER" install "$PATCHER" "$LOG_PATH" >/dev/null 2>&1 &!

echo "兼容性检查通过，安装已排队。"
echo "现在按 Command + Q 完全退出 Codex；安装完成后 Codex 会自动重新打开。"

