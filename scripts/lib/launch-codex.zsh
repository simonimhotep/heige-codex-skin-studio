#!/bin/zsh
set -euo pipefail

PORT="${1:-9341}"

if curl --silent --fail --max-time 1 "http://127.0.0.1:${PORT}/json/list" >/dev/null 2>&1; then
  return 0
fi

if pgrep -f '^/Applications/ChatGPT\.app/Contents/MacOS/ChatGPT' >/dev/null 2>&1; then
  echo "正在正常退出 Codex，以调试端口重新打开……"
  osascript -e 'tell application id "com.openai.codex" to quit' >/dev/null
  for _ in {1..60}; do
    pgrep -f '^/Applications/ChatGPT\.app/Contents/MacOS/ChatGPT' >/dev/null 2>&1 || break
    sleep 0.25
  done
fi

open -na "/Applications/ChatGPT.app" --args \
  --remote-debugging-address=127.0.0.1 \
  "--remote-debugging-port=${PORT}"

for _ in {1..80}; do
  curl --silent --fail --max-time 1 "http://127.0.0.1:${PORT}/json/list" >/dev/null 2>&1 && return 0
  sleep 0.25
done

echo "Codex 未在 ${PORT} 端口就绪。请彻底退出 Codex 后重试。" >&2
return 1
