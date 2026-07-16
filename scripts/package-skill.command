#!/bin/zsh
set -euo pipefail

if (( $# != 2 )); then
  print -u2 "usage: package-skill.command /absolute/output.skill SOURCE_DATE_EPOCH"
  exit 64
fi

ROOT="${0:A:h:h}"
NODE="${HEIGE_NODE:-$(command -v node || true)}"
[[ -n "$NODE" && -x "$NODE" ]] || { print -u2 "找不到可用的 Node.js"; exit 127; }
exec "$NODE" "$ROOT/scripts/package-skill.mjs" \
  --output "$1" \
  --source-date-epoch "$2"
