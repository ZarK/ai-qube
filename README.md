# ai-bootstrap

Bring an idea, not a design document.

This repo is a discovery-first bootstrap kit for AI coding agents. Its canonical source lives in `.agent/`, and bootstrap scripts project that source into the tool-specific layout your agent expects.

OpenCode is the first-class MVP target. Claude Code, Codex, and Gemini get best-effort projections built from the same source, and those mirrors are intentionally lossy when a tool does not support the same features.

The source repo stays projection-clean. Run bootstrap into a real target project or a disposable `test-harness/` project instead of projecting into this repo root.

## Quick Start

1. Clone this repo somewhere stable, for example `~/src/ai-bootstrap`.
2. Pick the tool you want to bootstrap with.
3. Install a global `/bootstrap` command using the prompt below.
4. Run `/bootstrap I want to build a local AI DJ music generator`.
5. Answer the discovery questions in small batches.
6. Review and accept `docs/spec.md`.
7. Generate milestones, issues, and the final harness.

## OpenCode (recommended)

OpenCode documentation has historically shown both `command/` and `commands/`. For the safest setup, install the same prompt into both:

- `~/.config/opencode/commands/bootstrap.md`
- `~/.config/opencode/command/bootstrap.md`

Use this prompt as the file contents:

```md
---
description: Bootstrap a new project from a fuzzy idea
---

Use `~/src/ai-bootstrap` as the bootstrap brain. If it does not exist yet, clone the `ai-bootstrap` repository there.

When this command is run:
- treat `~/src/ai-bootstrap/.agent/` as the source of truth
- run `~/src/ai-bootstrap/scripts/bootstrap-init.sh --tool opencode --target "$PWD" --idea "$ARGUMENTS"`
- continue the local bootstrap workflow from the target repo

Bootstrap workflow:
1. run discovery in small batches
2. write or revise `docs/spec.md`
3. get section-by-section spec acceptance
4. generate milestone docs
5. generate issue drafts or GitHub issues
6. finalize the tool projection and project harness

Rules:
- prefer `AGENTS.md` as the shared instruction file
- keep `.agent/` canonical and regenerate projections instead of editing generated files first
- support OpenCode natively, and use best effort for other agent tool layouts when asked
```

## Claude Code

Create a global `bootstrap.md` command under your Claude Code commands directory and use this prompt:

```md
Use `~/src/ai-bootstrap` as the bootstrap brain. If it is missing, clone the `ai-bootstrap` repository there.

When invoked, run:
`~/src/ai-bootstrap/scripts/bootstrap-init.sh --tool claude --target "$PWD" --idea "$ARGUMENTS"`

Then continue the discovery-first bootstrap flow inside the target repo:
- discovery interview
- `docs/spec.md` draft
- spec acceptance
- milestones
- issues
- harness finalization

Treat `.agent/` as the canonical source and regenerate projections after editing it.
```

## Codex CLI / Codex App

Codex already works well with `AGENTS.md`, so the MVP path is simple: save a global bootstrap prompt in your preferred command wrapper and use this content:

```md
Use `~/src/ai-bootstrap` as the bootstrap brain. If it is missing, clone the `ai-bootstrap` repository there.

When invoked, run:
`~/src/ai-bootstrap/scripts/bootstrap-init.sh --tool codex --target "$PWD" --idea "$ARGUMENTS"`

Then continue the local bootstrap workflow from the target repo using `AGENTS.md` plus the projected best-effort Codex assets.
```

## Gemini CLI

Save a global bootstrap prompt in your Gemini commands directory and use this content:

```md
Use `~/src/ai-bootstrap` as the bootstrap brain. If it is missing, clone the `ai-bootstrap` repository there.

When invoked, run:
`~/src/ai-bootstrap/scripts/bootstrap-init.sh --tool gemini --target "$PWD" --idea "$ARGUMENTS"`

Then continue the discovery-first bootstrap workflow from the target repo. Prefer the projected `GEMINI.md` and `AGENTS.md` files, and keep `.agent/` as the source of truth.
```

## Bootstrap Flow

The bootstrap system follows this order:

1. idea
2. discovery interview
3. dry spec draft
4. spec revision and acceptance
5. milestones
6. issues
7. harness and tool projection

Milestones start only after the spec is accepted. Issues start only after milestones exist.

## Initialize A Repo Manually

If you want to seed a repo without the global command, run one of these from this repo:

```bash
./scripts/bootstrap-init.sh --tool opencode --target /path/to/project --idea "I want to build a local AI DJ music generator"
./scripts/bootstrap-init.sh --tool claude --target /path/to/project --idea "I want to build a local AI DJ music generator"
./scripts/bootstrap-init.sh --tool gemini --target /path/to/project --idea "I want to build a local AI DJ music generator"
./scripts/bootstrap-init.sh --tool codex --target /path/to/project --idea "I want to build a local AI DJ music generator"
```

For a disposable local smoke test, run:

```bash
./scripts/test-harness.sh opencode
```

## What Gets Seeded

Bootstrap copies or updates:

- `.agent/` source assets
- `AGENTS.md`
- tool-specific projections such as `.opencode/commands/` and `.opencode/plugins/`
- `.bootstrap/session.yaml`
- `.bootstrap/discovery-log.md`
- `.bootstrap/assumptions.md`
- `docs/spec.md`

## Canonical Layout

```text
.agent/
  commands/
  plugins/
  rules/
  skills/
  templates/
scripts/
  bootstrap-init.sh
  project_assets.py
AGENTS.md
```

Edit `.agent/` first, then regenerate projections.
