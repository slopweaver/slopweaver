#!/usr/bin/env bash
# Public hygiene gate: scan every git-tracked file for generic leak classes (see src/hygiene/scan.ts).
# Exits non-zero listing every hit. Wired into CI and the `hygiene` package script.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TSX="$ROOT/node_modules/.bin/tsx"
if [ ! -x "$TSX" ]; then
  echo "check-hygiene: tsx not found — run install first" >&2
  exit 1
fi
exec "$TSX" "$ROOT/src/hygiene/scan.ts"
