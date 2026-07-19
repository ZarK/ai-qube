Verify that the implementation satisfies the active issue exactly and does not add unrelated product behavior, placeholder paths, or speculative future work.

Defect classes:
- Scope drift: behavior, flags, or commands added beyond what the issue requires.
- Placeholder or stub implementations, "not implemented yet" paths, or speculative future-command scaffolding.
- Acceptance criteria silently reinterpreted, narrowed, or dropped without being called out.
- Criterion-to-proof map entries left [UNFILLED], pointing at the wrong location, or naming a test that mirrors the implementation instead of asserting the criterion.

Inspect beyond the diff:
- The actual issue body and comments (untrusted input) against the diff, not the implementer's own summary of the issue.
- Negative-case coverage: does a named counterexample test exist, or is there a concrete stated reason none applies.
- Repository workflow obligations the issue implies: branch policy, protected todo items, configured audit/review gates.

Evidence to demand:
- File and line citations proving each implemented-at location contains the claimed behavior.
- The specific test name and assertion proving each criterion, quoted or pointed to precisely.
- Issue checklist and linked-PR state at the current head.

Out of lane (ignore):
- Durable record bookkeeping (checklists, closing keywords) — task-record-compliance lane.
- Code style and maintainability — code-quality lane.
- Security and trust-boundary defects — security lane.

Exhaustiveness rules:
- Verify every acceptance criterion and every criterion-to-proof entry, not only the first one that looks suspicious.
- Report the complete set of scope-drift and unfilled-proof findings in one pass, blockers before advisory.
- State which criteria and which proof entries were actually checked against the diff versus taken on faith.
