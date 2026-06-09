# AI Bootstrap Planning Docs

These documents capture the current product understanding for `ai-bootstrap` without forcing the repository to use its own generated spec/milestone format.

The intent is to keep `aib` clear enough to implement while avoiding confusing recursive artifacts such as "a spec for specs" or "a milestone for milestones".

## Documents

- [Product Model](product-model.md) - what `aib` is, what it owns, and what it must not assume.
- [Planning Workflow](planning-workflow.md) - the staged idea-to-work-item process.
- [Architecture](architecture.md) - package, state, provider, and agent-host boundaries.
- [Core Contracts](contracts.md) - neutral planning state, work item drafts, capabilities, and render adapter boundaries.
- [Work Buckets](work-buckets.md) - implementation buckets aligned to the existing GitHub issue queue.
- [Issue Alignment](issue-alignment.md) - mapping between the current issues and missing work.

## Core Product Sentence

`aib` turns a vague idea into a clarified project definition, milestone plans, and durable work items that an execution agent can safely act on later.

`aib` is not primarily a human-facing interactive CLI. It is an agent-facing planning CLI. The human talks to an AI agent; the agent calls `aib` for structured next actions, asks the human the returned questions, records the answers, and lets `aib` guide the bootstrap process forward.

It should help the user discover what the project is before it asks how the project should be engineered.
