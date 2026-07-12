#!/usr/bin/env bash
# SessionStart hook — install the CLI's Node dependencies into the persistent plugin-data dir. Claude
# Code never runs install for a plugin and we don't ship node_modules, so this is how deps arrive. It's
# a fast no-op once installed (guarded on package.json being unchanged).
set -euo pipefail

ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
DATA="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/plugins/data/slopweaver}/cli-deps"

# Already installed and package.json unchanged → nothing to do.
if [ -x "$DATA/node_modules/.bin/tsx" ] && diff -q "$ROOT/package.json" "$DATA/package.json" >/dev/null 2>&1; then
  exit 0
fi

mkdir -p "$DATA"
cp "$ROOT/package.json" "$DATA/package.json"
cp "$ROOT/yarn.lock" "$DATA/yarn.lock" 2>/dev/null || true
cp "$ROOT/.yarnrc.yml" "$DATA/.yarnrc.yml" 2>/dev/null || true
rm -rf "$DATA/stubs"; cp -R "$ROOT/stubs" "$DATA/stubs" 2>/dev/null || true  # sharp-stub resolution target

echo "[slopweaver] installing CLI dependencies (one-time, ~a minute)…" >&2
if (cd "$DATA" && (corepack enable >/dev/null 2>&1 || true) && yarn install >/dev/null 2>&1); then
  echo "[slopweaver] dependencies ready." >&2
else
  rm -f "$DATA/package.json"  # clear the marker so the next session retries
  echo "[slopweaver] dependency install failed — will retry next session. Ensure Node + Corepack (or Yarn) are on PATH." >&2
fi
