# ai-bootstrap

`@tjalve/aib` turns a fuzzy idea into durable planning state, an accepted spec, milestone plans, and provider-neutral work item drafts that an execution agent can pick up later.

The human talks to an AI agent. The agent operates `aib` with JSON commands, asks the human the returned questions, records answers, and advances the state machine. Human-readable output exists for setup and debugging; structured JSON is the product contract.

## Quick Start

From this repository:

```bash
corepack enable
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @tjalve/aib run verify
```

Start a local planning session in a target project:

```bash
node products/aib/bin/run init C:\path\to\project --agent codex --idea "Build a local field notes CLI" --json
node products/aib/bin/run next --state C:\path\to\project\.bootstrap\session.json --json
```

For package installation after publication, pin the exact version:

```bash
npm install -g @tjalve/aib@0.1.0 --ignore-scripts
```

Do not install floating `latest` versions into agent workflows.

## Codex Flow

1. The human asks Codex to use `aib` for a project idea.
2. Codex runs `aib init --agent codex --idea "<idea>" --json`.
3. Codex runs `aib next --json`, asks the returned questions, and records answers with `aib answer --field <field> --value <answer> --json`.
4. Codex drafts and validates the spec with `aib spec draft --json` and `aib spec validate --json`.
5. After section-aware acceptance, Codex runs `aib milestones generate --json`.
6. Codex generates and renders work items with `aib work-items generate --json` and `aib work-items render --provider markdown|github --dry-run --json`.

`aib init --agent codex --dry-run --json` reports planned files before mutation.

## OpenCode Flow

Use local projected assets instead of global command installation:

```bash
aib init . --agent opencode --dry-run --json
aib init . --agent opencode --json
```

This writes local instructions and `.opencode/commands/aib-bootstrap.md` in the target project. It does not install global skills, global commands, hooks, package managers, or provider credentials.

## Supported MVP Surfaces

- Stable MVP: local JSON CLI state machine, Codex instructions, OpenCode local command asset, markdown work item rendering.
- Best effort: Claude Code and Gemini instruction files.
- Future provider work: direct GitHub issue creation and additional work trackers. Current GitHub rendering is a dry-run preview.

## Release And Safety

Local gate:

```bash
pnpm --filter @tjalve/aib run verify
```

This runs typecheck, unit/E2E tests, build, and pack dry-run. The package uses exact dependency versions in `package.json` and should be installed with lockfile and lifecycle-script controls in automation. New dependencies require supply-chain intake before they are added.

Migration note: legacy bootstrap scripts remain as reference material while the CLI-backed flow becomes the product path. New docs and agent assets should point to `aib init`, `aib next`, and the structured command flow above.
