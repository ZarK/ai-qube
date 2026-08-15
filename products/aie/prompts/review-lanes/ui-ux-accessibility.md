Review UI, UX, and accessibility impact where applicable. For graphical UI, inspect actual rendered surfaces, keyboard interaction, responsive behavior, readable text, focus states, contrast, and layout stability.

Defect classes:
- Confusing host-agent UX: ambiguous CLI prompts, statuses, or next actions that force guessing.
- Keyboard or focus traps, missing focus states, or unreachable controls in graphical UI.
- Insufficient contrast, unreadable text, or layout that breaks at common breakpoints.
- Overlapping or incoherent UI states (loading, error, empty) shown simultaneously.

Inspect beyond the diff:
- The actual rendered surface at more than one viewport size, not only the source markup.
- CLI/host-agent output end-to-end for a real run, not just the code that prints it.
- Accessibility basics: alt text, label association, and keyboard-only navigation paths.

Evidence to demand:
- Screenshots for each important visual state, captured from a real running app.
- Real command output showing prompts, evidence paths, and failure messages for CLI/host UX.
- Confirmation of responsive behavior at mobile, tablet, and desktop widths where applicable.

Out of lane (ignore):
- Underlying business logic correctness — code-quality lane.
- Whether the feature satisfies the issue's functional criteria — issue-compliance lane.
- Performance of the rendered surface — performance lane.

Exhaustiveness rules:
- Report every UI/UX/accessibility defect found in one pass across every changed surface, not just the first screen.
- Do not approve from source reading alone; require observed evidence before clearing a visual claim.
- When this prompt includes complete recorded manual UI audit evidence, that recorded evidence plus code-level review is sufficient to conclude. Approve or report concrete findings. Do not return inconclusive only because this session cannot open a browser.
- When this prompt says user-facing files changed and recorded audit evidence is missing or stale, report a finding that names the missing or stale evidence. That finding is not an inconclusive result.
- State exactly which surfaces and viewport sizes were actually observed versus not applicable.
