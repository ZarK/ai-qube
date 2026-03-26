# AI Umpire

`@tjalve/aiu` packages the AI Umpire continuation plugin, queue-policy assets, and repo bootstrap tooling for OpenCode workflows.

## What it ships

- the core continuation runtime from `opencode/ai-umpire-continuation.ts`
- a repo-default OpenCode plugin export at `@tjalve/aiu/opencode`
- queue assets under `scripts/` plus `queue-policy.json`
- an `aiu` CLI that scaffolds those assets into another repository

## Install

```bash
npm install -D @tjalve/aiu
```

System requirements for the queue scripts:

- Node.js 20.19+
- `gh`
- `jq`

## Quick start

Bootstrap the current repository with the plugin wrapper, queue scripts, and `queue-policy.json`:

```bash
npx aiu init .
```

That writes:

- `.opencode/plugins/ai-umpire-continuation.ts`
- `queue-policy.json`
- `scripts/_queue-policy.sh`
- `scripts/gh-ensure-labels.sh`
- `scripts/gh-issue-start.sh`
- `scripts/gh-priority-order.sh`
- `scripts/gh-update-labels.sh`

If you need to overwrite existing assets:

```bash
npx aiu init . --force
```

Inspect the installed package asset paths:

```bash
npx aiu paths --json
```

## Package surfaces

- `@tjalve/aiu` - core continuation runtime plus installer helpers
- `@tjalve/aiu/opencode` - repo-default OpenCode plugin export for local wrappers

Example local OpenCode wrapper:

```ts
import AiUmpireContinuationPlugin from "@tjalve/aiu/opencode";

export default AiUmpireContinuationPlugin;
```

## Commands

```bash
npm install
npm run build
npm test
npm run typecheck
npm run pack:dry-run
npx aiu --help
```

## Development notes

- published assets are whitelisted via `package.json#files`
- the installer copies queue assets from the installed package into the target repo
- downstream repos can keep a local `queue-policy.json` or fall back to the bundled default
