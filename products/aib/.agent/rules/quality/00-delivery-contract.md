# Delivery Contract

- Surface assumptions explicitly in `.qube/aib/assumptions.md` and in spec drafts.
- Keep `docs/spec.md` stable and easy to reference.
- Use milestone files as visible delivery units.
- Keep issue drafts profile-aware: desktop UI projects need different verification than CLI or backend projects.
- Keep issue queue metadata aligned with `resources/gh-workflow.md`, especially `Blocked by:` lines and exceptional `Sequence:` usage.
- Keep issue label suggestions aligned with the queue: exactly one priority label, one status label, and one or more component labels.
- Keep transient implementation planning in the GitHub issue body or comments instead of extra repo markdown files.
- Prefer consolidated E2E coverage and fixture reuse before introducing new test specs or datasets.
- Preserve cross-tool compatibility when possible, but optimize first for the selected active tool.
