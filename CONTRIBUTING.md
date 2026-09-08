# Contributing

Read the [repository instructions](./AGENTS.md) before you start. They define
the issue workflow, security policy, review rules, and required shipping checks.
Agents must use the installed `asd-ste100` skill for plans and repository
communication.

## Development setup

This repository is a pnpm workspace. It requires Node.js 24 or newer. Use
Corepack with the `packageManager` field so that commands use the pinned pnpm
11.0.4 release. Install the locked dependencies without lifecycle scripts:

```sh
pnpm install --frozen-lockfile --ignore-scripts
```

The `packages/` directory contains shared libraries. Provider and host adapters
are in `adapters/`. The `products/` directory contains the AIB, AIE, AIQ, AIU,
and QUBE command-line packages. Their product names are Bootstrap, Executor,
Quality, Umpire, and QUBE. Keep a change in the smallest package that owns the
behavior.

## Checks

Use the existing package scripts for the files that you change. Examples:

```sh
pnpm --dir packages/qube-core --config.verify-deps-before-run=false run test
pnpm --dir products/aie --config.verify-deps-before-run=false run test
pnpm --dir products/qube --config.verify-deps-before-run=false run test
node --test test/docs-site.test.mjs test/version-audit.test.mjs
```

Before merge, run the required checks listed in the repository instructions.

Pull requests use path-based CI selection. Selected core packages must pass
manifest checks, build, typecheck, tests, and package checks. Quality changes
use a separate AIQ build, typecheck, functional-test, and test-configuration
job. The required aggregate job rejects failed or cancelled required work.

## Generated files

Do not edit compiled output or other generated build files. Change the owning
source and regenerate only the tracked artifacts that repository policy
requires. For files with QUBE-managed section markers, change the renderer and
rerun `qube init` to refresh the managed section. Preserve all user-owned text
outside those markers. Include only intentional, issue-scoped generated changes
in the pull request.
