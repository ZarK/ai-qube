#!/bin/bash

# Show and manage dependencies between GitHub issues.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "$SCRIPT_DIR/lib/gh-issue-helpers.sh"

show_usage() {
	echo "Usage: $0 <command> [issue_number] [--dry-run]"
	echo ""
	echo "Commands:"
	echo "  blockers <N>     Show direct blockers for issue #N"
	echo "  blocking <N>     Show open issues blocked by issue #N"
	echo "  chain <N>        Show the dependency chain for #N"
	echo "  all              Show all open blocked issues and their blockers"
	echo "  ready            Show ready issues in actual queue order"
	echo "  fix [--dry-run]  Sync stale S-Ready/S-Blocked labels to the blocker graph"
	echo ""
	echo "Examples:"
	echo "  $0 blockers 85"
	echo "  $0 blocking 79"
	echo "  $0 chain 94"
	echo "  $0 ready"
	echo "  $0 fix --dry-run"
	exit 1
}

if [ $# -eq 0 ]; then
	show_usage
fi

COMMAND="${1:-}"
ISSUE_NUM="${2:-}"
DRY_RUN=false

for arg in "$@"; do
	if [ "$arg" = "--dry-run" ]; then
		DRY_RUN=true
	fi
done

show_issue_header() {
	local issue_num="$1"
	local issue_data
	issue_data=$(gh issue view "$issue_num" --json number,title,state --jq '"#\(.number): \(.title) [\(.state)]"' 2>/dev/null)
	echo "$issue_data"
}

case "$COMMAND" in
"blockers")
	if [ -z "$ISSUE_NUM" ]; then
		echo "❌ Issue number required"
		exit 1
	fi

	echo "🔍 Direct blockers for $(show_issue_header "$ISSUE_NUM")"
	echo ""

	blockers=$(gh_issue_blockers "$ISSUE_NUM")
	open_issue_numbers=$(gh_open_issue_numbers)
	open_blockers=$(gh_issue_open_blockers "$ISSUE_NUM" "$open_issue_numbers" || true)

	if [ -z "$blockers" ]; then
		echo "✅ No direct blockers recorded"
		exit 0
	fi

	while IFS= read -r blocker; do
		[ -z "$blocker" ] && continue
		blocker_data=$(gh issue view "$blocker" --json title,state --jq '{title:.title,state:.state}' 2>/dev/null)
		blocker_title=$(echo "$blocker_data" | jq -r '.title')
		blocker_state=$(echo "$blocker_data" | jq -r '.state')
		if printf '%s\n' "$open_blockers" | grep -qx "$blocker"; then
			echo "  🔴 #$blocker [$blocker_state]: $blocker_title"
		else
			echo "  ✅ #$blocker [$blocker_state]: $blocker_title"
		fi
	done <<<"$blockers"

	echo ""
	if [ -n "$open_blockers" ]; then
		echo "⏳ Waiting on open blockers before this can start."
	else
		echo "💡 All recorded blockers are closed. Run:"
		echo "   ./scripts/gh-update-labels.sh $ISSUE_NUM sync"
	fi
	;;

"blocking")
	if [ -z "$ISSUE_NUM" ]; then
		echo "❌ Issue number required"
		exit 1
	fi

	echo "🔍 Open issues blocked by $(show_issue_header "$ISSUE_NUM")"
	echo ""

	blocked=$(gh_open_issues_blocked_by "$ISSUE_NUM")
	if [ -z "$blocked" ]; then
		echo "✅ No open issues are blocked by #$ISSUE_NUM"
		exit 0
	fi

	count=0
	while IFS= read -r num; do
		[ -z "$num" ] && continue
		echo "  🔒 $(show_issue_header "$num")"
		((count += 1))
	done <<<"$blocked"

	echo ""
	echo "📊 $count open issue(s) directly depend on #$ISSUE_NUM"
	;;

"chain")
	if [ -z "$ISSUE_NUM" ]; then
		echo "❌ Issue number required"
		exit 1
	fi

	echo "🔗 Dependency chain for issue #$ISSUE_NUM"
	echo ""

	show_chain() {
		local issue_num="$1"
		local depth="$2"
		local prefix="$3"

		if [ "$depth" -gt 8 ]; then
			echo "${prefix}… max depth reached"
			return
		fi

		local issue_data
		issue_data=$(gh issue view "$issue_num" --json title,state --jq '{title:.title,state:.state}' 2>/dev/null)
		local title state icon
		title=$(echo "$issue_data" | jq -r '.title')
		state=$(echo "$issue_data" | jq -r '.state')
		icon="🔴"
		if [ "$state" = "CLOSED" ]; then
			icon="✅"
		fi
		echo "${prefix}${icon} #$issue_num: $title [$state]"

		local blockers
		blockers=$(gh_issue_blockers "$issue_num")
		while IFS= read -r blocker; do
			[ -z "$blocker" ] && continue
			show_chain "$blocker" $((depth + 1)) "${prefix}  └─ "
		done <<<"$blockers"
	}

	show_chain "$ISSUE_NUM" 0 ""
	;;

"all")
	echo "📊 Open blocked issues and their open blockers"
	echo ""

	queue_json=$("$SCRIPT_DIR/gh-priority-order.sh" --json)
	echo "$queue_json" | jq -r '
		map(select(.effective_status == "S-Blocked"))
		| .[]
		| "\(.number)|\(.title)|\(.open_blockers | join(", "))"
	' | while IFS='|' read -r number title blockers; do
		echo "  #$number: $title"
		echo "     blocked by: $blockers"
	done
	;;

"ready")
	echo "✅ Issues ready to start (actual queue order)"
	echo ""

	"$SCRIPT_DIR/gh-priority-order.sh" --json | jq -r '
		map(select(.effective_status == "S-Ready"))
		| .[]
		| "  [\(.priority)] #\(.number): \(.title)"
	'
	echo ""
	echo "Start with: ./scripts/gh-issue-start.sh <number>"
	;;

"fix")
	echo "🔧 Syncing stale status labels against the live blocker graph"
	echo ""

	queue_json=$("$SCRIPT_DIR/gh-priority-order.sh" --json)
	mismatches=$(echo "$queue_json" | jq -r '
		map(select(.status_mismatch == true))
		| .[]
		| "\(.number)|\(.label_status)|\(.effective_status)|\(.open_blockers | join(", "))"
	')

	if [ -z "$mismatches" ]; then
		echo "✅ No stale S-Ready/S-Blocked labels found"
		exit 0
	fi

	while IFS='|' read -r number label_status effective_status blockers; do
		[ -z "$number" ] && continue
		echo "  #$number: $label_status -> $effective_status"
		if [ -n "$blockers" ]; then
			echo "     open blockers: $blockers"
		fi
		if [ "$DRY_RUN" = false ]; then
			"$SCRIPT_DIR/gh-update-labels.sh" "$number" sync >/dev/null
		fi
	done <<<"$mismatches"

	if [ "$DRY_RUN" = true ]; then
		echo ""
		echo "Dry run only. Re-run without --dry-run to apply."
	fi
	;;

*)
	echo "❌ Unknown command: $COMMAND"
	show_usage
	;;
esac
