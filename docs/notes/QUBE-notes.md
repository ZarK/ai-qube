# QUBE Notes

QUBE is the package family for turning durable work items into sustained autonomous development work with explicit planning, execution, quality, and continuation controls. GitHub Issues and pull requests remain the first/default implementation path, but core concepts should be provider-neutral.

Package-specific notes:

- [ai-bootstrap-notes.md](ai-bootstrap-notes.md)
- [ai-executor-notes.md](ai-executor-notes.md)
- [ai-code-quality-notes.md](ai-code-quality-notes.md)
- [ai-umpire-notes.md](ai-umpire-notes.md)
- [autoresearch-mode-notes.md](autoresearch-mode-notes.md)

## Package Roles

- **Quality-control**: `ai-code-quality`, npm `@tjalve/aiq`. Provides code-quality gates and deeper quality checks that other QUBE packages can call.
- **Umpire whip**: `ai-umpire`, npm `@tjalve/aiu` (unpublished). Keeps the agent loop alive, notices when work stalls, and resumes or redirects execution.
- **Bootstrap**: `ai-bootstrap`, npm `@tjalve/aib` (unpublished). Helps create the spec file, milestones, and work items that define the durable work queue.
- **Executor**: `ai-executor`, npm `@tjalve/aie` (unpublished). Executes work items end to end: queue selection, lifecycle, implementation guidance, verification, review item creation, merge, completion, and continuation.

The packages should stay separate by ownership boundary, but share a consistent CLI, config, queue, and agent-host model.

Autoresearch should become a QUBE mode rather than a fifth peer package at first. `qube autoresearch <target> <goal>` should compose the existing boundaries: Bootstrap plans the arena, Executor builds and runs the sandboxed loop, Quality-control referees metric/gate truthfulness, and Umpire keeps iteration moving from trusted JSON state. See [autoresearch-mode-notes.md](autoresearch-mode-notes.md).

## Shared Harness Model

Existing repositories such as `ai-code-quality`, `ai-umpire`, `ai-bootstrap`, and `memex.photos` already use a script-backed GitHub-first process:

- GitHub issues are the current durable executable queue encoding.
- Priority labels use `P1-Critical`, `P2-High`, `P3-Medium`, and `P4-Low`.
- Status labels use `S-Ready`, `S-InProgress`, `S-Blocked`, and `S-Blocking`.
- Blockers are recorded with issue-body lines like `Blocked by: #123`.
- Queue order is dependency-aware and should be derived from the live blocker graph, not stale labels alone.
- Only one open issue should normally be `S-InProgress`.
- Work starts from queue inspection, work item start/resume, work item view, implementation, tests and audits, review item creation, review gate, merge/submit, work item completion, unblocking dependents, and next work item selection.
- OpenCode commands such as `/memex` prove the shape of a small command that tells the agent to continue the autonomous workflow without unnecessary pauses.

Executor should turn the mature copied script behavior into package-backed commands. Bootstrap should generate the planning artifacts and work item batches. Umpire should call package commands to keep the loop moving. Quality-control should provide reusable verification gates.

## Forge, Tracker, And Repository Modularity

Research status: current as of 2026-05-16. QUBE should keep GitHub as the default happy path, but the implementation should not bake "GitHub issue plus pull request" into core state. Popular teams split these responsibilities across different systems, for example GitLab repo plus GitLab issues, Bitbucket repo plus Jira, Azure Repos plus Azure Boards, Gerrit review plus Jira, or GitHub repo plus Linear.

Provider seams:

- **Forge provider**: owns remote repository identity, branches, commits, tags, fork/upstream metadata, webhooks, releases, and sometimes CI.
- **Review provider**: owns pull requests, merge requests, changes, patchsets, approvals, review comments, mergeability, and branch protection/policies.
- **Work provider**: owns durable queue items, status, priority, dependencies/blockers, assignments, comments, projects/cycles/sprints, and completion.
- **CI provider**: owns checks, pipelines, builds, deployments, and required gate state.
- **Layout provider**: owns local repository structure, project graph, package manager/build-system detection, changed-project mapping, and gate selection.

Core commands should read/write a provider-neutral model and let adapters map it to host-specific concepts:

- `WorkItem`: provider key, stable URL, title, body, status, priority, labels/tags, assignees, project/cycle/sprint, blockers, blocked-by, comments, trusted metadata, and source trust level.
- `ReviewItem`: provider key, stable URL, source branch/ref, target branch/ref, review status, approval state, check state, mergeability, linked work items, and review comments.
- `RepoState`: local root, remotes, base branch, active branch, dirty state, worktree/submodule state, workspace roots, project graph, changed paths, and suggested gates.
- `GateEvidence`: command, scope, result, source, timestamp, provider check/build id when available, and trust level.

Forge/review provider matrix:

| Provider | Repo/review model | Work tracking fit | CI/check fit | QUBE priority |
| --- | --- | --- | --- | --- |
| GitHub | Git repos, pull requests, reviews, checks, branch protection, releases, Actions, webhooks. | GitHub Issues, Projects, labels, milestones. | GitHub Actions/checks first-class. | Default provider and first implementation target. |
| GitLab | Projects, issues, merge requests, labels, milestones, epics/groups in higher tiers, pipelines, approvals, webhooks. | Strong native work tracking; issue links can represent blockers better than body text. | GitLab CI pipelines first-class. | First alternative forge because one provider can cover repo, review, work, and CI. |
| Bitbucket Cloud/Data Center | Git repos, pull requests, reviewers, branch restrictions, webhooks, Pipelines. | Bitbucket Issues are basic; Jira is the normal serious tracker. | Bitbucket Pipelines or external CI. | High-value enterprise adapter, usually paired with Jira work provider. |
| Azure DevOps Repos | Git repos, pull requests, branch policies, reviewers, work item links, builds/releases, service hooks. | Azure Boards work items are the natural work provider. | Azure Pipelines/check policies first-class. | High-value enterprise adapter, but model must handle work item types and custom states. |
| Gitea | Git repos, issues, pull requests, labels, milestones, webhooks, releases, Actions in modern installs. | GitHub-like issue model, usually simpler. | Gitea Actions or external CI. | Good self-hosted adapter after GitLab/Bitbucket/Azure. |
| Forgejo / Codeberg | Gitea-derived Git forge with issues, pull requests, labels, milestones, webhooks, repository migration, and Actions/Woodpecker-style ecosystems. | GitHub-like issue model, with self-hosting and Codeberg community use cases. | Forgejo Actions/Woodpecker/external CI. | Pair with Gitea adapter where APIs overlap, but probe host/version. |
| Gerrit | Review-centric changes and patchsets, refs/for pushes, labels/votes, submit rules, REST API. | Not an issue tracker; normally paired with Jira, Bugzilla, GitLab issues, or internal trackers. | CI votes often appear as Gerrit labels such as Verified. | Specialized adapter for review-heavy enterprises and open-source infra. |
| SourceHut | Git hosting, mailing-list patch flow, todo/ticket service, builds, GraphQL API. | Separate todo service can be work provider. | builds.sr.ht can be CI provider. | Lower-volume but architecturally important because it is not PR/MR-shaped. |
| AWS CodeCommit | Git repos and pull requests for existing customers. | No strong native issue tracker; usually Jira/Azure/Linear/etc. | AWS CodeBuild/CodePipeline. | Legacy-only adapter. Do not optimize early unless a user has existing CodeCommit usage. |

Work provider matrix:

| Provider | Work model | Dependency/status mapping | QUBE priority |
| --- | --- | --- | --- |
| GitHub Issues | Issues, labels, milestones, assignees, comments, projects. | Current label/body blocker model works; project fields can become optional structured state. | Default. |
| GitLab Issues | Issues, labels, milestones, assignees, weights, due dates, issue links, boards. | Prefer native issue links for blockers/dependencies, fall back to labels/body lines. | First alternative. |
| Jira | Issues with types, workflows, statuses, priorities, labels, components, sprints, epics, issue links, comments. | Must be schema-driven because workflows and custom fields vary heavily. | First enterprise tracker adapter. |
| Linear | Issues, workflow states, priorities, labels, teams, projects, cycles, relations, comments, GraphQL API. | Strong fit for QUBE queue semantics; use native relations and workflow states. | First modern SaaS tracker adapter. |
| Azure Boards | Work items, states, areas, iterations, relations, comments, links to PRs/commits. | Needs configurable work item types and state transitions. | First Microsoft enterprise tracker adapter. |
| Bitbucket Issues | Issues, comments, assignees, components/milestones/versions depending on product surface. | Usable for simple queues, but usually weaker than Jira. | Basic adapter only; prefer Jira when connected. |
| Gitea/Forgejo Issues | Issues, labels, milestones, assignees, comments, pull request links. | GitHub-like fallback semantics. | Useful for self-hosted users. |
| YouTrack | Issues, custom fields, states, tags, links, boards, comments, workflows, REST API. | Schema-driven; issue links can represent blockers. | Secondary enterprise/dev-tool adapter. |
| Shortcut | Stories, epics, iterations, workflows, labels, comments, owners, priorities. | Workflow states and story relationships map well to QUBE. | Secondary startup/engineering tracker adapter. |
| Plane | Open-source issues, cycles, modules, labels, states, comments, project views. | Linear-like concepts; good self-hosted fallback if API is stable. | Secondary/self-hosted tracker. |
| Trello | Cards, lists, labels, checklists, comments, members, webhooks. | Lists become statuses; checklists can become subtask evidence. | Lightweight fallback, not ideal for autonomous execution. |
| Asana | Tasks, projects, sections, custom fields, assignees, stories/comments, webhooks. | Sections or status fields become states; dependencies are possible but should be probed. | Business-team fallback. |
| Notion | Databases/pages with arbitrary properties, statuses, relations, comments. | Requires user-provided schema mapping; never assume property names. | Prompt/export and configured-schema adapter. |
| ClickUp | Tasks, statuses, custom fields, comments, dependencies, lists/folders/spaces, webhooks. | Schema and hierarchy vary; status mapping must be configured. | Business-team fallback. |

Provider-neutral queue rules:

- GitHub-style labels are only one encoding of priority/status. Core QUBE state should use canonical values and adapters should map to labels, workflow states, board columns, list names, or custom fields.
- Blockers should prefer native dependency/link relations when the provider supports them. Body lines such as `Blocked by: #123` should remain a portable fallback.
- Comments are durable implementation notes, but QUBE should distinguish trusted tool state from untrusted prose on every provider.
- PR should be generalized to **review item**. A review item may be a GitHub pull request, GitLab merge request, Bitbucket/Azure pull request, Gerrit change, SourceHut patchset, or a provider-specific merge proposal.
- CI should be a separate provider capability. GitHub Actions, GitLab CI, Bitbucket Pipelines, Azure Pipelines, Buildkite, CircleCI, Jenkins, Woodpecker, CodeBuild, and local gates should all normalize into gate evidence.
- Webhooks are useful for Umpire, but polling trusted JSON state must remain the fallback because many users will not want to install server-side webhooks.

Repository layout matrix:

| Layout | Detection signals | QUBE behavior |
| --- | --- | --- |
| Single app/service | One obvious package/build root such as `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `pom.xml`, `build.gradle`, `.csproj`, `CMakeLists.txt`, or language-specific manifest. | Default gates can run at repo root; changed-path mapping is simple. |
| JavaScript/TypeScript workspace | `package.json` `workspaces`, `pnpm-workspace.yaml`, `yarn.lock`, `bun.lock`, `turbo.json`, `nx.json`, `lerna.json`, app/package directories. | Detect package manager, workspace members, task runner, affected projects, and per-package gates. |
| Python workspace/monorepo | Root `pyproject.toml`, `uv.lock`, uv workspace members, Poetry/Hatch/PDM config, `tox.ini`, `noxfile.py`, multiple package directories. | Detect workspace members and test/lint entrypoints without assuming one virtual environment per repo. |
| Rust workspace | Root `Cargo.toml` with `[workspace]`, member crates, `Cargo.lock`. | Use `cargo` package/workspace flags and changed crate mapping. |
| Go module/workspace | `go.mod`, optional `go.work`, multiple modules. | Prefer single-module behavior unless `go.work` or multiple `go.mod` roots require workspace-aware gates. |
| Java/Kotlin multi-project | Gradle `settings.gradle(.kts)`, root `build.gradle(.kts)`, Maven aggregator `pom.xml` with `<modules>`. | Use Gradle/Maven project/module selectors and avoid running the entire repo when affected scope is knowable. |
| .NET solution | `.sln`/`.slnx`, multiple `.csproj`/`.fsproj`, `Directory.Build.props`. | Map changed paths to projects and run `dotnet` gates at solution or project scope. |
| Bazel/Pants/Buck monorepo | `MODULE.bazel`, `WORKSPACE`, `BUILD`, `pants.toml`, `BUCK`, target graph files. | Ask the build tool for affected targets where possible; do not infer target graph by filenames alone. |
| C/C++ CMake superbuild | Root/nested `CMakeLists.txt`, `CMakePresets.json`, `FetchContent`, `add_subdirectory`, toolchain files. | Respect presets/toolchains and avoid broad configure/build commands unless configured. |
| Mobile app repo | Android Gradle files, Xcode `.xcodeproj`/`.xcworkspace`, CocoaPods/SwiftPM, Expo/React Native configs. | Require configured device/simulator/manual UI gates when deterministic local gates are insufficient. |
| Infrastructure repo | Terraform/OpenTofu modules, Helm charts, Kubernetes manifests, Ansible, Pulumi/CDK. | Treat plan/apply/deploy commands as high-risk; default to validation/plan-only gates and supply-chain/secret checks. |
| Docs/content repo | Docusaurus, MkDocs, Hugo, Sphinx, mdBook, Astro content, docs-only roots. | Use link/build/lint gates and avoid code-style assumptions. |
| Polyrepo or multi-checkout workspace | Multiple git remotes, sibling repos, Git submodules, Gradle composite builds, Go workspaces, external source dependencies. | Core should support one primary repo at first, then explicit multi-repo workspaces; never mutate sibling repos without policy. |
| Generated/vendor-heavy repo | `vendor/`, generated clients, lockfiles, `dist/`, vendored subtrees, generated code markers. | Quality-control should classify generated/vendor paths and keep implementation changes out unless policy allows. |

Layout provider requirements:

- `repo inspect --json` should return remotes, provider guess, base branch, active branch, root markers, project graph, package managers, lockfiles, CI config, likely gates, generated/vendor paths, and uncertainty warnings.
- `repo affected --json` should map changed paths to projects, packages, services, tests, and gates.
- `repo policy --json` should expose allowed mutation surfaces: branch creation, commits, pushes, review creation, merge, work item transition, dependency install, CI changes, and deploy commands.
- Bootstrap should generate work items with provider-neutral acceptance criteria and let Executor render host-specific instructions such as "open PR", "open MR", "create Gerrit change", or "post patchset".
- Umpire should continue from trusted provider state, not provider prose. It should know which adapter supplied queue state, review state, CI state, and layout state.
- Adapters must report capability flags and "unknown" states explicitly. If an adapter cannot prove mergeability, blockers, checks, or status transitions, QUBE should stop or ask rather than pretending GitHub semantics apply.

Package impact summary:

- **Bootstrap** becomes a provider-neutral planning and rendering package. Its core output is specs, milestones, and canonical work item drafts; GitHub issue creation is one renderer. It should ask or detect which forge/work/review/CI providers and repository layout are in use before generating final artifacts.
- **Executor** is the main adapter orchestration package. It owns provider adapters for queue reads, lifecycle transitions, branch/review operations, comments, CI evidence, and layout-aware gate selection. GitHub-specific commands can remain as aliases, but the internal model should use `WorkItem`, `ReviewItem`, `RepoState`, and `GateEvidence`.
- **Umpire** becomes a provider-neutral continuation policy engine. It should ask Executor and Bootstrap for trusted JSON state instead of calling GitHub directly or assuming GitHub labels, PRs, or Actions checks.
- **Quality-control** becomes layout-aware and provider-text-aware. It should inspect changed files, package/workspace structure, generated/vendor boundaries, review bodies, work item instructions, and CI evidence without assuming GitHub naming.
- **Shared config/common code** becomes more valuable. Provider capability schemas, canonical status/priority enums, adapter result envelopes, trust-level enums, and repo layout detection should probably live in a small shared package or shared module before too many adapters copy the same concepts.

Implementation phasing should keep the current GitHub workflow shippable:

1. Define provider-neutral schemas and make the GitHub adapter emit them.
2. Add `repo inspect --json` / `repo affected --json` style layout outputs before adding more forges.
3. Add GitLab as the first all-in-one alternative provider.
4. Add split-provider support, especially GitHub or Bitbucket repos with Jira/Linear work items.
5. Add self-hosted and specialized adapters such as Gitea/Forgejo and Gerrit only after capability probing and unknown-state handling are reliable.

## Reusable Package Spec Discipline

When planning a reusable package, QUBE agents should use likely consuming packages as private reference material, not as content for the generated package spec. The agent should inspect real consumers to understand duplicated behavior, integration constraints, migration risk, and the smallest useful public API. The generated package spec and milestone docs should stay dry, agnostic, and purpose-driven.

Reusable package specs should:

- state the package purpose in product terms, not by naming current consumers
- define ownership boundaries between the reusable package and application packages
- describe public APIs, runtime behavior, safety rules, tests, packaging, and documentation in generic terms
- allow application-specific extension metadata without importing application-domain concepts
- include adoption-validation milestones that prove the API against real packages without naming those packages in the spec
- keep source references, local paths, investigation notes, and consumer evidence out of the generated artifact
- avoid "reuse verification" reports, provenance sections, implementation history, or rationale notes inside the product spec unless explicitly requested

Bootstrap should preserve the thinking separately in planning state or work item comments when useful: which references were inspected, what duplication was found, what constraints shaped the generic API, and what adoption proof is needed. That evidence can guide future planning, but generated specs and milestones should read as standalone product documents.

## CLI Concepts To Reuse Across QUBE

Source: `/Users/tjalve/Github/ai-executor/docs/spec.md` and `/Users/tjalve/Github/ai-executor/docs/M1-package-and-cli-foundation.md`.

All QUBE CLIs should be explorable by humans and deterministic for agents:

- Human-first help: running the root command or an incomplete command should show concise next steps, examples, and mutation warnings.
- Agent-first structured output: commands useful to agents should support `--json` with stable schemas and no decorative output.
- Schema introspection: each package should expose a command like `<cli> schema --json` so agents and Umpire never need to scrape human help text.
- One command registry: command metadata should drive parser registration, help, schema output, completion, mutation labels, dry-run support, docs checks, and tests.
- Safe suggestions: typos may produce "did you mean" suggestions, but a CLI must never silently run a different mutating command.
- No arbitrary command-prefix abbreviations. Short aliases are acceptable only when explicit, documented, tested, and stable.
- TTY-aware interaction: prompts and rich formatting are allowed only for interactive terminals, and every prompt must have flag/config/non-interactive equivalents.
- Output discipline: data goes to stdout; warnings, progress, hints, and diagnostics go to stderr. JSON stdout must stay valid JSON.
- Error messages should include failed operation, likely cause, suggested next action, and exit-code category.
- Mutating commands should support `--dry-run` unless impossible for a documented reason.
- Shell completion should be explicit. Package installation must not modify shell profiles by side effect.

## Shared Config Concepts

Each package should have a small versioned config file and strict validation. Executor currently proposes `aie.config.json`; other packages should use equivalent package-specific names unless a shared QUBE config layer is introduced later.

Reusable config areas:

- provider selections and capability expectations
- priority, status, and component mappings, including GitHub label names where applicable
- branch naming policy
- work item and review item naming/linking policy
- review agents and review wait duration
- manual UI audit policy
- quality gate commands
- autonomous shipping policy
- prompt-injection instruction toggle
- no-agent-credit instruction toggle

Defaults should match across packages where concepts overlap, especially queue status values, review wait duration, branch/work-item conventions, and GitHub label names for the default provider.

## Package Safety Baseline

The Executor M1 milestone establishes a safety baseline that should apply across QUBE packages:

- TypeScript-first npm packages with explicit executable entrypoints.
- Current supported Node.js baseline; Executor notes Node.js 24 LTS or newer as of 2026-05-14.
- No `preinstall`, `install`, or `postinstall` lifecycle scripts for normal package use.
- No install-time repository mutation, hook installation, shell profile edits, or forge/tracker mutation.
- Pinned-version or lockfile-controlled install documentation; do not recommend floating `latest` installs as the preferred path.
- Minimal justified runtime dependencies.
- No `jq` requirement for core behavior; use Node for JSON parsing and orchestration.
- Normal command tests should not require network access unless the command explicitly tests a network integration.
- Include token-like value redaction in logs and debug output.

## Core Implementation Guardrails

Source: later Executor planning work in Codex session `019e2728-ee2d-72a0-a26a-ba878d9ffe4c`, current `ai-executor/docs/spec.md`, and `ai-executor/docs/M4-init-agent-instructions-and-make-it-so.md`.

QUBE should treat these as family-wide agent guardrails, with Bootstrap generating them into work items/instructions and Executor installing/enforcing them during work item execution:

- Implement only real requested behavior.
- Do not add executable future commands, placeholder command classes, stubs, no-op implementations, mock product paths, or "not implemented yet" runtime behavior.
- Do not add tests that pass without validating real behavior.
- Keep source code, tests, package scripts, comments, generated files, shipped docs, commits, review titles, and review bodies in product language.
- Do not leak milestone numbers, bootstrap phases, work item implementation history, baseline language, reference repository names, local reference paths, or source-provenance explanations into implementation artifacts.
- Do not create decision records, status files, progress reports, implementation plans, migration notes, quick guides, retrospectives, phase summaries, or other repository meta documentation unless the active work item explicitly asks for stable product, user, architecture, test, or workflow docs.
- Use provider work item comments and review items for durable implementation notes, with GitHub issue comments and PRs as the default provider encoding.
- Do not commit generated build output unless repository policy explicitly allows it.
- Keep test doubles, deterministic fixtures, harness adapters, and development probes isolated under test-support or harness boundaries. They must not be registered in default runtime paths or become product-visible fake features.

These rules are not only Executor implementation rules. Bootstrap should include them in generated work item acceptance criteria and installed planning instructions. Quality-control should be able to detect violations. Umpire should continue or stop work based on these rules instead of letting agents "complete" fake progress.

## Core Supply-Chain Guard

Source: `/Users/tjalve/.agents/skills/supply-chain-guard/SKILL.md`.

QUBE should include supply-chain protection as built-in behavior rather than assuming the host agent has a local skill installed. Relevant defaults:

- Prefer existing code, standard libraries, or existing dependencies before adding packages.
- Treat package-manager commands, project generators, CI actions/workflows, build caches, release jobs, IDE extensions, MCP servers, and AI-agent tools as code execution.
- Use exact versions and preserve lockfiles intentionally.
- Never recommend floating `latest`, unpinned Git branches, unverified tarballs, curl-pipe-shell installers, or broad upgrade commands as the default path.
- Disable lifecycle scripts by default during installs where the package manager supports it, for example `--ignore-scripts`.
- Require a package age gate: at least 7 full days for newly introduced versions, preferably 14 days for runtime, privileged, build-tooling, CI/CD, auth, crypto, networking, installer, postinstall, native binary, or transitive-heavy packages.
- Verify package identity, registry/source URL, repository metadata, provenance/signatures where available, builder/workflow identity, install scripts, native binaries, generated code, integrity hashes, and lockfile impact.
- Stop for explicit human approval on high-risk or ambiguous dependency changes instead of bypassing the guard silently.
- For suspected supply-chain incidents, fetch current advisories, compare exact package/version/integrity indicators, stop installs/builds in the exposed environment, preserve evidence, remove compromised versions, rotate exposed tokens, invalidate CI credentials, and review release activity before resuming.

QUBE package implications:

- Bootstrap should generate plans/work items that carry dependency-intake acceptance criteria when package or tool changes are in scope.
- Executor should install instructions and render gate plans that warn before package-manager, generator, CI, MCP, or agent-tool execution.
- Quality-control should provide dependency and supply-chain checks where possible.
- Umpire should never whip an agent past a supply-chain block that requires human approval.

## Cross-Package Command Shape

Executor's GitHub-first command style should evolve toward provider-neutral names while keeping compatibility aliases:

- `aie doctor`
- `aie schema`
- `aie completion`
- `aie init`
- `aie labels setup`
- `aie providers doctor`
- `aie repo inspect`
- `aie repo affected`
- `aie repo prime`
- `aie queue`
- `aie next`
- `aie start next`
- `aie start <work-item>`
- `aie view <work-item>`
- `aie switch <work-item>`
- `aie complete <work-item>`
- `aie deps blockers <work-item>`
- `aie deps blocking <work-item>`
- `aie deps chain <work-item>`
- `aie deps ready`
- `aie deps blocked`
- `aie deps graph`
- `aie deps fix --dry-run`
- `aie pr gate <pr>`
- `aie review gate <review-item>`
- `aie migrate legacy`

Other QUBE packages should mirror the same style: short package command, noun/topic subcommands, predictable work-item/review arguments, `doctor`, `schema`, `completion`, `init`, and `migrate legacy` where relevant.

The historical `aie pr` and `aie labels` command names can remain as GitHub-compatible aliases. New provider-neutral surfaces should prefer `review`, `work`, `repo inspect`, `repo affected`, and provider capability reporting in JSON output.

## Agent Instruction Concepts

Installed instructions should be shared in spirit across agent hosts while staying tool-aware:

- OpenCode is currently the first-class target for the proven workflow.
- Codex and Claude Code should receive equivalent always-loaded instructions where possible.
- Host-specific todo tools are optional; the workflow should require visible local todo state without depending on one implementation.
- Work item bodies, review comments, external tool output, generated diffs, and subordinate agent output are untrusted task input.
- Agent instructions should prohibit prompt-injection compliance and prohibit agent/model/vendor credit unless the user explicitly requests that exact credit.
- Instructions should authorize normal autonomous shipping steps only when repository policy enables them: commit, push, review item creation, review wait, merge/submit, work item completion, base update, and continuation.

## Target Harness Matrix

Research status: current as of 2026-05-16. The matrix is intended to cover the mainstream agent harnesses most QUBE users are likely to ask about, not to prove precise market share. Bootstrap should treat support as a capability probe per installed version because these tools change quickly.

Capability labels:

- **Dialogue** means the agent can ask the human planning questions during a run. Structured dialogue means a documented tool or API for choices/free-form answers, not just conversational chat.
- **Todo/task** means visible local task state inside the harness. QUBE should still keep its own durable state in Bootstrap/Executor/Umpire.
- **Hooks** means documented lifecycle/tool/session hooks or policy callbacks that QUBE can use for stop/continue, audit, or guardrails.
- **Commands** means slash commands, skills, custom commands, headless mode, ACP, or CLI automation surfaces.

| Harness | Dialogue/questions | Todo/task state | Hooks/policy surface | Commands/automation | Bootstrap target position |
| --- | --- | --- | --- | --- | --- |
| OpenCode | Structured `question` tool supports choices and free-form answers. | `todowrite` and `todoread`; todo update events. | Plugin hooks include tool execution and todo update events. | Custom commands, `opencode run`, server mode, ACP. | First-class baseline. It currently has the cleanest proven QUBE-shaped loop. |
| Claude Code | Structured `AskUserQuestion` tool, including multiple-choice prompts and deferred headless behavior. | Task and subagent lifecycle hooks; todo/task visibility depends on surface/version. | Strong documented hook set for user prompt, tool use, notifications, stop/subagent stop, session start/end, and pre-compaction. | Slash commands, skills, MCP, headless usage. | First-class target after OpenCode because its question and hook contracts are strong. |
| Gemini CLI | Structured `ask_user` tool. | `write_todos`; task tracker support. | Documented hook system. | Custom TOML slash commands, MCP/tooling, headless-friendly CLI usage. | Priority target; close to OpenCode/Claude for Bootstrap planning dialogue. |
| Qwen Code | Conversational dialogue plus `/btw` side questions; no OpenCode-style structured agent question tool confirmed in this pass. | Documented `todo_write` tool. | Documented hooks include tool, session, stop, subagent, compaction, notification, and permission events. | Slash commands, custom commands/extensions, MCP, subagents. | Priority open-source target, but adapter must version-probe rather than assuming full Gemini parity. |
| Codex | Interactive dialogue exists in Codex surfaces; no public OpenCode-style CLI question-tool contract confirmed in this pass. | Plan updates are emitted in non-interactive JSON; todo/plan UX varies by Codex surface. | Documented Codex hooks include session/tool hook points, and `PreToolUse` can block or add context. | Codex CLI/app/web/IDE, slash commands, AGENTS.md, MCP, rules, plugins, skills, subagents, non-interactive JSON, app/server/MCP-server automation. | Important target because many users will have it, but Bootstrap should not assume OpenCode-style question/todo tool names. |
| GitHub Copilot coding agent / CLI | Documented `ask_user` tool and `/ask` side question; IDE/cloud dialogue also exists. | `/tasks` manages subagents and shell commands; `task` tool runs subagents. | Documented hooks, permissions, custom instructions, MCP, plugins, skills, custom agents, and OpenTelemetry. | IDE chat/agent mode, Copilot CLI, `-p` programmatic mode with JSONL output, `/fleet`, `/plan`, `/pr`, `/remote`, ACP reference. | High-coverage priority target. It is strong enough for a first wave adapter, but QUBE should still probe exact CLI version and enterprise policy. |
| Cursor | Conversational Ask/Agent UX; no stable documented structured question tool found in this pass. | Agent planning is UI-visible; no portable todo API should be assumed. | Rules, MCP, approvals, background-agent/webhook surfaces; general local lifecycle hooks are limited compared with Claude/OpenCode. | Cursor CLI/headless prompts, rules, MCP, background agents. | High-coverage editor target. Bootstrap should export rules/prompts and use durable QUBE state outside Cursor. |
| Windsurf Cascade | Conversational questions and planning in Cascade. | Built-in todo/list behavior is documented for Cascade workflows. | Hooks, workflows, rules, and MCP-like integrations are documented. | Cascade commands, workflows, MCP/integrations, CLI/editor workflows. | High-coverage editor target; promising if hooks remain stable. |
| Cline | Structured `ask_followup_question` tool. | Task/new-task tools and checklist-style task state; exact todo API should be probed. | Rules, workflows, MCP, command execution controls, and extension lifecycle surfaces. | VS Code extension, MCP marketplace/config, workflows, CLI/headless JSON in newer docs. | Priority VS Code target because it has explicit human-question behavior. |
| Roo Code | Historically similar to Cline with custom modes, rules, MCP, and planning/todo patterns. | Historically supported task/todo-style workflows. | Historically documented rules/MCP/workflows. | VS Code extension commands and modes. | Do not make a new primary target unless the current project state is verified; the ecosystem shifted in 2026. |
| Grok Build | Interactive TUI planning/dialogue is documented; no public structured question-tool schema found yet. | No public todo primitive equivalent to `todowrite` found yet. | `/hooks` and hook support are documented, but public event/schema detail is still thin. | Skills as slash commands, plugins/marketplaces, MCP, headless `plain`/`json`/`streaming-json`, ACP. | Experimental target. Attractive, but too new to be Bootstrap primary until hooks, todos, and question schema are validated. |
| T3 Code / T3 Chat Code | Control plane over tools such as Claude Code, Codex, OpenCode, and Cursor rather than a distinct low-level harness. | Inherits task state from the selected underlying harness plus T3-level sessions/branches. | Inherits hooks mostly from the underlying harness; T3 may add workflow/UI controls. | Multi-agent/session UI, branches, diffs, terminal, PR actions, quick actions. | Treat as wrapper support: target the underlying harness first, then add T3-specific launch/session conveniences. |
| Continue | Conversational agent mode; no portable structured question tool should be assumed. | Agent/tool state exists, but durable todo support should live in QUBE. | Rules, tools, MCP, prompt files, and model/context configuration. | IDE extension, CLI/headless automation, custom slash prompts. | Secondary high-coverage target for teams already using Continue; good prompt/rules export surface. |
| Amazon Q Developer CLI | Conversational CLI/IDE agent. | No portable todo contract should be assumed. | CLI/tool policies, MCP-like server integration, and enterprise controls vary by product surface. | CLI chat commands, IDE integration, custom agents/personas in current docs. | Secondary enterprise/AWS target; use prompt/instruction export until hooks are verified. |
| Kiro | Spec-driven conversational agent UX. | Task/spec workflows are product concepts, but local todo API should be probed. | Agent hooks, MCP, and custom steering are documented. | Specs, steering files, hooks, MCP, CLI/IDE surfaces. | Strong conceptual fit for Bootstrap specs, but treat as separate adapter after OpenCode/Claude/Gemini/Codex/Copilot. |
| Sourcegraph Amp | Conversational coding agent; structured question tool not confirmed in this pass. | Todo/tool support exists in some agent workflows, but should be probed. | MCP and enterprise controls are documented; hook depth should be verified. | CLI/editor usage, execute/headless-style modes, MCP. | Secondary enterprise target; good for large codebase users if command contracts are stable. |
| Aider | Conversational terminal coding agent. | No first-class todo contract; tasks live in prompt/chat/git workflow. | No general lifecycle hook system; uses repo commands such as test/lint/build and git integration. | Rich slash commands, architect/code modes, lint/test loops, auto-commit options. | Fallback CLI target. Good for issue execution prompts, weak for Bootstrap-driven interactive questions. |
| OpenHands | Web/CLI autonomous agent platform. | Agent task state is platform-visible; QUBE should keep durable queue state externally. | Runtime, sandbox, event, and integration hooks depend on deployment. | CLI/headless/server modes, GitHub integration, custom agents/workflows. | Secondary open-source platform target for self-hosters. |
| Goose | Conversational desktop/CLI agent with extension tools. | No portable todo contract should be assumed. | Extension/tool server model; lifecycle hooks should be probed. | CLI/desktop, extensions, MCP-like integrations. | Secondary target; useful where users prefer local open-source agent orchestration. |
| Replit Agent, Bolt, Lovable, v0, web app builders | Conversational planning exists in the product UI. | Product-specific task/spec state, not a local portable todo API. | Usually no local lifecycle hooks suitable for QUBE. | Web UI actions, imports/exports, GitHub sync where supported. | Prompt/export-only support. They cover many users, but they are not good primary QUBE harnesses. |
| JetBrains AI/Junie and other IDE agents | Conversational IDE agent workflows. | Product-specific planning state. | IDE extension APIs and policy controls vary; no OpenCode-style portable hook contract should be assumed. | IDE commands, project instructions/rules where supported. | Prompt/instructions export target until a stable CLI/hook API is verified. |

Adapter priority:

1. **Primary structured targets**: OpenCode, Claude Code, Gemini CLI, GitHub Copilot CLI, Cline. These have the clearest question/dialogue primitives for Bootstrap.
2. **High-coverage prompt/rules targets**: Codex, Cursor, Windsurf. These cover many users, but Bootstrap should keep durable state outside the harness and probe for optional structured capabilities.
3. **Emerging or wrapper targets**: Grok Build, T3 Chat Code, Qwen Code, Kiro, Amp, Continue. Support them through a capability matrix and version probes instead of hardcoding assumptions.
4. **Fallback/export targets**: Aider, Goose, OpenHands, JetBrains agents, web app builders. Provide good prompts, instructions, work item bodies, and runbooks, but do not depend on structured dialogue or hooks.

Bootstrap should define a target capability schema rather than a single host assumption:

- `dialogue`: `none`, `conversational`, `structured-choice`, `structured-choice-and-freeform`, `headless-defer`
- `todo`: `none`, `harness-visible`, `tool-backed`, `task-lifecycle`
- `hooks`: `none`, `session`, `tool-prepost`, `todo-events`, `stop-continue`, `full-lifecycle`
- `commands`: `prompt-export`, `slash-command`, `skill-command`, `headless-json`, `streaming-json`, `server`, `acp`
- `instructions`: `repo-file`, `rules-file`, `custom-instructions`, `skill`, `mcp`
- `safety`: `approval-gates`, `sandbox`, `permission-config`, `policy-hooks`

Bootstrap should always degrade gracefully:

- If structured dialogue exists, generate choice-based planning questions with recommended defaults.
- If only conversational dialogue exists, generate a single concise prompt that asks the same questions in human language.
- If no live dialogue exists, emit a planning questionnaire file or work item comment.
- If todo tools exist, mirror only short-lived planning steps into the harness todo list.
- If todo tools do not exist, rely on `aib status --json` and durable planning state.
- If hooks exist, use them for prompt-injection guardrails, supply-chain stops, and continuation checks.
- If hooks do not exist, make Umpire poll trusted `aib`/`aie`/`aiq` JSON state instead of trusting agent prose.

Primary sources checked during this pass included OpenCode docs, Claude Code docs, Gemini CLI docs/source, Qwen Code docs, Codex/OpenAI official docs/source, GitHub Copilot CLI/docs, Cursor docs, Windsurf docs, Cline docs, Grok Build docs, and T3 Code docs. Lower-tier fallback rows should be refreshed from primary docs before committing implementation adapters.

## Bootstrap Planning UX

Source: Codex session `019e2728-ee2d-72a0-a26a-ba878d9ffe4c`, "Package Executor as npm package", run in `/Users/tjalve/Github/ai-executor` on 2026-05-14.

The process used for `ai-executor` should become a core `ai-bootstrap` experience. A human can arrive with a built-out idea, rough notes, or only an initial direction. Bootstrap should help turn that into a dry functional spec, milestone docs, and durable work items through a guided loop.

The important pattern from the Executor session:

- Start by reading nearby reference projects and existing docs so questions are grounded in real repo behavior.
- Ask only scope questions that materially change the spec.
- Use the human's own language. Avoid exposing internal abstraction labels such as "workflow assets" when the human thinks in terms of scripts, commands, issue flow, PR review, and agents continuing overnight.
- Offer concrete options and recommendations rather than broad conceptual interviews.
- Let the human answer with rough bullets, corrections, and preferences.
- Convert those answers into explicit product boundaries and functional requirements.
- Keep meta layers clean: product requirements describe the thing being built; source references and research material can guide spec/milestone generation, but must not become runtime product concepts unless they are actual functionality.
- When the human catches a meta-layer problem, refine the spec immediately rather than defending the draft.
- Make the spec self-sufficient enough that a new context thread can generate milestones from it without remembering the conversation.
- Keep references available for milestone generation as local source material, but do not require the shipped package to know about that corpus.
- Break down milestones by deliverable slices, not one work item per FR.
- For each milestone, include strategic goal, FR mapping, dependencies, source references, concrete parts, proposed work item set, and exit criteria.
- Carry cross-cutting research, such as CLI UX, into each relevant milestone as acceptance criteria, not as vague background.

The Executor session produced this rough planning pipeline:

1. Initial idea intake and repo archaeology.
2. Concrete scope questions with recommendations and defaults.
3. Human feedback that corrects language, product boundaries, and priorities.
4. Draft `docs/spec.md` with stable FR IDs and `Required / Desired / Future` statuses.
5. Review pass for missing behavior, safety, migration, references, and meta-layer mistakes.
6. Refinement pass to make the spec dry and self-contained.
7. Milestone shape planning based on the spec and reference milestone docs.
8. Milestone generation one by one, with work item counts kept intentionally small.
9. Research loops inserted when a topic needs better grounding, such as CLI UX for humans and agents.
10. Acceptance criteria updates so research conclusions affect implementation work.

Bootstrap should support two planning modes:

- **Interactive mode**: the agent collaborates with the human, asks concrete questions, proposes tradeoffs, writes draft artifacts, and iterates on feedback.
- **Automatic mode**: at any point, the human can hand the process to Umpire with a prompt/whip override that keeps the agent moving through spec, milestone, and work item writing until the planning queue is complete.

Automatic mode must be multi-step and resumable. It cannot assume everything fits in one context window. Bootstrap should create durable planning state so Umpire can restart the next step in a fresh context:

- current planning phase
- source notes and reference paths
- unanswered questions
- human decisions already made
- draft spec path and status
- generated milestone list and status
- generated work item batches and status
- next recommended prompt for the agent
- stop conditions, such as "blocked on human decision" or "all work items generated"

Umpire integration should not mean "write everything in one session." It should mean "continue the next concrete planning step, verify the artifact, record state, and either proceed or ask for the missing human decision."

Bootstrap should eventually expose commands or flows along these lines:

- `aib plan`: start or resume the planning conversation.
- `aib questions`: generate concrete scope questions from current notes and references.
- `aib spec`: write or refine the dry functional spec.
- `aib milestones`: propose and then generate milestone docs from the spec.
- `aib issues`: generate work items from milestone docs, with GitHub Issues as the default provider renderer.
- `aib status --json`: report planning state for Umpire.
- `aib continue --json`: return the next planning action for Umpire or an agent host.
- `aib whip`: produce a continuation prompt/override that tells Umpire to keep the planning loop alive until completion or a human-blocking question.

Bootstrap should be comfortable with a human saying "default" or giving partial answers. The product should reason conservatively, write down assumptions, and surface only the remaining decisions that truly affect scope.

## Provider And Tool Extraction Roadmap

QUBE should treat provider support and agent tooling support as separate abstraction axes. The initial package set can stay GitHub and OpenCode only because those are the current testable surfaces. Abstraction work should preserve that working path first, then extract seams deliberately.

Planned sequence:

1. Complete `aiq`, `aie`, and `aiu` as GitHub plus OpenCode packages.
2. Move the packages into a QUBE monorepo while preserving working GitHub/OpenCode behavior.
3. Extract shared QUBE code inside the monorepo before deciding which pieces deserve npm packages.
4. Extract GitHub functionality as the first provider package for `aie`, `aiu`, and `aiq`.
5. Abstract agent tooling as a first-class concept.
6. Extract OpenCode as the first tooling package for `aie`, `aiu`, and `aiq`.
7. Create `ai-bootstrap` on the real GitHub/OpenCode stack, using the emerging interfaces but accepting the extra later extraction cost. Bootstrap should not start as a non-functional package that cannot be tested against real provider and tool surfaces.
8. Expand the GitHub and OpenCode packages with `aib` support.
9. Create the top-level QUBE package that composes the product packages, provider packages, and tooling packages.
10. Add other providers and tools only after the GitHub/OpenCode split proves the seams, for example Linear, GitLab, Jira, Azure Boards, Codex, Claude Code, Gemini CLI, Cursor, and Cline.

Shared QUBE code is not automatically an npm package. At first it should be monorepo-internal code for schemas, capability contracts, config normalization, trust models, JSON envelopes, command metadata, and shared guardrails. Promote shared code to published packages only when more than one product package needs a stable external dependency boundary or third-party adapters need to compile against it.

Provider packages own remote/product integrations:

- API calls, CLIs, authentication assumptions, pagination, rate limits, and provider-specific error handling
- mapping provider work, review, CI, and repository state into QUBE canonical models
- provider mutations such as status transitions, comments, issue closure, review requests, merge/submit operations, and dependency links
- explicit unknown or unsupported states when the provider cannot prove a capability

Tooling packages own agent-host integrations:

- instruction targets, project commands, slash commands, skills, rules files, and prompts
- todo/task primitives and fallback behavior
- dialogue/question primitives and deferred human decision handling
- hooks, stop/continue behavior, permissions, sandbox policy, and session/headless execution surfaces
- tool-specific continuation prompts such as OpenCode's `make-it-so` command
- tool-specific agent/category descriptor compilation, such as OpenCode subagent config, Codex subagent prompts, Claude Code task prompts, Gemini/Qwen task prompts, Cursor rules/prompts, or fallback prompt-only exports

Product packages consume capabilities rather than concrete integrations:

- `aiq`: quality checks, evidence validation, provider-text checks, and layout-aware findings
- `aie`: work execution, lifecycle transitions, branch/review/gate orchestration, and completion
- `aiu`: continuation policy over trusted JSON state
- `aib`: idea intake, spec/milestone/work-item generation, provider rendering, and planning continuation
- `qube`: top-level composition, defaults, init, doctor, schema, and status UX

Core abstractions:

- `WorkItem`: durable task, story, issue, ticket, or card
- `ReviewItem`: pull request, merge request, Gerrit change, patchset, or provider-specific review object
- `RepoState`: local checkout, refs, remotes, dirty state, worktrees, submodules, layout, and affected scope
- `GateEvidence`: local command evidence, CI provider evidence, review evidence, audit evidence, quality-control evidence, trust level, timestamp, and stale/unknown state
- `PlanningState`: idea/spec/milestone/work-item generation state, provider choices, unresolved questions, generated artifacts, created provider IDs, and next planning action
- `ProviderSource`: source provider, resource kind, resource id, URL, metadata, and trust boundary
- `CapabilityReport`: supported, unsupported, unknown, and policy-blocked operations for providers and tools
- `AgentToolHost`: coding-agent environment with instruction, command, todo, dialogue, hook, permission, and continuation capabilities
- `AgentInstructionTarget`: host-specific files, rules, skills, commands, or prompts that carry QUBE instructions
- `AgentTodoState`: transient local execution checklist mirrored from durable work state when available
- `AgentDialogue`: structured choices, free-form questions, conversational fallback, or no-live-dialogue questionnaire behavior
- `AgentContinuation`: stop hooks, session resume, headless execution, polling, and next-prompt generation
- `AgentDescriptor`: reusable agent role with name, description, kind, optional host type, optional model or reasoning-effort preference, prompt seed, read-only/write-scope hints, and required skills or tools
- `CategoryDescriptor`: routeable work category with name, description, optional model/effort preference, prompt append, default agent, and safety or verification hints

Agent and category descriptors should be product-neutral. Tooling packages compile them into host-native forms instead of product packages hardcoding OpenCode, Codex, Claude Code, or other tool details. For example:

- OpenCode can render subagent config, command files, todo conventions, and `AGENTS.md` sections.
- Codex can render subagent prompt seeds, model/effort hints where supported, skill/plugin routing hints, and `AGENTS.md` sections.
- Claude Code, Gemini CLI, Qwen Code, Cline, Copilot, Cursor, and other hosts should receive the closest supported instruction, command, task, rule, hook, or prompt export based on probed capabilities.

Descriptor compilation must degrade gracefully. If a host cannot honor a model, reasoning effort, permission, todo, dialogue, or hook request, the adapter should use the configured fallback and expose the substitution in debug or JSON output.

Prompt composition should be deterministic and inspectable:

1. Host safety prefix from the tooling package.
2. Agent seed or category executor seed.
3. Category prompt append, if any.
4. Skill, plugin, MCP, or rule routing hints.
5. Work-item, review-item, planning, or command-specific context.
6. Output contract, including paths, JSON shape, verification evidence, or summary fields.

Reusable agent descriptors should focus on durable work roles, not on one provider's persona names. The useful part of the OmO-style setup is the routing taxonomy: well-instructed read-only specialists, bounded workers, reviewers, and creative or UX routes that a tooling package can compile into whatever the host supports.

Recommended descriptor catalog:

| Descriptor | Default role | Use when | Host compilation notes |
| --- | --- | --- | --- |
| `explorer` | Read-only codebase search specialist. | Finding where behavior lives, mapping internal patterns, answering "how is this implemented?", preparing file/path context before execution. | Prefer read-only subagent/task if available; otherwise emit a focused search prompt. Should return exact paths, why they matter, direct answer, and next steps. |
| `librarian` | Read-only external research specialist. | Official docs, OSS source behavior, changelogs, package/API history, examples, ecosystem constraints. | Tooling adapter should include source/link requirements and evidence-vs-inference discipline. Should not edit repository files. |
| `oracle` | Read-only senior technical advisor. | Architecture, hard debugging, repeated failed fixes, security/performance tradeoffs, high-risk decisions. | Should produce one primary recommendation, action plan, confidence, risks, and verification guidance. Useful as a review/advisory subagent before implementation. |
| `qa-reviewer` | Read-only verification and regression reviewer. | After implementation, before review item creation, or when evidence is weak. | Should inspect diff, changed files, tests, risks, missing cases, and output findings by severity. Can compose with `aiq`, CI, or repository gate evidence. |
| `plan-reviewer` | Read-only plan critic. | Reviewing specs, milestone plans, or execution plans before work begins. | Should validate references, dependencies, task executability, acceptance criteria, and QA scenarios. Reject only for true blockers. |
| `pre-planner` | Ambiguity and hidden-requirement scout. | Before planning broad or unclear work. | Should identify hidden intent, ambiguity, unstated constraints, likely agent failure modes, concrete questions, and planner directives. |
| `deep-worker` | Bounded autonomous implementation worker. | Clear goal, non-trivial implementation, root-cause fix, or multi-file delivery. | Should explore before edits, respect existing patterns, own only assigned scope, verify end to end, and report changed paths plus evidence. |
| `quick-worker` | Small bounded implementation worker. | Trivial or narrow change with obvious scope. | Should use minimal exploration, avoid abstractions, and verify the exact change. Often local execution is cheaper than spawning. |
| `ux-visual` | UX/UI/design/frontend specialist. | Layout, interaction, styling, animation, visual polish, accessibility, responsive QA. | Tooling adapter should attach host-specific UI skill/rules, design-system inspection instructions, browser/screenshot QA, and visual acceptance criteria. |
| `writer` | Documentation and prose specialist. | Docs, technical writing, release notes, issue/PR prose, spec cleanup. | Should match audience and tone, remove filler, preserve source truth, and avoid product claims not supported by evidence. |
| `business-logic` | Domain-rule modeling specialist. | Invariants, edge cases, data flow, policy rules, validation rules, state machines. | Should model rules explicitly and propose tests around invariants and failure modes. |
| `multimodal-reader` | Visual/document interpreter. | Screenshots, PDFs, diagrams, mockups, videos, or other non-code artifacts. | Should extract only requested information and say when evidence is absent. |
| `creative-strategist` | Taste-heavy or unconventional ideation specialist. | Naming, product framing, design direction, unusual solution exploration. | Should generate coherent alternatives, select a direction, and avoid turning creative exploration into unbounded implementation. |

Executor can use these descriptors as routing hints when a work item, review item, or local task benefits from specialization. It should still keep the durable state and final responsibility in the product package: subagents provide evidence, advice, or bounded changes; they do not become the source of truth for queue status, review status, or gate truthfulness.

Category descriptors can be simpler than named agents:

| Category | Typical descriptor | Intent |
| --- | --- | --- |
| `quick` | `quick-worker` | Small exact task, minimal scope, no new abstraction. |
| `deep` | `deep-worker` | Hard implementation with broad enough exploration and full verification. |
| `ultrabrain` | `oracle` or `deep-worker` | Genuinely hard reasoning, architecture, algorithm, or systemic tradeoff. |
| `visual-engineering` | `ux-visual` | UI/UX/CSS/layout/animation/frontend design with design-system and browser QA. |
| `writing` | `writer` | Human prose, docs, release notes, specs, and communication. |
| `business-logic` | `business-logic` | Domain invariants, edge cases, data flow, and rule tests. |
| `review` | `qa-reviewer` | Diff review, regression risk, missing tests, and evidence quality. |
| `research` | `explorer` or `librarian` | Internal codebase search or external docs/source research. |

Adapters should probe host support before using these routes. OpenCode may compile them into subagent config and commands; Codex may compile them into subagent prompts with model/effort hints where supported; Claude Code, Gemini CLI, Qwen Code, Copilot, Cline, Cursor, and other hosts should receive the closest supported task/rule/prompt form. If no subagent mechanism exists, QUBE can still use the same descriptors to generate a strong single-agent prompt.

Provider capability map:

| Capability | GitHub v0 | Linear | GitLab | Jira |
| --- | --- | --- | --- | --- |
| Work items | GitHub Issues | Linear issues | GitLab issues | Jira issues |
| Work status | `S-*` labels | workflow states | labels, state, or boards | workflow statuses |
| Priority | `P*` labels | native priority | labels or weight | priority field |
| Dependencies | body fallback, native links later | native relations | issue links | issue links |
| Comments | issue comments | comments | notes | comments |
| Review items | pull requests | external review provider | merge requests | external review provider |
| CI/checks | GitHub checks/actions | external CI provider | GitLab pipelines | external CI provider |
| Mergeability | pull request API | not native | merge request API | not native |
| Mutations | labels, comments, close, PR actions | update/comment/transition | issue/MR updates | workflow/comment/update |
| Best role | default all-in-one provider | work provider | forge, work, review, and CI provider | enterprise work provider |

Agent tooling capability map:

| Capability | OpenCode v0 | Codex | Claude Code | Cursor |
| --- | --- | --- | --- | --- |
| Always-loaded instructions | `AGENTS.md` | `AGENTS.md` or rules | `CLAUDE.md` | rules/instructions |
| Project commands | `.opencode/commands` | tool-specific or limited | slash/custom commands | rules/prompts |
| Todo/task state | `todowrite` and `todoread` | plan/todo where available | `TodoWrite` and `TodoRead` | UI-visible, not portable |
| Dialogue | structured question support | conversational, surface-dependent | strong question support | conversational |
| Hooks/policy | strong OpenCode hooks | host hooks vary | strong hooks | limited/general |
| Headless/session | `opencode run`, server, ACP | CLI/app modes | headless modes | CLI/background varies |
| Permissions/safety | host permissions and hooks | sandbox/hooks vary | tool permissions and hooks | IDE approvals |
| Initial QUBE role | first tested tooling package | later high-priority adapter | later high-priority adapter | prompt/rules adapter |

The practical extraction test is simple: after GitHub and OpenCode are packages, core product code should not need direct `gh`, GitHub issue-number, GitHub PR-number, `S-*` label, GitHub milestone, `.opencode`, `todowrite`, or OpenCode command-path assumptions except through compatibility aliases and adapter-owned renderers.

## Open Questions

- Should QUBE eventually have a wrapper command, for example `qube`, or should each package remain directly invoked by `aiq`, `aiu`, `aib`, and `aie`?
- Should shared CLI metadata, output envelopes, config validation, provider schemas, and default GitHub label definitions live in a small common package?
- Should Bootstrap own the first shared QUBE spec format, or should the format live outside all four packages?
- How much of the mature shell helper behavior should remain as compatibility wrappers during migration versus being replaced immediately by package commands?
