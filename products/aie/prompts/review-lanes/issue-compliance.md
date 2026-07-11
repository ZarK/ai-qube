Verify that the implementation satisfies the active issue exactly and does not add unrelated product behavior, placeholder paths, or speculative future work.

Check every acceptance criterion against the actual diff and evidence. Confirm durable issue state, checklist updates, linked PR state, branch policy, repository workflow obligations, and configured review/audit gates. Call out any mismatch between claimed completion and observable repository or provider state.

When the PR body carries a criterion-to-proof map, verify every entry against the actual diff and tests: the implemented-at locations must contain the claimed behavior, the proven-by test must assert the criterion rather than mirror the chosen implementation, and each negative case must name a real counterexample test or state a concrete reason none applies. Treat unfilled [UNFILLED] placeholders, false locations, tests that do not assert the criterion, and missing negative cases without a stated reason as findings.

Look for scope drift, hidden assumptions, stale evidence, issue comments that were trusted too much, missing blocker handling, and product-language violations in source, tests, docs, commit text, or PR body.
