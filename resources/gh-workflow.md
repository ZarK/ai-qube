## GitHub Issues Workflow

This project uses dependency-aware queueing. Labels still matter, but the actual work order is driven by the live blocker graph plus milestone ordering metadata.

### Labels

Priority labels:
- `P1-Critical` - critical priority, blocks other work
- `P2-High` - high priority, next release
- `P3-Medium` - medium priority
- `P4-Low` - low priority

Status labels:
- `S-Ready` - ready to work on
- `S-InProgress` - currently being worked
- `S-Blocked` - blocked by open dependencies
- `S-Blocking` - blocks other work

Component labels:
- `C-Frontend` - React UI code
- `C-Electron` - Electron shell and IPC
- `C-Backend` - .NET backend
- `C-Pipeline` - import and processing pipeline
- `C-Database` - SQLite schema and data flow
- `C-Testing` - tests and test infrastructure

### Core Scripts

```bash
# Start working on an issue.
# Refuses to start if open blockers exist, unless --force is used.
./scripts/gh-issue-start.sh <issue_number>
./scripts/gh-issue-start.sh <issue_number> --force

# Complete an issue, close it, and unblock dependents whose remaining blockers are all closed.
./scripts/gh-issue-complete.sh <issue_number>
./scripts/gh-issue-complete.sh <issue_number> --dry-run

# Switch between issues while preserving correct ready/blocked state on the paused issue.
./scripts/gh-issue-switch.sh <to_issue>
./scripts/gh-issue-switch.sh <to_issue> <from_issue>
./scripts/gh-issue-switch.sh <to_issue> --force

# Inspect dependencies and status drift.
./scripts/gh-issue-deps.sh blockers <N>
./scripts/gh-issue-deps.sh blocking <N>
./scripts/gh-issue-deps.sh chain <N>
./scripts/gh-issue-deps.sh ready
./scripts/gh-issue-deps.sh all
./scripts/gh-issue-deps.sh fix --dry-run
./scripts/gh-issue-deps.sh fix

# Show the actual queue.
./scripts/gh-priority-order.sh
./scripts/gh-priority-order.sh --json
```

### Queue Semantics

The queue sorts by:

1. priority label
2. effective status from the live blocker graph
3. explicit `Sequence:` metadata in the issue body, if present
4. milestone numbering from titles like `M34.2.15: ...`
5. GitHub issue number as the final tie-breaker

This means stale `S-Ready` or `S-Blocked` labels do not silently change the true queue order.

### Blocker Metadata

Direct blockers are recorded in the issue body with one line per blocker:

```text
Blocked by: #803
Blocked by: #764
```

The scripts only treat `Blocked by:` lines as dependencies. Other `#123` references in the issue body do not affect queue order.

### Ad Hoc Queue Steering

Use `Sequence:` only when blocker chains and milestone numbering are not enough.

Supported formats:
- `Sequence: 0.0.0.0`
- `Sequence: 34.2.15`
- `Sequence: 34.2.15.4000`

Default milestone tasks sort as `M<milestone>.<chapter>.<task>.5000`, which leaves room to inject issues before or after a task without renumbering existing milestone issues.

Recommended commands:

```bash
# Put an issue ahead of all other same-priority work.
./scripts/gh-update-labels.sh <issue_number> first

# Put an issue before or after a specific task.
./scripts/gh-update-labels.sh <issue_number> before <target_issue>
./scripts/gh-update-labels.sh <issue_number> after <target_issue>

# Set or clear explicit sequence manually.
./scripts/gh-update-labels.sh <issue_number> sequence 34.2.15.4000
./scripts/gh-update-labels.sh <issue_number> sequence none
```

Use cases:
- a newly discovered substrate issue that must land before `M34.2.4`
- an urgent regression that should be first in the current priority band
- a small harness fix that should sit immediately after a specific milestone task

### Manual Issue Maintenance

```bash
# Labels
./scripts/gh-update-labels.sh <issue_number> priority P2-High
./scripts/gh-update-labels.sh <issue_number> component C-Frontend
./scripts/gh-update-labels.sh <issue_number> sync

# Blockers
./scripts/gh-update-labels.sh <issue_number> blockers
./scripts/gh-update-labels.sh <issue_number> add-blocker <blocker_issue>
./scripts/gh-update-labels.sh <issue_number> remove-blocker <blocker_issue>
```

Prefer `sync` over manually forcing `ready` or `unblock`. It recomputes `S-Ready` versus `S-Blocked` from the current blocker graph.

### Shared Planning

If implementation notes or short plans need to survive across sessions or be visible to other agents, keep them in the GitHub issue body or issue comments.

- Prefer updating issue checklists and leaving concise issue comments over creating extra markdown files in the repo.
- Use repo docs for stable workflow or product guidance, not transient implementation planning.
- If queue steering or dependency rationale is non-obvious, document that decision in the issue comment that introduced the blocker or `Sequence:` override.

### Best Practices

- Use `gh-issue-start.sh` and `gh-issue-complete.sh` as the normal lifecycle entrypoints.
- Keep blocker chains explicit with `Blocked by:` lines instead of relying on issue numbers or comments.
- Use `gh-issue-deps.sh fix --dry-run` before mass cleanup so you can see label drift first.
- Use `first`, `before`, and `after` instead of editing `Sequence:` by hand when possible.
- Keep only one issue `S-InProgress` unless you are deliberately forcing a switch.

## Development Workflow

### Issue-Driven Development

Always start from a GitHub issue.

```bash
# Create a new issue with current labels.
gh issue create --title "Feature: Add new functionality" \
                --body "Description" \
                --label "P3-Medium,C-Frontend,S-Ready"

# If it must run ahead of an existing task:
./scripts/gh-update-labels.sh <new_issue> before <target_issue>

# Create a branch for the issue.
git checkout -b <type>/<number>-<slug>
```

Branch naming:
- branch prefix is `<type>/`
- `<slug>` should be short, lowercase, and hyphenated

### Pull Request Standards

- Link PRs to issues with `Closes #123`
- Use conventional commit titles such as `feat:`, `fix:`, `refactor:`
- Squash merge to keep history clean
- Delete merged branches

### Required Quality Gates

- Complete the manual UI audit after implementation and before tests
- Run `bun run build` with zero warnings
- Run `bun run test:backend`
- Run `bun run test:e2e`
- Run `cubic review`, apply fixes, and re-run the gates until clean
- After PR creation, wait 10 minutes and check Copilot/Cubic review comments before merging
