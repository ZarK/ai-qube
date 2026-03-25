#!/usr/bin/env bash
set -euo pipefail

# Ensure the core priority/status labels required by the queue scripts exist.

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/_queue-policy.sh"

labels=(
)

while IFS=$'\t' read -r name color description; do
	labels+=("$name|$color|$description")
done < <(
	jq -r '.priorities[], .statuses[], .components.labels[]? | [.name, .color, .description] | @tsv' "$QUEUE_POLICY_PATH"
)

queue_capture_gh label list --limit 200 --json name --jq '.[].name'
if [ "$QUEUE_LAST_GH_STATUS" -ne 0 ]; then
	queue_fail_gh "Failed to read existing labels from GitHub."
fi
existing_labels="$QUEUE_LAST_GH_OUTPUT"

for entry in "${labels[@]}"; do
	IFS='|' read -r name color description <<<"$entry"
	if printf '%s\n' "$existing_labels" | grep -Fxq "$name"; then
		echo "✓ $name"
		continue
	fi

	gh label create "$name" --color "$color" --description "$description"
	echo "+ $name"
done
