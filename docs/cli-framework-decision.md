# CLI Framework Decision Record

**Date:** 2026-05-14  
**Status:** Accepted for M1.2  
**Milestone:** M1 - Package and CLI Foundation (issue #2)

## Selected Dependencies

- **@oclif/core** (^4.2.0, resolved 4.11.x) — Command tree, argument/flag parsing, help system, `--json` surfaces, hooks, and topic support with space separator.
- **@clack/prompts** (to be added in M4 when `aie init` interactive flows are implemented; target 1.3.0 or newer satisfying age gate) — Lightweight TTY prompts for initialization and future flows that always have non-interactive flag/config equivalents.

## Why These Choices

@oclif/core provides:
- Native support for space-separated command topics (`aie labels setup`, `aie pr gate`) via `topicSeparator: " "`.
- Per-command `enableJsonFlag` with `jsonEnabled()`, `logJson()`, and `toSuccessJson()` for deterministic agent output without decorative text.
- Extensible `Help` base class (`showRootHelp`, `showTopicHelp`, `showCommandHelp`) and `command_not_found` hook for progressive human discovery and safe suggestions.
- Built-in `--version` top-level handling, `additionalHelpFlags: ["help"]` for `aie <topic> help` forms, and automatic stdout/stderr separation via `log()` vs `logToStderr()`.
- Small, focused runtime surface (ansis for color, supports-color for TTY detection) with no install lifecycle scripts, no remote execution, and long provenance under the oclif GitHub org.
- TypeScript-first with strict config and cached command metadata usable for `aie schema`.

@clack/prompts will be used only for interactive paths (init prompts, optional confirmations) that are always bypassable via flags (`--defaults`, `--yes`) or config. It is a small, focused prompt library with no hidden side effects.

Both packages were reviewed against supply-chain guard: exact versions, 7-day (14-day preferred for UX) age gate, no lifecycle scripts in their manifests, source repo matches published package, no native binaries or postinstall, lockfile impact limited to narrow runtime surface.

## Rejected Alternatives

- **Commander.js**: Minimal parser. Lacks first-class topic/subcommand grouping with space separator, built-in JSON flag contract, extensible help base for custom landing/incomplete-command UX, and `command_not_found` hook. Would require significantly more custom code to meet FR-15 explorability and agent schema requirements.
- **yargs**: Strong parsing and completion, but heavier dependency graph, less ergonomic TypeScript declaration for shared metadata, and different help/completion model that would duplicate oclif's topic and JSON strengths.
- **Clipanion**: Excellent type safety. Smaller ecosystem and fewer examples for custom root/topic help, schema introspection, and hook-based error surfaces needed for safe suggestions and landing page.
- **Ink**: React-based TUI renderer. Far too heavy for a command-oriented CLI; only relevant for dashboard-style views that are not in scope.

## Tradeoffs And Constraints

- oclif's command discovery and help system require a small amount of framework-specific wiring (custom Help subclass, hooks, BaseCommand), but this is localized and enables the single source-of-truth metadata model required by FR-15-019.
- No TypeScript runtime loader (`ts-node`/`tsx`) added as devDependency. Active command development requires `npm run build` before `./bin/dev` or `./bin/run`. This keeps the published package surface minimal and avoids another dev tooling package that would need age/provenance review.
- `@clack/prompts` is intentionally not added in M1.2. It will be introduced in M4 (`aie init`) after passing the age gate and supply-chain checklist at that time. Decision record already names it so later milestones do not re-evaluate the choice.
- Color handling relies on oclif's ansis + supports-color (respects `NO_COLOR`, `FORCE_COLOR`, and `--no-color` when wired as base flag). No additional color package.
- Completion surface in M1.2 is a documented `aie completion` command printing setup instructions rather than pulling in `@oclif/plugin-autocomplete`. Full shell completion can be added later without breaking the metadata model.

## Implementation Notes For M1.2

- A small internal `CommandMeta` registry (src/commands/meta.ts) captures mutation behavior, dry-run support, JSON support, examples, and stable error kinds. This drives custom help text, `aie schema --json`, suggestion lists, and future docs/tests.
- All placeholder and real commands extend `BaseCommand` which enforces consistent error wording ("failed operation: …; likely cause: …; next action: …"), exit codes (0 success, 1 internal, 2 user/invalid, 3 not-implemented), and stdout (data) / stderr (diagnostics, warnings, progress).
- Unimplemented reserved commands (`init`, `labels setup`, `start`, `pr gate`, etc.) are explicit placeholders that exit 3 with a clear message and do not touch git, GitHub, or the filesystem.
- Root (`aie` with no arguments), incomplete topics (`aie labels`, `aie deps`, `aie start`, `aie pr`), and `aie doctor --help` all demonstrate the required progressive discovery and mutation labeling.
- `aie schema --json` and `aie completion` are the first agent-facing surfaces.

This decision satisfies FR-15-001 through FR-15-020 and FR-13-001/003 for the CLI UX and observability foundations while keeping runtime dependencies minimal and supply-chain posture strict.

Next milestone that touches the CLI stack (M4 init) will re-confirm the @clack/prompts version against the age gate before `npm install --save-exact --ignore-scripts`.
