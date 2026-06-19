# QUBE Host And Adapter Surfaces

This matrix records host integration ownership by product. It separates real product surfaces from shared adapter contract packages.

| Product | Package | CLI | GitHub | OpenCode | Ownership decision |
| --- | --- | --- | --- | --- | --- |
| Bootstrap | `@tjalve/aib` | yes | yes | yes | AIB owns planning state and work-item rendering. GitHub output is currently a safe preview/rendering surface; OpenCode output is bootstrap command/instruction installation. |
| Executor | `@tjalve/aie` | yes | yes | yes | AIE owns GitHub work-item, PR, queue, branch, review, and completion behavior. It also owns host instruction init/migration for agent execution workflows. |
| Quality | `@tjalve/aiq` | yes | no | no | AIQ owns quality command behavior and evidence. Its GitHub Action and OpenCode plugin packages are standalone adapters, not QUBE-facing GitHub/OpenCode product surfaces. |
| Umpire | `@tjalve/aiu` | yes | no | yes | AIU owns continuation policy, trusted state, OpenCode plugin composition, stop-hook handling, and local continuation state. |

The private packages `@tjalve/qube-adapter-github` and `@tjalve/qube-adapter-opencode` are contract-only packages until their behavior is shared by multiple products. They document provider boundaries and helper types; product packages still own product-specific command behavior and side effects.

`packages/qube-core` is the checked source of truth for this table. Tests fail if `qubeProductContracts` drifts from the documented ownership decisions.
