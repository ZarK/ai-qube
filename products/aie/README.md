# @tjalve/aie

`@tjalve/aie` is the AI Executor CLI for issue-driven execution. It helps an
agent inspect ready work, start a scoped branch, run repository gates, open or
update pull requests, check reviews, and complete work after merge.

Executor is intentionally repository-centered. It works from the target checkout
and uses the repository's own scripts, policy, branch state, configured work
provider, and pull requests as the source of truth.

GitHub work support is available through the built-in Executor adapter boundary.
Non-default work providers such as Linear and GitLab are optional adapter
package boundaries: AIE core keeps provider-neutral lifecycle behavior, while
adapter packages own provider API clients, credentials, mapping, capability
flags, and unsupported-operation diagnostics. Selecting an optional provider
without its adapter installed fails with setup guidance instead of falling back
to GitHub semantics.

For the full QUBE package family and command deck, see
https://zark.github.io/ai-qube/ or the repository landing-page artifact at
https://github.com/ZarK/ai-qube/blob/HEAD/docs/index.html.

## Install

```sh
pnpm add -D --save-exact --ignore-scripts @tjalve/aie@0.1.4
pnpm exec aie --help
```

For manual global use:

```sh
npm install -g @tjalve/aie@0.1.4 --ignore-scripts
aie --help
```

## Requirements

- Node.js 24 or newer
- `git`
- GitHub CLI `gh` for GitHub-backed issues, pull requests, and checks
- access to the configured work and review providers

## Common Commands

```sh
aie --version
aie doctor
aie schema --json
aie queue --json
aie start next --dry-run
aie start next
aie pr status --json
aie complete <issue-number>
```

Initialize a repository policy after reviewing the dry-run output:

```sh
aie init . --dry-run --json
aie init . --defaults --yes
```

## Migration

Repositories that already have copied issue-workflow helpers can inspect a
package-backed migration plan before changing files:

```sh
aie migrate map
aie migrate legacy --dry-run --json
```

Apply only the migration action you intend:

```sh
aie migrate legacy --apply --dry-run
aie migrate legacy --apply
aie migrate legacy --install-wrappers --dry-run
aie migrate legacy --install-wrappers --apply
aie migrate legacy --cleanup --dry-run
aie migrate legacy --cleanup --apply
```

The migration commands report detected legacy paths, instruction references,
compatibility wrappers, cleanup candidates, preserved files, conflicts, required
confirmations, and next commands. Review the resulting git diff before committing
any migration output.

## Safety Notes

- The package has no install lifecycle scripts.
- `doctor`, `schema`, `queue`, and migration dry-runs are inspection-first
  commands.
- Executor does not create credentials or bypass repository policy.
- Cleanup removes only known legacy helper files unless exact paths and force
  behavior are explicitly selected.

## Development

```sh
corepack enable
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @tjalve/aie run verify
```

Design details live in the repository spec:

- https://github.com/ZarK/ai-qube/tree/main/products/aie/docs/spec.md
- https://github.com/ZarK/ai-qube/tree/main/products/aie/docs/migration.md
