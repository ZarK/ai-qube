# QUBE Agent Harness Surfaces

QUBE configures an agent harness. You can still run every QUBE command in a terminal, but the terminal is not an agent harness and has no instruction, task, review, or continuation surface.

The version 1 profiles for the five harnesses below are the source of truth for `qube init`, Executor instructions, Make It So, review routing, model discovery, and Umpire continuation. The profiles contain declarations only. Executable parsers, invocations, and probes remain in the adapter packages and are not serialized.

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

The serialized profile keeps the following dimensions separate: task read and write; subagent invocation; host-guided and isolated review; model catalog and model-bound invocation; Stop hooks, idle events, selected-session delivery, and wait behavior; session targeting and resume; process restart; authentication; repository trust; read-only sandboxing; and permission approval. A direct prompt or Stop hook does not imply wait, selected-session, resume, or restart support.

OpenCode delivers Umpire prompts through its host integration. Codex, Claude Code, and Grok Build use managed Stop hooks. Run `qube aiu verify --tool <host> --json` to test the native allow and continue paths in a disposable repository. The command warns before model use and records active evidence only after the harness consumes a continuation response and completes the next turn. Grok Build remains experimental. Cursor has no Umpire continuation asset, so Umpire setup records no continuation delivery for Cursor and does not claim support.

## Runtime readiness

Declared support and observed readiness are different. `qube components --json` reports the version 1 declared profile and a separate version 1 readiness report for each harness. Each report contains adapter, executable identity, observed version, supported-version status, authentication, repository trust, managed assets, and feature activation facts. Every fact is `ready`, `blocked`, `unknown`, or `not-required` and includes a stable reason code, an observation time, a bounded explanation, and a safe next action.

Component discovery performs only a local executable lookup. A name on `PATH` remains `unknown` until the selected command runs the bounded adapter probe that verifies identity, version, authentication, and any other facts that command requires. Help, version, queue, issue view, and status do not request harness authentication, model, or trust probes. A missing optional harness capability therefore does not block those commands.

## Current init flow

Run the guided setup in the repository:

```sh
qube init
```

The guide asks only the questions that apply. It covers agent harnesses, the
issue tracker, automated checks, Continuous Shipping, Umpire, Quality checks,
and Review. See the [guided init guide](./qube-init.md) for every choice and
recommendation.

All four QUBE products participate in one init run:

1. Bootstrap prepares repository planning for the selected harnesses.
2. Executor prepares issue work, automated checks, review, and shipping policy.
3. Quality Control prepares the selected quality stages.
4. Umpire prepares the selected continuation scope.

QUBE writes the instructions and the canonical Make It So entry point for each
selected harness. It uses each harness capability profile to include only
supported behavior.

Use `--dry-run --json` to inspect the resolved answers without changing the
repository. Use `--yes` or `--defaults` for noninteractive setup. A rerun keeps
valid current values. If all values match, it makes no changes.

After init completes, start a new agent session. The harness then loads the new
instructions and Make It So entry point.

## Runtime boundary

QUBE resolves component CLIs from its own install or from the current repository install. It does not load a QUBE component from an unrelated executable on the ambient `PATH`.

The harness owns the agent session, model access, task tools, subagents, and hooks that it exposes. QUBE writes instructions and configuration, invokes QUBE commands, records evidence, and reports capability state. QUBE does not install, update, authenticate, trust, restart, or wrap an agent harness. An external launcher remains outside QUBE; correct operation through that launcher depends on it preserving the harness workspace, process, and session behavior declared by the selected QUBE capability.
