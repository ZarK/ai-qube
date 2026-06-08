#!/bin/bash

# Enhanced issue view script that shows issue details and relevant comments
# Excludes automated open/close/start/pause/resume comments

set -e

if [ $# -eq 0 ]; then
	echo "Usage: $0 <issue_number>"
	echo ""
	echo "Shows issue details and relevant comments (excludes automated ones)"
	exit 1
fi

ISSUE_NUM=$1

# Fetch issue data with comments
issue_data=$(gh issue view "$ISSUE_NUM" --json number,title,body,comments 2>/dev/null)
if [ $? -ne 0 ]; then
	echo "❌ Issue #$ISSUE_NUM not found"
	exit 1
fi

# Extract title and body
title=$(echo "$issue_data" | jq -r '.title')
body=$(echo "$issue_data" | jq -r '.body')

echo "🔍 Issue #$ISSUE_NUM: $title"
echo "========================================"
echo ""
echo "$body"
echo ""

# Filter and display relevant comments
echo "💬 Relevant Comments:"
echo "======================"

echo "$issue_data" | jq -r '.comments[] | select(.body | test("^🚀 \\*\\*Started|^✅ \\*\\*Completed|^⏸️ \\*\\*Paused|^▶️ \\*\\*Resumed") | not) | "\(.author.login) (\(.createdAt | strptime("%Y-%m-%dT%H:%M:%SZ") | strftime("%Y-%m-%d %H:%M"))):\n\(.body)\n---"' 2>/dev/null || echo "No relevant comments found"

