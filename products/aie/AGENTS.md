# Executor Package Instructions

Follow the repository instructions in the root `AGENTS.md` file. The root file defines issue workflow, shipping, review, audit, supply-chain, and Git rules.

Before you change this package, read the active issue, its comments, and [docs/spec.md](docs/spec.md).

## Product Changes

- Describe Executor behavior, requirements, and command semantics.
- Keep implementation artifacts free of issue history, local paths, and process notes.
- Implement complete product behavior. Do not add placeholders, stubs, or no-op paths.
- Update affected product documentation when behavior or commands change.
- Do not commit generated build output unless repository policy permits it.

## TypeScript

- Use strict TypeScript.
- Avoid `any`. Use `unknown` only when the code immediately narrows it.
- Prefer small typed contracts and focused functions.
- Avoid hidden global state and broad utility modules.
- Use structured parsers and APIs instead of ad hoc string handling.
- Drive CLI behavior from shared command metadata.
- Use `@oclif/core` for the command tree.
- Use `@clack/prompts` only when flags or config provide an equivalent non-interactive path.
- Do not add `preinstall`, `install`, or `postinstall` scripts.
- Do not install or recommend shell completion.
- Package scripts must perform a real check or fail.

## Verification

- Test product behavior instead of implementation details.
- Keep human output and JSON output separate.
- Make errors state the failed operation, likely cause, and next action.
