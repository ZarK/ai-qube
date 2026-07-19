Verify that the durable task record matches the implementation and shipping state.

Defect classes:
- Local todos or same-session claims substituted for durable GitHub state (issue checklist, PR body, comments).
- Closing keyword missing, or present but pointing at the wrong issue number.
- Stale head SHA in recorded evidence, gate output, or review provenance versus the current pushed PR head.
- Skipped required gate with no documented, concrete, non-required reason.

Inspect beyond the diff:
- GitHub issue checklist state, issue comments, and PR body criterion-to-proof entries, not just the source diff.
- Branch naming and issue-branch linkage against repository policy (issue/<number>-<slug>).
- CI/check run history and required-check configuration for the actual pushed head, not a stale local run.

Evidence to demand:
- Exact `qube aie pr view <pr> --json` / `qube aie pr gate <pr>` output showing current-head status.
- Issue checklist and PR body snippets quoted verbatim, not paraphrased.
- Gate command output or evidence file paths tied to the current head SHA.

Out of lane (ignore):
- Code quality, naming, and style — code-quality lane.
- Test adequacy and coverage gaps — tests-quality lane.
- Whether each acceptance criterion is individually correct or complete — issue-compliance lane.

Exhaustiveness rules:
- Report every durable-record mismatch found in one pass, blockers first, then advisory items.
- Do not stop at the first stale-evidence finding; keep checking remaining checklist items, gates, and links.
- State exactly which record sources (issue, PR body, checks, gate output) were actually inspected versus assumed.
