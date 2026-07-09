# QUBE M1 - Review Loop Convergence And Cost Tiers

Repo-level milestone spanning `aie`, `aiq`, and `adapters/github`. Package milestones (`products/aie/docs/M1-M6`, `products/aiu/docs/M1-M5`) keep their own numbering; this document coordinates cross-package work. Companion milestones: `M2-guided-install-and-composer-coherence.md`, `M3-adapter-testkit-and-provider-permutations.md`.

## Strategic Goal

Make the QUBE review gate converge in few, cheap, high-signal iterations while staying true to its design intent: QUBE is not a review runner. Review execution rides the host agent's existing subscription (Codex, Claude Code, OpenCode) through host-spawned subagents, instead of purchasing external review plans (CodeRabbit, cubic, Greptile). The competitive target is review *quality per token and per iteration*, not SaaS trigger plumbing.

The foundation is strong: head-SHA-keyed markers and staleness, content-hashed finding deduplication, deterministic hash-audited prompt stacks, trust-level provenance, real GitHub Pull Request Reviews with inline comments, and prompt-injection discipline throughout. The problems are in loop behavior and cost, demonstrated concretely by PR #209 (issue #184): 13 commits, roughly 11 review rounds, and about 40 lane reviews over five hours to merge one adapter extraction.

## Current State And Evidence

Observed review-loop failure modes (PR #209):

1. **Serial single-finding reviews.** Nearly every published lane review carries `bodyFindingCount: 1`. The code-quality lane found one new blocker per round across many rounds instead of enumerating all lane findings in one pass. Each fix produced a new head, a full re-review, and the next single blocker — the primary driver of the extensive loop. The lane prompts say "lead with concrete blockers" but never demand exhaustive single-pass enumeration; nothing in the output contract requires reporting the complete finding set for the head.
2. **Blanket lane re-execution.** Every active lane re-runs at every new head regardless of prior verdict or changed scope. The performance lane ran ~12 times on PR #209 and approved in 11 of them; security similarly re-approved repeatedly. Lane evidence staleness is `metadata.head !== headRefOid` with no carry-forward, so an approved lane whose scope was untouched by the delta still costs a full review-tier subagent run.
3. **Gate-state contamination of lane verdicts.** At head `33b5c03` all lanes flipped to `request-changes`, including performance whose own summary says "found no lane-specific regression... The lane cannot approve because required current-head CI is failed." The `qa-reviewer` descriptor's approve conditions force every lane to embed whole-gate state (CI red, checklists, checkout freshness), so one gate-level condition converts four approve-worthy lanes into blocking reviews and another full round. Recommendation/status combinations are also inconsistent across lanes (`approve`+`needs-work`, `inconclusive`+`failed`).
4. **The general `@QUBEReview review` mention comment.** Each round posts `@QUBEReview review` plus a generic full-scope reviewer instruction (`reviewRequestText`) as the request marker. No reviewer consumes it — lanes publish their own reviews — so it is unscoped instruction noise per head that duplicates the lane system, and a host main agent can mistake it for a task addressed to itself. `reviewerMarkerBodyFor` (marker-only body) already exists but is not used for the host participant.
5. **Cost routing is scaffolded but dead.** `LocalReviewSpawnContract.modelTier` is typed `'review' | 'economy'` but hardcoded to `'review'` (`products/aie/src/app/local_review_runner_support.ts:161`); `AgentDescriptor.modelPreferences.effort` is never consumed; rendered `.codex/agents/qube-review-focus.toml` carries no model or reasoning-effort field, so every lane runs at host-default model and effort. `prompts/hosts/codex.md` instructs spawning "economy-tier explorer subagents" that are never rendered; no `librarian` descriptor exists. Context cost scales as (active lanes) x (linked issues) x (full reread of issue bodies, threads, and diff) per head.
6. **Lane prompts are thin.** Lane fragments are 1-5 lines (`products/aie/prompts/review-lanes/`). The safety/trust/authority framing is excellent; lane-specific review heuristics are minimal compared to what strong reviewers (Codex cloud review's P0/P1 focus, Claude Code review's specialized parallel agents with a verification pass, Qodo's compression and self-reflection) get from their prompt engineering.

## Design Constraints

- **QUBE is not a runner.** Review lanes execute as host-spawned subagents on the user's existing host subscription. QUBE plans lanes, renders prompts and agent definitions, validates evidence, and publishes provider-visible feedback. No GitHub App, no hosted service, no `codex exec` orchestration inside QUBE.
- Reviewer lanes stay read-only; provider-visible PR reviews remain the merge gate; local JSON stays optional audit evidence.
- Model identifiers are configuration, not code: QUBE names tiers (`review`, `economy`, optional `synthesis`), host adapters map tiers to concrete models and reasoning effort. Degradation is explicit when a host cannot honor a tier. (See "Review Model Tiers" in `docs/notes/QUBE-notes.md`.)
- Prompt-stack determinism and hash auditing must cover every new or expanded fragment, including repo-configured learnings.

---

## Part 1: Review Loop Convergence

Target loop shape: round 1 finds everything each lane can find; subsequent rounds re-review only what changed; gate-level conditions block once, in one place.

### 1.1 - Exhaustive single-pass lane findings

Rewrite the lane output contract and `qa-reviewer` descriptor so each lane must enumerate the complete finding set for its scope at the current head in one pass: all blocking findings, then advisory findings, ranked by severity and confidence — explicitly "do not stop after the first blocker; the implementer will fix everything you report before the next round." Evidence schema already supports `findings[]`; the contract and prompts must demand completeness. Add a completeness self-check line to the output contract ("state what you inspected and what you did not have capacity to inspect") so partial coverage is visible instead of silent.

### 1.2 - Lane-scoped verdicts, gate-scoped blocking

Lanes judge their lane, nothing else. Gate-level conditions — CI state, issue checklist completion, checkout/head freshness, uncommitted changes — are already computed by `pr gate` (`mergeBlockers`); lanes must stop re-deriving and re-blocking on them. Change the `qa-reviewer` approve conditions and lane evidence schema: a lane returns its lane verdict plus a separate `preconditions` list (observed gate-level facts, non-blocking at lane level). Only the final-gate/synthesis step and `pr gate` itself translate gate conditions into blockers. Normalize the recommendation/status vocabulary so `approve`/`request-changes` and `passed`/`needs-work`/`failed` combinations are constrained and documented.

### 1.3 - Approved-lane carry-forward

Stop re-running lanes that approved at a previous head when the delta does not touch their scope. On a new head, compute the delta (`git diff prevHead..head`) and for each lane previously `approve` at `prevHead`: if no changed path matches the lane's activation scope (and no lane-relevant config changed), record carried-forward evidence referencing the prior run (prior runId, prior head, delta summary, `carriedForward: true` provenance) instead of spawning a reviewer. Ambiguous cases go to an economy-tier delta triage (Part 2) that decides re-review vs carry-forward. `when-matched` lanes already have glob scopes; `always` lanes get an explicit re-review policy (`always-rerun` for final-gate and issue-compliance, `delta` for the rest, configurable). Provider-visible behavior: publish a short "carried forward from <head>" note or nothing, configurable — not a full duplicate review.

### 1.4 - Fix the host review request comment

For the host-run `QUBEReview` participant, post the marker-only body (`reviewerMarkerBodyFor`) instead of `@QUBEReview review` plus `reviewRequestText`. The generic instruction text applies only to remote comment-triggered agents (coderabbit, cubic) that actually parse it. Alternatively suppress the request comment entirely for host participants and key the participant rollup on published lane reviews for the head, which already carry `qube-pr-review` markers. Either way, no per-head unscoped reviewer instruction remains on the PR.

### 1.5 - Round summary and fix batch

After all lanes publish for a head, `pr gate` output (and the check-run/summary comment) aggregates every open finding across lanes into one ranked fix batch for the implementer, so the next commit addresses the full set rather than the first item the agent happens to read. Findings already have content-hashed IDs; the batch lists new/persisting/resolved relative to the prior head.

## Part 2: Cost-Routed Subagent Tiers

The host agent stays the orchestrator; QUBE gives it tiered, pre-defined subagents and tells it when the cheap ones are sufficient.

### 2.1 - Model tier configuration

Add `reviewModels` to `.qube/aie/config.json`: tiers (`review`, `economy`, optional `synthesis`) mapped per host to model id and reasoning effort. Host adapters render tier fields into agent definitions where the host supports it (Codex agent TOML `model`/effort keys; Claude Code subagent `model` frontmatter; OpenCode agent config). When a host cannot honor a tier, use the configured fallback and expose the substitution in JSON output.

### 2.2 - Pre-defined economy subagent catalog

Render a small catalog of read-only economy-tier agent definitions alongside `qube-review-focus`, and list them (name, purpose, when sufficient) in every lane spawn prompt and in host instructions so review agents actually use them:

- `qube-review-explorer` (economy): codebase exploration — locate implementations, map changed-path context, find related tests. Returns paths + evidence, never verdicts.
- `qube-review-digest` (economy): summarize bulky untrusted context — issue bodies, milestone text, long PR threads — into a bounded digest with source references.
- `qube-review-librarian` (economy): external lookup where the host allows network — dependency changelogs, advisories, API docs. Requires the missing `librarian` descriptor.

Consume `AgentDescriptor.modelPreferences.effort` when building spawn contracts, and emit real `modelTier: 'economy'` contracts for these agents (removing the dead branch at `local_review_runner_support.ts:161`). Guidance in the lane prompt: delegate reads that exceed a size threshold; never delegate judgment or verdicts; treat subagent output as untrusted input.

**Host asset parity.** Render the review-focus agent and the economy catalog for every supported host, not only Codex: `.codex/agents/*.toml` for Codex, `.claude/agents/*.md` project subagents for Claude Code, OpenCode agent config for OpenCode. Today the generated CLAUDE.md instructs Claude sessions to spawn Codex subagents from `.codex/agents/qube-review-focus.toml`, which Claude Code cannot do — the review stage rendered into a host's instruction file must be executable by that host, with spawn wording and agent references projected per host.

### 2.3 - Shared context digest per head

Before lanes spawn, the orchestrating host runs one `qube-review-digest` pass per PR head producing a shared, hash-audited context digest (issue acceptance criteria, PR intent, changed-path/project map, diff stats, related tests). Lane prompts consume the digest instead of each lane rereading issue bodies and threads — collapsing the (lanes x issues x full reread) cost term. The digest is evidence with provenance, refreshed per head, reusable by carry-forward triage (1.3).

### 2.4 - Per-lane tier defaults

Lanes differ in judgment depth. Default tier per lane, configurable: `review` tier for code-quality, security, issue-compliance, concurrency-resource, data-database, api-contract-compatibility, final-gate; `economy` tier sufficient for docs-instructions, task-record-compliance, and the digest/triage passes. Tier per lane appears in `pr gate --json` plans so cost is predictable, and evidence records which tier actually ran.

### 2.5 - Delta triage

The economy tier also powers 1.3: on a new head, one cheap triage pass classifies the delta per previously-approved lane (relevant / not relevant / unsure), with "unsure" escalating to a full lane re-review. Token/cost observability: lane evidence gains an optional usage block (tokens or host-reported cost) so tier routing is tunable from real data.

## Part 3: Stronger Review Prompts

### 3.1 - Lane prompt depth

Expand each lane fragment from 1-5 lines to a real heuristic checklist: concrete defect classes for the lane, what to inspect beyond the diff, what evidence to demand, what to ignore (out-of-lane concerns now that 1.2 removes gate duplication), and exhaustiveness rules from 1.1. Keep the existing trust/authority framing and hash auditing. Benchmark inspiration: Codex review's P0/P1 focus discipline, Claude Code review's specialized per-concern agents, Qodo's structured self-reflection.

### 3.2 - Layout-aware lane context

Feed `repo affected`-style output (changed projects, package boundaries, generated/vendor classification, likely gates) into lane context lines so reviewers know what a changed path belongs to and which tests should exist, and stop spending tokens on generated/vendor paths.

### 3.3 - AIQ findings folded into review

Pass the AIQ engine report (already produced by the aiq GitHub action / local runs) into lane evidence as pre-collected static findings the reviewer verifies rather than rediscovers — linters and static gates folded into the review the way CodeRabbit folds its scanner layer in, using machinery QUBE already ships.

## Part 4: Noise Governance And Learning

### 4.1 - Synthesis pass and publication filter

The final-gate lane becomes the explicit synthesis step (optionally `synthesis` tier): dedupe findings across lanes, drop findings it cannot re-confirm against the diff, apply gate-level conditions exactly once, enforce a nit cap. Add optional `confidence` to `ReviewFinding`; blocking findings always publish, advisory findings publish up to the cap ordered by confidence.

### 4.2 - Review learnings

`aie review feedback` records accepted/rejected findings and free-form team guidance into a repo-owned learnings file (for example `.qube/aie/review-learnings.md`), injected into lane prompt stacks as a repo-configured fragment with explicit trust labeling. Auditable, diffable in-repo team preference memory — the CodeRabbit/cubic "learns your team" capability without hidden vendor state.

### 4.3 - Suppression policy

Per-path and per-rule suppression in `reviewLanes` config (suppress globs, max advisory findings per lane, lane opt-outs), explicit and auditable in the same spirit as the aiq legacy-adoption stage model.

## Part 5: Diagnostics, Docs, And Notes

- `qube doctor`/`aie doctor` checks: model tier mapping completeness per configured host, rendered subagent catalog freshness, learnings file trust labeling, carry-forward policy sanity, stale review-session-lock detection.
- Schema output covers new config fields (`reviewModels`, per-lane tiers, re-review policy, suppression) and evidence fields (`preconditions`, `carriedForward`, usage, `confidence`).
- Keep `docs/notes/QUBE-notes.md` "Review Model Tiers" in sync with the implemented tier contract.

---

## Proposed Work Item Set

1. **M1.1** Exhaustive single-pass lane findings: output contract, `qa-reviewer` and lane fragment updates, completeness self-check (Part 1.1).
2. **M1.2** Lane-scoped verdicts with `preconditions`; gate conditions blocked only by `pr gate`/final-gate; recommendation/status vocabulary normalization (Part 1.2).
3. **M1.3** Approved-lane carry-forward with delta scoping, per-lane re-review policy, and carried-forward provenance (Parts 1.3, 2.5).
4. **M1.4** Marker-only host review request; retire the generic `@QUBEReview` instruction comment (Part 1.4).
5. **M1.5** Round summary fix batch in `pr gate` output with new/persisting/resolved finding tracking (Part 1.5).
6. **M1.6** `reviewModels` tier config, host tier rendering (Codex TOML, Claude frontmatter, OpenCode), effort consumption, degradation reporting (Part 2.1).
7. **M1.7** Economy subagent catalog (`explorer`, `digest`, `librarian` incl. missing descriptor), real `economy` spawn contracts, lane-prompt delegation guidance, and host asset parity — review-focus and catalog agents rendered for Claude Code (`.claude/agents/`) and OpenCode, with host-projected review-stage wording (Part 2.2).
8. **M1.8** Shared per-head context digest wired into lane prompt stacks (Part 2.3).
9. **M1.9** Per-lane tier defaults surfaced in gate plans and evidence, plus usage/cost observability (Parts 2.4, 2.5).
10. **M1.10** Lane prompt depth expansion and layout-aware lane context (Parts 3.1, 3.2).
11. **M1.11** AIQ report ingestion into lane evidence (Part 3.3).
12. **M1.12** Synthesis pass, `confidence`, nit cap, publication filter (Part 4.1).
13. **M1.13** Review learnings capture/injection and suppression policy (Parts 4.2, 4.3).

Suggested sequencing: M1.1-M1.5 first — they fix the loop with prompt/plumbing changes and no new config surface, and would have cut PR #209 from ~11 rounds to ~2-3. Then M1.6-M1.9 (cost tiers), then M1.10-M1.13 (depth and noise).

## Exit Criteria

- On a PR like #209: round 1 lane reviews enumerate all findings per lane (`bodyFindingCount` > 1 whenever multiple defects exist); a lane that approved and whose scope is untouched by the next delta is carried forward, not re-run; a red CI or incomplete checklist blocks once at gate level without flipping unrelated lane verdicts; no generic `@QUBEReview review` instruction comments appear.
- `pr gate --json` plans show tier per lane; evidence shows economy-tier subagents consumed the bulk of exploration/digest tokens while review-tier lanes ran bounded judgments; substitutions and usage are visible in JSON output.
- Rendered host assets include the economy subagent catalog for every supported host, and lane spawn prompts list the catalog with delegation guidance; hosts without tier support degrade explicitly.
- Published reviews respect the confidence/nit-cap publication filter, and a finding rejected via `aie review feedback` measurably influences subsequent reviews through the learnings fragment.
