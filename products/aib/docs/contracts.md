# Core Contracts

`aib` uses provider-neutral and agent-host-neutral contracts as its product center. GitHub Issues and OpenCode command files are render targets, not the core vocabulary.

## Planning State

`PlanningState` is the durable machine-readable source of truth for the bootstrap process.

It uses neutral fields:

- `project` for intent, name, and project type
- `artifacts` for spec, milestone, and work item document status
- `workItemDrafts` for canonical units of work before provider rendering
- `providers` for capability reports from work, forge, review, CI, and layout providers
- `agentHosts` for capability reports from Codex, OpenCode, Claude Code, Gemini, or another host
- `nextAction` for the agent-facing instruction to perform next

Core state does not require GitHub issue numbers, GitHub milestones, pull requests, labels, URLs, or OpenCode paths. Provider adapters may store those details in adapter-owned metadata after rendering.

## Work Item Drafts

`WorkItemDraft` is the canonical work unit. It has:

- stable draft id
- title
- body sections
- priority
- draft status
- components
- dependencies on other draft ids
- sequence
- source anchors
- optional provider metadata

GitHub rendering can turn a `WorkItemDraft` into an issue title, body, labels, blocker lines, and URL metadata. Markdown rendering can export the same draft without GitHub authentication or network access.

## Capability Reports

`CapabilityReport` records what an adapter can do without forcing the core workflow to assume that support exists.

Every operation is one of:

- `supported`
- `unsupported`
- `unknown`
- `policy-blocked`

This applies to provider operations such as creating work items, reading review state, or running CI status checks, and agent-host operations such as rendering instructions, commands, prompts, todos, hooks, or continuation hints.

## Agent-Operated Contract

`aib` is operated by an AI agent working with a human.

The human speaks to the agent. The agent calls commands such as `aib next --json`, asks the returned questions in natural language, records answers, and lets `aib` advance durable planning state. Human-readable output remains useful for setup and debugging, but structured JSON is the product contract.
