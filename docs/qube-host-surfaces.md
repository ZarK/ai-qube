# QUBE Agent Harness Surfaces

QUBE configures an agent harness. You can still run every QUBE command in a terminal, but the terminal is not an agent harness and has no instruction, task, review, or continuation surface.

The five harness profiles below are the current source of truth for `qube install`, `qube init`, Executor instructions, Make It So, review routing, model discovery, and Umpire continuation.

## Harness setup

| Harness | Adapter package | Instruction file | Make It So asset | Start command |
| --- | --- | --- | --- | --- |
| OpenCode | `@tjalve/qube-adapter-opencode` | `AGENTS.md` | `.opencode/commands/make-it-so.md` | `/make-it-so` |
| Codex | `@tjalve/qube-adapter-codex` | `AGENTS.md` | `.agents/skills/make-it-so/SKILL.md` | `$make-it-so` |
| Claude Code | `@tjalve/qube-adapter-claude-code` | `CLAUDE.md` | `.claude/commands/make-it-so.md` | `/make-it-so` |
| Grok Build | `@tjalve/qube-adapter-grok-build` | `AGENTS.md` | `.grok/commands/make-it-so.md` | `/make-it-so` |
| Cursor | `@tjalve/qube-adapter-cursor` | `AGENTS.md` | `.cursor/commands/make-it-so.md` | `/make-it-so` |

QUBE uses a command asset where the harness supports project commands. Codex uses a skill because that is its project-level invocation surface.

## Capability matrix

`Experimental` means that QUBE has a tested integration with explicit limits or verification requirements. `Unsupported` means that QUBE does not claim or install that capability.

| Harness | Task list | Subagents | Host-local review | Isolated review | Live model list | Umpire continuation |
| --- | --- | --- | --- | --- | --- | --- |
| OpenCode | Supported | Supported | Supported | Unsupported | Supported | Supported |
| Codex | Supported | Supported | Supported | Supported | Supported | Experimental |
| Claude Code | Supported | Supported | Supported | Unsupported | Unsupported | Experimental |
| Grok Build | Unsupported | Supported | Supported | Supported | Supported | Experimental |
| Cursor | Unsupported | Unsupported | Unsupported | Supported | Supported | Unsupported |

Host-local review uses fresh subagents inside the selected harness and can use the same subscription as the main agent. Isolated review starts a separate supported CLI harness in a read-only review session. External review services are configured through Executor and are not agent harness capabilities.

OpenCode delivers Umpire prompts through its host integration. Codex, Claude Code, and Grok Build use managed Stop hooks. Umpire reports these integrations as unverified until it observes a valid event. Cursor has no Umpire asset, so Cursor-only init does not run Umpire setup.

## Current init flow

Use one or more harness ids with `--host`:

```sh
qube init . --host codex --yes
qube init . --host opencode,codex,claude-code,grok-build,cursor --yes --json
```

`qube init` does the following work:

1. It runs Executor init once with every selected harness and the selected issue tracker, review provider, and automated-checks provider.
2. It uses the first selected harness as the primary model-routing host unless you select another installed primary host.
3. It runs Umpire init once for each selected harness that has an Umpire surface: OpenCode, Codex, Claude Code, or Grok Build.
4. It writes the instruction file and the single canonical Make It So asset for each selected harness.
5. It reports create, update, skip, or conflict actions. A repeated run reuses the current configuration and reports only the remaining work.

Executor (`@tjalve/aie`) and Umpire (`@tjalve/aiu`) participate by default. Add Bootstrap (`@tjalve/aib`) or Quality (`@tjalve/aiq`) with `--with aib`, `--with aiq`, or `--with aib,aiq`.

Use `--dry-run --json` to inspect the plan without writing files. Use `--defaults --json` when an agent needs a non-interactive init with the repository defaults. After init completes, start a new agent session so the harness loads the new instructions and Make It So asset.

The selected harness profile also supplies its trust steps. Executor instructions include attribution hygiene by default so public git and GitHub writes use the human project identity. Use `--no-credit-warning` only when you intentionally do not want those rules.

## Runtime boundary

QUBE resolves component CLIs from its own install or from the current repository install. It does not load a QUBE component from an unrelated executable on the ambient `PATH`.

The harness owns the agent session, model access, task tools, subagents, and hooks that it exposes. QUBE writes instructions and configuration, invokes QUBE commands, records evidence, and reports capability state. QUBE cannot force a harness or model to obey those instructions.
