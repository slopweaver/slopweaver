#!/usr/bin/env bash
# PreToolUse hook shim — resolve tsx (dev node_modules, else the plugin-data deps) and run the raw-tool
# guard (hooks/pretooluse-admit.ts), passing the tool-call JSON through on stdin. Fails OPEN (exit 0) if
# tsx can't be found, so a broken toolchain never wedges every tool call; the in-process door is the real
# contract, this hook is defence in depth.
set -uo pipefail

ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
DATA="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/plugins/data/slopweaver}/cli-deps"

TSX="$ROOT/node_modules/.bin/tsx"
[ -x "$TSX" ] || TSX="$DATA/node_modules/.bin/tsx"
if [ ! -x "$TSX" ]; then
  exit 0
fi

exec "$TSX" "$ROOT/hooks/pretooluse-admit.ts"
