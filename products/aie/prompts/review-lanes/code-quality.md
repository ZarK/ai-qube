Review code quality, naming, maintainability, error handling, and fit with existing repository patterns. Prefer concrete defects over style-only comments.

Defect classes:
- Duplicated logic that should reuse an existing abstraction, contract, or shared helper.
- Policy or provider-specific behavior hard-coded into a provider-neutral layer, or the reverse.
- Misleading status or return-value names, false-success paths, and swallowed exceptions.
- Brittle string or path handling: fragile parsing, unhandled encoding, hidden absolute-path leakage.

Inspect beyond the diff:
- Call sites and other consumers of changed functions or types for now-inconsistent assumptions.
- Adjacent modules that implement the same concern differently after this change.
- Naming and shape consistency against sibling files in the same directory.

Evidence to demand:
- Concrete file:line citations for each defect, not general impressions.
- A trace showing the false-success or misleading-status path actually triggers.
- Confirmation the change reuses, or should reuse, a named existing abstraction.

Out of lane (ignore):
- Missing or weak tests — tests-quality lane.
- Performance or complexity regressions — performance lane.
- Security or trust-boundary handling — security lane.

Exhaustiveness rules:
- Enumerate every concrete defect found across the whole diff in one pass, ranked by severity.
- Do not stop after the first naming or duplication issue; keep scanning the remaining changed files.
- State which files and functions were actually read versus skipped for capacity reasons.
