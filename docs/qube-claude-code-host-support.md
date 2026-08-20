# QUBE Claude Code Agent Harness

QUBE supports Claude Code as an agent harness. You can run QUBE commands in any terminal, but Claude Code supplies the agent session and harness features.

## Setup

Run QUBE init for Claude Code:

```sh
qube init . --host claude-code --yes
```

QUBE writes or updates these harness assets:

- `CLAUDE.md` contains the repository instructions.
- `.claude/commands/make-it-so.md` contains the Make It So command.

Start QUBE work in a new Claude Code session with `/make-it-so`. A new session loads the new instructions and command.

Claude Code task-list state is session working memory. Keep durable work state in the configured issue tracker, pull requests, and QUBE evidence.

## Review

Claude Code supports native review with fresh subagents. QUBE validates the returned review results and publishes the configured provider feedback.

Claude Code does not have a tested QUBE isolated-review route. Select a harness with isolated-review support if you need a separate read-only review process.

Claude Code does not expose a non-interactive list of models for the signed-in account. Use `/model` to inspect the available models. QUBE leaves the native review model unpinned when no live catalog is available.

Use these commands to inspect review work:

```sh
qube aie review gate <issue> --prompt
qube aie pr gate <pr>
qube aie pr view <pr> --json
```

## Umpire continuation

Claude Code Umpire continuation is experimental. QUBE installs a managed Stop hook in `.claude/settings.json`.

Review the settings change and trust the hook before you rely on continuation. Then run the Umpire probe:

```sh
qube aiu doctor --json
```

QUBE reports the hook as unverified until the probe observes a valid event. Continuation is effective only after the hook is trusted and the probe succeeds.

The Stop hook can help recover current-issue work during Continuous Shipping. It does not replace issue state, pull request checks, or repository policy.

## Runtime boundary

Claude Code owns the agent session, model access, task tools, subagents, permissions, and hooks. QUBE writes instructions and configuration, runs its workflow commands, records evidence, and reports capability state.

QUBE cannot force Claude Code or a model to follow its instructions.
