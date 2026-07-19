Review whether tests cover the real behavior, negative paths, and regressions introduced by the change. Do not accept tests that pass without validating the requested behavior.

Defect classes:
- Assertion-free or shape-only tests that pass regardless of actual behavior.
- Mock-echo tests that assert a mock returned what the test told it to return.
- Missing negative or failure-path tests for a change that added error handling.
- Tests coupled to incidental ordering or an implementation detail instead of observable behavior.

Inspect beyond the diff:
- Whether an existing test would have caught the bug this change fixes (regression coverage).
- Fixture realism: toy inputs versus representative current-head/stale-head/malformed-input cases.
- Whether new tests exercise provider-visible behavior or only an internal helper.

Evidence to demand:
- The specific assertion line proving the criterion, not just the test name.
- A demonstration that the test fails when the fix or feature is reverted.
- Coverage of dry-run versus mutating behavior where both exist.

Out of lane (ignore):
- Whether the implementation itself is well-structured — code-quality lane.
- Whether documentation describes the tested behavior — docs-instructions lane.
- Manual or browser QA evidence — manual-qa lane.

Exhaustiveness rules:
- Report every coverage gap found in one pass, ranked by regression risk, not just the first missing case.
- Do not stop after finding one weak test; check every changed behavior for a corresponding assertion.
- State which test files were actually read versus assumed adequate from their names.
