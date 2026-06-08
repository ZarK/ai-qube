#!/bin/bash

set -euo pipefail

usage() {
	echo "Usage: $0 [--dry-run] <absorbing_pr> <superseded_pr> [<superseded_pr> ...]"
	echo ""
	echo "Reconciles closed unmerged PR branches whose content was absorbed by a merged PR."
	echo ""
	echo "The script only deletes a stale head branch when its tree matches either:"
	echo "  - the absorbing PR's merge commit tree"
	echo "  - one of the absorbing PR's commit trees"
	echo ""
	echo "Examples:"
	echo "  $0 --dry-run 724 725 726"
	echo "  $0 724 725 726"
}

fail() {
	echo "❌ $*" >&2
	exit 1
}

DRY_RUN=false

while [ $# -gt 0 ]; do
	case "$1" in
	--dry-run)
		DRY_RUN=true
		shift
		;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		break
		;;
	esac
done

if [ $# -lt 2 ]; then
	usage
	exit 1
fi

ABSORBING_PR=$1
shift

REPO_JSON=$(gh repo view --json owner,name,defaultBranchRef)
REPO_OWNER=$(printf '%s' "$REPO_JSON" | jq -r '.owner.login')
REPO_NAME=$(printf '%s' "$REPO_JSON" | jq -r '.name')
DEFAULT_BRANCH=$(printf '%s' "$REPO_JSON" | jq -r '.defaultBranchRef.name')
REPO_SLUG="$REPO_OWNER/$REPO_NAME"

get_commit_tree() {
	local owner=$1
	local repo=$2
	local oid=$3

	gh api "repos/$owner/$repo/git/commits/$oid" --jq '.tree.sha'
}

get_pr_commit_oids() {
	local owner=$1
	local repo=$2
	local pr_number=$3

	gh api "repos/$owner/$repo/pulls/$pr_number/commits" --paginate --jq '.[].sha'
}

get_live_branch_oid() {
	local owner=$1
	local repo=$2
	local branch_name=$3
	local output

	if output=$(gh api "repos/$owner/$repo/git/ref/heads/$branch_name" --jq '.object.sha' 2>/dev/null); then
		printf '%s\n' "$output"
	fi
}

delete_remote_branch() {
	local owner=$1
	local repo=$2
	local branch_name=$3

	gh api -X DELETE "repos/$owner/$repo/git/refs/heads/$branch_name" >/dev/null
}

reconciliation_comment_exists() {
	local pr_number=$1
	local marker=$2

	gh api "repos/$REPO_OWNER/$REPO_NAME/issues/$pr_number/comments" --jq '.[].body' 2>/dev/null | grep -F "$marker" >/dev/null
}

candidate_entries=""

add_candidate_tree() {
	local tree_sha=$1
	local label=$2

	if [ -z "$tree_sha" ]; then
		return 0
	fi

	if find_candidate_label "$tree_sha" >/dev/null; then
		return 0
	fi

	if [ -n "$candidate_entries" ]; then
		candidate_entries="$candidate_entries
$tree_sha|$label"
	else
		candidate_entries="$tree_sha|$label"
	fi
}

find_candidate_label() {
	local tree_sha=$1
	local entry_tree
	local entry_label

	while IFS='|' read -r entry_tree entry_label; do
		if [ "$entry_tree" = "$tree_sha" ]; then
			printf '%s\n' "$entry_label"
			return 0
		fi
	done <<EOF
$candidate_entries
EOF

	return 1
}

ABSORBING_JSON=$(gh pr view "$ABSORBING_PR" --json number,title,state,mergeCommit,url)
ABSORBING_STATE=$(printf '%s' "$ABSORBING_JSON" | jq -r '.state')
ABSORBING_TITLE=$(printf '%s' "$ABSORBING_JSON" | jq -r '.title')
ABSORBING_URL=$(printf '%s' "$ABSORBING_JSON" | jq -r '.url')
ABSORBING_MERGE_OID=$(printf '%s' "$ABSORBING_JSON" | jq -r '.mergeCommit.oid // empty')

if [ "$ABSORBING_STATE" != "MERGED" ]; then
	fail "PR #$ABSORBING_PR is $ABSORBING_STATE, expected MERGED"
fi

if [ -z "$ABSORBING_MERGE_OID" ]; then
	fail "PR #$ABSORBING_PR has no merge commit"
fi

ABSORBING_MERGE_TREE=$(get_commit_tree "$REPO_OWNER" "$REPO_NAME" "$ABSORBING_MERGE_OID")
add_candidate_tree "$ABSORBING_MERGE_TREE" "merge commit $ABSORBING_MERGE_OID"

while IFS= read -r commit_oid; do
	if [ -n "$commit_oid" ]; then
		commit_tree=$(get_commit_tree "$REPO_OWNER" "$REPO_NAME" "$commit_oid")
		add_candidate_tree "$commit_tree" "absorbing commit $commit_oid"
	fi
done <<EOF
$(get_pr_commit_oids "$REPO_OWNER" "$REPO_NAME" "$ABSORBING_PR")
EOF

VALIDATED=""

for SUPERSEDED_PR in "$@"; do
	PR_JSON=$(gh pr view "$SUPERSEDED_PR" --json number,title,state,mergedAt,headRefName,headRefOid,headRepository,headRepositoryOwner,url)
	PR_STATE=$(printf '%s' "$PR_JSON" | jq -r '.state')
	PR_MERGED_AT=$(printf '%s' "$PR_JSON" | jq -r '.mergedAt // empty')
	PR_TITLE=$(printf '%s' "$PR_JSON" | jq -r '.title')
	PR_URL=$(printf '%s' "$PR_JSON" | jq -r '.url')
	HEAD_REF=$(printf '%s' "$PR_JSON" | jq -r '.headRefName // empty')
	HEAD_OID=$(printf '%s' "$PR_JSON" | jq -r '.headRefOid // empty')
	HEAD_OWNER=$(printf '%s' "$PR_JSON" | jq -r '.headRepositoryOwner.login // empty')
	HEAD_REPO=$(printf '%s' "$PR_JSON" | jq -r '.headRepository.name // empty')

	if [ "$PR_STATE" != "CLOSED" ] || [ -n "$PR_MERGED_AT" ]; then
		fail "PR #$SUPERSEDED_PR is not a closed unmerged PR"
	fi

	if [ -z "$HEAD_REF" ] || [ -z "$HEAD_OID" ] || [ -z "$HEAD_OWNER" ] || [ -z "$HEAD_REPO" ]; then
		fail "PR #$SUPERSEDED_PR has no restorable head branch metadata"
	fi

	HEAD_TREE=$(get_commit_tree "$HEAD_OWNER" "$HEAD_REPO" "$HEAD_OID")
	MATCH_LABEL=$(find_candidate_label "$HEAD_TREE" || true)

	if [ -z "$MATCH_LABEL" ]; then
		fail "PR #$SUPERSEDED_PR (${PR_TITLE}) head tree $HEAD_TREE does not match PR #$ABSORBING_PR merge/commit trees"
	fi

	ENTRY="$SUPERSEDED_PR|$HEAD_REF|$HEAD_OWNER|$HEAD_REPO|$HEAD_OID|$HEAD_TREE|$MATCH_LABEL|$PR_URL|$PR_TITLE"
	if [ -n "$VALIDATED" ]; then
		VALIDATED="$VALIDATED
$ENTRY"
	else
		VALIDATED="$ENTRY"
	fi
done

echo "✅ Reconciliation validated against PR #$ABSORBING_PR: $ABSORBING_TITLE"
echo "   $ABSORBING_URL"
echo "   merge commit: $ABSORBING_MERGE_OID"
echo ""

while IFS='|' read -r pr_number head_ref head_owner head_repo head_oid _head_tree match_label pr_url pr_title; do
	[ -n "$pr_number" ] || continue

	echo "#${pr_number}: $pr_title"
	echo "  head branch: $head_owner/$head_repo:$head_ref"
	echo "  head commit: $head_oid"
	echo "  tree match: $match_label"
	echo "  url: $pr_url"

	if [ "$DRY_RUN" = true ]; then
		echo "  dry-run: would comment on PR and delete stale branch"
		echo ""
		continue
	fi

	if [ "$head_owner/$head_repo" = "$REPO_SLUG" ]; then
		if [ "$head_ref" = "$DEFAULT_BRANCH" ]; then
			fail "PR #$pr_number resolves to default branch $head_ref; refusing to delete it"
		fi

		LIVE_HEAD_OID=$(get_live_branch_oid "$head_owner" "$head_repo" "$head_ref")

		if [ -z "$LIVE_HEAD_OID" ]; then
			if ! reconciliation_comment_exists "$pr_number" "Reconciled via #$ABSORBING_PR."; then
				gh pr comment "$pr_number" --body "Reconciled via #$ABSORBING_PR. Verified that this closed PR's head tree matches $match_label from #$ABSORBING_PR. The head branch $head_ref on $REPO_SLUG was already absent at reconciliation time, so no branch deletion was performed."
			fi

			echo "  branch already absent on $REPO_SLUG: $head_ref"
			echo "  already reconciled"
			echo ""
			continue
		fi

		if [ "$LIVE_HEAD_OID" != "$head_oid" ]; then
			fail "PR #$pr_number head branch moved to $LIVE_HEAD_OID after validation; refusing to delete $head_ref"
		fi

		delete_remote_branch "$head_owner" "$head_repo" "$head_ref"
		gh pr comment "$pr_number" --body "Reconciled via #$ABSORBING_PR. Verified that this closed PR's head tree matches $match_label from #$ABSORBING_PR, and deleted stale head branch $head_ref after confirming it still pointed at $head_oid."
	else
		gh pr comment "$pr_number" --body "Reconciled via #$ABSORBING_PR. Verified that this closed PR's head tree matches $match_label from #$ABSORBING_PR. The head branch lives on $head_owner/$head_repo, so delete it there to remove misleading ahead/behind divergence."
		echo "  skipped remote delete: head repo is $head_owner/$head_repo, expected $REPO_SLUG"
	fi

	echo "  cleaned up"
	echo ""
done <<EOF
$VALIDATED
EOF

if [ "$DRY_RUN" = true ]; then
	echo "Dry run complete. No branches or PR comments were changed."
else
	echo "Done. Superseded PR branches were reconciled and cleaned up."
fi
