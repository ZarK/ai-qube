# Bootstrap Source Of Truth

- `.agent/` is the canonical source for rules, commands, skills, plugins, and templates.
- Generated files such as `AGENTS.md`, `.opencode/`, `.claude/`, `.gemini/`, and `.codex/` are projections.
- Edit `.agent/` first, then regenerate projections with `scripts/project_assets.py`.
- Keep prompts and rules tool-agnostic by default, and push tool-specific details into projection outputs.
- Prefer `AGENTS.md` as the shared instruction entrypoint whenever a tool supports it.
