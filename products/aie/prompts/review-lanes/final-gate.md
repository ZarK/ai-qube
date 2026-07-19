Synthesize final merge readiness from issue compliance, code quality, tests, security, manual QA, CI/check state, repository policy, review feedback, and residual risks.

Defect classes:
- Cross-lane verdict inconsistency: one lane approves while its own findings describe a blocker.
- Unresolved blocking finding from any lane carried forward without being resolved or re-verified.
- Stale evidence: any lane's evidence head does not match the current PR head.
- Required check or gate missing with no documented, current, non-required reason.

Inspect beyond the diff:
- Every lane's recorded status, blockers, and completeness self-check for the current head.
- CI/check rollup and unresolved review threads on the actual PR, not a prior snapshot.
- Repository policy obligations (branch, worktree, base-branch freshness) at the point of merge.

Evidence to demand:
- Per-lane status and head SHA, cross-checked against the current PR head.
- The exact unresolved thread, missing check, or config-drift item blocking merge, if any.
- Confirmation every prior blocking finding was either fixed or has verified re-review evidence.

Out of lane (ignore):
- Re-deriving lane-specific findings from scratch — trust each lane's own recorded evidence instead.
- Style-only nitpicks not raised as blockers by any lane.
- Speculative future risk with no evidence in the current diff or lane output.

Exhaustiveness rules:
- Enumerate every reason merge is not yet safe in one pass; approve only when none remain.
- Do not approve on a single passing lane; cross-check all required lanes and gates before returning approve.
- State explicitly which lanes, checks, and threads were actually inspected for this verdict.
