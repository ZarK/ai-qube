# @tjalve/aie

`@tjalve/aie` is the AI Executor CLI for issue-driven execution. It helps an
agent inspect ready work, start a scoped branch, run repository gates, open or
update pull requests, check reviews, and complete work after merge.

Executor is intentionally repository-centered. It works from the target checkout
and uses the repository's own scripts, policy, branch state, configured work
provider, and pull requests as the source of truth.

GitHub work support is owned by the optional adapter package
`@tjalve/qube-adapter-github`. AIE core keeps provider-neutral lifecycle
behavior, while adapter packages own provider API clients, credentials, mapping,
capability flags, merge and review-thread reads, and unsupported-operation
diagnostics. Other work providers follow the same package boundary: the GitLab
adapter lives in `@tjalve/qube-adapter-gitlab`, and the Linear adapter lives in
`@tjalve/qube-adapter-linear`. Selecting a provider without its adapter
installed fails with setup guidance instead of falling back to GitHub semantics.

For the full QUBE package family and command deck, see
https://zark.github.io/ai-qube/ or the repository landing-page artifact at
https://github.com/ZarK/ai-qube/blob/HEAD/docs/index.html.

## Install

```sh
pnpm add -D --save-exact --ignore-scripts @tjalve/aie@0.2.0
pnpm exec aie --help
```

For manual global use:

```sh
npm install -g @tjalve/aie@0.2.0 --ignore-scripts
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

## Safety Notes

- The package has no install lifecycle scripts.
- `doctor`, `schema`, `queue`, and init dry-runs are inspection-first commands.
- Executor does not create credentials or bypass repository policy.

## Development

```sh
corepack enable
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @tjalve/aie run verify
```

Design details live in the repository spec:

- https://github.com/ZarK/ai-qube/tree/main/products/aie/docs/spec.md
