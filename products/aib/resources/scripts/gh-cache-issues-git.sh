#!/usr/bin/env bash
set -euo pipefail

#
# Git-based Issues Cache Script
#
# Creates a lightweight issue cache using only git commands and local repo data.
# This works for agents who have git access but no GitHub CLI authentication.
#
# Provides:
# 1. Recent commit history with issue references
# 2. Branch information for issue tracking
# 3. Current project status from local files
#

# Default to local cache, but use home directory if not in git repo
if git rev-parse --git-dir >/dev/null 2>&1; then
	CACHE_DIR=".issue-cache"
	IN_GIT_REPO=true
else
	CACHE_DIR="$HOME/.ai-ws-finetune-cache"
	IN_GIT_REPO=false
	echo "📁 Not in git repository - using home directory cache: $CACHE_DIR"
fi

echo "🗂️  Git-based Issues Cache - Creating offline context for agents"

# Create cache directory (don't clean if GitHub CLI cache exists)
mkdir -p "$CACHE_DIR"

# Check if GitHub CLI cache exists
if [ -f "${CACHE_DIR}/issues-list.json" ]; then
	echo "📋 GitHub CLI cache found - adding complementary git-based context..."
	GH_CACHE_EXISTS=true
else
	echo "📁 Creating standalone git-based cache..."
	GH_CACHE_EXISTS=false
fi

# Get current branch and repo info (with fallbacks for non-git environments)
if [ "$IN_GIT_REPO" = true ]; then
	CURRENT_BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
	REPO_URL=$(git remote get-url origin 2>/dev/null || echo "https://github.com/ZarK/ai-ws-finetune.git")
else
	CURRENT_BRANCH="main"
	REPO_URL="https://github.com/ZarK/ai-ws-finetune.git"
	echo "📋 Using hardcoded repository info for non-git environment"
fi

echo "📋 Gathering git-based project context..."

# Create project status summary
cat >"${CACHE_DIR}/project-status.md" <<EOF
# Project Status (Git-based Cache)

**Generated:** $(date -u +"%Y-%m-%d %H:%M:%S UTC")  
**Current Branch:** $CURRENT_BRANCH  
**Repository:** $REPO_URL  

## Recent Development Activity

### Last 20 Commits
EOF

# Add recent commits with issue references
if [ "$IN_GIT_REPO" = true ]; then
	echo "🔍 Analyzing recent commits for issue references..."
	git log --oneline -20 --decorate >>"${CACHE_DIR}/project-status.md" 2>/dev/null || echo "No git history available" >>"${CACHE_DIR}/project-status.md"

	# Extract issue numbers from commit messages
	echo -e "\n### Issue References in Recent Commits" >>"${CACHE_DIR}/project-status.md"
	git log --oneline -50 2>/dev/null | grep -E '#[0-9]+' | head -10 >>"${CACHE_DIR}/project-status.md" || echo "No issue references found in recent commits" >>"${CACHE_DIR}/project-status.md"

	# Add branch information
	echo -e "\n### Branch Information" >>"${CACHE_DIR}/project-status.md"
	echo "**Current Branch:** $CURRENT_BRANCH" >>"${CACHE_DIR}/project-status.md"
	echo "**All Branches:**" >>"${CACHE_DIR}/project-status.md"
	git branch -a 2>/dev/null | head -20 >>"${CACHE_DIR}/project-status.md" || echo "No branches available" >>"${CACHE_DIR}/project-status.md"

	# Check for feature branches that might indicate active work
	echo -e "\n### Feature Branches (Active Work)" >>"${CACHE_DIR}/project-status.md"
	git branch -a 2>/dev/null | grep -E "(feature|fix|issue)" | head -10 >>"${CACHE_DIR}/project-status.md" || echo "No feature branches found" >>"${CACHE_DIR}/project-status.md"
else
	echo "ℹ️  Git context not available - using general repository information"
	echo -e "\n### Repository Information" >>"${CACHE_DIR}/project-status.md"
	echo "**Repository:** $REPO_URL" >>"${CACHE_DIR}/project-status.md"
	echo "**Default Branch:** $CURRENT_BRANCH" >>"${CACHE_DIR}/project-status.md"
	echo "**Environment:** Non-git setup (agent environment)" >>"${CACHE_DIR}/project-status.md"
fi

# Analyze CLAUDE.md for known issues and priorities
echo "📖 Extracting known issues from CLAUDE.md..."
if [ -f "CLAUDE.md" ]; then
	cat >"${CACHE_DIR}/known-issues.md" <<EOF
# Known Issues and Priorities (from CLAUDE.md)

**Source:** CLAUDE.md project documentation  
**Extracted:** $(date -u +"%Y-%m-%d %H:%M:%S UTC")

## Current Priority Work

EOF

	# Extract sections that mention issues, priorities, or TODOs
	grep -A 5 -B 2 -i "issue\|priority\|todo\|critical\|high\|epic" CLAUDE.md | head -50 >>"${CACHE_DIR}/known-issues.md" 2>/dev/null || echo "No priority information found in CLAUDE.md" >>"${CACHE_DIR}/known-issues.md"
fi

# Analyze agents.md for agents guidance
echo "🤖 Extracting agents guidance from agents.md..."
if [ -f "agents.md" ]; then
	cat >"${CACHE_DIR}/agents-guidance.md" <<EOF
# Agents Development Guidance

**Source:** agents.md  
**Extracted:** $(date -u +"%Y-%m-%d %H:%M:%S UTC")

## Current System Capabilities
EOF

	# Extract system capabilities and current work sections
	grep -A 10 -B 2 "Completed Features\|Current Priority\|Critical Path" agents.md >>"${CACHE_DIR}/agents-guidance.md" 2>/dev/null || echo "No system capabilities found in agents.md" >>"${CACHE_DIR}/agents-guidance.md"
fi

# Create development context from file changes
echo "📁 Analyzing recent file changes..."
cat >"${CACHE_DIR}/recent-changes.md" <<EOF
# Recent Development Changes

**Generated:** $(date -u +"%Y-%m-%d %H:%M:%S UTC")

## Files Modified in Last 10 Commits
EOF

if [ "$IN_GIT_REPO" = true ]; then
	# Show files changed in recent commits
	git log --name-only --oneline -10 2>/dev/null | grep -v "^[a-f0-9]" | sort | uniq -c | sort -nr | head -20 >>"${CACHE_DIR}/recent-changes.md" || echo "No recent file changes available" >>"${CACHE_DIR}/recent-changes.md"

	# Add current working tree status
	echo -e "\n## Current Working Tree Status" >>"${CACHE_DIR}/recent-changes.md"
	git status --porcelain 2>/dev/null >>"${CACHE_DIR}/recent-changes.md" || echo "Clean working tree" >>"${CACHE_DIR}/recent-changes.md"
else
	echo "Git history not available in this environment" >>"${CACHE_DIR}/recent-changes.md"
	echo -e "\n## Environment Status" >>"${CACHE_DIR}/recent-changes.md"
	echo "Running in non-git environment (likely agent setup)" >>"${CACHE_DIR}/recent-changes.md"
fi

# Create component analysis from directory structure
echo "🏗️ Analyzing project structure..."
cat >"${CACHE_DIR}/project-structure.md" <<EOF
# Project Structure Analysis

**Generated:** $(date -u +"%Y-%m-%d %H:%M:%S UTC")

## Source Code Organization
EOF

# Analyze project structure (works in both git and non-git environments)
if [ -d "src" ]; then
	echo "### Source Code Components" >>"${CACHE_DIR}/project-structure.md"
	find src -type f -name "*.py" 2>/dev/null | head -20 | while read file; do
		echo "- $file" >>"${CACHE_DIR}/project-structure.md"
	done
else
	echo "### Project Structure" >>"${CACHE_DIR}/project-structure.md"
	echo "Source directory not found in current location" >>"${CACHE_DIR}/project-structure.md"
	echo "This is likely a agent environment - refer to GitHub repository for structure" >>"${CACHE_DIR}/project-structure.md"
fi

# Analyze tests
if [ -d "tests" ]; then
	echo -e "\n### Test Coverage" >>"${CACHE_DIR}/project-structure.md"
	find tests -name "*.py" 2>/dev/null | wc -l | xargs echo "- Test files:" >>"${CACHE_DIR}/project-structure.md"
	find tests -name "*.py" 2>/dev/null | head -10 >>"${CACHE_DIR}/project-structure.md"
fi

# Check for configuration files that might indicate current focus
echo -e "\n### Configuration Files" >>"${CACHE_DIR}/project-structure.md"
ls -la *.yaml *.yml *.json *.md 2>/dev/null | head -10 >>"${CACHE_DIR}/project-structure.md" || echo "Configuration files not found in current directory" >>"${CACHE_DIR}/project-structure.md"

# Create summary for agent (different filename if GitHub CLI cache exists)
if [ "$GH_CACHE_EXISTS" = true ]; then
	SUMMARY_FILE="${CACHE_DIR}/git-context.md"
else
	SUMMARY_FILE="${CACHE_DIR}/README.md"
fi

cat >"$SUMMARY_FILE" <<EOF
# Git-based Project Cache for Agents

This cache provides offline project context using only git commands and local files.
No GitHub API or authentication required.

**Generated:** $(date -u +"%Y-%m-%d %H:%M:%S UTC")  
**Current Branch:** $CURRENT_BRANCH

## Available Context Files

- \`project-status.md\` - Recent commits, branches, and git activity
- \`known-issues.md\` - Priority work extracted from CLAUDE.md
- \`agents-guidance.md\` - Development guidance from agents.md
- \`recent-changes.md\` - File change analysis and working tree status
- \`project-structure.md\` - Code organization and component analysis

## Quick Development Context

### Recent Work Focus
$(if [ "$IN_GIT_REPO" = true ]; then git log --oneline -3 2>/dev/null || echo "No recent commits available"; else echo "Repository: ${REPO_URL}"; fi)

### Current Working State
- Branch: $CURRENT_BRANCH
- Modified files: $(if [ "$IN_GIT_REPO" = true ]; then git status --porcelain 2>/dev/null | wc -l | tr -d ' '; else echo "0"; fi) files
- Recent commits: $(if [ "$IN_GIT_REPO" = true ]; then git log --oneline -10 2>/dev/null | wc -l | tr -d ' '; else echo "N/A"; fi) in last 10

### Key Areas (from structure)
$(find src -maxdepth 1 -type d 2>/dev/null | tail -n +2 | head -5 | xargs -I {} basename {} 2>/dev/null | sed 's/^/- /' || echo "- Core ML training and inference\n- CTF challenge system\n- CVE monitoring\n- Dataset generation")

## Usage for Agents

1. **Check current priorities:** \`cat .issue-cache/known-issues.md\`
2. **Understand recent work:** \`cat .issue-cache/project-status.md\`
3. **Find development guidance:** \`cat .issue-cache/agents-guidance.md\`
4. **Analyze code structure:** \`cat .issue-cache/project-structure.md\`

This approach works entirely offline and provides rich context for development tasks.
EOF

echo "✅ Git-based cache complete!"
echo ""
if [ "$GH_CACHE_EXISTS" = true ]; then
	echo "📁 Git context added to existing GitHub CLI cache:"
	echo "   📄 GitHub issues: $(ls "${CACHE_DIR}"/issue-*.md 2>/dev/null | wc -l | tr -d ' ') detailed files"
	echo "   📄 Git context: project-status.md, known-issues.md, agents-guidance.md"
	echo "   📄 Summary: README.md (GitHub) + git-context.md (Git)"
else
	echo "📁 Standalone git cache contents:"
	echo "   📄 Project status with git history"
	echo "   📄 Known issues from documentation"
	echo "   📄 Development guidance for agents"
	echo "   📄 File change analysis"
	echo "   📄 Project structure overview"
fi
echo ""
echo "🤖 Agents can now work with comprehensive offline context"
