# AI Bootstrap Notes

`ai-bootstrap` (`@tjalve/aib`) owns the planning experience: turn an idea into a dry functional spec, milestone docs, and durable work items that agents can execute later. GitHub Issues are the default renderer, not the only core model.

## Planning UX

Bootstrap should reproduce the productive loop from Codex session `019e2728-ee2d-72a0-a26a-ba878d9ffe4c`:

- read nearby repositories and reference material before asking questions
- ask concrete questions in the human's language
- offer recommendations and defaults instead of broad abstract interviews
- turn rough answers into product boundaries and stable FRs
- keep the spec self-contained for future fresh-context milestone generation
- separate product requirements from source references and research material
- generate milestones by deliverable slice, not one work item per FR
- keep work item batches small enough to review and execute

Bootstrap should support interactive planning and Umpire-driven automatic planning. Automatic mode must be resumable across contexts and store durable state: current phase, known decisions, unanswered questions, draft paths, generated milestone/work-item status, next prompt, and stop condition.

## Reusable Package Planning

When Bootstrap plans a reusable package, it should inspect likely consumers and reference implementations to infer the real shared need, then generate a clean package spec that does not leak those consumers. The investigation is a planning input, not product content.

Bootstrap should:

- identify repeated behavior, duplicated glue, common safety rules, and integration constraints across references
- extract the smallest generic package purpose that would serve those references
- write requirements around public API, runtime behavior, package safety, tests, docs, and adoption validation
- keep specs and milestone docs dry: no consumer names, local paths, source-provenance sections, or "why this is useful for package X" notes
- express adoption proof generically, such as "validate one read-only command" and "validate one mutating or dry-run-capable command"
- preserve reference evidence only in planning state, provider comments, or internal notes, not in the generated product artifact
- ask for clarification when the reusable boundary is unclear instead of encoding current consumers into the core package

This rule lets Bootstrap use concrete context without turning a reusable package into an accidental application-specific package. Generated specs should remain understandable to a future reader who has never seen the reference repositories.

## Provider And Repository Impact

Provider modularity changes Bootstrap from "write GitHub issues" to "write canonical work item drafts and render them for a configured work provider."

Bootstrap should:

- detect or ask for the forge, work tracker, review provider, CI provider, and repository layout before final work-item generation
- keep specs and milestone docs provider-neutral unless the user explicitly wants provider-specific workflow documentation
- store provider choices and capability flags in planning state so Umpire can resume without rediscovering them
- render work item batches through adapters such as GitHub Issues, GitLab Issues, Jira issues, Linear issues, Azure Boards work items, or markdown/export-only files
- use native dependency relations where available, while preserving body-line blocker fallbacks for simple providers
- generate host-specific execution instructions late, for example "open PR", "open MR", "create Gerrit change", or "post patchset"
- generate repository-layout-aware acceptance criteria, including affected package/service gates, generated/vendor boundaries, and high-risk infra/mobile/manual audit notes
- keep provider-specific IDs and URLs out of product requirements except in planning state and generated work item metadata

Automatic mode must persist more than draft paths. It should also persist:

- configured providers and adapter versions
- canonical-to-provider status and priority mappings
- project/workspace roots and detected package managers
- generated work item drafts before provider creation
- provider-created work item IDs/URLs after creation
- unresolved schema questions, such as Jira workflow state names or Notion database property mappings

Bootstrap should ask concrete setup questions only when provider detection cannot answer them safely. Examples:

- "Should work items be created in GitHub Issues, GitLab Issues, Jira, Linear, or exported as markdown?"
- "Which tracker states map to ready, in progress, blocked, and done?"
- "Should blockers use native issue links where supported, or portable `Blocked by:` lines?"
- "Which workspace/package roots should issue acceptance criteria mention?"

## Generated Artifact Rules

Bootstrap is allowed to create stable planning artifacts when that is the point of the command:

- `docs/spec.md`
- milestone docs
- work items, with GitHub Issues as the default provider rendering
- stable repository workflow docs when explicitly requested

Bootstrap should not normalize agents creating transient repository markdown during execution. Generated work items and instructions should say that implementation notes belong in provider work-item comments and review items, such as GitHub issue comments and PRs, not in status files, progress reports, phase summaries, migration notes, quick guides, or ad hoc decision records.

## Work Item Template Guardrails

Generated work items should include guardrails when relevant:

- implement real requested behavior only
- no placeholder commands, stubs, no-op implementations, or "not implemented yet" runtime paths
- no tests that pass without validating real behavior
- no product-visible fake features or mock product paths
- test doubles and fixtures must be isolated under test/harness boundaries
- implementation artifacts must use product language, not milestone/bootstrap/reference-corpus language
- generated build output must not be committed unless policy allows it
- stable docs may be edited only when the work item asks for product, user, architecture, test, or workflow documentation

Bootstrap should make these acceptance criteria easy to include without bloating every work item. For example, package/tooling work items can inherit a "QUBE implementation guardrails" block.

## Supply-Chain Planning

Supply-chain guard should be core Bootstrap behavior. When a spec, milestone, or work item introduces packages, package managers, generators, CI actions, MCP servers, IDE extensions, or AI-agent tools, Bootstrap should add acceptance criteria for:

- exact versions and lockfile preservation
- no floating `latest` or unpinned Git/tarball sources
- lifecycle scripts disabled by default where possible
- package age check: 7 days minimum, 14 days preferred for high-risk tooling/runtime dependencies
- source/provenance/integrity/script review
- human approval for high-risk or ambiguous additions
- no broad upgrade commands

Bootstrap should also avoid generating work item instructions that tell agents to run dependency-provided tooling before this intake is complete.
