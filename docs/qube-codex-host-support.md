# QUBE Codex Host Support

QUBE treats Codex as a first-class host surface for repository instruction
discovery and agent workflow guidance. Codex support is intentionally separate
from OpenCode, Claude Code, and generic shell behavior.

## Capability Model

The installed QUBE composer package exposes a Codex host capability layer. It
does not depend on private workspace adapter packages, so `@tjalve/qube` remains
independently installable.

Supported QUBE-owned behavior:

- Detect project `AGENTS.md` as the Codex instruction target.
- Report Codex instruction support for AIB and AIE init flows.
- Report Executor repository checks for branch policy, worktree state, base
  branch freshness, and blocking pull requests.

Host-provided behavior:

- Codex local todos are session working memory. Keep durable task state in
  GitHub issues, pull requests, and `.qube/` artifacts.
- Codex command execution follows the active session permissions, sandbox,
  approvals, and repository policy.
- Codex Browser use can inspect unauthenticated local routes and file-backed
  previews when the Browser capability is available.
- Codex app worktrees and handoff are host-managed. QUBE still enforces the
  repository branch/worktree policy before issue work starts.

Unsupported Codex host behavior:

- QUBE does not install OpenCode-style project command files for Codex.
- Codex host support does not directly invoke external PR reviewers.
- Codex host support does not bypass branch policy or open pull requests
  without the configured AIE/GitHub workflow.

## Initialize

Use QUBE commands when setting up a repository for Codex:

```sh
qube install --host codex --work-provider github --yes --dry-run --json
qube aib init . --agent codex --idea "Plan this project" --json
qube aie init . --tool codex --defaults --yes --json
```

Codex reads `AGENTS.md` from the repository instruction chain. QUBE writes or
updates `AGENTS.md` through the owning product command; it does not create a
Codex-specific project command directory.

## Run

Use QUBE as the regular command deck inside Codex sessions:

```sh
qube aie queue --json
qube aie start next --json
qube aie branch check <issue> --json
qube aie review gate <issue> --prompt
qube aie pr view <pr> --json
qube aiq doctor --format json
qube aiu status --json
```

Treat Codex local todos as working memory. Use GitHub issue comments,
checklists, pull requests, and QUBE evidence files for durable shared state.

## Audit UI

When an issue touches user-facing UI, use Executor audit guidance first:

```sh
qube aie audit ui <issue> --prepare
qube aie run start --name ui-audit -- pnpm dev
qube aie run wait --name ui-audit --url http://127.0.0.1:5173 --timeout 30
```

Then inspect the actual rendered app with the Codex in-app browser or Browser
use when available. Keep evidence local under the audit directory and record
browser observations before claiming UI audit coverage.

## Continue

After merge, follow the Executor cycle:

```sh
qube aie complete <issue> --json
git checkout main
git pull --ff-only origin main
qube aie next --json
```

Codex app worktrees are useful for parallel work, but repositories can still
choose to require primary-checkout execution. Follow the active repository
policy before starting or shipping issue work.
