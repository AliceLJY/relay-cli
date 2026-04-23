#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_HOST="${DUO_MAC_HOST:-mac}"
TARGET_DIR="${DUO_MAC_DIR:-/Users/USER/Projects/relay-cli}"

ssh "$TARGET_HOST" "mkdir -p '$TARGET_DIR'"

rsync -a \
  --exclude node_modules \
  --exclude dist \
  --exclude .duo \
  "$ROOT/" \
  "$TARGET_HOST:$TARGET_DIR/"

ssh "$TARGET_HOST" "cd '$TARGET_DIR' && npm ci && npm run check && npm link && duo status"
