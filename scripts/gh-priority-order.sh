#!/usr/bin/env bash
set -euo pipefail

# Smart GitHub Issues Priority Ordering
# Creates a clean, dependency-aware prioritized work list

json_mode=false
show_help=false

for arg in "$@"; do
	case "$arg" in
	"--json") json_mode=true ;;
	"--help" | "-h") show_help=true ;;
	esac
done

# Get all open issues with their labels (limit 100 to get all)
issues_data=$(gh issue list --state open --limit 100 --json number,title,labels --jq '
  map({
    number: .number,
    title: .title,
    priority: (.labels | map(select(.name | startswith("P"))) | .[0].name // "P3-Medium"),
    status: (.labels | map(select(.name | startswith("S"))) | .[0].name // "S-Ready"), 
    component: (.labels | map(select(.name | startswith("C"))) | .[0].name // ""),
    labels: [.labels[]?.name]
  })
')

# Function to get priority score for sorting
get_priority_score() {
	local priority="$1"
	local status="$2"
	local base_score
	local status_modifier

	# Base priority scores
	case "$priority" in
	"P1-Critical") base_score=1000 ;;
	"P2-High") base_score=500 ;;
	"P3-Medium") base_score=100 ;;
	"P4-Low") base_score=10 ;;
	*) base_score=50 ;; # Default for unlabeled
	esac

	# Status modifiers
	case "$status" in
	"S-Blocking") status_modifier=200 ;;
	"S-Ready") status_modifier=50 ;;
	"S-InProgress") status_modifier=25 ;;
	"S-Blocked") status_modifier=-100 ;;
	*) status_modifier=0 ;;
	esac

	echo $((base_score + status_modifier))
}

build_ordered_issues_json() {
	while IFS=$'\t' read -r score priority status component number title; do
		jq -nc \
			--argjson score "$score" \
			--arg priority "$priority" \
			--arg status "$status" \
			--arg component "$component" \
			--argjson number "$number" \
			--arg title "$title" \
			'{
				component: (if $component == "__NONE__" then "" else $component end),
				labels: ([$priority] + (if $component == "__NONE__" then [] else [$component] end) + [$status]),
				number: $number,
				priority: $priority,
				score: $score,
				status: $status,
				title: $title
			}'
	done < <(
		while IFS=$'\t' read -r priority status component number title; do
			score=$(get_priority_score "$priority" "$status")
			printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$score" "$priority" "$status" "$component" "$number" "$title"
		done < <(
			echo "$issues_data" | jq -r '.[] | [(.priority // "P3-Medium"), (.status // "S-Ready"), ((.component // "") | if . == "" then "__NONE__" else . end), (.number | tostring), .title] | @tsv'
		) | sort -t$'\t' -k1,1nr -k2,2 -k3,3r -k5,5n
	) | jq -s '.'
}

ordered_issues_json=$(build_ordered_issues_json)
ready_issues_json=$(printf '%s\n' "$ordered_issues_json" | jq '[.[] | select(.status == "S-Ready") | .number]')
blocked_issues_json=$(printf '%s\n' "$ordered_issues_json" | jq '[.[] | select(.status == "S-Blocked") | .number]')
next_issue_json=$(printf '%s\n' "$ordered_issues_json" | jq '([.[] | select(.status != "S-InProgress" and .status != "S-Blocked") | .number] | .[0]) // null')
in_progress_json=$(printf '%s\n' "$ordered_issues_json" | jq '[.[] | select(.status == "S-InProgress") | .number]')

if [ "$json_mode" = true ]; then
	jq -n \
		--argjson blockedIssues "$blocked_issues_json" \
		--argjson inProgress "$in_progress_json" \
		--argjson issues "$ordered_issues_json" \
		--argjson nextIssue "$next_issue_json" \
		--argjson readyIssues "$ready_issues_json" \
		'{
			version: 1,
			issues: $issues,
			readyIssues: $readyIssues,
			nextIssue: $nextIssue,
			blockedIssues: $blockedIssues,
			inProgress: $inProgress
		}'
	exit 0
fi

echo "🎯 PRIORITY ORDER (Next → Last)"
echo "================================="

# Create prioritized list
counter=1

while IFS=$'\t' read -r priority status component number title; do
	if [ "$component" = "__NONE__" ]; then
		component=""
	fi

	labels="[$priority"
	if [ "$component" != "" ]; then
		labels="$labels, $component"
	fi
	labels="$labels, $status]"

	echo "$counter. #$number: $title $labels"
	((counter++))
done < <(
	printf '%s\n' "$ordered_issues_json" | jq -r '.[] | [.priority, .status, ((.component // "") | if . == "" then "__NONE__" else . end), (.number | tostring), .title] | @tsv'
)

echo ""

# Show recommendations
next_issue=$(printf '%s\n' "$next_issue_json" | jq -r 'if . == null then "" else "#\(.)" end')
if [ -n "$next_issue" ]; then
	echo "💡 Next recommended work: $next_issue (ready to start)"
fi

# Show blocked issues
blocked_issues=$(printf '%s\n' "$blocked_issues_json" | jq -r 'map("#\(.)") | join(" ")')
if [ -n "$blocked_issues" ]; then
	echo "🚫 Blocked issues: $blocked_issues (resolve dependencies first)"
fi

# Show in progress
in_progress=$(printf '%s\n' "$in_progress_json" | jq -r 'map("#\(.)") | join(" ")')
if [ -n "$in_progress" ]; then
	echo "🔄 Currently in progress: $in_progress"
fi

echo ""
echo "Commands:"
echo "  gh issue view <number>                    - View issue details"
echo "  ./scripts/gh-update-labels.sh <number>   - Update issue labels"
echo "  ./scripts/gh-priority-order.sh --json    - Show structured queue data"
echo "  ./scripts/gh-priority-order.sh --help    - Show labeling guide"

# Show help if requested
if [ "$show_help" = true ]; then
	echo ""
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
	echo "  S-Blocking   🟣 Blocks other work"
	echo ""
	echo "Component Labels (C):"
	echo "  C-Training      Training/ML model related"
	echo "  C-Dataset       Dataset management"
	echo "  C-Evaluation    Model evaluation"
	echo "  C-Infrastructure Core infrastructure"
	echo ""
	echo "Quick Commands:"
	echo "  ./scripts/gh-update-labels.sh 14 start      # Mark as in progress"
	echo "  ./scripts/gh-update-labels.sh 14 ready      # Mark as ready"
	echo "  ./scripts/gh-update-labels.sh 14 block      # Mark as blocked"
	echo "  ./scripts/gh-priority-order.sh --json       # Print machine-readable queue data"
	echo "  ./scripts/gh-update-labels.sh 14 priority P2-High"
	echo "  ./scripts/gh-update-labels.sh 14 component C-Infrastructure"
fi
