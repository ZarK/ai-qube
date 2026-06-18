# Release Readiness

This release is scoped to the package CLI and local planning artifacts. It does not claim direct GitHub issue mutation or broad provider support.

## Stable MVP

- `aib init`, `aib next`, and `aib answer` for agent-operated discovery.
- `aib spec draft`, `aib spec validate`, `aib spec accept`, and `aib spec reopen`.
- `aib milestones generate`.
- `aib work-items generate`.
- `aib work-items render --provider markdown`.
- `aib work-items render --provider github --dry-run` for issue previews.
- Local agent asset projection for Codex and OpenCode, with best-effort Claude Code and Gemini instruction files.

## Local Gates

Run from the repository root:

```bash
pnpm --filter @tjalve/aib run verify
node products/aie/bin/run doctor --json
node products/aie/bin/run queue --json
```

`verify` is the package release gate. `aie doctor` and `aie queue` are repository readiness checks; any warnings should be read as release notes unless they block the active issue workflow.

Current intentional `aie doctor` warnings for this package workspace:

- Managed Executor instruction files are not installed at the repository root; `aib` release readiness does not require running `aie init`.
- OpenCode Executor make-it-so commands are not installed at the repository root; `aib` projects its own local bootstrap command only into target projects.
- The active issue may lack a GitHub milestone assignment; milestone ordering is advisory for this package release.

## Package Safety

- Use the exact package version, for example `@tjalve/aib@0.1.0`.
- Do not document or use floating `latest` in agent workflows.
- Use `pnpm install --frozen-lockfile --ignore-scripts` for repository setup.
- Do not add dependencies without supply-chain intake.
- Keep generated agent assets local to the target project; no global command, hook, skill, or credential installation is part of `aib init`.

## End-To-End Proof

The CLI test suite includes a deterministic flow from idea to answers, spec draft and validation, section acceptance, milestone generation, work-item generation, and markdown/GitHub render previews.

## Migration Notes

Older script scaffold material remains available as reference input. The current product path is package-first:

```text
aib init --agent <host> --json
aib next --json
aib answer --field <field> --value <answer> --json
aib spec draft --json
aib spec validate --json
aib spec accept --section all --json
aib milestones generate --json
aib work-items generate --json
aib work-items render --provider markdown --json
```

Do not point new quick starts at `scripts/bootstrap-init.sh` except as a migration note for older users.
