#!/bin/bash

# Install git hooks from scripts/hooks/ to .git/hooks/

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HOOKS_SRC="$SCRIPT_DIR/hooks"
HOOKS_DST="$REPO_ROOT/.git/hooks"

if [ ! -d "$HOOKS_SRC" ]; then
	echo "❌ No hooks directory found at $HOOKS_SRC"
	exit 1
fi

echo "📦 Installing git hooks..."

for hook in "$HOOKS_SRC"/*; do
	if [ -f "$hook" ]; then
		hook_name=$(basename "$hook")
		echo "   Installing $hook_name..."
		cp "$hook" "$HOOKS_DST/$hook_name"
		chmod +x "$HOOKS_DST/$hook_name"
	fi
done

echo "✅ Git hooks installed successfully"
