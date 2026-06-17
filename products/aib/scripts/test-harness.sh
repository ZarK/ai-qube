#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOOL="${1:-opencode}"
TARGET="$REPO_ROOT/test-harness/${TOOL}-smoke"
IDEA="${2:-I want to build a local AI DJ music generator}"
PROFILE="${3:-local-ai-app}"

rm -rf "$TARGET"
mkdir -p "$TARGET"

"$REPO_ROOT/scripts/bootstrap-init.sh" \
	--tool "$TOOL" \
	--target "$TARGET" \
	--idea "$IDEA" \
	--profile "$PROFILE"

printf 'Smoke harness ready at %s\n' "$TARGET"
