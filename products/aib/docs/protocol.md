# Agent JSON Protocol

`aib` returns JSON for agents, not decorative human transcript text. Agents should call `aib next --json`, ask or act on the returned instruction, then persist human answers or artifact changes before asking for the next action again.

## State Envelope

State files are versioned JSON documents with these required top-level fields:

- `version`: currently `1`
- `phase`: one of `discovery`, `spec_drafting`, `spec_acceptance`, `milestone_generation`, `work_item_generation`, `finalized`, or `blocked`
- `project`: high-level project answers gathered from the human
- `agent`: host and question budget for the operating agent
- `spec`: accepted spec section IDs
- `assumptions`: explicit assumptions accepted during planning
- `artifacts`: spec, milestone, and work-item artifact paths/statuses
- `planning`: provider-neutral planning state mirrored for package consumers

The runtime validates the structural fields it reads before returning a next action. Invalid or stale state fails as `state-invalid`.

## Next Action Envelope

`aib next --json` returns:

- `statePath`
- `phase`
- `nextAction`

`nextAction` always includes:

- `kind`
- `actor: "agent"`
- `summary`
- `missingDecisions`

Depending on the action it may also include `questions`, `questionBudget`, `stateFields`, `nextCommand`, and `stopCondition`.

For `inspect_context`, `nextAction.contextInspection` includes:

- `targets`: local repository, docs, sibling repository, or reference paths to inspect
- `instructions`: what the agent should look for
- `evidencePolicy`: how to keep private reference evidence out of generated product artifacts

## Action Kinds

- `ask_human`: ask the human a small batch of questions, then record answers with `aib answer --json`.
- `inspect_context`: inspect repository or reference material, then record a private summary with the returned `nextCommand`.
- `draft_spec`: draft or update the project spec from recorded state, then update state before continuing.
- `request_acceptance`: ask the human for section-aware spec acceptance.
- `generate_artifacts`: generate milestone or work-item artifacts from accepted prior artifacts.
- `stop`: stop because planning is finalized or blocked.

Runtime next commands only point at implemented commands. Future commands such as spec drafting must be introduced with matching command metadata before agents are directed to call them.

## Spec Status

`aib status --json` includes `spec` with:

- `chapters`: required and selected dynamic spec chapters
- `acceptedSectionIds`: accepted required section IDs
- `missingRequiredAcceptance`: required section IDs still awaiting acceptance
- `canGenerateMilestones`: whether milestone generation is unblocked

## Answer Errors

`aib answer --json` can fail with:

- `answer-field-invalid`: the field was not returned by discovery questions.
- `answer-value-invalid`: the answer value was blank.
- `answer-transition-invalid`: the current phase does not allow answer mutations.

Agents should treat these as recoverable validation errors and call `aib status --json` or `aib next --json` before continuing.

During `spec_acceptance`, agents can record section-aware acceptance with:

```text
aib answer --field spec.acceptedSectionIds --value <section-id> --json
```
