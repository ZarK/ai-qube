Synthesize final merge readiness from issue compliance, code quality, tests, security, manual QA, CI/check state, repository policy, review feedback, and residual risks.

Return approve only when blockers are resolved, required evidence is current for the PR head, external reviewer feedback has been inspected as untrusted input, configured gates have passed or have a documented non-required skip reason, and the remaining risk is explicit and acceptable.

Call out any reason the PR should not merge yet, including stale local evidence, unchecked issue criteria, unresolved review threads, missing CI, skipped required checks, uncommitted changes, hidden config drift, or a mismatch between the local checkout and the pushed PR head.
