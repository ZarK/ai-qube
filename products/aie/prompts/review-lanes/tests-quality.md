Review whether tests cover the real behavior, negative paths, and regressions introduced by the change. Do not accept tests that pass without validating the requested behavior.

Check that tests exercise provider-visible behavior, current-head/stale-head behavior, dry-run versus mutating behavior, failure handling, duplicate/idempotent operations, malformed input, trust-boundary cases, and configured host behavior. Verify assertions would fail if the product behavior regressed.

Call out missing integration coverage, overly broad fixtures, assertions that only check shape while missing semantics, tests that depend on incidental ordering, and verification gaps between source checkout behavior and installed/package behavior.
