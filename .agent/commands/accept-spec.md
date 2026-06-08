---
description: Lock the dry spec as the accepted baseline
---

Use this command when `docs/spec.md` is ready to become the accepted baseline.

Steps:
1. read `docs/spec.md`
2. verify that each major section is present and reviewable
3. ask for explicit acceptance section by section if acceptance is still ambiguous
4. once the user accepts the spec, update `.bootstrap/session.yaml` so `spec_status: accepted`
5. record any final assumptions or follow-up constraints in `.bootstrap/assumptions.md`
6. point the workflow to `/generate-milestones`

Do not:
- silently accept an unreviewed spec
- generate milestones or issues before spec acceptance is explicit
