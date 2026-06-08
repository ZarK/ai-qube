# AI Bootstrap Planning Docs

These documents capture the current product understanding for `ai-bootstrap` without forcing the repository to use its own generated spec/milestone format.

The intent is to keep `aib` clear enough to implement while avoiding confusing recursive artifacts such as "a spec for specs" or "a milestone for milestones".

## Documents

- [Product Model](product-model.md) - what `aib` is, what it owns, and what it must not assume.
- [Planning Workflow](planning-workflow.md) - the staged idea-to-work-item process.
- [Architecture](architecture.md) - package, state, provider, and agent-host boundaries.
- [Work Buckets](work-buckets.md) - implementation buckets aligned to the existing GitHub issue queue.
- [Issue Alignment](issue-alignment.md) - mapping between the current issues and missing work.

## Core Product Sentence

`aib` turns a vague idea into a clarified project definition, milestone plans, and durable work items that an execution agent can safely act on later.

It should help the user discover what the project is before it asks how the project should be engineered.

