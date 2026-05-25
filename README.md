# AIQ

AIQ is a code quality runner for AI-assisted repositories. It gives humans and agents one stage ladder, one persisted current stage, and one command to run the checks that matter now.

## Quickstart

```bash
npx @tjalve/aiq run .
npx @tjalve/aiq config --set-stage 3
npx @tjalve/aiq run .
```

On first use, `aiq` initializes `.aiq/aiq.config.json` and `.aiq/progress.json` when it can infer a supported project. After that, `aiq run <paths...>` uses `.aiq/progress.json` and runs every stage from `0` through the persisted `current_stage`.

## Stage Ladder

| # | Stage | Scope |
|---|---|---|
| 0 | e2e | full run |
| 1 | lint | diff-safe |
| 2 | format | diff-safe |
| 3 | typecheck | full run |
| 4 | unit | full run |
| 5 | sloc | diff-safe |
| 6 | complexity | diff-safe |
| 7 | maintainability | diff-safe |
| 8 | coverage | full run |
| 9 | security | full run |

## Stage Selection

```bash
npx @tjalve/aiq config --set-stage 6
npx @tjalve/aiq run src
npx @tjalve/aiq plan src
npx @tjalve/aiq run src --up-to 3
npx @tjalve/aiq run src --only 1
npx @tjalve/aiq run src --stage typecheck
```

- Default `run` and `plan`: use cumulative stages `0..current_stage` when `.aiq/progress.json` exists.
- `--up-to N`: ignore persisted progress and run every stage from `0` through `N`.
- `--only N`: run one numeric stage.
- `--stage <name>`: advanced named-stage selection for scripts or focused diagnostics.
- `check`: compatibility alias for older automation; prefer `run` for new use.

## Diff-Only

`--diff-only` scopes file-local stages to the supplied changed files: `lint`, `format`, `sloc`, `complexity`, and `maintainability`.

Full-run stages stay selected and use the workspace context because they cannot be made safe from a changed-file list alone: `e2e`, `typecheck`, `unit`, `coverage`, and `security`.

## Useful Commands

```bash
npx @tjalve/aiq --help
npx @tjalve/aiq doctor
npx @tjalve/aiq config --print-config
npx @tjalve/aiq run src --dry-run
npx @tjalve/aiq run src --format json
```

`doctor` checks config/progress state and reports runtime prerequisites. `--dry-run` prints the exact plan without executing tools or writing artifacts.

## Development

This repository is the TypeScript monorepo for `@tjalve/aiq`.

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
pnpm run lint
pnpm test
pnpm run test:smoke
```
