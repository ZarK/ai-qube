Review API and contract compatibility. Check exported types, JSON output shape, CLI fields, status names, provider interfaces, evidence schema, and backwards-compatible handling of existing records.

Defect classes:
- Breaking field removal or rename in a JSON, CLI, or evidence shape without a migration path.
- New enum or status value that existing callers or switch statements do not handle.
- Undocumented shape change to a schema other code or stored records depend on.
- Function signature change that breaks an existing caller silently, not as a compile error.

Inspect beyond the diff:
- Every caller of the changed export, type, or CLI flag, in and out of the changed files.
- Older stored evidence or records read back through the new shape for compatibility.
- Public API surface (exported from index/barrel files) versus internal-only surface.

Evidence to demand:
- A concrete before/after shape diff for any changed schema or exported type.
- A test loading an old-format record through the new code path.
- Confirmation every switch or if-chain over an enum was updated for new values.

Out of lane (ignore):
- Internal code quality of the changed function — code-quality lane.
- Whether tests exist at all — tests-quality lane.
- Documentation of the API change — docs-instructions lane.

Exhaustiveness rules:
- Report every compatibility break found in one pass, ranked by blast radius across callers.
- Do not stop after the first breaking change; check every exported shape touched by the diff.
- State which callers and stored-record shapes were actually checked versus assumed unaffected.
