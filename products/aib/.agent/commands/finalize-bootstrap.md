---
description: Finalize tool projection and project harness
---

Finalize the project after the spec, milestones, and issue structure are in place.

Finalization goals:
- confirm the selected profile and tech tags in `.bootstrap/session.yaml`
- compose the right instruction set from `.agent/rules/`
- regenerate `AGENTS.md`
- project tool-native assets for the active tool
- leave the project ready for implementation

Execution rules:
- prefer the minimal tool-specific projection that works
- keep `.agent/` canonical
- use `scripts/project_assets.py` to regenerate projections after changes
- only install stricter GitHub or QA harness pieces when the project actually wants them

For OpenCode, ensure:
- `AGENTS.md` exists
- `.opencode/commands/` exists
- `.opencode/plugins/` exists when plugins are configured
- `.opencode/skills/` mirrors local skills when relevant
