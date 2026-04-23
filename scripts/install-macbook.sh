#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_HOST="${DUO_MAC_HOST:-mac}"
TARGET_DIR="${DUO_MAC_DIR:-$HOME/Projects/relay-cli}"
DUO_BIN="${DUO_BIN:-/opt/homebrew/bin/duo}"
CLAUDE_BIN="${DUO_CLAUDE_BIN:-$HOME/.local/bin/claude}"

ssh "$TARGET_HOST" "mkdir -p '$TARGET_DIR'"

rsync -a \
  --exclude node_modules \
  --exclude dist \
  --exclude .duo \
  "$ROOT/" \
  "$TARGET_HOST:$TARGET_DIR/"

ssh "$TARGET_HOST" "cd '$TARGET_DIR' && npm ci && npm run check && npm link && duo status"
ssh "$TARGET_HOST" "codex mcp get duo >/dev/null 2>&1 || codex mcp add duo -- '$DUO_BIN' mcp"
ssh "$TARGET_HOST" "cd '$TARGET_DIR' && if [ -x '$CLAUDE_BIN' ]; then '$CLAUDE_BIN' mcp get duo >/dev/null 2>&1 || '$CLAUDE_BIN' mcp add -s project duo -- '$DUO_BIN' mcp; fi"
