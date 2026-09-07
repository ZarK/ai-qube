<!-- BEGIN EXECUTOR MANAGED SECTION -->
<!-- executor-managed-version: 1 -->
<!-- executor-managed-tool: 0.2.13 -->
<!-- executor-managed-checksum: 64a96c6bf13a7d5b807dd4c41b690b8a0d6d75e1cc403173e1036c72797d6fff -->
---
description: Continue the Executor Continuous Shipping workflow
---

Continue repository development by completing the current issue, shipping it, and selecting the next ready issue.

Follow the repository policy in the managed Executor instructions. Search for information, analyze the issue, and complete all work within the configured shipping boundary.

Rules:

- Never ask questions during normal work. Make decisions according to repository policy and continue.
- Think holistically. Consider system-wide impact, not just the immediate issue.
- Follow installed repository instructions and Executor policy.
- Follow the latest user instruction. A user stop or scope change overrides continuation and repository automation. Preserve unrelated work when you repair state.
- Do not ask for routine permission that the user or repository policy already grants.
- Repository policy authorizes you to commit, push, create non-draft PRs, run `qube pr gate <pr>`, complete local review focuses, and check provider-visible feedback, merge, run `qube complete <issue>`, pull the configured base branch, and continue to the next ready issue.
- Analysis, investigation, and queue triage are allowed before implementation starts when the user asks. Start implementation only after normal Executor checks pass.
- Use composer `qube` commands for queue and lifecycle state instead of raw `aie` or manual label edits. Prefer `qube queue`, `qube next`, `qube start`, `qube view`, `qube branch`, `qube pr`, `qube complete`, `qube audit`, `qube app`, `qube review`, and `qube quality`. `qube aie …` remains valid only as a component passthrough.
- Review mode is isolated. Use the configured GitHub workflow: run `qube pr gate <pr>`, complete local review focuses, and check provider-visible feedback. GitHub review publisher mode is github-app (installation token minting for formal PR review events when the identity is not the PR author). Use the configured reviewer identity only for review publication. Keep private keys and tokens out of repository files, prompts, evidence, issues, and pull requests. Config may reference a local key path or an environment variable name.
- For UI audit servers use `qube aie run start --name ui-audit -- <command>`. If start fails, run `qube aie run status --name ui-audit` exactly once, read the current attempt logs, stop, and record the blocker. If start succeeds, run exactly one bounded wait: `qube aie run wait --name ui-audit --url <url> --timeout 30`. Do not run status after a successful start, retry wait, or raise the shell timeout above 45 seconds. If wait fails, stop and record the blocker. Prefer repository package scripts such as `npm run dev`, `npm start`, or `pnpm dev` as the command.
- Use agent-browser first for visual UI inspection when available, with Playwright or browser automation as fallback. Navigate and interact with the changed flows. Visually inspect the results. For important states, capture and inspect PNG screenshots. Record the typed outcome, observations, screenshot hashes, findings, and blockers in audit.json. During the audit, never claim UI audit success from CLI JSON, HTTP/API responses, DOM text, passing tests, notes, filenames, hashes, or status checks; a pass requires browser navigation, relevant interaction, explicit visual observations, and inspected screenshots. Then run `qube aie run stop --name ui-audit`.
- If the Executor local app runner is unavailable or startup fails, collect `qube aie run status --name ui-audit` logs once and report the exact blocker.
- Use `qube pr view <pr> --json`, `qube pr gate <pr>`, and `qube pr body <issue>` for pull request state instead of raw provider review or comment payloads.
- Before new issue work, verify no linked worktree is in use, no blocking open pull requests remain, and `origin/main` is current.
- Commit intentional changes, push, open the ready pull request, run `qube pr gate <pr>`, complete local review focuses, and check provider-visible feedback, address blocking feedback, and merge when required checks pass and no concrete blocker remains. Advisory findings do not block merge. Then run `qube complete <issue>`, update the base branch, and continue.
- Stop implementation when the queue is empty, every issue is blocked, multiple active issues need repair, required tools are unavailable, configured gates cannot run, a linked worktree is detected before new issue work, blocking open pull requests remain, the local `main` branch is not current with `origin/main`. Explicit user-directed analysis and queue triage may still proceed before implementation starts. Report the exact blocker and the next supported action that would unblock implementation work.

Workflow:

`qube start next` or resume active issue -> `qube view <issue>` -> `qube branch check <issue>` / `qube branch create <issue>` -> implement -> tests/audits/configured gates -> commit -> push -> non-draft, ready-for-review pull request with work item closure -> run `qube pr gate <pr>`, complete local review focuses, and check provider-visible feedback -> address blocking feedback -> merge -> `qube complete <issue>` -> update base -> repeat.

Go.
<!-- END EXECUTOR MANAGED SECTION -->
