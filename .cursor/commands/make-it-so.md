<!-- BEGIN EXECUTOR MANAGED SECTION -->
<!-- executor-managed-version: 1 -->
<!-- executor-managed-tool: 0.2.9 -->
<!-- executor-managed-checksum: 7857accf7d5f00afff53aa8f68bc83a51b5b6456041e04506307e0f7a2b00feb -->
---
description: Continue the Executor Continuous Shipping workflow
---

Continue repository development by completing the current issue, shipping it, and selecting the next ready issue.

Follow the repository policy in the managed Executor instructions. Search for information, analyze the issue, and complete all work within the configured shipping boundary.

Rules:

- Never ask questions during normal work. Make decisions according to repository policy and continue.
- Think holistically. Consider system-wide impact, not just the immediate issue.
- Follow installed repository instructions and Executor policy.
- Repository policy authorizes you to commit, push, create non-draft PRs, run `qube aie pr gate <pr>` to request reviewers, wait for configured review gates, and check status, merge, run `qube aie complete <issue>`, pull the configured base branch, and continue to the next ready issue.
- Analysis, investigation, queue triage, and manual GitHub issue creation or issue suggestion are allowed before implementation starts when the user explicitly asks for them; start implementation only after normal Executor queue and pre-start policy pass.
- Use `aie` commands for queue and lifecycle state instead of manually changing labels whenever possible.
- Use the Executor local app runner, `qube aie run start --name ui-audit -- <command>`, `qube aie run wait --name ui-audit --url <url> --timeout 30`, `qube aie run status --name ui-audit`, and `qube aie run stop --name ui-audit` for long-running UI audit or integration-test app servers; after that command and URL work, record them with `qube aie audit ui set-run --command "<command>" --url <url>`; prefer repository package scripts such as `npm run dev`, `npm start`, or `pnpm dev` as the command; do not improvise raw PowerShell job/process recipes when this runner is available.
- Use agent-browser first for visual UI inspection when available, with Playwright/browser automation as fallback; capture screenshots for important states and never claim UI audit success from CLI JSON, API health, notes, or status checks without visiting visual surfaces.
- If the Executor local app runner is unavailable or startup fails, collect `qube aie run status --name ui-audit` logs/status once and report the exact blocker, and stop instead of waiting indefinitely.
- Use `qube aie pr view <pr> --json`, `qube aie pr gate <pr>`, and `qube aie pr body <issue>` for pull request state instead of raw `gh pr view` review/comment payloads whenever possible.
- Before new issue work, verify no linked worktree is in use, no blocking open pull requests remain, and `origin/main` is current.
- Commit intentional changes, push, open the non-draft, ready-for-review pull request, inspect required reviews and checks, address feedback, merge once repository policy, CI, required tests, and configured gates are satisfied, run `qube aie complete <issue>`, update the base branch, and continue.
- Stop implementation only when the queue is empty, every issue is blocked, multiple active issues need repair, required tools are unavailable, configured gates cannot run, a linked worktree is detected before new issue work, blocking open pull requests remain, the local `main` branch is not current with `origin/main`. Explicitly user-directed analysis, investigation, queue triage, and manual GitHub issue creation or issue suggestion may still proceed before implementation starts. Report the exact blocker and the next Executor command or repository action that would unblock implementation work.

Workflow:

`qube aie start next` or resume active issue -> `qube aie view <issue>` -> branch check/create -> implement -> tests/audits/configured gates -> commit -> push -> non-draft, ready-for-review pull request with issue closure -> `qube aie pr gate <pr>` to request reviewers, wait for configured review gates, and check status -> address feedback -> merge -> `qube aie complete <issue>` -> update base -> repeat.

Go.
<!-- END EXECUTOR MANAGED SECTION -->
