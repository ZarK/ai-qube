#!/bin/bash

# Complete a GitHub issue
# - Verifies all tasks are completed
# - Closes the issue
# - Finds and unblocks dependent issues
# - Adds a completion comment

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "$SCRIPT_DIR/lib/gh-issue-helpers.sh"

check_incomplete_tasks() {
	local issue_num="$1"
	local body
	body=$(gh issue view "$issue_num" --json body --jq '.body' 2>/dev/null)

	if [ -z "$body" ]; then
		return 0
	fi

	local unticked
	unticked=$(echo "$body" | grep -E '^\s*-\s*\[ \]' | sed -E 's/^[[:space:]]*-[[:space:]]*\[[[:space:]]\][[:space:]]*//' || true)

	if [ -n "$unticked" ]; then
		echo "$unticked"
		return 1
	fi

	return 0
}

# Function to extract issue number from branch name
# Branch format: type/N-slug (e.g., feat/827-gh-harness)
get_issue_from_branch() {
	local branch="$1"
	echo "$branch" | grep -oE '/[0-9]+' | head -1 | tr -d '/' || true
}

if [ $# -eq 0 ]; then
	echo "Usage: $0 <issue_number> [--dry-run] [--force] [--check-only]"
	echo ""
	echo "Completes an issue by:"
	echo "  1. Verifying all tasks are completed"
	echo "  2. Closing the issue"
	echo "  3. Finding issues blocked by this one"
	echo "  4. Unblocking those issues (S-Blocked → S-Ready)"
	echo "  5. Adding completion comments"
	echo ""
	echo "Options:"
	echo "  --dry-run      Show what would happen without making changes"
	echo "  --check-only   Only check task completion, don't close (exit 1 if incomplete)"
	echo ""
	echo "Example:"
	echo "  $0 85"
	echo "  $0 85 --dry-run"
	echo "  $0 85 --check-only"
	exit 1
fi

ISSUE_NUM=$1
DRY_RUN=false
FORCE=false
CHECK_ONLY=false

shift
while [ $# -gt 0 ]; do
	case "$1" in
	--dry-run)
		DRY_RUN=true
		;;
	--force)
		FORCE=true
		;;
	--check-only)
		CHECK_ONLY=true
		;;
	esac
	shift
done

if [ "$DRY_RUN" = true ]; then
	echo "🔍 DRY RUN MODE - no changes will be made"
	echo ""
fi

# Check if issue exists and get current state
echo "🔍 Checking issue #$ISSUE_NUM..."

issue_data=$(gh issue view "$ISSUE_NUM" --json number,title,state,labels 2>/dev/null)
if [ $? -ne 0 ]; then
	echo "❌ Issue #$ISSUE_NUM not found"
	exit 1
fi

issue_state=$(echo "$issue_data" | jq -r '.state')
issue_title=$(echo "$issue_data" | jq -r '.title')

echo "📋 Verifying all tasks are completed..."
echo ""

incomplete_tasks=$(check_incomplete_tasks "$ISSUE_NUM" || true)
has_incomplete=false

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🚨 REVIEW BEFORE COMPLETING:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [ -n "$incomplete_tasks" ]; then
	has_incomplete=true
	while IFS= read -r item; do
		if [ -n "$item" ]; then
			echo "  ❓ Did you fully complete \"$item\" as intended by the issue?"
		fi
	done <<<"$incomplete_tasks"
	echo ""
fi

echo "  ❓ Did you cover all new backend functionality with unit tests?"
echo "  ❓ Did you cover all new frontend functionality with E2E tests?"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [ "$has_incomplete" = true ]; then
	if [ "$CHECK_ONLY" = true ]; then
		echo "❌ CHECK FAILED: Incomplete tasks found"
		exit 1
	fi

	if [ "$FORCE" = true ]; then
		echo "⚠️  WARNING: Proceeding with --force despite incomplete tasks"
		echo ""
	else
		echo "💡 Complete all tasks, then retry"
		echo ""
		exit 1
	fi
else
	echo "✅ All tasks are complete"
	echo ""
fi

if [ "$CHECK_ONLY" = true ]; then
	echo "✅ CHECK PASSED: All tasks are complete"
	exit 0
fi

if [ "$issue_state" = "CLOSED" ]; then
	echo "ℹ️  Issue #$ISSUE_NUM is already closed"
	echo "   Checking for blocked issues to unblock..."
fi

# Find issues that are blocked by this one using the shared blocker parser
echo "🔍 Finding issues blocked by #$ISSUE_NUM..."

all_blocked=$(gh_open_issues_blocked_by "$ISSUE_NUM" | grep -v '^$' || true)

blocked_count=$(echo "$all_blocked" | grep -c '[0-9]' 2>/dev/null || echo "0")
blocked_count=$(echo "$blocked_count" | tr -d '[:space:]')

echo ""
if [ "$blocked_count" -gt 0 ]; then
	echo "📋 Found $blocked_count issue(s) blocked by #$ISSUE_NUM:"
	for blocked_num in $all_blocked; do
		blocked_title=$(gh issue view "$blocked_num" --json title --jq '.title' 2>/dev/null)
		echo "   - #$blocked_num: $blocked_title"
	done
	echo ""
else
	echo "📋 No issues are blocked by #$ISSUE_NUM"
	echo ""
fi

if [ "$DRY_RUN" = true ]; then
	echo "🔍 DRY RUN - Would perform:"
	if [ "$issue_state" != "CLOSED" ]; then
		echo "   1. Close issue #$ISSUE_NUM"
	fi
	if [ "$blocked_count" -gt 0 ]; then
		echo "   2. Unblock $blocked_count issue(s): $all_blocked"
	fi
	exit 0
fi

# Close the issue if not already closed
if [ "$issue_state" != "CLOSED" ]; then
	echo "📝 Closing issue #$ISSUE_NUM..."
	gh issue close "$ISSUE_NUM"

	# Add completion comment
	gh issue comment "$ISSUE_NUM" --body "✅ **Completed**

This issue has been closed. Any issues that were blocked by this one have been automatically unblocked."
fi

# Always remove S-InProgress label from the completed issue
echo "📝 Removing S-InProgress label from #$ISSUE_NUM..."
gh issue edit "$ISSUE_NUM" --remove-label "S-InProgress" 2>/dev/null || true

# Unblock dependent issues
if [ "$blocked_count" -gt 0 ]; then
	echo ""
	echo "🔓 Unblocking dependent issues..."

	for blocked_num in $all_blocked; do
		echo "   Unblocking #$blocked_num..."

		remaining_open_blockers=$(gh_issue_open_blockers "$blocked_num")
		if [ -z "$remaining_open_blockers" ]; then
			# Remove S-Blocked and add S-Ready
			gh issue edit "$blocked_num" --remove-label "S-Blocked" 2>/dev/null || true
			gh issue edit "$blocked_num" --add-label "S-Ready" 2>/dev/null || true

			# Add unblock comment
			gh issue comment "$blocked_num" --body "🔓 **Unblocked**

Blocker #$ISSUE_NUM has been completed. This issue is now ready to work on."

			echo "      ✅ Unblocked #$blocked_num"
		else
			while IFS= read -r blocker; do
				[ -z "$blocker" ] && continue
				echo "      ⚠️  Still blocked by #$blocker (open)"
			done <<<"$remaining_open_blockers"
			echo "      ℹ️  #$blocked_num has other open blockers, keeping S-Blocked"
		fi
	done
fi

echo ""
echo "✅ Completed issue #$ISSUE_NUM: $issue_title"
if [ "$blocked_count" -gt 0 ]; then
	echo "🔓 Processed $blocked_count dependent issue(s)"
fi
echo "🧹 If this issue absorbed work from closed same-repo PRs via squash merge, reconcile any stale head branches with:"
echo "   ./scripts/gh-pr-reconcile-superseded.sh <merged_pr> <closed_pr> [<closed_pr> ...]"

# Check for next available issue using priority order (same logic as gh-priority-order.sh)
echo ""
echo "🔍 Checking for next issue (by priority order)..."

# Get all open issues and sort by priority (same logic as gh-priority-order.sh)
queue_json=$("$SCRIPT_DIR/gh-priority-order.sh" --json)

top_ready=$(echo "$queue_json" | jq -r '
  map(select(.effective_status == "S-Ready"))
  | .[0:3]
  | .[]
  | "#\(.number): \(.title) [\(.priority)]"
')

if [ -n "$top_ready" ]; then
	# Get the first issue number for the command examples
	first_num=$(echo "$top_ready" | head -1 | grep -oE '#[0-9]+' | head -1 | tr -d '#')
	echo ""
	echo "═══════════════════════════════════════════════════════════════════════════════"
	echo "🚨 AGENT CONTINUATION REQUIRED — YOUR WORK IS NOT DONE"
	echo "═══════════════════════════════════════════════════════════════════════════════"
	echo ""
	echo "Top S-Ready issues (by priority):"
	echo "$top_ready" | while read -r line; do
		echo "   $line"
	done
	echo ""
	echo "You MUST continue with the following steps:"
	echo ""
	echo "1. Start the next issue:"
	echo "   ./scripts/gh-issue-start.sh $first_num"
	echo ""
	echo "2. Read the issue details:"
	echo "   ./scripts/gh-issue-view.sh $first_num"
	echo ""
	echo "3. Create todos for the new issue using todowrite()"
	echo ""
	echo "4. Continue working until all issues are complete"
	echo ""
	echo "DO NOT STOP. DO NOT ASK FOR PERMISSION. CONTINUE WORKING."
	echo "═══════════════════════════════════════════════════════════════════════════════"
else
	echo ""
	echo "═══════════════════════════════════════════════════════════════════════════════"
	echo "✅ ALL DONE — No more S-Ready issues available"
	echo "═══════════════════════════════════════════════════════════════════════════════"
	echo ""
	echo "All available issues are either completed or blocked."
	echo "You may now stop and report your progress to the user."
	echo ""
	echo "To see full status: ./scripts/gh-priority-order.sh"
fi
