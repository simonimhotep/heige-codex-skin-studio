#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h:h}"
exec node "$ROOT/payload/src/theme-patch.mjs" check

