## Desktop UI Additions

### User Flow

- Entry point in UI:
- Primary interaction path:
- Empty / loading / error states touched:
- Responsive or narrow-width considerations:

### Optional UI-Focused Sections

Use these when the issue is UI-state-heavy or interaction-heavy.

- Visibility Rules:
- UI States:
- Update Flow:
- Required Selectors:

### E2E Planning Notes

- Preferred existing flow to extend:
- Preferred existing fixture set to reuse:
- Reason a new spec or fixture is needed, if any:

### Queue / Workflow Notes

- If this work is blocked, record blockers only with top-of-body `Blocked by: #NNN` lines.
- Add `Sequence:` only when blocker chains and milestone numbering are not enough.
- Suggest exactly one priority label, one status label, and one or more component labels.
- Keep transient implementation planning in the GitHub issue body or comments instead of extra repo markdown files.

### E2E / System

- [ ] cover the primary interactive flow with stable selectors
- [ ] cover at least one meaningful error or empty-state path
- [ ] cover keyboard or focus behavior when the flow depends on it
- [ ] split into multiple named E2E flows when the issue naturally has separate visibility, interaction, and reversal paths
- [ ] extend an existing consolidated E2E flow and fixture set first; only create a new spec or dataset when reuse would harm clarity

### Manual Verification

- launch the built app or local shell
- verify the flow with real UI interactions
- verify responsive or narrow-width behavior where it matters
- verify that visible state matches stored or emitted state when relevant
