#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h:h}"
SOURCE="$ROOT/custom-pet/miku-future"
TARGET="$HOME/.codex/pets/miku-future"

test -s "$SOURCE/pet.json"
test -s "$SOURCE/spritesheet.webp"
mkdir -p "$TARGET"
cp "$SOURCE/pet.json" "$TARGET/pet.json"
cp "$SOURCE/spritesheet.webp" "$TARGET/spritesheet.webp"

CONFIG="$HOME/.codex/config.toml"
if [[ -f "$CONFIG" ]] && grep -q '^selected-avatar-id = "custom:miku-future"$' "$CONFIG"; then
  : # 已经是目标宠物，无需改动
elif [[ -f "$CONFIG" ]] && grep -q '^selected-avatar-id = ' "$CONFIG"; then
  cp "$CONFIG" "$CONFIG.bak-miku-pet-$(date +%Y%m%d-%H%M%S)"
  sed -i '' 's/^selected-avatar-id = .*/selected-avatar-id = "custom:miku-future"/' "$CONFIG"
elif [[ -f "$CONFIG" ]] && grep -q '^\[desktop\]$' "$CONFIG"; then
  # 键必须落在 [desktop] 节内，追加到文件尾会写进别的节
  cp "$CONFIG" "$CONFIG.bak-miku-pet-$(date +%Y%m%d-%H%M%S)"
  sed -i '' '/^\[desktop\]$/a\
selected-avatar-id = "custom:miku-future"' "$CONFIG"
else
  [[ -f "$CONFIG" ]] && cp "$CONFIG" "$CONFIG.bak-miku-pet-$(date +%Y%m%d-%H%M%S)"
  printf '\n[desktop]\nselected-avatar-id = "custom:miku-future"\n' >> "$CONFIG"
fi

echo "Miku Future 已安装到 $TARGET 并设为当前宠物"
