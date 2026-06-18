#!/usr/bin/env bash
# shellcheck disable=SC2034,SC2129
set -euo pipefail

#
# GitHub Issues Cache Script
#
# Fetches and caches GitHub issues for Codex offline access:
# 1. List of all open issues -> .issue-cache/issues-list.json
# 2. Detailed markdown files for high priority issues -> .issue-cache/*.md
#
# This allows Codex agents to work with current project state without internet access.
#

# Default to local cache, but use home directory if not in git repo
if git rev-parse --git-dir >/dev/null 2>&1; then
	CACHE_DIR=".issue-cache"
else
	CACHE_DIR="$HOME/.ai-ws-finetune-cache"
	echo "📁 Not in git repository - using home directory cache: $CACHE_DIR"
fi

ISSUES_LIST="${CACHE_DIR}/issues-list.json"
HIGH_PRI_LABELS="P1-Critical,P2-High"
# Hardcode repository for Codex environments without git context
REPO_OWNER="ZarK"
REPO_NAME="ai-ws-finetune"

echo "🗂️  GitHub Issues Cache - Fetching current project state for Codex"
echo "📂 Repository: ${REPO_OWNER}/${REPO_NAME}"
echo "📁 Cache location: ${CACHE_DIR}"

# Create/clean cache directory
if [ -d "$CACHE_DIR" ]; then
	echo "🧹 Cleaning existing cache..."
	rm -rf "$CACHE_DIR"
fi
mkdir -p "$CACHE_DIR"

# Check if gh CLI is available
if ! command -v gh >/dev/null 2>&1; then
	echo "❌ GitHub CLI (gh) not found. Please install: https://cli.github.com/"
	exit 1
fi

# Check authentication (supports both interactive login and GH_TOKEN)
if ! gh auth status >/dev/null 2>&1; then
	if [ -z "${GH_TOKEN:-}" ]; then
		echo "❌ Not authenticated with GitHub."
		echo "   For interactive use: gh auth login"
		echo "   For Codex/automation: Set GH_TOKEN environment variable"
		echo "   Example: export GH_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx"
		exit 1
	else
		echo "🔑 Using GH_TOKEN environment variable for authentication"
	fi
else
	echo "🔑 Using stored GitHub CLI credentials"
fi

echo "📋 Fetching all open issues..."

# Fetch all open issues with labels and save as JSON (with hardcoded repo)
gh issue list \
	--repo "${REPO_OWNER}/${REPO_NAME}" \
	--state open \
	--limit 1000 \
	--json number,title,labels,assignees,createdAt,updatedAt,url \
	>"$ISSUES_LIST"

echo "✅ Cached $(jq length "$ISSUES_LIST") open issues to $ISSUES_LIST"

echo "📄 Fetching detailed content for high priority issues..."

# Get high priority issue numbers
HIGH_PRI_ISSUES=$(jq -r "
    .[] | 
    select(.labels[]?.name | IN(\"P1-Critical\", \"P2-High\")) | 
    .number
" "$ISSUES_LIST")

if [ -z "$HIGH_PRI_ISSUES" ]; then
	echo "ℹ️  No high priority issues found"
else
	echo "🎯 Found high priority issues: $(echo "$HIGH_PRI_ISSUES" | tr '\n' ' ')"

	# Fetch detailed content for each high priority issue
	for issue_num in $HIGH_PRI_ISSUES; do
		echo "   📄 Caching issue #$issue_num..."

		# Get issue details including body (with hardcoded repo)
		issue_data=$(gh issue view "$issue_num" --repo "${REPO_OWNER}/${REPO_NAME}" --json number,title,body,labels,assignees,createdAt,updatedAt,url)

		# Extract data for markdown
		title=$(echo "$issue_data" | jq -r '.title')
		body=$(echo "$issue_data" | jq -r '.body // ""')
		labels=$(echo "$issue_data" | jq -r '.labels[]?.name' | tr '\n' ', ' | sed 's/,$//')
		assignees=$(echo "$issue_data" | jq -r '.assignees[]?.login' | tr '\n' ', ' | sed 's/,$//')
		created=$(echo "$issue_data" | jq -r '.createdAt')
		updated=$(echo "$issue_data" | jq -r '.updatedAt')
		url=$(echo "$issue_data" | jq -r '.url')

		# Create markdown file
		cat >"${CACHE_DIR}/issue-${issue_num}.md" <<EOF
# Issue #${issue_num}: ${title}

**URL:** ${url}  
**Created:** ${created}  
**Updated:** ${updated}  
**Labels:** ${labels}  
**Assignees:** ${assignees}

## Description

${body}

---
*Cached: $(date -u +"%Y-%m-%d %H:%M:%S UTC")*
EOF
	done
fi

echo "📊 Creating issue summary for Codex..."

# Create a summary file for Codex
cat >"${CACHE_DIR}/README.md" <<EOF
# GitHub Issues Cache

This folder contains cached GitHub issues for offline Codex access.

**Generated:** $(date -u +"%Y-%m-%d %H:%M:%S UTC")

## Files

- \`issues-list.json\` - Complete list of all open issues with metadata
- \`issue-*.md\` - Detailed content for high priority (P1-Critical, P2-High) issues

## Issue Counts by Priority

EOF

# Add issue counts by priority
echo "### All Open Issues" >>"${CACHE_DIR}/README.md"
jq -r '
group_by(.labels[]?.name | select(startswith("P"))) | 
map({
    priority: (.[0].labels[]?.name | select(startswith("P"))), 
    count: length
}) | 
sort_by(.priority) | 
.[] | 
"- **\(.priority // "No Priority")**: \(.count) issues"
' "$ISSUES_LIST" >>"${CACHE_DIR}/README.md"

# Add critical path issues
echo -e "\n### Critical Path (P1-Critical)" >>"${CACHE_DIR}/README.md"
jq -r '
.[] | 
select(.labels[]?.name == "P1-Critical") | 
"- [#\(.number)](\(.url)) - \(.title)"
' "$ISSUES_LIST" >>"${CACHE_DIR}/README.md"

echo -e "\n### High Priority (P2-High)" >>"${CACHE_DIR}/README.md"
jq -r '
.[] | 
select(.labels[]?.name == "P2-High") | 
"- [#\(.number)](\(.url)) - \(.title)"
' "$ISSUES_LIST" >>"${CACHE_DIR}/README.md"

# Add epic organization
echo -e "\n### By Epic" >>"${CACHE_DIR}/README.md"
jq -r '
group_by(.labels[]?.name | select(startswith("Epic-"))) | 
map(select(length > 0)) | 
sort_by(.[0].labels[]?.name | select(startswith("Epic-"))) | 
.[] | 
"#### " + (.[0].labels[]?.name | select(startswith("Epic-"))) + "\n" + 
(map("- [#\(.number)](\(.url)) - \(.title)") | join("\n"))
' "$ISSUES_LIST" >>"${CACHE_DIR}/README.md"

echo "✅ Issues cache complete!"
echo ""
echo "📁 Cache contents:"
echo "   📄 $(wc -l <"$ISSUES_LIST") issues in issues-list.json"
echo "   📄 $(find "$CACHE_DIR" -name "issue-*.md" | wc -l) detailed issue files"
echo "   📄 Summary available in ${CACHE_DIR}/README.md"
echo ""
echo "🤖 Codex agents can now work offline with current project state"
