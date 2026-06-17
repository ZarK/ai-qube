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

mkdir -p "$TARGET/.bootstrap" "$TARGET/docs/milestones"

if [ ! -f "$TARGET/.bootstrap/discovery-log.md" ]; then
	cp "$TARGET/.agent/templates/bootstrap/discovery-log.md" "$TARGET/.bootstrap/discovery-log.md"
fi

if [ ! -f "$TARGET/.bootstrap/assumptions.md" ]; then
	cp "$TARGET/.agent/templates/bootstrap/assumptions.md" "$TARGET/.bootstrap/assumptions.md"
fi

if [ ! -f "$TARGET/docs/spec.md" ]; then
	cp "$TARGET/.agent/templates/spec/dry-spec.md" "$TARGET/docs/spec.md"
fi

if [ ! -f "$TARGET/.bootstrap/session.yaml" ]; then
	{
		printf 'idea: "%s"\n' "${IDEA//\"/\\\"}"
		printf 'project_name: ""\n'
		printf 'tool: "%s"\n' "$TOOL"
		printf 'profile: "%s"\n' "$PROFILE"
		if [ "${#TECH_ARGS[@]}" -eq 0 ]; then
			printf 'tech: []\n'
		else
			printf 'tech:\n'
			index=1
			while [ "$index" -lt "${#TECH_ARGS[@]}" ]; do
				printf '  - "%s"\n' "${TECH_ARGS[$index]}"
				index=$((index + 2))
			done
		fi
		printf 'name_candidates: []\n'
		printf 'target_users: []\n'
		printf 'platforms: []\n'
		printf 'privacy_requirements: []\n'
		printf 'core_flows: []\n'
		printf 'assumptions: []\n'
		printf 'unresolved_questions: []\n'
		printf 'spec_status: drafting\n'
		printf 'milestone_status: pending\n'
		printf 'issue_status: pending\n'
		printf 'harness_status: pending\n'
	} >"$TARGET/.bootstrap/session.yaml"
fi

printf 'Bootstrapped %s for %s\n' "$TARGET" "$TOOL"
printf 'Next steps:\n'
printf '1. Open the target repo in your agent tool\n'
printf '2. Run /bootstrap with your idea if you have not already\n'
printf '3. Refine docs/spec.md until accepted\n'
printf '4. Generate milestones, issues, and finalize the harness\n'
