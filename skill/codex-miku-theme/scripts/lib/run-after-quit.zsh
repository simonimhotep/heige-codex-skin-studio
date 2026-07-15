#!/bin/zsh
set -euo pipefail

ACTION="$1"
PATCHER="$2"
LOG_PATH="$3"

exec >>"$LOG_PATH" 2>&1
echo "[$(/bin/date -Iseconds)] Waiting for Codex to exit before $ACTION"

while /usr/bin/pgrep -f '/Applications/ChatGPT.app/Contents/' >/dev/null 2>&1; do
  /bin/sleep 1
done

if [[ "$ACTION" == "install" ]]; then
  node "$PATCHER" check
  node "$PATCHER" install
elif [[ "$ACTION" == "restore" ]]; then
  node "$PATCHER" restore
else
  echo "Unsupported queued action: $ACTION"
  exit 64
fi

echo "[$(/bin/date -Iseconds)] $ACTION completed"
/usr/bin/open /Applications/ChatGPT.app

