#!/bin/bash

# Start work on a GitHub issue
# - Sets S-InProgress label
# - Verifies issue is not blocked
# - Adds a start comment

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "$SCRIPT_DIR/lib/gh-issue-helpers.sh"

if [ $# -eq 0 ]; then
    echo "Usage: $0 <issue_number> [--force]"
    echo ""
    echo "Starts work on an issue by:"
    echo "  1. Checking if issue is blocked (fails if blocked, unless --force)"
    echo "  2. Setting status to S-InProgress"
    echo "  3. Adding a start comment"
    echo ""
    echo "Options:"
    echo "  --force    Start even if issue is marked S-Blocked"
    echo ""
    echo "Example:"
    echo "  $0 85"
    echo "  $0 85 --force"
    exit 1
fi

ISSUE_NUM=$1
FORCE=false

if [ "${2:-}" = "--force" ]; then
    FORCE=true
fi

# Check if issue exists and get current state
echo "🔍 Checking issue #$ISSUE_NUM..."

issue_data=$(gh issue view "$ISSUE_NUM" --json number,title,state,labels,body 2>/dev/null)
if [ $? -ne 0 ]; then
    echo "❌ Issue #$ISSUE_NUM not found"
    exit 1
fi

issue_state=$(echo "$issue_data" | jq -r '.state')
issue_title=$(echo "$issue_data" | jq -r '.title')
labels=$(echo "$issue_data" | jq -r '.labels[].name' | tr '\n' ',')
open_issue_numbers=$(gh_open_issue_numbers)
open_blockers=$(gh_issue_open_blockers "$ISSUE_NUM" "$open_issue_numbers" || true)

# Check if already closed
if [ "$issue_state" = "CLOSED" ]; then
	echo "❌ Issue #$ISSUE_NUM is already closed"
	exit 1
fi

# Check actual blockers before trusting labels
if [ -n "$open_blockers" ]; then
	if [ "$FORCE" = false ]; then
		echo "🚫 Issue #$ISSUE_NUM is blocked!"
		echo ""
		while IFS= read -r blocker; do
			[ -z "$blocker" ] && continue
			blocker_title=$(gh issue view "$blocker" --json title --jq '.title' 2>/dev/null || echo "")
			echo "  - #$blocker: $blocker_title"
		done <<<"$open_blockers"
		echo ""
		echo "Check blockers with: ./scripts/gh-issue-deps.sh blockers $ISSUE_NUM"
		echo "Or use --force to start anyway"
		exit 1
	else
		echo "⚠️  Starting blocked issue (--force used)"
	fi
elif echo "$labels" | grep -q "S-Blocked"; then
	echo "ℹ️  Issue #$ISSUE_NUM has a stale S-Blocked label but no open blockers"
fi

# Check if already in progress
if echo "$labels" | grep -q "S-InProgress"; then
    echo "ℹ️  Issue #$ISSUE_NUM is already in progress"
    exit 0
fi

# Check for other in-progress issues
in_progress=$(gh issue list --label "S-InProgress" --state open --json number,title --jq '.[] | "#\(.number): \(.title)"' 2>/dev/null)
if [ -n "$in_progress" ]; then
    if [ "$FORCE" = false ]; then
        echo "⚠️  Other issues are currently in progress:"
        echo "$in_progress"
        echo ""
        echo "Use --force to start #$ISSUE_NUM anyway"
        exit 1
    fi

    echo "⚠️  Starting while other issues are in progress (--force used)"
    echo "$in_progress"
    echo ""
fi

# Update labels
echo "📝 Setting S-InProgress..."
gh issue edit "$ISSUE_NUM" --remove-label "S-Ready,S-Blocked" 2>/dev/null || true
gh issue edit "$ISSUE_NUM" --add-label "S-InProgress"

# Add start comment
echo "💬 Adding start comment..."
gh issue comment "$ISSUE_NUM" --body "🚀 **Started work on this issue**

Working on: $issue_title

Will update checkboxes as progress is made."

echo ""
echo "✅ Started issue #$ISSUE_NUM: $issue_title"
echo ""
echo "Next steps:"
echo "  1. Implement the changes"
echo "  2. Commit with: #$ISSUE_NUM <type>: <summary>"
echo "  3. Push after each commit"
echo "  4. Update issue checkboxes"
echo "  5. When done: ./scripts/gh-issue-complete.sh $ISSUE_NUM"
