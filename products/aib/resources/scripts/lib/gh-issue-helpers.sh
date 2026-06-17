#!/bin/bash

gh_extract_blockers_from_body() {
	local body="${1:-}"

	if [ -z "$body" ]; then
		return 0
	fi

	printf '%s\n' "$body" | awk '
		BEGIN { IGNORECASE = 1 }
		/^[[:space:]]*-?[[:space:]]*Blocked by:/ {
			while (match($0, /#[0-9]+/)) {
				print substr($0, RSTART + 1, RLENGTH - 1)
				$0 = substr($0, RSTART + RLENGTH)
			}
		}
	' | sort -n | uniq
}

gh_issue_body() {
	local issue_num="$1"
	gh issue view "$issue_num" --json body --jq '.body // ""' 2>/dev/null
}

gh_issue_blockers() {
	local issue_num="$1"
	local body
	body=$(gh_issue_body "$issue_num")
	gh_extract_blockers_from_body "$body"
}

gh_open_issue_numbers() {
	gh issue list --state open --limit 500 --json number --jq '.[].number' 2>/dev/null || true
}

gh_issue_open_blockers() {
	local issue_num="$1"
	local open_issue_numbers="${2:-}"
	local blockers

	blockers=$(gh_issue_blockers "$issue_num")
	if [ -z "$blockers" ]; then
		return 0
	fi

	if [ -z "$open_issue_numbers" ]; then
		open_issue_numbers=$(gh_open_issue_numbers)
	fi

	while IFS= read -r blocker; do
		[ -z "$blocker" ] && continue
		if printf '%s\n' "$open_issue_numbers" | grep -qx "$blocker"; then
			echo "$blocker"
		fi
	done <<<"$blockers"
}

gh_issue_has_open_blockers() {
	local issue_num="$1"
	local open_issue_numbers="${2:-}"
	[ -n "$(gh_issue_open_blockers "$issue_num" "$open_issue_numbers")" ]
}

gh_issue_sequence_key() {
	local issue_num="$1"
	local issue_json

	issue_json=$(gh issue view "$issue_num" --json title,body 2>/dev/null || echo '{}')
	ISSUE_JSON="$issue_json" python3 - <<'PY'
import json
import os
import re

issue = json.loads(os.environ["ISSUE_JSON"])
title = issue.get("title") or ""
body = issue.get("body") or ""

sequence_re = re.compile(r"^Sequence:\s*M?(?P<nums>\d+(?:\.\d+){0,3})\s*$", re.IGNORECASE | re.MULTILINE)
task_re = re.compile(r"^M(?P<milestone>\d+)\.(?P<chapter>\d+)\.(?P<task>\d+):")
DEFAULT_RANK = 5000
HUGE = 10**9

def normalize(parts):
    nums = [int(part) for part in parts]
    if len(nums) == 1:
        nums = [nums[0], 0, 0, 0]
    elif len(nums) == 2:
        nums = [nums[0], nums[1], 0, 0]
    elif len(nums) == 3:
        nums = [nums[0], nums[1], nums[2], DEFAULT_RANK]
    elif len(nums) >= 4:
        nums = nums[:4]
    return nums

match = sequence_re.search(body)
if match:
    key = normalize(match.group("nums").split("."))
else:
    match = task_re.match(title)
    if match:
        key = [
            int(match.group("milestone")),
            int(match.group("chapter")),
            int(match.group("task")),
            DEFAULT_RANK,
        ]
    else:
        key = [HUGE, HUGE, HUGE, DEFAULT_RANK]

print(".".join(str(part) for part in key))
PY
}

gh_open_issues_blocked_by() {
	local blocker_num="$1"
	local issues_json

	issues_json=$(gh issue list --state open --limit 500 --json number,body 2>/dev/null || echo "[]")
	ISSUES_JSON="$issues_json" BLOCKER_NUM="$blocker_num" python3 - <<'PY'
import json
import os
import re

issues = json.loads(os.environ["ISSUES_JSON"])
blocker_num = int(os.environ["BLOCKER_NUM"])
pattern = re.compile(r"^\s*-?\s*Blocked by:", re.IGNORECASE)

matches = []
for issue in issues:
    body = issue.get("body") or ""
    blockers = set()
    for line in body.splitlines():
        if not pattern.match(line):
            continue
        for ref in re.findall(r"#(\d+)", line):
            blockers.add(int(ref))
    if blocker_num in blockers:
        matches.append(issue["number"])

for number in sorted(set(matches)):
    print(number)
PY
}
