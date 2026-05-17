# @tjalve/aie

AI Executor — autonomous GitHub issue execution for agentic development.

## Installation

Executor follows strict supply-chain policy.

**Recommended (pinned, no lifecycle scripts):**

```bash
pnpm install --frozen-lockfile --ignore-scripts
# or for one-off:
pnpm add @tjalve/aie@0.1.0 --ignore-scripts --save-exact
```

Do not use `pnpm add @tjalve/aie@latest` as the preferred path.

The package has no `preinstall`, `install`, or `postinstall` scripts.

## Usage

```bash
aie --version
aie --help
```

Initialize a repository after installing the package:

```bash
aie init . --dry-run
aie init . --defaults --yes
```

Check repository readiness before starting work:

```bash
aie doctor
aie schema --json
```

## Migration

Repositories that already have copied issue-workflow helpers can inspect and migrate to package-backed Executor commands without changing files first:

```bash
aie migrate map
aie migrate legacy
aie migrate legacy --dry-run
aie migrate legacy --dry-run --json
```

`aie migrate legacy --dry-run` shows detected legacy paths, instruction references that can be updated, compatibility wrappers that could be installed, cleanup candidates, preserved files, conflicts, required confirmations, and the next recommended command. Review that plan before applying any local file changes.

For a full adoption guide, see [docs/migration.md](docs/migration.md).

Apply only the specific migration action you intend:

```bash
aie migrate legacy --apply --dry-run
aie migrate legacy --apply
aie migrate legacy --install-wrappers --dry-run
aie migrate legacy --install-wrappers --apply
aie migrate legacy --cleanup --dry-run
aie migrate legacy --cleanup --apply
```

Compatibility wrappers are temporary shims for repositories whose instructions still call old helper paths. Cleanup removes only known legacy helper files unless exact paths are selected and reviewed with the documented force behavior. After any apply run, review the git diff, run the configured checks, and commit only intentional source and documentation changes.

After migration, use the normal autonomous issue cycle:

```bash
aie queue
aie start next --dry-run
aie start next
aie doctor
```

## Requirements

- Node.js 24 LTS or newer
- `git`
- GitHub CLI `gh`

## Design

See [docs/spec.md](docs/spec.md) for the functional requirements.
