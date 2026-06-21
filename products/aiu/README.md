# @tjalve/aiu

`@tjalve/aiu` is the AI Umpire CLI for safe agent continuation. It reads
configured trusted state commands, evaluates continuation policy, and produces a
concrete prompt only when the next action is bounded enough for an agent to
continue.

AIU does not decide quality, planning, or issue status from agent narration. It
expects structured local state from trusted commands and treats unknown,
malformed, stale, blocked, or untrusted state as a stop condition.

## Install

```sh
pnpm add -D --save-exact --ignore-scripts @tjalve/aiu@0.0.4
pnpm exec aiu --help
```

For manual global use:

```sh
npm install -g @tjalve/aiu@0.0.4 --ignore-scripts
aiu --help
```

## What It Provides

- the `aiu` CLI
- typed `.qube/aiu/config.json` discovery, defaults, and validation
- read-only diagnostics through `aiu doctor`
- path inspection through `aiu paths`
- local continuation state, locks, and redacted logs under `.qube/aiu/`
- dry-runnable `aiu init` plans for supported host files
- trusted-state continuation decisions for quality, planning, work, and optional
  maintenance prompts
- public helper exports from `@tjalve/aiu` and `@tjalve/aiu/opencode`

## Quick Start

Inspect the current repository before writing files:

```sh
pnpm exec aiu paths --json
pnpm exec aiu config --json
pnpm exec aiu doctor --json
pnpm exec aiu init --dry-run --json
```

Apply a reviewed init plan:

```sh
pnpm exec aiu init --tool all
pnpm exec aiu doctor --json
```

Existing host files that differ from package-managed content are reported as
conflicts. AIU does not replace them unless `--force` is explicitly selected
after review.

## Continuation Policy

Quality continuation is driven by configured trusted commands that emit the
`quality` state kind. AIU can continue quality work only when that state reports
a concrete failing stage or finding group, affected paths when relevant, a next
command, expected evidence, and a rerun command.

Planning continuation is driven by configured trusted commands that emit the
`planning` state kind. AIU can continue planning only when planning continuation
is enabled and the state includes a concrete next action such as a command,
artifact check, or draft path. Human-blocking questions, inconsistent artifacts,
approval blocks, and ambiguous mappings stop continuation.

Whip tasks are optional idle maintenance prompts. They are considered only after
higher-priority continuation work is unavailable, and prompt delivery alone never
completes a task.

## Host Support

| Host | Status | Init target | Notes |
| --- | --- | --- | --- |
| OpenCode | Supported | `aiu init --tool opencode` | Project plugin delegates to the package runtime. |
| Codex CLI/Desktop | Experimental | `aiu init --tool codex` | Stop-hook behavior must be explicitly trusted and enabled. |
| Claude Code | Experimental | `aiu init --tool claude-code` | Project settings are preserved on conflict. |
| Generic MCP, Git hooks, GitHub Actions | Not a continuation host | none | These are not interactive idle-session continuation surfaces. |

## Migration

Inspect migration plans before changing files:

```sh
pnpm exec aiu migrate --dry-run --json
```

Apply and cleanup are explicit:

```sh
pnpm exec aiu migrate --apply --json
pnpm exec aiu migrate --cleanup --dry-run --json
pnpm exec aiu migrate --cleanup --confirm scripts/aiu-stop.js --json
```

Migration preserves repository policy, trusted command descriptors, prompt
customizations, and legacy durable state unless an explicit reviewed command
changes them.

## Safe Uninstall

Remove the package only after host files and trusted command descriptors no
longer depend on `aiu`:

```sh
pnpm remove @tjalve/aiu
```

Review `pnpm exec aiu doctor --json`, `pnpm exec aiu paths --json`, and normal
git diffs before deleting host configuration. For old copied helper assets, use
`pnpm exec aiu migrate --cleanup --dry-run --json` first and confirm only the
cleanup candidates you intend to remove.

## Safety Notes

- The package has no install lifecycle scripts.
- `doctor`, `paths`, `config`, `status`, `init --dry-run`, and migration
  dry-runs are inspection-first commands.
- AIU does not stage, commit, push, open pull requests, close issues, delete
  files, install package managers, or create provider credentials.
- Local `.qube/aiu/` state, locks, and logs are diagnostics, not provider truth.
- Use `pnpm install --frozen-lockfile --ignore-scripts` for repository
  development and trusted publishing for package releases.

## Public API

- `@tjalve/aiu` - config loading, prompt rendering, path inspection, and
  diagnostics helpers
- `@tjalve/aiu/opencode` - OpenCode plugin composition helpers
- `aiu` - package CLI entrypoint

## Development

```sh
corepack enable
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @tjalve/aiu run release:check
```
