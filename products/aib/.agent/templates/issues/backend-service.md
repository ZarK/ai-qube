## Backend Service Additions

### Service Boundary

- Entrypoint or method(s):
- Input validation rules:
- Output / error envelope:
- Persistence or side effects:

### Optional Deep-Dive Sections

Use these when the issue is data-heavy, state-heavy, or contract-heavy.

- Data Model:
- SQL Implementation:
- Update Flow:
- Core Principle:
- Performance Targets:

### Queue / Workflow Notes

- If this work is blocked, record blockers only with top-of-body `Blocked by: #NNN` lines.
- If ordering needs steering beyond blockers and milestone numbering, add `Sequence:` using a supported numeric format.
- Suggest exactly one priority label, one status label, and one or more component labels.
- Keep transient implementation planning in the GitHub issue body or comments instead of extra repo markdown files.

### Unit / Integration

- [ ] cover the main service path
- [ ] cover validation or failure behavior
- [ ] cover contract compatibility at the boundary
- [ ] cover query, aggregation, or migration behavior when applicable
- [ ] prefer existing integration or end-to-end fixture setups before inventing a new dataset for this issue

### Manual Verification

- exercise the API or command path with representative payloads
- verify logs, status codes, or error envelopes are correct
- verify restart / cancellation / idempotence behavior when relevant
