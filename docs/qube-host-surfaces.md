# QUBE Host And Adapter Surfaces

This matrix records host integration ownership by product. It separates real product surfaces from shared adapter contract packages.

| Product | Package | CLI | GitHub | OpenCode | Ownership decision |
| --- | --- | --- | --- | --- | --- |
| Bootstrap | `@tjalve/aib` | yes | yes | yes | AIB owns planning state and work-item rendering. GitHub output is currently a safe preview/rendering surface; OpenCode output is bootstrap command/instruction installation. |
| Executor | `@tjalve/aie` | yes | yes | yes | AIE owns GitHub work-item, PR, queue, branch, review, and completion behavior. It also owns host instruction init/migration for agent execution workflows. |
| Quality | `@tjalve/aiq` | yes | no | no | AIQ owns quality command behavior and evidence. Its GitHub Action and OpenCode plugin packages are standalone adapters, not QUBE-facing GitHub/OpenCode product surfaces. |
| Umpire | `@tjalve/aiu` | yes | no | yes | AIU owns continuation policy, trusted state, OpenCode plugin composition, stop-hook handling, and local continuation state. |

`@tjalve/qube-adapter-opencode` is the shared OpenCode host adapter. It detects `AGENTS.md` and `.opencode/commands`, reports the host todo tools (`todowrite` and `todoread`), records the supported project-command and prompt/stop-hook capability boundaries, and returns explicit unsupported-capability results for behavior that OpenCode does not own, such as external review requests, branch creation, or pull request creation.

Product packages still own product-specific side effects:

- AIB installs its OpenCode bootstrap instruction and command assets.
- AIE installs Executor OpenCode project commands and renders Oracle-style review prompts without invoking host-only reviewers.
- AIU owns OpenCode session continuation, prompt delivery, and stop-hook decisions from trusted state.
- AIQ exposes OpenCode quality tools through its standalone plugin package, not through a QUBE-facing host surface.

`@tjalve/qube-adapter-github` is the private shared GitHub provider adapter. It records the explicit capability model for GitHub issue work items, queue reads, status-label synchronization, pull request reads, review-gate requests, CI status normalization, CI diagnostics, review-thread reads, standalone AIQ GitHub Action behavior, and unsupported GitHub operations such as workflow-run triggering, pull request approval, repository file mutation, and release publishing.

Product packages still own GitHub-specific side effects:

- AIB renders provider-neutral work-item drafts into GitHub issue text without mutating GitHub.
- AIE owns GitHub issue queue reads, issue label/state transitions, branch and pull request workflow, configured review-gate requests, pull request review-state reads, unresolved review-thread collection, and CI status diagnostics.
- QUBE composes and dispatches product commands; it does not hide GitHub side effects behind a separate adapter command.
- AIQ exposes GitHub behavior only through its standalone GitHub Action package, not as a QUBE-facing GitHub provider surface.

`packages/qube-core` is the checked source of truth for this table. Tests fail if `qubeProductContracts` drifts from the documented ownership decisions.
