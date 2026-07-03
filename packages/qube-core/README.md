# @tjalve/qube-core

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
