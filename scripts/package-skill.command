#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h:h}"
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/heige-codex-skin.XXXXXX")
TARGET="$STAGE/heige-codex-skin-studio"
OUTPUT="$ROOT/output/heige-codex-skin-studio.skill"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$TARGET/payload" "$ROOT/output"
cp "$ROOT/skill/heige-codex-skin-studio/SKILL.md" "$TARGET/"
cp "$ROOT/skill/heige-codex-skin-studio/README.md" "$TARGET/"
cp -R "$ROOT/skill/heige-codex-skin-studio/scripts" "$TARGET/"
cp "$ROOT/package.json" "$TARGET/payload/"
cp -R "$ROOT/src" "$TARGET/payload/"
cp -R "$ROOT/themes" "$TARGET/payload/"
cp -R "$ROOT/custom-pet" "$TARGET/payload/"
cp -R "$ROOT/scripts" "$TARGET/payload/"

rm -f "$OUTPUT"
(cd "$STAGE" && /usr/bin/zip -X -q -r "$OUTPUT" heige-codex-skin-studio)
unzip -tq "$OUTPUT" >/dev/null
echo "$OUTPUT"
