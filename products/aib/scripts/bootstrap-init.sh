#!/usr/bin/env bash
set -euo pipefail

usage() {
	cat <<'EOF'
Usage: bootstrap-init.sh --tool <opencode|claude|gemini|codex|all> --target <dir> [--idea <text>] [--profile <name>] [--tech <name>]
EOF
}

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOOL=""
TARGET=""
IDEA=""
PROFILE=""
TECH_ARGS=()

while [ "$#" -gt 0 ]; do
	case "$1" in
	--tool)
		TOOL="$2"
		shift 2
		;;
	--target)
		TARGET="$2"
		shift 2
		;;
	--idea)
		IDEA="$2"
		shift 2
		;;
	--profile)
		PROFILE="$2"
		shift 2
		;;
	--tech)
		TECH_ARGS+=("--tech" "$2")
		shift 2
		;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		echo "Unknown argument: $1" >&2
		usage >&2
		exit 1
		;;
	esac
done

if [ -z "$TOOL" ] || [ -z "$TARGET" ]; then
	usage >&2
	exit 1
fi

mkdir -p "$TARGET"

PROJECT_ARGS=(--tool "$TOOL" --target "$TARGET")
if [ -n "$PROFILE" ]; then
	PROJECT_ARGS+=(--profile "$PROFILE")
fi
if [ "${#TECH_ARGS[@]}" -gt 0 ]; then
	PROJECT_ARGS+=("${TECH_ARGS[@]}")
fi

python3 "$REPO_ROOT/scripts/project_assets.py" "${PROJECT_ARGS[@]}"

mkdir -p "$TARGET/.qube/aib" "$TARGET/docs/milestones"

if [ ! -f "$TARGET/.qube/aib/discovery-log.md" ]; then
	cp "$TARGET/.agent/templates/bootstrap/discovery-log.md" "$TARGET/.qube/aib/discovery-log.md"
fi

if [ ! -f "$TARGET/.qube/aib/assumptions.md" ]; then
	cp "$TARGET/.agent/templates/bootstrap/assumptions.md" "$TARGET/.qube/aib/assumptions.md"
fi

if [ ! -f "$TARGET/docs/spec.md" ]; then
	cp "$TARGET/.agent/templates/spec/dry-spec.md" "$TARGET/docs/spec.md"
fi

case "$TOOL" in
claude)
	AGENT_HOST="claude-code"
	;;
codex | opencode | gemini)
	AGENT_HOST="$TOOL"
	;;
*)
	AGENT_HOST="other"
	;;
esac

if [ ! -f "$TARGET/.qube/aib/session.json" ]; then
	AIB_IDEA="$IDEA" AIB_AGENT_HOST="$AGENT_HOST" python3 - "$TARGET/.qube/aib/session.json" <<'PY'
import json
import os
import sys

idea = os.environ.get("AIB_IDEA", "")
agent_host = os.environ.get("AIB_AGENT_HOST", "other")
project = {"intent": idea} if idea else {}
artifacts = {
    "spec": {"path": "docs/spec.md", "status": "missing"},
    "milestones": [],
    "workItems": [],
}
planning = {
    "version": 1,
    "project": project,
    "artifacts": artifacts,
    "milestoneDrafts": [],
    "workItemDrafts": [],
    "providers": [],
    "agentHosts": [],
    "nextAction": {
        "kind": "ask_human",
        "actor": "agent",
        "summary": "Ask the human for product intent and project shape before provider or host details.",
        "questionBudget": 3,
        "stateFields": ["project.intent", "project.type"],
    },
}
state = {
    "version": 1,
    "phase": "discovery",
    "project": project,
    "discovery": {
        "referencePaths": [],
        "inspectCurrentRepo": False,
        "inspectDocs": False,
        "inspectSiblingRepos": False,
        "inspectedSources": [],
        "knownDecisions": [],
        "unresolvedQuestions": [],
    },
    "agent": {"host": agent_host, "questionBudget": 3},
    "spec": {
        "acceptedSectionIds": [],
        "reopenedSectionIds": [],
        "unresolvedGaps": [],
        "revision": 0,
    },
    "assumptions": [],
    "artifacts": artifacts,
    "planning": planning,
}
with open(sys.argv[1], "w", encoding="utf-8") as file:
    json.dump(state, file, indent=2)
    file.write("\n")
PY
fi

printf 'Bootstrapped %s for %s\n' "$TARGET" "$TOOL"
printf 'Next steps:\n'
printf '1. Open the target repo in your agent tool\n'
printf '2. Run /bootstrap with your idea if you have not already\n'
printf '3. Refine docs/spec.md until accepted\n'
printf '4. Generate milestones, issues, and finalize the harness\n'
