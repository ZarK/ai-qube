#!/usr/bin/env bash
set -euo pipefail

# Ensure the core priority/status labels required by the queue scripts exist.

labels=(
  "P1-Critical|b60205|Critical priority, blocks other work"
  "P2-High|d93f0b|High priority, next release"
  "P3-Medium|fbca04|Medium priority, upcoming work"
  "P4-Low|0e8a16|Low priority, future work"
  "S-Ready|0e8a16|Ready to work on"
  "S-InProgress|1d76db|Currently being worked"
  "S-Blocked|5319e7|Blocked by open dependencies"
  "S-Blocking|b60205|Blocks other work"
)

existing_labels="$(gh label list --limit 200 --json name --jq '.[].name' 2>/dev/null || true)"

if [ -z "$existing_labels" ]; then
  echo "⚠️  Could not read existing labels with gh. Ensure gh is authenticated and the current directory points at the target repository."
fi

for entry in "${labels[@]}"; do
  IFS='|' read -r name color description <<<"$entry"
  if printf '%s\n' "$existing_labels" | grep -Fxq "$name"; then
    echo "✓ $name"
    continue
  fi

  gh label create "$name" --color "$color" --description "$description"
  echo "+ $name"
done
