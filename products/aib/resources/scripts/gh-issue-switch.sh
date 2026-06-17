#!/bin/bash

# Quickly switch S-InProgress between two issues
# Useful for quick manual work interruptions

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

if [ $# -lt 1 ]; then
    echo "Usage: $0 <to_issue> [from_issue] [--force]"
    echo ""
    echo "Switches S-InProgress label from one issue to another."
    echo ""
    echo "Arguments:"
    echo "  to_issue    Issue number to switch TO (will become S-InProgress)"
    echo "  from_issue  Issue number to switch FROM (optional, auto-detects current in-progress)"
    echo "  --force     Allow switching to a blocked issue"
    echo ""
    echo "Examples:"
    echo "  $0 90           # Pause current in-progress issue, start #90"
    echo "  $0 90 85        # Pause #85, start #90"
    echo "  $0 90 --force   # Force-switch to blocked #90"
    echo "  $0 85           # Switch back to #85 (pauses current)"
    exit 1
fi

TO_ISSUE=$1
FROM_ISSUE="${2:-}"
FORCE=false

for arg in "$@"; do
    if [ "$arg" = "--force" ]; then
        FORCE=true
    fi
done

if [ "$FROM_ISSUE" = "--force" ]; then
    FROM_ISSUE=""
fi

# Auto-detect current in-progress issue if not specified
if [ -z "$FROM_ISSUE" ]; then
    FROM_ISSUE=$(gh issue list --label "S-InProgress" --state open --json number --jq '.[0].number' 2>/dev/null)
fi

# Validate TO issue exists
echo "🔍 Checking issue #$TO_ISSUE..."
to_data=$(gh issue view "$TO_ISSUE" --json number,title,state 2>/dev/null)
if [ $? -ne 0 ]; then
    echo "❌ Issue #$TO_ISSUE not found"
    exit 1
fi

to_title=$(echo "$to_data" | jq -r '.title')
to_state=$(echo "$to_data" | jq -r '.state')

if [ "$to_state" = "CLOSED" ]; then
    echo "❌ Issue #$TO_ISSUE is closed"
    exit 1
fi

# Handle FROM issue if exists
if [ -n "$FROM_ISSUE" ] && [ "$FROM_ISSUE" != "null" ]; then
    if [ "$FROM_ISSUE" = "$TO_ISSUE" ]; then
    echo "ℹ️  Issue #$TO_ISSUE is already in progress"
        exit 0
    fi
    
    from_data=$(gh issue view "$FROM_ISSUE" --json number,title 2>/dev/null)
    from_title=$(echo "$from_data" | jq -r '.title')
    
    echo "⏸️  Pausing #$FROM_ISSUE: $from_title"
    gh issue edit "$FROM_ISSUE" --remove-label "S-InProgress" 2>/dev/null || true
    "$SCRIPT_DIR/gh-update-labels.sh" "$FROM_ISSUE" sync >/dev/null

    gh issue comment "$FROM_ISSUE" --body "⏸️ **Paused** - switching to #$TO_ISSUE" 2>/dev/null || true
else
    echo "ℹ️  No current in-progress issue found"
fi

# Start TO issue
echo "▶️  Starting #$TO_ISSUE: $to_title"
if [ "$FORCE" = true ]; then
    "$SCRIPT_DIR/gh-issue-start.sh" "$TO_ISSUE" --force
else
    "$SCRIPT_DIR/gh-issue-start.sh" "$TO_ISSUE"
fi

echo ""
echo "✅ Switched to issue #$TO_ISSUE: $to_title"
if [ -n "$FROM_ISSUE" ] && [ "$FROM_ISSUE" != "null" ] && [ "$FROM_ISSUE" != "$TO_ISSUE" ]; then
    echo "   (Paused #$FROM_ISSUE)"
    echo ""
    echo "To switch back: ./scripts/gh-issue-switch.sh $FROM_ISSUE"
fi
