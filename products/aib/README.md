# @tjalve/aib

`@tjalve/aib` is an agent-operated planning CLI. It turns a rough idea into
durable planning state, a draftable spec, milestone plans, and work item drafts
that another tool or agent can execute later.

The CLI is designed for structured agent use: human-readable output is available
for setup and debugging, while JSON output is the stable contract for automated
flows.

## Install

```sh
pnpm add -D --save-exact --ignore-scripts @tjalve/aib@0.1.0
pnpm exec aib --help
```

For manual global use:

```sh
npm install -g @tjalve/aib@0.1.0 --ignore-scripts
aib --help
```

## Planning Flow

```sh
aib init . --agent codex --idea "Build a local field notes CLI" --json
aib next --state .qube/aib/session.json --json
aib answer --state .qube/aib/session.json --field project.goal --value "Capture searchable field notes" --json
aib spec draft --state .qube/aib/session.json --json
aib spec validate --state .qube/aib/session.json --json
aib milestones generate --state .qube/aib/session.json --json
aib work-items generate --state .qube/aib/session.json --json
aib work-items render --state .qube/aib/session.json --provider markdown --dry-run --json
```

Use `--dry-run --json` before writing files in an existing repository:

```sh
aib init . --agent opencode --idea "Add import/export support" --dry-run --json
```

## Outputs

Depending on the selected provider and command, AIB can produce:

- planning state under `.qube/aib/`
- spec drafts and validation results
- milestone plans
- work item drafts
- local instruction assets for supported host tools
- markdown previews for review before provider writes

GitHub issue creation is not the default path in this package version. Use
markdown rendering and dry-run output unless a future provider command explicitly
adds direct provider writes.

## Safety Notes

- The package has no install lifecycle scripts.
- `init`, `answer`, and rendering commands expose JSON and dry-run behavior for
  reviewable automation.
- Host instruction files are local project assets; AIB does not install global
  skills, hooks, package managers, or provider credentials.
- Planning state is product data. Review generated specs and work items before
  using them as execution authority.

## Development

```sh
corepack enable
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @tjalve/aib run verify
```
