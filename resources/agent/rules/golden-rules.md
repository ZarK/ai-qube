# Golden Rules

These rules apply to ALL agents, ALL tasks, ALL times. No exceptions.

## Rule 1: Manual UI Audit Before Tests
Every UI change MUST be manually audited with `agent-browser` on the real Electron app **after implementation and before tests**.
- Launch the built Electron app in E2E mode with a CDP port
- Use `MEMEX_FIXTURE_DIR` and `window.__memexTest` instead of automating native OS folder dialogs
- Follow `docs/manual-ui-audit.md` for the primary workflow; Playwright MCP + dev-bridge is fallback only
- Capture evidence via real screenshots saved to local disk
- **No fake AI, no fabricated evidence - audits must use a real running app.**

## Rule 2: E2E Tests Required
Every UI change MUST have Playwright E2E tests using `data-testid` selectors.
- Tests must use real UI interactions (clicks, typing, navigation)
- Tests must cover happy path, edge cases, and error states
- NO mocking of the actual feature being tested

## Rule 2: Zero Tolerance for Failures
If a test fails, the build fails. Period.
- No "expected failures"
- No "known flaky"
- No "pre-existing issue"
- No "unrelated to my changes"
- Build warnings are failures — build must complete with **zero warnings**.

## Rule 2b: Cubic CLI Review (Mandatory)
- Run cubic review **after E2E tests**.
- Apply all actionable fixes and re-run tests + cubic until clean.

## Rule 3: No Cheating
Tests must prove the feature works, not just pass.
- No hardcoded expectations (`expect(x).toBe('5')`)
- No tautologies (`expect(true).toBe(true)`)
- No arbitrary waits (`waitForTimeout(5000)`)
- No skipped tests (`.skip()`, `[Skip]`)

## Rule 4: Clean Main
Never push broken code to main.
- All tests must pass before merge
- No TODO comments left behind
- No debug code (console.log, print statements)

## Rule 5: One Issue at a Time
- Only ONE active issue in progress
- Do not start another until current is FULLY CLOSED
- "Done" = merged to main + issue closed + branch deleted

## Rule 6: GitHub Issue = Source of Truth
```
spec.md          -> High-level product intent
dev-tasks/*.md   -> Milestone context and technical guidance
GitHub Issue     -> Binding delivery unit and acceptance criteria
```
Use the issue as the implementation contract. Read the relevant spec and dev-task docs for context, intent, and architecture, but do not use them to justify doing less work or to silently expand scope beyond the issue. If they conflict with the issue or imply extra work that is not clearly part of the issue, ask the user.

## Rule 7: Never Bypass Hooks
- FORBIDDEN: `git commit --no-verify`, `-n`, any hook bypass
- If hook blocks, YOUR WORK IS INCOMPLETE
- The hook tells you what's missing - GO COMPLETE IT

## Rule 8: Update Both Todo Systems
| System | Purpose | Affects Hook? |
|--------|---------|---------------|
| opencode todos | Your working memory | No |
| GitHub issue checkboxes | Official record | Yes |

Update BOTH as you complete tasks. Hook checks GitHub checkboxes.

## Rule 9: Artifact Verification (Local Disk)
Store verification screenshots locally and reference the filesystem path in the issue/PR comment.

Path convention:
```
~/github-verification/<repo>/<issue>/<case-description>.ext
```

Example:
```
~/github-verification/memex/664/import-audit-start.png
```

**STRICT SAFETY RULE**: These files stay local. **NEVER upload secrets or sensitive images** (tokens/keys, credentials, private dashboards, user data, private repo code screenshots, personal photos).

## Rule 10: No Momus or Metis
- Do not invoke `Momus` or `Metis`.
- Do not rely on `.sisyphus` plan or review workflows in this repo.
- Use the GitHub issue, local todos, and the repo-local `./scripts/gh-*` workflow instead.
