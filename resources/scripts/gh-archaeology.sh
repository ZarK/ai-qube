#!/usr/bin/env bash
set -euo pipefail

# Code Archaeology Helper
# Finds relevant context for a file: git history, related issues, and dev-task docs

usage() {
    echo "Usage: $0 <file-path>"
    echo ""
    echo "Traces the history of a file and finds:"
    echo "  - Recent commits that modified it"
    echo "  - Related GitHub issues (from commit messages)"
    echo "  - Relevant dev-task documentation"
    echo ""
    echo "Example: $0 e2e/tests/playwright/import_detects_duplicates.spec.ts"
    exit 1
}

if [[ $# -lt 1 ]]; then
    usage
fi

FILE="$1"
REPO_ROOT="$(git rev-parse --show-toplevel)"

if [[ ! -f "$FILE" ]]; then
    echo "Error: File not found: $FILE"
    exit 1
fi

echo "# Code Archaeology: $FILE"
echo ""

# Collect data silently
ISSUES=$(git log --oneline -30 -- "$FILE" 2>/dev/null | grep -oE '#[0-9]+' | sort -u | tr '\n' ' ')
DEV_TASKS_DIR="$REPO_ROOT/docs/dev-tasks"
FOUND_DOCS=""

# Find dev-task docs (priority: Context/Ref > title pattern > keywords)
if [[ -n "$ISSUES" && -d "$DEV_TASKS_DIR" ]]; then
    for ISSUE in $ISSUES; do
        NUM="${ISSUE#\#}"
        
        # Try Context/Ref in body first
        BODY=$(gh issue view "$NUM" --json body 2>/dev/null | jq -r '.body // empty' 2>/dev/null || true)
        if [[ -n "$BODY" ]]; then
            REF_DOC=$(echo "$BODY" | grep -oE 'docs/dev-tasks/M[0-9]+-[a-z-]+\.md' | head -1 || true)
            if [[ -n "$REF_DOC" ]]; then
                DOC_NAME=$(basename "$REF_DOC")
                if [[ -f "$DEV_TASKS_DIR/$DOC_NAME" && ! "$FOUND_DOCS" =~ "$DOC_NAME" ]]; then
                    FOUND_DOCS="$FOUND_DOCS $DOC_NAME"
                fi
            fi
        fi
        
        # Try title pattern if no Context/Ref
        if [[ -z "$FOUND_DOCS" ]]; then
            TITLE=$(gh issue view "$NUM" --json title 2>/dev/null | jq -r '.title // empty' 2>/dev/null || true)
            if [[ -n "$TITLE" ]]; then
                M_REF=$(echo "$TITLE" | grep -oE 'M[0-9]+' | head -1 || true)
                if [[ -n "$M_REF" ]]; then
                    MATCHING_DOC=$(ls "$DEV_TASKS_DIR"/${M_REF}-*.md 2>/dev/null | head -1 || true)
                    if [[ -n "$MATCHING_DOC" ]]; then
                        DOC_NAME=$(basename "$MATCHING_DOC")
                        if [[ ! "$FOUND_DOCS" =~ "$DOC_NAME" ]]; then
                            FOUND_DOCS="$FOUND_DOCS $DOC_NAME"
                        fi
                    fi
                fi
            fi
        fi
    done
fi

# Fallback: keyword search
if [[ -z "$FOUND_DOCS" && -d "$DEV_TASKS_DIR" ]]; then
    BASENAME=$(basename "$FILE" .ts)
    BASENAME=$(basename "$BASENAME" .spec)
    KEYWORDS=$(echo "$BASENAME" | tr '_' '\n' | tr '-' '\n' | grep -v '^$' || true)
    SKIP_WORDS="import|test|spec|e2e|app|shows|and|the|with|for|detects"
    DOMAIN_KEYWORDS=$(echo "$KEYWORDS" | grep -vE "^($SKIP_WORDS)$" 2>/dev/null | head -3 || true)
    
    for KEYWORD in $DOMAIN_KEYWORDS; do
        if [[ ${#KEYWORD} -ge 4 ]]; then
            MATCHES=$(grep -li "$KEYWORD" "$DEV_TASKS_DIR"/*.md 2>/dev/null | head -1 || true)
            if [[ -n "$MATCHES" ]]; then
                DOC_NAME=$(basename "$MATCHES")
                if [[ ! "$FOUND_DOCS" =~ "$DOC_NAME" ]]; then
                    FOUND_DOCS="$FOUND_DOCS $DOC_NAME"
                fi
            fi
        fi
    done
fi

# Output: Related Issues
echo "## Related Issues"
echo ""
if [[ -z "$ISSUES" ]]; then
    echo "(no issues found in git history)"
else
    for ISSUE in $ISSUES; do
        NUM="${ISSUE#\#}"
        INFO=$(gh issue view "$NUM" --json title,state 2>/dev/null | jq -r '"\(.title) [\(.state)]"' 2>/dev/null || true)
        if [[ -n "$INFO" ]]; then
            echo "- **#$NUM**: $INFO"
        fi
    done
fi
echo ""

# Output: Dev Task Documentation
echo "## Dev Task Documentation"
echo ""
if [[ -z "$FOUND_DOCS" ]]; then
    echo "(no matching documentation found)"
else
    for DOC in $FOUND_DOCS; do
        if [[ -n "$DOC" ]]; then
            echo "- **$DOC**: \`docs/dev-tasks/$DOC\`"
        fi
    done
fi
echo ""

# Output: Git History
echo "## Recent Changes"
echo ""
git log --oneline -10 -- "$FILE" 2>/dev/null || echo "(no git history)"
