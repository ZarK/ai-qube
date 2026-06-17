#!/bin/bash

# Epic-focused GitHub Issues Viewer
# Provides epic-specific views and management commands

if [ $# -eq 0 ]; then
	echo "🎯 EPIC VIEWER - Manage Issues by Epic"
	echo "======================================"
	echo ""
	echo "Usage: $0 <command> [epic_name]"
	echo ""
	echo "Commands:"
	echo "  list                     - List all epics with issue counts"
	echo "  view <epic_name>         - View all issues in specific epic"
	echo "  progress <epic_name>     - Show epic progress summary"
	echo "  critical                 - Show critical path epics (P1)"
	echo "  ready                    - Show ready issues across all epics"
	echo ""
	echo "Epic Names:"
	echo "  cve-monitoring          Epic-CVE-Monitoring"
	echo "  fast-training           Epic-Fast-Training"
	echo "  ctf-system              Epic-CTF-System"
	echo "  dataset-generation      Epic-Dataset-Generation"
	echo "  demo-orchestration      Epic-Demo-Orchestration"
	echo "  dashboard               Epic-Dashboard"
	echo "  integration             Epic-Integration"
	echo "  security-safety         Epic-Security-Safety"
	echo "  performance             Epic-Performance"
	echo "  documentation           Epic-Documentation"
	echo "  planning                Epic-Planning"
	echo ""
	echo "Examples:"
	echo "  $0 list"
	echo "  $0 view fast-training"
	echo "  $0 progress ctf-system"
	echo "  $0 critical"
	exit 1
fi

COMMAND=$1
EPIC_SHORT=$2

# Map short names to full epic labels
case $EPIC_SHORT in
"cve-monitoring") EPIC_LABEL="Epic-CVE-Monitoring" ;;
"fast-training") EPIC_LABEL="Epic-Fast-Training" ;;
"ctf-system") EPIC_LABEL="Epic-CTF-System" ;;
"dataset-generation") EPIC_LABEL="Epic-Dataset-Generation" ;;
"demo-orchestration") EPIC_LABEL="Epic-Demo-Orchestration" ;;
"dashboard") EPIC_LABEL="Epic-Dashboard" ;;
"integration") EPIC_LABEL="Epic-Integration" ;;
"security-safety") EPIC_LABEL="Epic-Security-Safety" ;;
"performance") EPIC_LABEL="Epic-Performance" ;;
"documentation") EPIC_LABEL="Epic-Documentation" ;;
"planning") EPIC_LABEL="Epic-Planning" ;;
*) EPIC_LABEL="$EPIC_SHORT" ;;
esac

case $COMMAND in
"list")
	echo "🎯 ALL EPICS - Issue Count Summary"
	echo "=================================="
	echo ""

	# List each epic with counts
	epics=("Epic-CVE-Monitoring" "Epic-Fast-Training" "Epic-CTF-System" "Epic-Dataset-Generation" "Epic-Demo-Orchestration" "Epic-Dashboard" "Epic-Integration" "Epic-Security-Safety" "Epic-Performance" "Epic-Documentation" "Epic-Planning")
	epic_names=("🔍 CVE Monitoring" "⚡ Fast Training" "🏆 CTF System" "🏭 Dataset Generation" "🎬 Demo Orchestration" "📊 Dashboard" "🔗 Integration" "🛡️ Security & Safety" "⚡ Performance" "📚 Documentation" "🎯 Planning")

	for i in "${!epics[@]}"; do
		epic="${epics[$i]}"
		name="${epic_names[$i]}"

		total=$(gh issue list --label "$epic" --json number | jq '. | length' 2>/dev/null || echo "0")
		open=$(gh issue list --label "$epic" --state open --json number | jq '. | length' 2>/dev/null || echo "0")
		closed=$(gh issue list --label "$epic" --state closed --json number | jq '. | length' 2>/dev/null || echo "0")

		if [ "$total" -gt 0 ]; then
			progress=$((closed * 100 / total))
			printf "%-25s %2d total (%2d open, %2d closed) [%3d%% complete]\n" "$name" "$total" "$open" "$closed" "$progress"
		else
			printf "%-25s  0 total\n" "$name"
		fi
	done
	;;

"view")
	if [ -z "$EPIC_LABEL" ]; then
		echo "❌ Please specify an epic name"
		exit 1
	fi

	echo "🔍 EPIC: $EPIC_LABEL"
	echo "$(printf '%.0s=' {1..50})"
	echo ""

	# Show epic issues with status
	gh issue list --label "$EPIC_LABEL" --json number,title,state,labels | jq -r '
          .[] | 
          .priority = (.labels[]? | select(.name | startswith("P")) | .name) |
          .status = (.labels[]? | select(.name | startswith("S")) | .name) |
          "\(.state | if . == "open" then "🔓" else "✅" end) #\(.number): \(.title) [\(.priority // "P3-Medium"), \(.status // "S-Ready")]"
        '
	;;

"progress")
	if [ -z "$EPIC_LABEL" ]; then
		echo "❌ Please specify an epic name"
		exit 1
	fi

	echo "📊 EPIC PROGRESS: $EPIC_LABEL"
	echo "$(printf '%.0s=' {1..40})"
	echo ""

	# Calculate progress statistics
	total=$(gh issue list --label "$EPIC_LABEL" --json number | jq '. | length')
	open=$(gh issue list --label "$EPIC_LABEL" --state open --json number | jq '. | length')
	closed=$(gh issue list --label "$EPIC_LABEL" --state closed --json number | jq '. | length')

	if [ "$total" -gt 0 ]; then
		progress=$((closed * 100 / total))
		echo "Total Issues: $total"
		echo "Completed: $closed"
		echo "Remaining: $open"
		echo "Progress: $progress%"
		echo ""

		# Show progress bar
		completed_bars=$((progress / 10))
		remaining_bars=$((10 - completed_bars))
		echo -n "Progress: ["
		printf '%.0s█' $(seq 1 $completed_bars)
		printf '%.0s░' $(seq 1 $remaining_bars)
		echo "] $progress%"
		echo ""

		# Show status breakdown
		echo "Status Breakdown:"
		ready=$(gh issue list --label "$EPIC_LABEL" --label "S-Ready" --state open --json number | jq '. | length')
		in_progress=$(gh issue list --label "$EPIC_LABEL" --label "S-InProgress" --state open --json number | jq '. | length')
		blocked=$(gh issue list --label "$EPIC_LABEL" --label "S-Blocked" --state open --json number | jq '. | length')

		echo "  Ready: $ready"
		echo "  In Progress: $in_progress"
		echo "  Blocked: $blocked"
	else
		echo "No issues found for this epic."
	fi
	;;

"critical")
	echo "🔴 CRITICAL PATH EPICS (P1-Critical)"
	echo "===================================="
	echo ""

	# Show P1-Critical epics
	critical_epics=("Epic-CVE-Monitoring" "Epic-Fast-Training" "Epic-CTF-System")
	critical_names=("🔍 CVE Monitoring" "⚡ Fast Training" "🏆 CTF System")

	for i in "${!critical_epics[@]}"; do
		epic="${critical_epics[$i]}"
		name="${critical_names[$i]}"

		total=$(gh issue list --label "$epic" --json number | jq '. | length')
		open=$(gh issue list --label "$epic" --state open --json number | jq '. | length')
		ready=$(gh issue list --label "$epic" --label "S-Ready" --state open --json number | jq '. | length')

		echo "$name"
		echo "  Total: $total | Open: $open | Ready: $ready"

		# Show next ready issue
		next_issue=$(gh issue list --label "$epic" --label "S-Ready" --state open --limit 1 --json number,title | jq -r '.[] | "    Next: #\(.number) - \(.title)"')
		if [ ! -z "$next_issue" ] && [ "$next_issue" != "    Next: # - " ]; then
			echo "$next_issue"
		fi
		echo ""
	done
	;;

"ready")
	echo "🟢 READY TO WORK - All Epics"
	echo "============================"
	echo ""

	# Show ready issues grouped by epic
	gh issue list --label "S-Ready" --state open --json number,title,labels | jq -r '
          .[] | 
          .epic = (.labels[]? | select(.name | startswith("Epic-")) | .name) |
          .priority = (.labels[]? | select(.name | startswith("P")) | .name) |
          "\(.epic // "No-Epic")|\(.priority // "P3-Medium")|\(.number)|\(.title)"
        ' | sort -t'|' -k2,2 -k1,1 |
		{
			current_epic=""
			while IFS='|' read -r epic priority number title; do
				if [ "$epic" != "$current_epic" ]; then
					if [ "$current_epic" != "" ]; then
						echo ""
					fi

					case "$epic" in
					"Epic-CVE-Monitoring") echo "🔍 CVE MONITORING" ;;
					"Epic-Fast-Training") echo "⚡ FAST TRAINING" ;;
					"Epic-CTF-System") echo "🏆 CTF SYSTEM" ;;
					"Epic-Dataset-Generation") echo "🏭 DATASET GENERATION" ;;
					"Epic-Demo-Orchestration") echo "🎬 DEMO ORCHESTRATION" ;;
					"Epic-Dashboard") echo "📊 DASHBOARD" ;;
					"Epic-Integration") echo "🔗 INTEGRATION" ;;
					"Epic-Security-Safety") echo "🛡️ SECURITY & SAFETY" ;;
					"Epic-Performance") echo "⚡ PERFORMANCE" ;;
					"Epic-Documentation") echo "📚 DOCUMENTATION" ;;
					"Epic-Planning") echo "🎯 PLANNING" ;;
					*) echo "📋 OTHER" ;;
					esac
					echo "$(printf '%.0s─' {1..20})"
					current_epic="$epic"
				fi

				echo "  #$number: $title [$priority]"
			done
		}
	;;

*)
	echo "❌ Unknown command: $COMMAND"
	echo "Run '$0' with no arguments to see usage"
	;;
esac
