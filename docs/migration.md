# Executor Migration Guide

This guide covers the safe path from repository-local issue workflow helpers to package-backed Executor commands.

## Install Safely

Use pinned package versions and disable dependency lifecycle scripts where your package manager supports it:

```bash
pnpm add @tjalve/aie@0.1.2 --ignore-scripts --save-exact
```

For checked-in projects, prefer lockfile-based installs:

```bash
pnpm install --frozen-lockfile --ignore-scripts
```

Executor does not require `preinstall`, `install`, or `postinstall` scripts for normal use.

## Initialize A Repository

Preview the managed config and instruction changes first:

```bash
aie init . --dry-run
```

Then apply the selected repository policy explicitly:

```bash
aie init . --defaults --yes
```

Use `aie doctor` after initialization to check runtime tools, config, instructions, labels, queue health, migration state, wrapper state, and recommended next commands.

## Inspect Migration State

Start with read-only commands:

```bash
aie migrate map
aie migrate legacy
aie migrate legacy --dry-run
aie migrate legacy --dry-run --json
```

The dry-run plan reports detected legacy paths, instruction references, compatibility wrapper options, cleanup candidates, preserved files, conflicts, required confirmations, state-preservation guarantees, and the next recommended command. JSON output is intended for agents and automation; human output is intended for review before any local file mutation.

## Apply Instruction Updates

Apply only after reviewing the dry-run plan:

```bash
aie migrate legacy --apply --dry-run
aie migrate legacy --apply
```

Managed instruction sections can be updated safely while preserving user-authored text outside managed sections. Unmanaged instruction files require explicit path selection and documented force behavior after review.

## Choose Wrappers Or Cleanup

Compatibility wrappers are temporary shims for repositories whose existing instructions still call old helper paths:

```bash
aie migrate legacy --install-wrappers --dry-run
aie migrate legacy --install-wrappers --apply
```

Wrappers delegate to package-backed `aie` commands and print a deprecation notice. They should be removed after instruction references have been updated.

Cleanup removes known legacy helper files only when explicitly requested:

```bash
aie migrate legacy --cleanup --dry-run
aie migrate legacy --cleanup --apply
```

Cleanup preserves project-specific scripts and review-required files unless exact paths are selected and the documented force behavior is used after review.

## Review The Diff

After any apply run:

1. Inspect the local git diff.
2. Confirm only intended instruction, wrapper, cleanup, or config files changed.
3. Confirm labels, blocker metadata, sequence metadata, milestone assignments, issue state, branch state, and git history were not changed by migration.
4. Run the configured checks for the repository.
5. Commit only intentional source and documentation changes.

For agent-assisted review and PR readiness, use the same review surfaces as normal issue work:

```bash
aie review gate <issue> --dry-run
aie pr body <issue>
aie pr gate <pr> --dry-run
```

These commands help agents review the local diff, prepare pull request context, and inspect configured PR review obligations without treating review output as workflow policy.

## Continue Issue Work

After migration is clean, use the normal issue cycle:

```bash
aie doctor
aie queue
aie start next --dry-run
aie start next
aie complete <issue> --check-only
```

`aie doctor --json` exposes machine-readable migration readiness, compatibility wrapper state, stale wrapper paths, remaining legacy references, cleanup status, and recommended commands for agents.

`aie schema --json` exposes the implemented command contract, including migration commands, flags, mutation targets, dry-run support, JSON support, stable error kinds, stable exit codes, and migration enum values.
