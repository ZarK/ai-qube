# QUBE Claude Code Host Support

QUBE treats Claude Code as a first-class host surface for repository instruction
discovery, todo guidance, and continuation boundaries. Claude Code support
is intentionally separate from Codex, OpenCode, and generic shell behavior.

## Capability Model

The installed QUBE composer package exposes a Claude Code host capability layer.
It does not depend on private workspace adapter packages, so `@tjalve/qube`
remains independently installable and individual component packages remain usable
when a project intentionally installs only one package.

Supported QUBE-owned behavior:

- Detect project `CLAUDE.md` as the Claude Code instruction target.
- Report Claude Code instruction support for AIB and AIE init flows.
- Report Executor repository checks for branch policy, worktree state, base
  branch freshness, and blocking pull requests.

Host-provided behavior:

- Claude Code todo state is session working memory. Keep durable task state in
  GitHub issues, pull requests, and `.qube/` artifacts.
- Claude Code command execution follows active host settings, permissions,
  hooks, and repository policy.
- Claude Code hooks are host settings. Review `.claude/settings.json` before
  relying on hook behavior.
- Claude Code slash commands and skills are host customization assets. QUBE
  composer install notes report them, but do not create command or skill files.
- Claude Code subagents can support bounded research or review work, while
  protected QUBE issue workflow state stays in the main session.
- Claude Code conversation resume is host context. QUBE workflow continuation
  remains anchored in provider state and `.qube/` state.

Unsupported Claude Code host behavior:

- QUBE composer install notes do not create `.claude/commands` or
  `.claude/skills` assets.
- Claude Code host support does not directly invoke external PR reviewers.
- Claude Code host support does not bypass branch policy or open pull requests
  without the configured AIE/GitHub workflow.

## Initialize

Use QUBE commands when setting up a repository for Claude Code:

```sh
qube install --host claude-code --work-provider github --yes --dry-run --json
qube aib init . --agent claude-code --idea "Plan this project" --json
qube aie init . --tool claude-code --defaults --yes --json
qube aiu init --tool claude-code --yes --json
```

Claude Code reads `CLAUDE.md` from the project. QUBE writes or updates
`CLAUDE.md` through the owning product command; it does not create a
Claude-specific command directory from the composer installer.

## Run

Use QUBE as the regular command deck inside Claude Code sessions:

```sh
qube aie queue --json
qube aie start next --json
qube aie branch check <issue> --json
qube aie review gate <issue> --prompt
qube aie pr view <pr> --json
qube aiq doctor --format json
qube aiu status --json
```

Treat Claude Code todo tools as working memory. Use GitHub issue comments,
checklists, pull requests, and QUBE evidence files for durable shared state.

## Review And Continuation

AIE owns review and pull request gates, even when the work is performed from
Claude Code:

```sh
qube aie review gate <issue> --prompt
qube aie pr gate <pr>
qube aie pr view <pr> --json
```

AIU owns Claude Code continuation policy through its explicit Stop hook surface:

```sh
qube aiu init --tool claude-code --yes --json
qube aiu hook-stop --tool claude-code --json
```

Claude Code hook payloads and transcript-adjacent data are untrusted inputs.
QUBE continuation decisions must still load trusted state, honor repository
policy, and safe-allow stopping when state is missing, malformed, or disabled.

## Continue

After merge, follow the Executor cycle:

```sh
qube aie complete <issue> --json
git checkout main
git pull --ff-only origin main
qube aie next --json
```

Claude Code resume can restore host conversation context, but it is not the
source of truth for issue completion, PR checks, or the next ready issue.
