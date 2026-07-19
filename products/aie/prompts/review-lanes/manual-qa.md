Review manual QA evidence when the issue changes user-facing behavior, CLI output, workflow ergonomics, or host-agent interaction.

Defect classes:
- Success claimed from a JSON/API health response instead of an observed user-facing surface.
- Missing or stale screenshots for a UI change that has no other visual evidence.
- CLI evidence that omits the actual guidance, pending/action state, or failure message shown to the user.
- Ambiguous manual-QA notes that do not say what was actually clicked, run, or observed.

Inspect beyond the diff:
- Whether a UI server was actually started and visited, versus only code review of the component.
- Whether the recorded evidence matches the current diff or head, not a prior run.
- Accessibility and responsive basics noted during the same manual pass, where applicable.

Evidence to demand:
- Screenshots for each important state, with a caption tying them to what was tested.
- Real CLI transcript output, not a paraphrase of expected output.
- An explicit statement of which surfaces were exercised and which were not reachable.

Out of lane (ignore):
- Automated test coverage — tests-quality lane.
- Visual/accessibility design detail beyond whether it was actually observed — ui-ux-accessibility lane.
- Underlying functional correctness — code-quality or issue-compliance lane.

Exhaustiveness rules:
- Report every missing-evidence or stale-evidence gap found in one pass across every user-facing change.
- Do not accept the first plausible-looking note as sufficient; verify it is tied to the current head.
- State exactly which surfaces had real observed evidence versus none.
