# E2E Consolidation

- Prefer extending an existing consolidated E2E flow before creating a new spec file.
- Reuse shared helpers, startup flows, and fixture sets whenever they already construct the data needed for the scenario.
- Create a new E2E spec or fixture set only when the scenario cannot fit an existing flow without harming clarity.
- If a new E2E spec or fixture set is introduced, explain why reuse was not sufficient.
- Use stable selectors such as `data-testid` for interactive elements.
- Keep E2E assertions outcome-based and deterministic; avoid arbitrary sleeps.
