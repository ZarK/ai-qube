# AI Umpire

`@tjalve/aiu` provides the `aiu` CLI and runtime for safe agent continuation. It reads configured trusted state commands, evaluates continuation policy, and wires supported host tools to package-backed Umpire entrypoints.

## What It Ships

- a package-backed `aiu` CLI
- repository config, init, doctor, paths, schema, status, and hook entrypoints
- OpenCode project plugin wrapper support
- Codex and Claude Code stop-hook entrypoints
- dry-run planning for host installation and migration
- TypeScript runtime/config/policy types for supported extension points

It does not bundle companion CLIs or keep copied helper scripts as a runtime fallback path. Repositories configure trusted commands explicitly.

## Install

```bash
pnpm add -D --save-exact --ignore-scripts @tjalve/aiu
```

System requirements:

- Node.js 24+
- pnpm for development and documented local workflows
- host tool trust/enablement for project hooks where required

Install companion tools separately only when repository policy uses their commands as trusted state inputs.

## Quick Start

Preview host setup without writing files:

```bash
pnpm exec aiu init . --dry-run
pnpm exec aiu init . --tool all --dry-run --json
```

Apply selected host setup explicitly:

```bash
pnpm exec aiu init . --tool opencode
pnpm exec aiu init . --tool codex
pnpm exec aiu init . --tool claude-code
```

Inspect package and repository health:

```bash
pnpm exec aiu doctor
pnpm exec aiu paths --json
pnpm exec aiu schema --json
```

Tool support:

- OpenCode: installs a project plugin wrapper that delegates to the package runtime.
- Codex: installs a project Stop hook that runs `aiu hook stop --tool codex`.
- Claude Code: installs a project Stop hook that runs `aiu hook stop --tool claude-code`.

Stop hooks allow stopping unless trusted state loads successfully and the decision engine returns a safe, concrete continuation or repair prompt.

## Migration

Repositories that previously used repo-local Umpire hooks, local-checkout imports, copied helper scripts, or old host entries can use migration tooling to move to package-backed entrypoints.

Migration is dry-run first:

```bash
pnpm exec aiu migrate --dry-run
pnpm exec aiu migrate --dry-run --json
```

Migration does not stage, commit, branch, push, open PRs, close work items, or preserve old helper semantics as runtime fallback behavior.

## Package Surfaces

- `@tjalve/aiu` - public runtime/config/policy types and helpers
- `@tjalve/aiu/opencode` - OpenCode plugin export for project wrappers
- `aiu hook stop --tool codex|claude-code` - stop-hook entrypoint that emits host JSON

Example OpenCode wrapper:

```ts
import AiUmpireContinuationPlugin from "@tjalve/aiu/opencode";

export default AiUmpireContinuationPlugin;
```

## Development

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
pnpm test
pnpm run typecheck
pnpm run pack:dry-run
pnpm run release:check
pnpm exec aiu --help
```

## Planning Specs

- [Functional requirements](docs/spec.md)
- [M1 - Package, CLI, Config, And Host Foundation](docs/M1-package-cli-config-and-host-foundation.md)
- [M2 - Continuation State And Policy Engine](docs/M2-continuation-state-and-policy-engine.md)
- [M3 - Provider Status Integration And Stop Hooks](docs/M3-provider-status-integration-and-stop-hooks.md)
- [M4 - Whip Tasks, Quality Idle Work, And Planning Continuation](docs/M4-whip-tasks-quality-idle-work-and-planning-continuation.md)
- [M5 - Existing Repository Migration And Release Readiness](docs/M5-migration-release-readiness-and-provider-architecture.md)

## Publish Checklist

Before public publish:

- authenticate to npm as the account that owns the `@tjalve` scope
- confirm the package version
- keep the working tree clean so the tarball matches git
- make the GitHub repo public, then enable branch protection or rulesets for `main`
- configure the `npm-publish` environment with required reviewers
- configure npm trusted publishing for the `Publish` workflow

Release flow:

```bash
pnpm run release:check
git tag v0.1.0
git push origin main v0.1.0
```

The tagged release workflow publishes with npm provenance:

```bash
pnpm publish --access public --provenance
```
