# Architecture

## System Shape

`aib` should become a CLI-backed planning engine with agent-facing JSON commands and provider renderers.

The agent owns conversation, file reading, and judgment. `aib` owns durable state, phase transitions, artifact paths, validation, and machine-readable next actions.

```text
+--------+       +--------------+       +-------------------+
| Human  | <-->  | Agent Host   | <-->  | aib CLI / State   |
+--------+       +--------------+       +-------------------+
                         |                       |
                         v                       v
                  Local repo/docs        Planning artifacts
                         |                       |
                         v                       v
                  Provider adapters      Work item renderers
```

## State Model

Planning state should include:

- idea
- project name candidates
- project type
- audience
- scope
- non-goals
- accepted decisions
- assumptions
- unanswered questions
- current phase
- spec status and accepted sections
- generated milestone paths and status
- generated work item draft paths and status
- provider choices
- provider-created IDs/URLs
- agent host choices
- next recommended action
- stop condition, when blocked

State should be versioned and validated. Invalid or stale state should produce actionable errors.

## Agent JSON Protocol

Agents should be able to call commands such as:

- `aib init --idea ... --json`
- `aib status --json`
- `aib next --json`
- `aib answer --json`
- `aib spec draft --json`
- `aib spec accept --section ... --json`
- `aib milestones generate --json`
- `aib work-items generate --json`
- `aib work-items render --provider ... --json`

The important product rule is that `aib next --json` tells the agent what kind of next action is needed:

- ask the human
- inspect local context
- draft or revise a spec
- request section acceptance
- generate milestones
- generate work item drafts
- render provider work items
- stop because a human decision is required

Human-readable output can exist, but automation output must be valid JSON without decorative text on stdout.

## Provider Model

Core `aib` should not assume GitHub. It should model:

- work provider
- forge provider
- review provider
- CI provider
- layout provider

GitHub is the first happy-path renderer. Markdown export should exist as a no-provider fallback.

Provider-specific IDs, URLs, labels, and status mappings belong in planning state or provider metadata, not in product requirements.

## Agent Host Model

OpenCode, Codex, Claude Code, Gemini CLI, Cursor, and other tools should be treated as agent hosts with capabilities.

Agent-host adapters may render:

- `AGENTS.md` sections
- slash commands
- prompt files
- rules
- skills
- plugins
- todo guidance
- continuation prompts

The core product should ask for or detect host capabilities instead of hardcoding OpenCode behavior everywhere.

## Repository Layout Model

`aib` should not assume a single coding project at the repo root.

It should support:

- new coding project
- existing coding project
- package/library
- monorepo/workspace
- docs/content project
- research project
- design or planning project
- process or operations project
- export-only project with no provider mutation

Repository layout details should influence milestone and work item generation, but they should not dominate the first user interview.

## Template And Artifact Rendering

Templates should remain profile-aware but not profile-bound too early.

Profiles are useful later:

- CLI/tooling
- web UI
- desktop UI
- backend service
- local AI app
- data/media project
- docs/research/process project

The spec phase may infer candidate profiles. The milestone and work item phases can lock or refine them.

## Safety Boundaries

`aib` can write planning artifacts and generated instructions. It should not:

- execute project implementation work
- install global agent assets without explicit approval
- mutate providers before showing or saving drafts
- assume work provider mappings when a provider cannot prove them
- hide unresolved questions in generated artifacts
