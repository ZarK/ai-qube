Yes — that changes the design a lot.

The real product is not “a repo full of templates.” It is an **interactive bootstrap orchestrator** that starts from a fuzzy idea, interviews the user, writes the spec, gets it accepted, then turns that into milestones, issues, rules, and harness setup.

OpenCode is a good fit for this because it supports custom commands, project/global `AGENTS.md`, and configurable agents/tool permissions. One wrinkle: the current docs/examples are a bit inconsistent about command paths — official docs show `command` / `.opencode/command/`, while other examples mention `commands/`. Because of that, your bootstrap kit should install/support both or normalize via a wrapper instead of assuming one path. Also, the docs describe commands as local/global prompt definitions, not “run a remote Git repo directly,” so the robust way to support `/bootstrap ...` is a thin global wrapper that syncs the bootstrap repo locally and then invokes its project commands. ([OpenCode][1])

## What the system should become

Think of it as a 2-layer system.

**Layer 1: a global launcher**
You type something like:

```text
/bootstrap I want to build a local AI DJ music generator
```

That launcher does three things:

1. syncs or clones the bootstrap repo locally,
2. creates or enters the target project folder,
3. starts the **discovery/spec workflow**.

**Layer 2: a project-local bootstrap brain**
Once inside the new repo, the local commands run the actual process:

* discovery interview
* dry spec drafting
* review/acceptance loop
* milestone generation
* issue generation
* tech-profile selection
* harness/rules/agents assembly
* implementation-ready finalization

That means the starting input can be tiny, vague, and human.

## The correct end-to-end flow

The flow should be:

**idea → discovery interview → draft spec → spec revision loop → accepted spec → milestones → milestone review loop → issues → tech/harness composition → ready for implementation**

That is the key architectural correction.

Your current materials are strong for the later stages:

* `deep-research-report.md` is excellent for the **dry spec method**
* `feature-specification-system.md` is excellent for **milestone/task decomposition**
* the Memex scripts/rules are strong raw material for the **GitHub + agent harness**

What was missing was the **front door**.

## The front door: discovery-first bootstrap

For vague inputs, the AI should not ask for schemas, ADRs, or architecture up front. It should run a staged interview.

### Stage A: product intent

Questions like:

* Who is this for?
* What does success look like in one sentence?
* What makes it “local”?
* What is the core outcome: generation, remixing, live mixing, recommendations, stem separation?

### Stage B: operating constraints

Questions like:

* Desktop, web, CLI, or hybrid?
* Fully offline, mostly local, or local-first with optional cloud?
* Real-time latency requirements?
* GPU required or CPU-friendly?
* Any licensing/copyright constraints?

### Stage C: system shape

Questions like:

* Does it work from prompts, local music libraries, or both?
* Does it need timeline editing, playback, queueing, live transitions?
* Is this for solo creation or performance use?
* Are model downloads acceptable?

### Stage D: quality and delivery

Questions like:

* What is the first usable milestone?
* What are the non-goals?
* How polished does v1 need to be?
* What testing burden is appropriate?

The AI should ask **small batches**, not twenty questions at once.

For your example, `/bootstrap I want to build a local ai dj music generator`, a good first reply would be something like:

```text
Great. I need to pin down the product shape before I draft the spec.

1. Is this a desktop app, web app, or CLI-first tool?
2. Should all generation/mixing run fully offline on the user’s machine?
3. Does “AI DJ” mean:
   - generating full music,
   - mixing existing songs,
   - generating transitions between songs,
   - stem separation/remix,
   - or all of the above?
4. Does it need real-time playback/live performance behavior, or is batch generation enough?
5. Are users bringing their own local music library, typing prompts, or both?
```

That is the missing behavior.

## The bootstrap commands you actually want

I would make `/bootstrap` the orchestrator, and keep the others as resumable subcommands.

### 1. `/bootstrap $ARGUMENTS`

The main entrypoint.

Responsibilities:

* initialize `.qube/aib/session.json`
* classify the project idea
* start the discovery interview
* continue until enough certainty exists for a first dry spec
* write the initial spec draft
* keep iterating until spec acceptance

### 2. `/create-spec`

Used inside the project if bootstrap was interrupted.
It either:

* continues discovery, or
* produces the next spec draft.

### 3. `/accept-spec`

Locks the dry spec as the baseline and enables downstream generation.

### 4. `/generate-milestones`

Reads the accepted dry spec and creates milestone docs.

### 5. `/generate-issues M1`

Expands one milestone into GitHub-ready issues.

### 6. `/finalize-bootstrap`

Composes:

* `AGENTS.md`
* `.opencode` rules/commands
* GitHub scripts
* hooks
* tech-specific quality gates
* starter CI/lint/test config stubs

## The internal state the bootstrap system should keep

Do not rely on raw conversation alone. Keep structured state.

I’d add something like:

```text
.qube/aib/
  session.json
  discovery-log.md
  assumptions.md
  decisions/
    ADR-0001-*.md
```

`session.json` should track:

* project idea
* name candidates
* target users
* platforms
* privacy/offline requirements
* core flows
* tech assumptions
* unresolved questions
* spec status: drafting / review / accepted
* milestone status
* chosen tech profile

That makes the process resumable and agent-friendly.

## How spec writing should work now

Your generalized spec-writing system should be framed as:

**conversation-driven, invariants-first, contract-oriented, acceptance-hooked**

The AI should:

1. gather enough context,
2. draft a dry spec,
3. surface explicit assumptions,
4. ask for focused approval,
5. revise until accepted.

The acceptance loop matters. The AI should not ask “do you like it?” in a vague way. It should ask for approval section by section:

* Strategic Goal
* Invariants
* Functional Requirements
* Contracts
* UI/UX flows
* Testability rules
* Milestone mapping assumptions

That makes acceptance practical.

## How milestone writing should work now

Milestones should only start **after** the spec is accepted.

The milestone generator should:

* read stable spec anchors,
* identify the first valuable vertical slices,
* keep milestones implementation-sized,
* ensure each milestone ends in a visible/testable result,
* map each milestone to likely issue count and dependencies.

For a vague product like a local AI DJ generator, the first milestones might become:

* M1: app shell + local project setup + model/runtime detection
* M2: local library import + metadata/index
* M3: playback deck + queue + waveform UI
* M4: AI transition suggestion engine
* M5: prompt-to-mix or auto-mix session generation
* M6: export/render pipeline

That is much better than asking the user to hand you milestone structure.

## The issue-generation command you need

This should be a real first-class command, not an afterthought.

### Command

```text
/generate-issues M2
```

### Behavior

* read the accepted spec
* read the milestone doc
* split milestone into small vertical slices
* infer blockers from milestone ordering and task dependencies
* write GitHub-ready issue drafts using a project-type-aware template
* optionally create them with `gh issue create`

### Important rule

The template must be **profile-aware**.

Your example includes:

* Playwright
* manual UI audit
* data-testid
* Electron-ish workflow

That is correct for a desktop/UI-heavy profile, but not for every project. A CLI project or backend service should not get that exact block.

So the issue generator should render different sections depending on the active profile:

* desktop-ui profile
* web-ui profile
* backend-service profile
* cli-tool profile
* research/model-training profile

## A strong generalized issue template

Here’s the shape I’d use:

```markdown
Blocked by: #<issue-id>
Blocked by: #<issue-id>

## Problem
<What is broken, missing, or too slow?>

## Why It Matters
<User and system impact>

## Technical Background
<Relevant codepaths, current behavior, architectural constraints>

## Proposed Solution
<Concrete implementation direction, but not full code>

## Acceptance Criteria
- [ ] ...
- [ ] ...
- [ ] ...

## Test Requirements
### Unit / Integration
- [ ] ...

### E2E / System
- [ ] ...
- [ ] ...

## Milestone References
- docs/dev-tasks/M<N>-<slug>.md
- docs/spec.md §X.Y

## Priority
P2-High / P3-Medium / etc.

## Suggested Labels
- C-Frontend
- C-Backend
- C-Testing

## Test Fixtures
- tests/fixtures/...
- e2e/fixtures/...

## Manual Verification
<Rendered from active harness profile>

## Notes
<Assumptions, non-goals, follow-up boundaries>
```

And for a desktop UI profile, the `Manual Verification` block can expand into your stricter form.

## The prompt behind `/generate-issues`

This is the reusable prompt I’d put in the bootstrap kit:

```markdown
You are generating GitHub issues from an accepted milestone and accepted dry spec.

Inputs:
- Accepted dry spec: @docs/spec.md
- Milestone: @docs/dev-tasks/$MILESTONE.md
- Active project profile: @$PROFILE
- Existing issues/dependencies: !`./scripts/gh-priority-order.sh --json || true`

Goal:
Create a set of implementation-ready GitHub issues for this milestone.

Rules:
- One primary intent per issue.
- Prefer vertical slices over layer-only tasks.
- Add explicit `Blocked by:` lines when dependencies exist.
- Include concrete acceptance criteria.
- Include test requirements appropriate to the active project profile.
- Include manual verification instructions appropriate to the active project profile.
- Do not include irrelevant UI/E2E sections for non-UI issues.
- Keep scope tight enough for a single focused PR when possible.
- Reference milestone and spec anchors.
- Surface assumptions explicitly instead of hiding them.

For each issue, use this template:

Blocked by: #<id>

## Problem
...

## Why It Matters
...

## Technical Background
...

## Proposed Solution
...

## Acceptance Criteria
- [ ] ...

## Test Requirements
### Unit / Integration
- [ ] ...

### E2E / System
- [ ] ...

## Milestone References
- ...

## Priority
...

## Suggested Labels
- ...

## Test Fixtures
- ...

## Manual Verification
...

Now generate the issues for $MILESTONE.
```

That’s the piece you were missing.

## The harness should be modular, not Memex-default

This is important.

Do **not** make Memex’s exact workflow the universal default. Some of it is reusable; some of it is very specific.

### Good candidates for core reusable modules

* blocker-aware GitHub issue scripts
* queue ordering / label sync
* branch naming
* pre-commit issue checkbox enforcement
* opencode protected todo persistence
* injection defense / no-crediting rules
* quality-gate fragments
* issue-driven workflow fragments

### Should become optional profile modules

* Electron manual audit workflow
* Playwright/agent-browser specifics
* .NET guidance
* React/Tailwind guidance
* IPC/JSON-RPC rules
* autonomous ship workflow
* heavy E2E-first mandates

For some repos, “auto-merge and continue forever” is perfect.
For others, it’s too opinionated.

So `agents.md` should be **composed**, not copied.

## How `AGENTS.md` should be built

Split it into fragments like:

```text
fragments/agents/
  core/
    injection-defense.md
    issue-driven-workflow.md
    no-crediting.md
    shared-planning.md
  quality/
    strict-testing.md
    lightweight-testing.md
    manual-audit-required.md
  workflow/
    autonomous-ship.md
    conservative-ship.md
  tech/
    react.md
    tailwind.md
    electron.md
    dotnet.md
    python.md
    fastapi.md
    postgres.md
  profiles/
    desktop-ui.md
    web-ui.md
    backend-service.md
    cli-tool.md
    ai-research.md
```

Then:

```bash
./scripts/compose-agents.sh \
  --profile desktop-ui \
  --tech react,electron,dotnet,tailwind \
  --workflow autonomous-ship \
  --quality strict-testing
```

That writes the final `AGENTS.md`.

## The README promise should change

The README should promise this:

**Bring an idea, not a design document.**

Something like:

```text
1. Install OpenCode and GitHub CLI.
2. Add the global bootstrap command.
3. Run:

   /bootstrap I want to build a local AI DJ music generator

4. Answer the discovery questions.
5. Review the generated dry spec.
6. Accept the spec.
7. Generate milestones.
8. Generate issues.
9. Finalize the project harness.
10. Start implementation.
```

That’s the agent-friendly entrypoint.

## The repository layout I’d aim for

```text
README.md

bootstrap/
  profiles/
    desktop-ui.yaml
    web-ui.yaml
    backend-service.yaml
    cli-tool.yaml
    ai-local-app.yaml
  prompts/
    discovery/
      bootstrap.md
      product-intake.md
      uncertainty-reduction.md
    spec/
      create-spec.md
      revise-spec.md
      accept-spec.md
    milestones/
      generate-milestones.md
    issues/
      generate-issues.md

templates/
  spec/
    dry-spec.md
    adr-lite.md
  milestones/
    milestone.md
  issues/
    base.md
    desktop-ui.md
    backend.md

fragments/
  agents/
    ...
  opencode/
    commands/
    rules/
    plugins/

scripts/
  bootstrap-init.sh
  sync-bootstrap-repo.sh
  compose-agents.sh
  install-opencode.sh
  install-github-harness.sh
  generate-readme.sh
  finalize-project.sh

github/
  scripts/
    gh-issue-start.sh
    gh-issue-complete.sh
    gh-issue-deps.sh
    gh-priority-order.sh
    gh-update-labels.sh
    ...
```

## My main review of your idea

The idea is strong. The key adjustment is:

**Don’t think of this as a spec-template repo. Think of it as an AI project bootstrap operating system.**

That means:

* start from vague natural language,
* run discovery first,
* draft/accept the dry spec,
* then derive milestones,
* then derive issues,
* then compose the right harness for the chosen project.

And one more practical point: because the OpenCode command-path docs/examples are inconsistent right now, make the installer defensive and support both singular/plural command directories instead of baking in one assumption. ([OpenCode][1])

The cleanest next move is to redesign the repo around `/bootstrap` as the primary orchestrator, with `/create-spec`, `/generate-milestones`, `/generate-issues`, and `/finalize-bootstrap` as resumable subcommands.

[1]: https://opencode.ai/docs/commands?utm_source=chatgpt.com "Commands | opencode"
