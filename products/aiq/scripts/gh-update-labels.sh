#!/bin/bash
# shellcheck disable=SC2086

# Quick label management script for GitHub issues

if [ $# -eq 0 ]; then
	echo "Usage: $0 <issue_number> [action]"
	echo ""
	echo "Actions:"
	echo "  priority <P1-Critical|P2-High|P3-Medium|P4-Low>"
	echo "  status <S-Ready|S-InProgress|S-Blocked|S-Blocking>"
	echo "  component <C-Training|C-Dataset|C-Evaluation|C-Infrastructure>"
	echo "  epic <Epic-CVE-Monitoring|Epic-Fast-Training|Epic-CTF-System|...>"
	echo "  ready      - Mark as ready to work on"
	echo "  start      - Mark as in progress"
	echo "  block      - Mark as blocked"
	echo "  unblock    - Remove blocked status"
	echo ""
	echo "Examples:"
	echo "  $0 14 priority P2-High"
	echo "  $0 14 status S-Ready"
	echo "  $0 14 epic Epic-Fast-Training"
	echo "  $0 14 ready"
	echo "  $0 14 start"
	exit 1
fi

ISSUE_NUM=$1
ACTION=$2
VALUE=$3

case $ACTION in
"priority")
	if [[ "$VALUE" =~ ^P[1-4]-(Critical|High|Medium|Low)$ ]]; then
		# Remove existing priority labels
		gh issue edit $ISSUE_NUM --remove-label "P1-Critical,P2-High,P3-Medium,P4-Low" 2>/dev/null
		gh issue edit $ISSUE_NUM --add-label "$VALUE"
		echo "✅ Set issue #$ISSUE_NUM priority to $VALUE"
	else
		echo "❌ Invalid priority. Use P1-Critical, P2-High, P3-Medium, or P4-Low"
	fi
	;;
"status")
	if [[ "$VALUE" =~ ^S-(Ready|InProgress|Blocked|Blocking)$ ]]; then
		# Remove existing status labels
		gh issue edit $ISSUE_NUM --remove-label "S-Ready,S-InProgress,S-Blocked,S-Blocking" 2>/dev/null
		gh issue edit $ISSUE_NUM --add-label "$VALUE"
		echo "✅ Set issue #$ISSUE_NUM status to $VALUE"
	else
		echo "❌ Invalid status. Use S-Ready, S-InProgress, S-Blocked, or S-Blocking"
	fi
	;;
"component")
	if [[ "$VALUE" =~ ^C-(Training|Dataset|Evaluation|Infrastructure)$ ]]; then
		# Remove existing component labels
		gh issue edit $ISSUE_NUM --remove-label "C-Training,C-Dataset,C-Evaluation,C-Infrastructure" 2>/dev/null
		gh issue edit $ISSUE_NUM --add-label "$VALUE"
		echo "✅ Set issue #$ISSUE_NUM component to $VALUE"
	else
		echo "❌ Invalid component. Use C-Training, C-Dataset, C-Evaluation, or C-Infrastructure"
	fi
	;;
"epic")
	# Define valid epic labels
	valid_epics="Epic-CVE-Monitoring|Epic-Fast-Training|Epic-CTF-System|Epic-Dataset-Generation|Epic-Demo-Orchestration|Epic-Dashboard|Epic-Integration|Epic-Security-Safety|Epic-Performance|Epic-Documentation|Epic-Planning"

	if [[ "$VALUE" =~ ^Epic-(CVE-Monitoring|Fast-Training|CTF-System|Dataset-Generation|Demo-Orchestration|Dashboard|Integration|Security-Safety|Performance|Documentation|Planning)$ ]]; then
		# Remove existing epic labels
		gh issue edit $ISSUE_NUM --remove-label "$valid_epics" 2>/dev/null
		gh issue edit $ISSUE_NUM --add-label "$VALUE"
		echo "✅ Set issue #$ISSUE_NUM epic to $VALUE"
	else
		echo "❌ Invalid epic. Use one of:"
		echo "  Epic-CVE-Monitoring, Epic-Fast-Training, Epic-CTF-System"
		echo "  Epic-Dataset-Generation, Epic-Demo-Orchestration, Epic-Dashboard"
		echo "  Epic-Integration, Epic-Security-Safety, Epic-Performance"
		echo "  Epic-Documentation, Epic-Planning"
	fi
	;;
"ready")
	gh issue edit $ISSUE_NUM --remove-label "S-Blocked,S-InProgress" 2>/dev/null
	gh issue edit $ISSUE_NUM --add-label "S-Ready"
	echo "✅ Marked issue #$ISSUE_NUM as ready"
	;;
"start")
	gh issue edit $ISSUE_NUM --remove-label "S-Ready,S-Blocked" 2>/dev/null
	gh issue edit $ISSUE_NUM --add-label "S-InProgress"
	echo "✅ Started work on issue #$ISSUE_NUM"
	;;
"block")
	gh issue edit $ISSUE_NUM --remove-label "S-Ready,S-InProgress" 2>/dev/null
	gh issue edit $ISSUE_NUM --add-label "S-Blocked"
	echo "🚫 Marked issue #$ISSUE_NUM as blocked"
	;;
"unblock")
	gh issue edit $ISSUE_NUM --remove-label "S-Blocked" 2>/dev/null
	gh issue edit $ISSUE_NUM --add-label "S-Ready"
	echo "✅ Unblocked issue #$ISSUE_NUM (marked as ready)"
	;;
*)
	echo "❌ Unknown action: $ACTION"
	echo "Run '$0' with no arguments to see usage"
	;;
esac
