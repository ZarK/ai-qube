# QUBE Host And Adapter Surfaces

This matrix records host integration ownership by product. It separates real product surfaces from shared adapter contract packages.

| Product | Package | CLI | GitHub | GitLab | Linear | Codex | OpenCode | Claude Code | Ownership decision |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Bootstrap | `@tjalve/aib` | yes | yes | yes | yes | yes | yes | yes | AIB owns planning state and work-item rendering. GitHub, GitLab, and Linear output are safe preview/rendering surfaces; Codex, OpenCode, and Claude Code output is host instruction installation, with OpenCode adding project command assets. |
| Executor | `@tjalve/aie` | yes | yes | yes | yes | yes | yes | yes | AIE owns GitHub work-item, PR, queue, branch, review, and completion behavior. It also owns GitLab and Linear read mapping with explicit lifecycle mutation gaps, plus Codex/OpenCode/Claude Code host instruction init/migration for agent execution workflows. |
| Quality | `@tjalve/aiq` | yes | no | no | no | no | no | no | AIQ owns quality command behavior and evidence. Its GitHub Action and OpenCode plugin packages are standalone adapters, not QUBE-facing GitHub/OpenCode product surfaces. |
| Umpire | `@tjalve/aiu` | yes | no | no | no | no | yes | yes | AIU owns continuation policy, trusted state, OpenCode plugin composition, Claude Code stop-hook handling, and local continuation state. |

`@tjalve/qube` includes the installed Codex host capability layer. It detects project `AGENTS.md`, reports Codex-local todo, command execution, Browser use, and worktree/handoff capabilities as host-provided, and reports unsupported Codex operations such as OpenCode-style project command installation, direct external reviewer invocation, branch creation, and pull request creation with actionable next steps.

Product packages still own Codex-specific side effects:

- AIB can plan or write `AGENTS.md` instruction assets for Codex through `qube aib init . --agent codex`.
- AIE can install managed Executor instructions for Codex through `qube aie init . --tool codex` and still owns branch, PR, review, and completion workflow.
- QUBE installer guidance consumes the Codex capability layer for `qube install --host codex` notes.
- Codex host todo state remains local session state; durable work state stays in GitHub issues, pull requests, and `.qube/` artifacts.

`@tjalve/qube` includes the installed Claude Code host capability layer. It detects project `CLAUDE.md`, `.claude/settings.json`, `.claude/commands`, and `.claude/skills`, reports Claude Code todo state, command execution, hooks, slash commands, subagents, and session continuation as host-provided, and reports unsupported Claude Code operations such as QUBE-managed slash-command installation, direct external reviewer invocation, branch creation, and pull request creation with actionable next steps.

Product packages still own Claude Code-specific side effects:

- AIB can plan or write `CLAUDE.md` instruction assets for Claude Code through `qube aib init . --agent claude-code`.
- AIE can install managed Executor instructions for Claude Code through `qube aie init . --tool claude-code` and still owns branch, PR, review, and completion workflow.
- AIU owns the experimental Claude Code Stop hook integration through `qube aiu init --tool claude-code` and `qube aiu hook-stop --tool claude-code`.
- QUBE installer guidance consumes the Claude Code capability layer for `qube install --host claude-code` notes.
- Claude Code todo and conversation state remains local host state; durable work state stays in GitHub issues, pull requests, and `.qube/` artifacts.
- QUBE composer install notes do not create `.claude/commands` or `.claude/skills` assets.

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

## Linear Provider Surface

Linear support is an optional work-provider adapter package boundary, not bundled AIE core behavior. The planned `@tjalve/qube-adapter-linear` package owns Linear API access, credential diagnostics, issue mapping, capability flags, and unsupported-operation reporting. AIE core owns provider-neutral lifecycle orchestration and refuses to fall back to GitHub semantics when the optional adapter is missing.

Product boundaries:

- AIB renders provider-neutral work item drafts into Linear issue previews through `work-items render --provider linear --dry-run`.
- AIE reads Linear issues only when `providers.work.kind` is `linear`, the optional Linear adapter package is installed, and the documented Linear credentials are present.
- AIE lifecycle mutations for Linear workflow state, comments, assignees, and completion are explicitly unsupported until a tested Linear mutation adapter exists.
- Review and CI behavior remain separate provider choices; Linear work does not imply GitHub pull requests or GitHub Actions.

## GitLab Provider Surface

GitLab support is an optional work-provider adapter package boundary, not bundled AIE core behavior. The planned `@tjalve/qube-adapter-gitlab` package owns GitLab API access, credential diagnostics, issue mapping, capability flags, and unsupported-operation reporting. AIE core owns provider-neutral lifecycle orchestration and refuses to fall back to GitHub semantics when the optional adapter is missing.

Product boundaries:

- AIB renders provider-neutral work item drafts into GitLab issue previews through `work-items render --provider gitlab --dry-run`.
- AIE reads GitLab issues only when `providers.work.kind` is `gitlab`, the optional GitLab adapter package is installed, and the documented GitLab credentials are present.
- AIE lifecycle mutations for GitLab issue state, labels, comments, assignees, completion, merge requests, approvals, and CI pipelines are explicitly unsupported until tested GitLab mutation/review/CI adapters exist.
- Review and CI behavior remain separate provider choices; GitLab work does not imply GitHub pull requests or GitHub Actions.

`packages/qube-core` is the checked source of truth for this table. Tests fail if `qubeProductContracts` drifts from the documented ownership decisions.
