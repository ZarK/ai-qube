#!/usr/bin/env bash
set -euo pipefail

usage() {
	cat <<'EOF'
Usage:
  ./scripts/print-permissions.sh <agent-name>
  ./scripts/print-permissions.sh --list
  ./scripts/print-permissions.sh --self-test

Examples:
  ./scripts/print-permissions.sh implementer
  ./scripts/print-permissions.sh qa-agent

This prints the YAML frontmatter "tools" and "permission" sections from:
  <repo>/.opencode/agent/<agent-name>.md
EOF
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
agent_dir="$repo_root/.opencode/agent"

if [[ ! -d "$agent_dir" ]]; then
	echo "ERROR: Agent directory not found: $agent_dir" >&2
	exit 2
fi

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
	usage
	exit 0
fi

if [[ "${1:-}" == "--list" || "${1:-}" == "-l" ]]; then
	find "$agent_dir" -maxdepth 1 -type f -name '*.md' -print | sed -n 's|.*/||; s/\.md$//p' | sort
	exit 0
fi

if [[ "${1:-}" == "--self-test" ]]; then
	failed=0
	while IFS= read -r agent; do
		if ! "$0" "$agent" >/dev/null; then
			echo "FAIL: $agent" >&2
			failed=1
		fi
	done < <("$0" --list)

	if [[ "$failed" == "0" ]]; then
		echo "OK"
		exit 0
	fi

	exit 1
fi

agent_raw="${1:-}"
if [[ -z "$agent_raw" ]]; then
	usage >&2
	echo >&2
	echo "Available agents:" >&2
	find "$agent_dir" -maxdepth 1 -type f -name '*.md' -print | sed -n 's|.*/||; s/\.md$//p' | sort >&2
	exit 2
fi

agent_name="$agent_raw"
agent_name="${agent_name#@}"
agent_name="${agent_name%.md}"

agent_file="$agent_dir/$agent_name.md"
if [[ ! -f "$agent_file" ]]; then
	alt_name="${agent_name//_/-}"
	if [[ "$alt_name" != "$agent_name" && -f "$agent_dir/$alt_name.md" ]]; then
		agent_name="$alt_name"
		agent_file="$agent_dir/$agent_name.md"
	fi
fi

if [[ ! -f "$agent_file" ]]; then
	echo "ERROR: Agent file not found for '$agent_raw'" >&2
	echo "Looked for: $agent_file" >&2
	echo >&2
	echo "Available agents:" >&2
	find "$agent_dir" -maxdepth 1 -type f -name '*.md' -print | sed -n 's|.*/||; s/\.md$//p' | sort >&2
	exit 2
fi

frontmatter="$(
	awk '
    NR==1 && $0=="---" { in_block=1; next }
    in_block && $0=="---" { exit }
    in_block { print }
  ' "$agent_file"
)"

if [[ -z "$frontmatter" ]]; then
	echo "ERROR: No YAML frontmatter found in: $agent_file" >&2
	exit 3
fi

print_section() {
	local key="$1"

	awk -v key="$key" '
    BEGIN { in_section=0 }
    $0 ~ "^" key ":" {
      in_section=1
      found=1
      print
      next
    }
    in_section {
      if ($0 ~ "^[^[:space:]]" && $0 !~ "^" key ":") exit
      print
    }
    END {
      if (!found) exit 10
    }
  ' <<<"$frontmatter"
}

echo "Agent: $agent_name"
echo "File:  $agent_file"
echo

echo "--- tools ---"
if ! print_section "tools"; then
	echo "tools: (not specified)"
fi

echo

echo "--- bash permission ---"
if ! awk '
  BEGIN { in_permission=0; in_bash=0 }
  /^permission:/ { in_permission=1; next }
  in_permission {
    if (!in_bash && /^[[:space:]]+bash:/) { in_bash=1; print "permission:"; print "  bash:"; next }
    if (!in_bash) next

    # Stop when leaving the bash block (next key at same or lower indent)
    if (/^[[:space:]]{2}[^[:space:]]/ && $0 !~ /^[[:space:]]{2}bash:/) exit
    if (/^[^[:space:]]/) exit

    # Print entries under bash:
    if (/^[[:space:]]{4}/) print
  }
' <<<"$frontmatter"; then
	printf '%s\n' "permission:" "  bash: (not specified)"
fi
