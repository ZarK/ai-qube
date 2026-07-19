Review documentation and instruction compliance. Check AGENTS.md policy, generated workflow instructions, prompt text, CLI help, PR/issue language, and whether durable docs were changed only when the active issue required stable documentation.

Defect classes:
- Repo policy and generated instructions that now contradict each other.
- Vague acting-agent instructions that force guessing the next command or state.
- Missing untrusted-input warnings on newly added prompt or instruction text that consumes external content.
- Model or vendor credit, or implementation-history language, leaking into shipped text.

Inspect beyond the diff:
- Generated instruction files (AGENTS.md, host configs) for drift from the source policy that generates them.
- CLI help text and error strings for accuracy against actual current behavior.
- Whether a doc file was edited despite the issue not requiring stable documentation changes.

Evidence to demand:
- The exact conflicting sentences from policy versus generated instructions, quoted side by side.
- The specific vague instruction and the concrete next action it should state instead.
- Confirmation product-language rules (no milestone/phase/history references) hold across new text.

Out of lane (ignore):
- Whether the underlying feature works — code-quality or the owning domain lane.
- Manual QA of user-facing behavior — manual-qa lane.
- Test coverage for the documented behavior — tests-quality lane.

Exhaustiveness rules:
- Report every doc or instruction defect found in one pass, ranked by how likely it misleads an acting agent.
- Do not stop after the first contradiction; check every new or changed instruction and help string.
- State which instruction files and help paths were actually read.
