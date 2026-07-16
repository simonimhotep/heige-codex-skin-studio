#!/bin/zsh
set -euo pipefail

PORT="${1:-9341}"
HEIGE_CODEX_APP="/Applications/ChatGPT.app"
HEIGE_CODEX_BIN="$HEIGE_CODEX_APP/Contents/MacOS/ChatGPT"

heige_codex_running() { pgrep -f '^/Applications/ChatGPT\.app/Contents/MacOS/ChatGPT' >/dev/null 2>&1 }
heige_codex_flagged() { pgrep -f '^/Applications/ChatGPT\.app/Contents/MacOS/ChatGPT.*remote-debugging-port' >/dev/null 2>&1 }
heige_port_ready() { curl --silent --fail --max-time 1 "http://127.0.0.1:${PORT}/json/list" >/dev/null 2>&1 }
heige_wait_port() {
  for _ in {1..160}; do
    heige_port_ready && return 0
    sleep 0.25
  done
  return 1
}
heige_quit_codex() {
  heige_codex_running || return 0
  echo "正在正常退出 Codex……"
  osascript -e 'tell application id "com.openai.codex" to quit' >/dev/null
  for _ in {1..120}; do
    heige_codex_running || return 0
    sleep 0.25
  done
  # 退出失败绝不能继续开新实例：单实例锁会把新实例转发给老实例，
  # 调试参数被丢弃、端口永远不开，表现为「参数没有保留」
  echo "Codex 没有退出：可能弹出了退出确认框，或有任务正在运行。" >&2
  echo "请手动完全退出 Codex（Cmd+Q 并确认对话框），再重新运行本脚本。" >&2
  return 1
}

heige_port_ready && return 0

heige_quit_codex || return 1

echo "以调试端口重新打开 Codex……"
open -na "$HEIGE_CODEX_APP" --args \
  --remote-debugging-address=127.0.0.1 \
  "--remote-debugging-port=${PORT}"
heige_wait_port && return 0

# 第一通道失败。若参数没挂上（open 传参失败或被残留实例接管），
# 退干净后改用直接拉起二进制的兜底通道，argv 必达
if ! heige_codex_flagged; then
  heige_quit_codex || return 1
  echo "open 传参未生效，改用直接启动兜底通道……"
  nohup "$HEIGE_CODEX_BIN" \
    --remote-debugging-address=127.0.0.1 \
    "--remote-debugging-port=${PORT}" >/dev/null 2>&1 &
  disown
  heige_wait_port && return 0
fi

if heige_codex_flagged; then
  echo "Codex 已带调试参数启动，但端口 ${PORT} 未开放：当前 Codex 版本可能禁用了本机调试端口。" >&2
else
  echo "Codex 未能以调试模式启动。" >&2
fi
echo "请运行 doctor（node src/cli.mjs doctor）并把输出贴到 https://github.com/HeiGeAi/heige-codex-skin-studio/issues 反馈。" >&2
return 1
