---
trigger: always_on
description: Agent Instruction Block: GitHub Issues + Commits Workflow
---

# Agent Instruction Block: GitHub Issues + Commits Workflow

You are an LLM coding agent working in a repo that uses issue-driven development with strict execution rules and **automated dependency management**. Your job is to write code AND keep GitHub issues, commits, and tests synchronized.

Always read the relevant docs/dev-tasks for the issue before you start any work.

---

## Scripts Available

| Script | Purpose |
|--------|---------|
| `./scripts/gh-issue-start.sh <N>` | Start work on issue #N (checks blockers, sets S-InProgress) |
| `./scripts/gh-issue-complete.sh <N>` | Complete issue #N (closes it, auto-unblocks dependents) |
| `./scripts/gh-issue-deps.sh <cmd> [N]` | View/manage dependencies between issues |
| `./scripts/gh-priority-order.sh` | Show prioritized work order |
| `./scripts/gh-update-labels.sh <N> <action>` | Manual label updates |

---

## Non-negotiable Rules

1. **Never work without an issue**
   - Every change must be tied to exactly one GitHub issue.
   - If no issue exists, create one with labels: 1×P, 1×S, 1×C.

2. **One issue at a time**
   - You may only have one active issue in progress.
   - Do not start another issue until the current one is fully done and closed.

3. **No "drive-by coding"**
   - Do not mix unrelated fixes into an issue.
   - If you discover a separate problem, create a new issue and stop.

4. **No lying about tests**
   - You must not claim tests passed unless you actually ran them.
   - If you cannot run tests, say so explicitly.

5. **Audit + build discipline**
   - Manual UI audit must happen **after implementation and before any tests**.
   - Build must complete with **zero warnings** (warnings are failures).
   - Run cubic review **after E2E tests** and fix issues before shipping.

---

## Issue Lifecycle (Use the Scripts!)

### A) Start Work

**Always use the script:**
```bash
./scripts/gh-issue-start.sh <issue_number>
```

The script will:
- Check if issue is blocked (fails if blocked, unless `--force`)
- Warn if other issues are in progress
- Set S-InProgress label
- Add a start comment

**Manual alternative** (if script unavailable):
```bash
./scripts/gh-update-labels.sh <N> start
```

### B) Work in Small, Tested Increments

Each increment must:
- Be logically cohesive (one intent)
- Be tested (unit/integration; E2E when applicable)
- End with: commit → push → update issue checkboxes

### C) Commit Rules (Mandatory)

**Message format:**
```
#<issue-number> <type>: <imperative summary>
```

**Types:** `feat`, `fix`, `refactor`, `docs`, `chore`, `test`

**Example:**
```
#85 feat: implement import wizard UI with 4-step modal
```

**Content rules:**
- Must be a coherent unit (not half-finished)
- Must include updates to tests/docs if needed
- Must not include unrelated changes

### D) Issue Checkbox Discipline

After each commit, update the issue:
- Mark completed items as `[x]`
- Add new checkbox items if sub-tasks were discovered

**Progress comment template:**
```markdown
✅ Progress update

- Commit: <hash>
- What changed:
  - ...
- Tests:
  - `...` ✅
- Checkboxes updated: yes
```

### E) Push Rules

- You must push after every commit
- Remote must reflect reality so progress is visible

---

## Completing an Issue (Use the Script!)

**Always use the script:**
```bash
./scripts/gh-issue-complete.sh <issue_number>
```

The script will:
1. Close the issue
2. Find all issues blocked by this one
3. Auto-unblock them (S-Blocked → S-Ready) if no other blockers remain
4. Add completion comments to all affected issues

**You may only complete when ALL are true:**
- [ ] All Acceptance Criteria checkboxes are checked
- [ ] All required tests are passing
- [ ] All issues that touch UI must have E2E tests
- [ ] Final completion comment posted

**Completion comment template:**
```markdown
✅ Completed

- Delivered:
  - ...
- Acceptance Criteria: all met ✅
- Tests:
  - `...` ✅
- Follow-ups:
  - None / #<id>
```

---

## Managing Dependencies

### Check what blocks an issue:
```bash
./scripts/gh-issue-deps.sh blockers <N>
```

### Check what an issue blocks:
```bash
./scripts/gh-issue-deps.sh blocking <N>
```

### Show full dependency chain:
```bash
./scripts/gh-issue-deps.sh chain <N>
```

### Find issues ready to start:
```bash
./scripts/gh-issue-deps.sh ready
```

### Auto-fix stale S-Blocked labels:
```bash
./scripts/gh-issue-deps.sh fix
```

This scans all S-Blocked issues and unblocks any whose blockers are all closed.

---

## Practical Working Loop

```
1. ./scripts/gh-priority-order.sh           # See what's next
2. ./scripts/gh-issue-deps.sh ready         # Find unblocked issues
3. ./scripts/gh-issue-start.sh <N>          # Start the issue
4. Implement one cohesive increment
5. Run tests for that increment
6. git commit -m "#N <type>: <summary>"
7. git push
8. Update issue checkboxes + progress comment
9. Repeat 4-8 until all AC + tests done
10. ./scripts/gh-issue-complete.sh <N>      # Complete and unblock dependents
11. Move to next issue
```

---

## Movement to Next Issue (Hard Rule)

You are NOT allowed to start the next issue until:
- Current issue is closed
- Repository is in a clean, pushed state
- Issue checkboxes accurately reflect completed work
- `./scripts/gh-issue-complete.sh` was run (to unblock dependents)

---

## Quick Reference

| Action | Command |
|--------|---------|
| See priority order | `./scripts/gh-priority-order.sh` |
| See ready issues | `./scripts/gh-issue-deps.sh ready` |
| Start issue | `./scripts/gh-issue-start.sh <N>` |
| Complete issue | `./scripts/gh-issue-complete.sh <N>` |
| Check blockers | `./scripts/gh-issue-deps.sh blockers <N>` |
| Fix stale labels | `./scripts/gh-issue-deps.sh fix` |
| Manual label change | `./scripts/gh-update-labels.sh <N> <action>` |
