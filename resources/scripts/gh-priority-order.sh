#!/bin/bash

# Smart GitHub Issues Priority Ordering
# Creates a clean, dependency-aware prioritized work list

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

show_help() {
	echo "LABELING SYSTEM GUIDE"
	echo "===================="
	echo ""
	echo "Priority Labels (P):"
	echo "  P1-Critical  🔴 Critical priority, blocks other work"
	echo "  P2-High      🟠 High priority, next release"
	echo "  P3-Medium    🟡 Medium priority, upcoming releases"
	echo "  P4-Low       🟢 Low priority, future releases"
	echo ""
	echo "Status Labels (S):"
	echo "  S-Ready      🟢 Ready to work on"
	echo "  S-InProgress 🔵 Currently being worked"
	echo "  S-Blocked    🟣 Blocked by dependencies"
	echo ""
	echo "Component Labels (C):"
	echo "  C-Backend       Backend .NET code"
	echo "  C-Frontend      Frontend React/UI code"
	echo "  C-Electron      Electron shell/IPC"
	echo "  C-Database      SQLite schema/data"
	echo "  C-Pipeline      Import/processing pipeline"
	echo "  C-Testing       Tests and test infrastructure"
	echo ""
	echo "Options:"
	echo "  --json     Emit the normalized issue queue as JSON"
	echo "  --help     Show this help"
	echo ""
	echo "Quick Commands:"
	echo "  ./scripts/gh-issue-start.sh 14           # Start work on issue"
	echo "  ./scripts/gh-issue-complete.sh 14        # Complete issue"
	echo "  ./scripts/gh-update-labels.sh 14 start   # Mark as in progress"
	echo "  ./scripts/gh-update-labels.sh 14 sync    # Recompute ready/blocked from blockers"
	echo "  ./scripts/gh-update-labels.sh 14 before 803  # Insert before a target issue"
	echo "  ./scripts/gh-update-labels.sh 14 first   # Put issue at the front of its priority band"
}

# Show help if requested
if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
	show_help
	exit 0
fi

json_mode=false
if [ "${1:-}" = "--json" ]; then
	json_mode=true
fi

issues_json=$(gh issue list --state open --limit 200 --json number,title,labels,body)

sorted_json=$(ISSUES_JSON="$issues_json" python3 - <<'PY'
import json
import os
import re
import sys

issues = json.loads(os.environ["ISSUES_JSON"])
open_numbers = {issue["number"] for issue in issues}

priority_scores = {
    "P1-Critical": 1,
    "P2-High": 2,
    "P3-Medium": 3,
    "P4-Low": 4,
}
status_scores = {
    "S-Ready": 1,
    "S-InProgress": 2,
    "S-Blocked": 3,
}

blocker_line_re = re.compile(r"^\s*-?\s*Blocked by:", re.IGNORECASE)
task_re = re.compile(r"^M(?P<milestone>\d+)\.(?P<chapter>\d+)\.(?P<task>\d+):")
sequence_re = re.compile(r"^Sequence:\s*M?(?P<nums>\d+(?:\.\d+){0,3})\s*$", re.IGNORECASE | re.MULTILINE)
DEFAULT_RANK = 5000

def normalize_task_key(parts):
    nums = [int(part) for part in parts]
    if len(nums) == 1:
        nums = [nums[0], 0, 0, 0]
    elif len(nums) == 2:
        nums = [nums[0], nums[1], 0, 0]
    elif len(nums) == 3:
        nums = [nums[0], nums[1], nums[2], DEFAULT_RANK]
    elif len(nums) >= 4:
        nums = nums[:4]
    return tuple(nums)

normalized = []

for issue in issues:
    label_names = [label["name"] for label in issue.get("labels", [])]
    priority = next((name for name in label_names if name.startswith("P")), "P3-Medium")
    label_status = next((name for name in label_names if name in {"S-Ready", "S-InProgress", "S-Blocked"}), "S-Ready")
    component = next((name for name in label_names if name.startswith("C-")), "")
    blockers = sorted(
        {
            int(ref)
            for line in (issue.get("body") or "").splitlines()
            if blocker_line_re.match(line)
            for ref in re.findall(r"#(\d+)", line)
        }
    )
    open_blockers = [blocker for blocker in blockers if blocker in open_numbers]

    if label_status == "S-InProgress":
        effective_status = "S-InProgress"
    elif open_blockers:
        effective_status = "S-Blocked"
    else:
        effective_status = "S-Ready"

    sequence_match = sequence_re.search(issue.get("body") or "")
    task_match = task_re.match(issue["title"])
    if sequence_match:
        task_key = normalize_task_key(sequence_match.group("nums").split("."))
        sequence_source = "body"
    elif task_match:
        task_key = normalize_task_key(
            [
                task_match.group("milestone"),
                task_match.group("chapter"),
                task_match.group("task"),
            ]
        )
        sequence_source = "title"
    else:
        task_key = (10**9, 10**9, 10**9, DEFAULT_RANK)
        sequence_source = "none"

    normalized.append(
        {
            "number": issue["number"],
            "title": issue["title"],
            "priority": priority,
            "label_status": label_status,
            "effective_status": effective_status,
            "component": component,
            "priority_score": priority_scores.get(priority, 3),
            "status_score": status_scores.get(effective_status, 2),
            "blockers": blockers,
            "open_blockers": open_blockers,
            "task_key": list(task_key),
            "sequence_source": sequence_source,
            "status_mismatch": label_status != effective_status,
        }
    )

normalized.sort(
    key=lambda issue: (
        issue["priority_score"],
        issue["status_score"],
        issue["task_key"][0],
        issue["task_key"][1],
        issue["task_key"][2],
        issue["number"],
    )
)

json.dump(normalized, sys.stdout)
PY
)

if [ "$json_mode" = true ]; then
	echo "$sorted_json"
	exit 0
fi

echo "🎯 PRIORITY ORDER (Next → Last)"
echo "================================="

# Track state for recommendations
counter=1
next_issue=""
next_title=""
blocked_count=0
ready_count=0
queue_mismatches=0

# Process sorted issues
while IFS= read -r row; do
	[ -z "$row" ] && continue

	priority=$(echo "$row" | jq -r '.priority')
	status=$(echo "$row" | jq -r '.effective_status')
	component=$(echo "$row" | jq -r '.component')
	number=$(echo "$row" | jq -r '.number')
	title=$(echo "$row" | jq -r '.title')
	label_status=$(echo "$row" | jq -r '.label_status')
	open_blockers=$(echo "$row" | jq -r '.open_blockers | join(", ")')
	status_mismatch=$(echo "$row" | jq -r '.status_mismatch')

	# Build label display
	labels="[$priority"
	if [ -n "$component" ]; then
		labels="$labels, $component"
	fi
	labels="$labels, $status]"
	if [ "$status_mismatch" = "true" ]; then
		if [ -n "$open_blockers" ]; then
			labels="$labels {label=$label_status, blockers=$open_blockers}"
		else
			labels="$labels {label=$label_status}"
		fi
		((queue_mismatches++))
	fi

	# Format issue line
	echo "$counter. #$number: $title $labels"

	# Track stats
	if [ "$status" = "S-Blocked" ]; then
		((blocked_count++))
	elif [ "$status" = "S-Ready" ]; then
		((ready_count++))
		# First ready issue becomes recommendation
		if [ -z "$next_issue" ]; then
			next_issue="$number"
			next_title="$title"
		fi
	fi

	((counter++))
done < <(echo "$sorted_json" | jq -c '.[]')

echo ""

# Show in progress first
in_progress=$(echo "$sorted_json" | jq -r '.[] | select(.effective_status == "S-InProgress") | "#\(.number) \(.title)"')
if [ -n "$in_progress" ]; then
	echo "🔄 IN PROGRESS:"
	echo "$in_progress" | while read -r line; do
		echo "   $line"
	done
	echo ""
fi

# Show recommendations
if [ -n "$next_issue" ]; then
	echo "💡 NEXT: #$next_issue — $next_title"
fi

# Show summary
echo ""
echo "📊 Summary: $ready_count ready, $blocked_count blocked"
if [ "$queue_mismatches" -gt 0 ]; then
	echo "⚠️  $queue_mismatches issue(s) have status-label drift relative to their blocker graph"
fi
echo ""
echo "Commands:"
echo "  ./scripts/gh-issue-start.sh <N>    Start work on issue #N"
echo "  ./scripts/gh-issue-view.sh <N>     View issue details"
echo "  ./scripts/gh-priority-order.sh -h  Show labeling guide"
