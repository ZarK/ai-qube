# @tjalve/qube-core

Shared provider-neutral contracts for the QUBE package family: work items, review
forge surfaces, gate evidence, agent host profiles, and adapter boundaries.

Product CLIs such as `@tjalve/aie`, `@tjalve/aib`, and adapter packages depend
on this package at runtime. Most users install it transitively through
`@tjalve/aie`, `@tjalve/qube`, or an adapter install.

For the full QUBE package family and command deck, see
https://zark.github.io/ai-qube/ or the repository landing-page artifact at
https://github.com/ZarK/ai-qube/blob/HEAD/docs/index.html.

## Install

```sh
npm install --save-exact --ignore-scripts @tjalve/qube-core@0.2.1
```

Adapter and executor installs usually pull this package automatically:

```sh
npm install --save-exact --ignore-scripts @tjalve/aie@0.2.0 @tjalve/qube-adapter-github@0.1.1 @tjalve/qube-adapter-codex@0.1.1
```

## Requirements

- Node.js 24 or newer

## Contract modules

Shared provider-neutral QUBE contracts live in focused source modules. The package root `index.ts` is a public re-export surface only; new contracts should be owned by a focused module first, then exported once from the root.

## Contract Ownership

- `json_value.ts`: `JsonValue`, `JsonObject`.
- `provider_source.ts`: provider resource identity and source normalization.
- `work_item_key.ts`: provider-neutral work item keys and key helpers.
- `work_item.ts`: work item shape, checklist parsing, work item normalization, and issue-number helpers.
- `action_plan.ts`: provider-neutral action plan shapes and action-plan helpers.
- `work_provider.ts`: work provider capabilities, executor policy, and provider interface.
- `gate_evidence.ts`: gate definitions, gate evidence, and evidence normalization.
- `review_item.ts`: review item, merge blocker, conversation, feedback, and review-thread resolution contracts.
- `review_forge.ts`: review forge provider, review request, lane publishing, and review finding contracts.
- `review_participant.ts`: configured review participant coordination and rollup helpers.
- `agent_host.ts`: agent host profiles and host review-runner capability contracts.
- `review.ts`: compatibility barrel only; do not add contract definitions here.

Keep product-specific policy and runtime behavior in product packages such as `@tjalve/aie`. QUBE core should stay provider-neutral and should not duplicate type definitions across modules.
