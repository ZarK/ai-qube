#!/bin/bash

# Epic-organized GitHub Issues Priority List
# Displays issues grouped by epic with priority order

echo "🎯 PRIORITY ORDER BY EPIC"
echo "========================="

# Get all open issues with epic information
issues=$(gh issue list --state open --json number,title,labels | jq -r '
  .[] | 
  "\((.labels[]? | select(.name | startswith("Epic-")) | .name) // "No-Epic")|\((.labels[]? | select(.name | startswith("P")) | .name) // "P3-Medium")|\((.labels[]? | select(.name | startswith("S")) | .name) // "S-Ready")|\((.labels[]? | select(.name | startswith("C")) | .name) // "")|\(.number)|\(.title)"
')

# Process by epic
current_epic=""
epic_counter=1

echo "$issues" | sort -t'|' -k2,2 -k1,1 | while IFS='|' read -r epic priority status component number title; do
	# Epic header when epic changes
	if [ "$epic" != "$current_epic" ]; then
		if [ "$current_epic" != "" ]; then
			echo "" # Blank line between epics
		fi

		# Epic header with icon
		case "$epic" in
		"Epic-CVE-Monitoring") echo "🔍 CVE MONITORING & ANALYSIS" ;;
		"Epic-Fast-Training") echo "⚡ FAST TRAINING PIPELINE" ;;
		"Epic-CTF-System") echo "🏆 CTF CHALLENGE SYSTEM" ;;
		"Epic-Dataset-Generation") echo "🏭 DATASET GENERATION" ;;
		"Epic-Demo-Orchestration") echo "🎬 DEMO ORCHESTRATION" ;;
		"Epic-Dashboard") echo "📊 REAL-TIME DASHBOARD" ;;
		"Epic-Integration") echo "🔗 SYSTEM INTEGRATION" ;;
		"Epic-Security-Safety") echo "🛡️ SECURITY & SAFETY" ;;
		"Epic-Performance") echo "⚡ PERFORMANCE & SCALING" ;;
		"Epic-Documentation") echo "📚 DOCUMENTATION" ;;
		"Epic-Planning") echo "🎯 MASTER PLANNING" ;;
		*) echo "📋 OTHER ISSUES" ;;
		esac
		echo "$(printf '%.0s─' {1..40})"

		current_epic="$epic"
		epic_counter=1
	fi

	# Build label display
	labels="[$priority"
	if [ "$component" != "" ]; then
		labels="$labels, $component"
	fi
	labels="$labels, $status]"

	# Format issue line
	echo "  $epic_counter. #$number: $title $labels"
	((epic_counter++))
done

echo ""
echo "Commands:"
echo "  gh issue view <number>                    - View issue details"
echo "  ./scripts/gh-update-labels.sh <number>   - Update issue labels"
echo "  ./scripts/gh-epic-view.sh <command>      - Epic-specific commands"
