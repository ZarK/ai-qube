#!/bin/bash

# Quick label management script for GitHub issues

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "$SCRIPT_DIR/lib/gh-issue-helpers.sh"

PRIORITY_LABELS="P1-Critical,P2-High,P3-Medium,P4-Low"
STATUS_LABELS="S-Ready,S-InProgress,S-Blocked,S-Blocking"
COMPONENT_LABELS="C-Backend,C-Electron,C-Frontend,C-Pipeline,C-Database,C-Testing"

set_status_label() {
	local issue_num="$1"
	local status_label="$2"
	gh issue edit "$issue_num" --remove-label "$STATUS_LABELS" 2>/dev/null || true
	gh issue edit "$issue_num" --add-label "$status_label"
}

sync_status_from_blockers() {
	local issue_num="$1"
	local labels
	labels=$(gh issue view "$issue_num" --json labels --jq '.labels[].name' 2>/dev/null | tr '\n' ',' || true)

	if echo "$labels" | grep -q "S-InProgress"; then
		echo "ℹ️  Issue #$issue_num is in progress; leaving status unchanged"
		return 0
	fi

	local open_blockers
	open_blockers=$(gh_issue_open_blockers "$issue_num")
	if [ -n "$open_blockers" ]; then
		set_status_label "$issue_num" "S-Blocked"
		echo "🚫 Issue #$issue_num is blocked by: $(echo "$open_blockers" | tr '\n' ' ' | sed 's/ *$//')"
	else
		set_status_label "$issue_num" "S-Ready"
		echo "✅ Issue #$issue_num is ready"
	fi
}

rewrite_issue_body_blockers() {
	local issue_num="$1"
	local action="$2"
	local blocker_num="${3:-}"
	local tmp_body

	tmp_body=$(mktemp)
	python3 - "$issue_num" "$action" "$blocker_num" "$tmp_body" <<'PY'
import json
import pathlib
import re
import subprocess
import sys

issue_num, action, blocker_num, output_path = sys.argv[1:]
body = json.loads(subprocess.check_output(["gh", "issue", "view", issue_num, "--json", "body"]).decode())["body"] or ""
lines = body.splitlines()

blocker_pattern = re.compile(r"^\s*-?\s*Blocked by:\s*#(\d+)\s*$", re.IGNORECASE)
blocker_lines = []
remaining_lines = []

for line in lines:
    if blocker_pattern.match(line):
        blocker_lines.append(f"Blocked by: #{blocker_pattern.match(line).group(1)}")
    else:
        remaining_lines.append(line)

existing = set(blocker_lines)
line = f"Blocked by: #{blocker_num}" if blocker_num else None

if action == "add" and line and line not in existing:
    blocker_lines.append(line)
elif action == "remove" and line:
    blocker_lines = [item for item in blocker_lines if item != line]

new_lines = blocker_lines + remaining_lines
text = "\n".join(new_lines)
if body.endswith("\n") or not body:
    text += "\n"
pathlib.Path(output_path).write_text(text, encoding="utf-8")
PY

	gh issue edit "$issue_num" --body-file "$tmp_body" >/dev/null
	rm -f "$tmp_body"
}

write_issue_sequence() {
	local issue_num="$1"
	local value="$2"
	local tmp_body

	tmp_body=$(mktemp)
	if ! python3 - "$issue_num" "$value" "$tmp_body" <<'PY'
import json
import pathlib
import re
import subprocess
import sys

issue_num, value, output_path = sys.argv[1:]
body = json.loads(subprocess.check_output(["gh", "issue", "view", issue_num, "--json", "body"]).decode())["body"] or ""
lines = body.splitlines()
sequence_pattern = re.compile(r"^\s*Sequence:\s*M?\d+(?:\.\d+){0,3}\s*$", re.IGNORECASE)
remaining_lines = [line for line in lines if not sequence_pattern.match(line)]

if value.lower() == "none":
    sequence_line = None
elif re.fullmatch(r"M?\d+(?:\.\d+){0,3}", value):
    sequence_line = f"Sequence: {value.lstrip('M')}"
else:
    raise SystemExit("INVALID_SEQUENCE")

new_lines = remaining_lines
if sequence_line:
    new_lines = [sequence_line] + new_lines

text = "\n".join(new_lines)
if body.endswith("\n") or not body:
    text += "\n"
pathlib.Path(output_path).write_text(text, encoding="utf-8")
PY
	then
		rm -f "$tmp_body"
		echo "❌ Invalid sequence. Use M34.6.1, 34.6.1, 34.6.1.4000, 0.0.0.0, or none"
		exit 1
	fi
	gh issue edit "$issue_num" --body-file "$tmp_body" >/dev/null
	rm -f "$tmp_body"
}

shift_sequence_relative_to_issue() {
	local direction="$1"
	local issue_num="$2"
	local target_issue="$3"
	local target_key
	local new_sequence

	target_key=$(gh_issue_sequence_key "$target_issue")
	new_sequence=$(TARGET_KEY="$target_key" DIRECTION="$direction" python3 - <<'PY'
import os

parts = [int(part) for part in os.environ["TARGET_KEY"].split(".")]
direction = os.environ["DIRECTION"]
step = 1000

parts = (parts + [5000, 5000, 5000, 5000])[:4]
if direction == "before":
    parts[3] = max(0, parts[3] - step)
else:
    parts[3] = parts[3] + step

print(".".join(str(part) for part in parts))
PY
)

	write_issue_sequence "$issue_num" "$new_sequence"
	echo "✅ Set issue #$issue_num to run $direction issue #$target_issue (Sequence: $new_sequence)"
}

if [ $# -eq 0 ]; then
	echo "Usage: $0 <issue_number> [action]"
	echo ""
	echo "Actions:"
	echo "  priority <P1-Critical|P2-High|P3-Medium|P4-Low>"
	echo "  status <S-Ready|S-InProgress|S-Blocked|S-Blocking>"
	echo "  component <C-Backend|C-Electron|C-Frontend|C-Pipeline|C-Database|C-Testing>"
	echo "  sequence <M34.6.1|34.6.1|34.6.1.4000|0.0.0.0|none>  - Set or clear explicit queue ordering metadata"
	echo "  before <issue_number>             - Run this issue before the target issue"
	echo "  after <issue_number>              - Run this issue after the target issue"
	echo "  first                             - Put this issue ahead of all other same-priority work"
	echo "  ready      - Mark as ready to work on"
	echo "  start      - Mark as in progress"
	echo "  block      - Mark as blocked"
	echo "  unblock    - Remove blocked status"
	echo "  sync       - Recompute ready/blocked from live blockers"
	echo "  blockers   - List direct blockers from the issue body"
	echo "  add-blocker <issue_number>     - Add a Blocked by line"
	echo "  remove-blocker <issue_number>  - Remove a Blocked by line"
	echo ""
	echo "Examples:"
	echo "  $0 14 priority P2-High"
	echo "  $0 14 status S-Ready"
	echo "  $0 14 ready"
	echo "  $0 14 start"
	exit 1
fi

ISSUE_NUM=$1
ACTION=${2:-}
VALUE=${3:-}
VALUE_LOWER=$(printf '%s' "$VALUE" | tr '[:upper:]' '[:lower:]')

case $ACTION in
"priority")
	if [[ "$VALUE" =~ ^P[1-4]-(Critical|High|Medium|Low)$ ]]; then
		# Remove existing priority labels
		gh issue edit "$ISSUE_NUM" --remove-label "$PRIORITY_LABELS" 2>/dev/null
		gh issue edit "$ISSUE_NUM" --add-label "$VALUE"
		echo "✅ Set issue #$ISSUE_NUM priority to $VALUE"
	else
		echo "❌ Invalid priority. Use P1-Critical, P2-High, P3-Medium, or P4-Low"
	fi
	;;
"status")
	if [[ "$VALUE" =~ ^S-(Ready|InProgress|Blocked|Blocking)$ ]]; then
		# Remove existing status labels
		gh issue edit "$ISSUE_NUM" --remove-label "$STATUS_LABELS" 2>/dev/null
		gh issue edit "$ISSUE_NUM" --add-label "$VALUE"
		echo "✅ Set issue #$ISSUE_NUM status to $VALUE"
	else
		echo "❌ Invalid status. Use S-Ready, S-InProgress, S-Blocked, or S-Blocking"
	fi
	;;
"component")
	if [[ "$VALUE" =~ ^C-(Backend|Electron|Frontend|Pipeline|Database|Testing)$ ]]; then
		# Remove existing component labels
		gh issue edit "$ISSUE_NUM" --remove-label "$COMPONENT_LABELS" 2>/dev/null
		gh issue edit "$ISSUE_NUM" --add-label "$VALUE"
		echo "✅ Set issue #$ISSUE_NUM component to $VALUE"
	else
		echo "❌ Invalid component. Use C-Backend, C-Electron, C-Frontend, C-Pipeline, C-Database, or C-Testing"
	fi
	;;
"sequence")
	write_issue_sequence "$ISSUE_NUM" "$VALUE"
	if [ "$VALUE_LOWER" = "none" ]; then
		echo "✅ Cleared explicit sequence metadata on issue #$ISSUE_NUM"
	else
		echo "✅ Set explicit sequence on issue #$ISSUE_NUM to ${VALUE#M}"
	fi
	;;
"before")
	if [[ ! "$VALUE" =~ ^[0-9]+$ ]]; then
		echo "❌ before requires a target issue number"
		exit 1
	fi
	shift_sequence_relative_to_issue before "$ISSUE_NUM" "$VALUE"
	;;
"after")
	if [[ ! "$VALUE" =~ ^[0-9]+$ ]]; then
		echo "❌ after requires a target issue number"
		exit 1
	fi
	shift_sequence_relative_to_issue after "$ISSUE_NUM" "$VALUE"
	;;
"first")
	write_issue_sequence "$ISSUE_NUM" "0.0.0.0"
	echo "✅ Set issue #$ISSUE_NUM to the front of the queue (Sequence: 0.0.0.0)"
	;;
"ready")
	sync_status_from_blockers "$ISSUE_NUM"
	;;
"start")
	gh issue edit "$ISSUE_NUM" --remove-label "S-Ready,S-Blocked" 2>/dev/null
	gh issue edit "$ISSUE_NUM" --add-label "S-InProgress"
	echo "✅ Started work on issue #$ISSUE_NUM"
	;;
"block")
	gh issue edit "$ISSUE_NUM" --remove-label "S-Ready,S-InProgress" 2>/dev/null
	gh issue edit "$ISSUE_NUM" --add-label "S-Blocked"
	echo "🚫 Marked issue #$ISSUE_NUM as blocked"
	;;
"unblock")
	sync_status_from_blockers "$ISSUE_NUM"
	;;
"sync")
	sync_status_from_blockers "$ISSUE_NUM"
	;;
"blockers")
	blockers=$(gh_issue_blockers "$ISSUE_NUM")
	if [ -z "$blockers" ]; then
		echo "No direct blockers recorded for issue #$ISSUE_NUM"
	else
		echo "Direct blockers for issue #$ISSUE_NUM:"
		while IFS= read -r blocker; do
			[ -z "$blocker" ] && continue
			echo "  - #$blocker"
		done <<<"$blockers"
	fi
	;;
"add-blocker")
	if [[ ! "$VALUE" =~ ^[0-9]+$ ]]; then
		echo "❌ add-blocker requires an issue number"
		exit 1
	fi
	rewrite_issue_body_blockers "$ISSUE_NUM" add "$VALUE"
	echo "✅ Added blocker #$VALUE to issue #$ISSUE_NUM"
	sync_status_from_blockers "$ISSUE_NUM"
	;;
"remove-blocker")
	if [[ ! "$VALUE" =~ ^[0-9]+$ ]]; then
		echo "❌ remove-blocker requires an issue number"
		exit 1
	fi
	rewrite_issue_body_blockers "$ISSUE_NUM" remove "$VALUE"
	echo "✅ Removed blocker #$VALUE from issue #$ISSUE_NUM"
	sync_status_from_blockers "$ISSUE_NUM"
	;;
*)
	echo "❌ Unknown action: $ACTION"
	echo "Run '$0' with no arguments to see usage"
	;;
esac
