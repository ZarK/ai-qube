# Planning Workflow

`aib` should guide projects through phases. Each phase has a different depth of questions and a different output.

The primary operator is an AI agent, not the human. The human should experience the workflow as a conversation with the agent. The agent uses `aib` as a structured planning engine:

1. agent calls `aib next --json`
2. `aib` returns the next action or question batch
3. agent asks the human in natural language
4. agent records the answer with `aib`
5. `aib` updates planning state and returns the next step

## Phase 1: Project Clarification

Goal: help the user identify what the project is.

The first questions should stay high level:

- Who is this for?
- What should it help them accomplish?
- What kind of project is it?
- What is in scope for the first useful version?
- What is explicitly out of scope?
- What should feel excellent or trustworthy?
- Is this a new project, an existing repo, or a non-code effort?
- Is there a target platform, runtime, organization, or audience constraint?

`aib` should return small batches for the agent to ask, usually 3-5 questions. It should accept rough answers, partial answers, "default", or "not sure".

### Output

- updated planning state
- discovery log entries
- assumptions list
- enough clarity to draft a first spec

## Phase 2: Dry Spec Drafting

Goal: create a high-level functional and non-functional project definition.

This is still not the place for detailed schemas, APIs, selectors, edge cases, or implementation plans. The spec should define the project in product terms.

### General Spec Chapters

Every generated project spec should normally include:

- Purpose
- Audience and stakeholders
- Success narrative
- Scope
- Non-goals
- Project shape
- Functional requirements
- Non-functional requirements
- Constraints and assumptions
- Feature or capability map
- Risks and unknowns
- Spec acceptance checklist

### Dynamic Spec Chapters

Add these only when the project requires them:

- User experience and workflows
- Data or content model
- AI/model behavior
- Integrations
- Privacy, safety, compliance, or legal constraints
- Operations and support
- Migration
- Research or evidence plan
- Hardware, local runtime, or deployment constraints
- Documentation/content structure
- Package/reuse boundaries

The project profile should drive these additions. Documentation/content, research, design, operations/process, and export-only profiles should omit coding-only chapters such as command surfaces, package constraints, API contracts, selectors, or harness details unless the human explicitly identifies them as relevant.

Spec validation should reject missing required chapters and shallow placeholders such as `TBD`, `TODO`, `N/A`, lorem ipsum, placeholder text, or "to be written". Dynamic chapters should be present only when project shape, constraints, or recorded answers justify them.

### Output

- draft `docs/spec.md`
- explicit assumptions
- list of unresolved questions that block spec acceptance

## Phase 3: Spec Review And Acceptance

Goal: confirm the project definition before planning delivery.

Acceptance should be section-aware. The user should not be asked "is this good?" as a single vague question. `aib` should ask for focused confirmation:

- intent and audience
- scope and non-goals
- functional requirements
- non-functional requirements
- constraints and assumptions
- feature/capability map
- risks and unknowns

Milestone generation is blocked until the spec is accepted.

Acceptance is tracked by section ID. Required sections must all be accepted before milestone generation can proceed; dynamic sections can remain draft or deferred when they are not required for the next milestone decision.

### Output

- accepted `docs/spec.md`
- recorded accepted sections
- remaining deferred questions, if any

## Phase 4: Milestone Planning

Goal: define meaningful deliveries.

Milestones usually follow features or capabilities from the spec, but some milestones are cross-cutting:

- harness or test data
- package/CLI foundation
- migration
- provider integration
- release readiness
- safety or quality controls
- documentation system

A milestone should deliver a coherent capability, not just a layer. It should be meaningful to a user, tester, operator, maintainer, or future implementer.

### Milestone Depth

This is where `aib` can ask deeper questions:

- What does this milestone mean in practice?
- What are its boundaries?
- What must it prove when complete?
- What are the main edge cases?
- What dependencies does it have?
- Does it need a technical decision before work items are generated?
- Is it independent, or does it depend on earlier milestones?

For coding projects, milestone docs may include:

- pseudo-algorithm notes
- state diagrams
- flow diagrams
- model/structure descriptions where necessary
- acceptance criteria
- test strategy

They should not include production code, detailed API models, or full implementation schemas unless the milestone exists specifically to define a public contract.

For non-code projects, milestone docs should describe reviewable deliverables and the evidence needed to accept them. Examples include document sets, research briefs, evidence tables, design artifacts, operating checklists, publication bundles, stakeholder signoff, or markdown handoff packages. These milestones should not force tests, builds, package commands, selectors, API schemas, or repository mutation when those are irrelevant to the project profile.

### Sequencing

It is not required to create every milestone up front. It is advisable to create at least the first three milestones before generating work items so boundary, dependency, and sequencing errors become visible.

Early foundation milestones often run in order. Later feature milestones may be partially independent. Dependencies should be explicit.

### Output

- milestone docs
- milestone dependency map
- milestone status in planning state

## Phase 5: Work Item Generation

Goal: create executable units for an implementation system.

Work items require an accepted spec and at least one milestone. Actual project work requires work items. `aib` should not tell an execution agent to start from a raw milestone or raw spec.

Work items should be provider-neutral first, then rendered:

- markdown export
- GitHub Issues
- GitLab issues
- Jira tickets
- Linear issues
- other configured provider

### Output

- canonical work item drafts
- rendered provider work items or markdown files
- provider-created IDs/URLs in planning state

## Phase 6: Agent And Harness Finalization

Goal: install or render the right instructions for the selected agent host and workflow.

This phase teaches agents how to use the planning and execution tools. It should be generated late so it reflects the actual provider, agent host, repository layout, and project type.

### Output

- `AGENTS.md` or managed sections
- host-specific commands/prompts/rules
- optional workflow docs
- clear split between `aib` planning and `aie` execution
