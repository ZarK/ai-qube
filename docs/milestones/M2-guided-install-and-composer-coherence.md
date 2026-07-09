# QUBE M2 - Guided Install And Composer Coherence

Repo-level milestone spanning `products/qube`, `packages/qube-cli`, `products/aie`, `products/aiu`, and the provider/host adapters. Companion milestones: `M1-review-loop-convergence-and-cost-tiers.md`, `M3-adapter-testkit-and-provider-permutations.md`.

## Strategic Goal

Make `qube install` and `qube init` take a human or an agent from any starting state (blank repo, packages already installed, instructions stale) to a doctor-verified working setup for their selected hosts and providers — executing within the existing supply-chain baseline instead of only printing a plan — and make the composer CLI surface coherent enough that neither humans nor agents need to know the component packages exist.

## Current State And Evidence

Installer:

- `qube install` is plan-only: `mode: "copy-commands"` hardcoded, output ends with "No commands were run." (`products/qube/src/runtime.ts:4046,4223`). It writes no files; `.qube/aie/config.json` and AGENTS.md/CLAUDE.md appear only as note strings; selected optional adapters (linear, gitlab, jira, jenkins, opencode) are described in notes but absent from the printed install command; host `inspect*Workspace` detection exists but is not consulted.
- Safety controls to preserve unchanged: `dependencyVersion()` throws on non-exact versions (`products/qube/src/package.ts:17`), `lifecycleFlag()` always yields `--ignore-scripts` (`runtime.ts:4232`), PATH-fallback integrity refusal (`runtime.ts:1104-1125`), TTY prompt gating under `--json`/`--yes`/CI, `publishConfig.provenance`.

Installer dogfood run (this repo, globally installed `@tjalve/qube@0.2.2`, hosts claude-code + codex + grok-build, GitHub work/CI):

1. **The plan never mentions `qube aie init`.** The actual setup work — writing `.qube/aie/config.json`, AGENTS.md, CLAUDE.md, `.codex/agents/qube-review-focus.toml` — happens through `qube aie init <target> --tool <host>`, but the printed install plan's only steps are the package-manager command and `qube components`. A human or agent following the plan verbatim ends with packages and no workflow. The one init pointer that does appear (`qube aiu init --tool claude-code`) is buried in a Claude hook note.
2. **No installed-state detection.** `qube` 0.2.2 was already installed globally and the repo already had `.qube/aie/config.json` and managed AGENTS.md; the plan still opened with `pnpm add -D --save-exact --ignore-scripts @tjalve/qube@0.2.2` and mentioned none of the existing state.
3. **Single-host planning.** `--host` accepts one value; covering claude-code + codex + grok-build takes three runs whose output is ~80% identical boilerplate. Nothing tells the user that Grok Build is covered by the Codex-managed AGENTS.md (`aie init --tool` has no grok-build value — the host-surface → init-tool mapping is undocumented).
4. **Verification is too shallow and manual.** The plan's verify step is `pnpm exec qube components`; the real post-setup verifier is `qube aie doctor`, which surfaced actionable state the plan ignores (stale base ref, blocking open PR, queue drift, `aiq=missing`, branch/issue mismatch). The plan never mentions doctor.
5. **Managed-file false conflicts.** `aie init --tool codex` blocked on `.codex/agents/qube-review-focus.toml` with "Managed section was edited outside Executor" although the content was byte-for-byte the rendered text; the checksum had drifted (line endings). Recovering required `--force` with a message that implies overwriting user edits.
6. **Host asset asymmetry.** Generated CLAUDE.md instructs Claude sessions to spawn Codex subagents from `.codex/agents/`; no `.claude/agents/` assets are rendered (asset parity itself is M1.7; the init/doctor composition is here).
7. **A committed syntax error made the CLI unbuildable.** `products/qube/package.json` was committed truncated (missing final `}` braces) by a version-bump commit; every `node products/qube/bin/run` invocation failed with `ERR_INVALID_PACKAGE_CONFIG`, and no verify/publish check caught invalid manifest JSON.

Connections: selecting an adapter prints capability lists but no connection setup — the Linear/Jira/GitLab/Jenkins env-var requirements live only in `MissingWorkProvider` setup strings that surface after the workflow already failed at runtime; config provider kinds must be hand-edited; `aie providers doctor` does not exist; nothing can test a connection.

Host toolkits: host initialization is split and partial — `aie init --tool` writes instructions plus the Codex review subagent (codex only) and the make-it-so command (opencode only); `aiu init --tool` writes stop-hook host settings (`.claude/settings.json`) and continuation config but is never chained; Claude Code receives no subagents, commands, or skills; no CLI dependency (gh) checking happens at setup time.

Composer surface (validated against all ~74 schema commands of installed 0.2.2): daily loop fully covered, dispatch healthy, `qube next` correctly resumes active work — plus the defects listed in Part 5.

## Design Constraints

- All install changes obey the package safety baseline: no lifecycle scripts, exact pins, no network in normal command tests, token redaction.
- Plan mode remains the default; execution requires explicit consent (`--apply` + confirmation or `--yes`); `--json` without `--yes` stays plan-only.
- Secrets live in env vars or CLI keychains, never in `.qube` files; non-secret connection settings live in config.
- Component inits and doctors remain first-class standalone commands; the composer composes them through contracts, never reimplements them.

---

## Part 1: Setup Contract — `qube install` Then `qube init`

### 1.1 - Composer `qube init` orchestrator

The user-facing contract is two composer commands: `qube install` owns packages, `qube init` owns workspace setup. `qube init <target> --host <hosts> --work-provider <p> --ci-provider <p>` takes one selection set and proxies each installed component's init (`aie init` for host instructions and provider config, `aiu init` for continuation/stop-hook assets, `aib init`/`aiq init` when planning or quality gates are selected). Components expose an init capability contract (what it initializes, accepted selections, how "already initialized" reports) so future components join by contract instead of hardcoded names.

This repurposes two misleading passthroughs: `qube init` currently aliases `aib init` (planning scaffolding — stays reachable via `qube aib init` and the plan/make-it-so routes) and `qube doctor` currently aliases `aiq doctor`. `qube doctor` becomes the aggregating verifier: composer-level checks (component versions, host asset coverage) plus each component's doctor.

The install plan reads, in order: (1) package install (skipped when satisfied), (2) one `qube init` command carrying the selections, (3) provider setup steps that apply (`labels setup` for GitHub work provider), (4) `qube doctor`. Every step is a concrete copyable command; "docs/config notes" name the command that generates the artifact instead of describing the artifact.

### 1.2 - Detect current state; plan only the delta

Before planning, probe: global and local package installs, existing `.qube/*/config.json`, existing managed instruction files per host and whether their managed sections are current or stale, and adapter packages present. The plan renders per-step status — `satisfied`, `stale (will refresh)`, `missing (will create)` — and `--apply` executes only the delta, so a second run is a no-op.

### 1.3 - Multi-select for every set-shaped choice

Every install/init selection that is a set rather than an enum supports multiple values — comma-list flags (`--host claude-code,codex,grok-build`), multi-select in the interactive TTY prompt (the `@clack/prompts` flow gains multiselect), and `all-detected` where detection applies:

- **Hosts**: one run plans all selected hosts, deduplicates shared notes, and fans out per-host init inside the single `qube init` step, with the host-surface → instruction-target mapping explicit (grok-build and codex both resolve to AGENTS.md; claude-code to CLAUDE.md; opencode to its command assets).
- **Adapter packages**: multiple optional adapters install together in one pinned command.
- **Providers**: where component config supports only one active provider per role, multi-select installs the chosen adapters and activates one, stating which is active and how to switch — install-many, activate-one, never silently dropping a selection.

Genuinely single-valued choices (scope, package manager, lifecycle posture, migration) stay single-select.

### 1.4 - `qube install --apply`

Execute the plan steps (pinned versions, `--ignore-scripts`, chosen package manager/scope, selected adapter packages included in the command) after an explicit TTY confirmation showing the full command list. The apply run finishes with `qube components --json` and `qube doctor`, reporting mismatches and findings instead of leaving verification as copy-paste steps.

## Part 2: Connection Contracts, Guidance, And Probes

Extend the adapter contract with a **connection contract** alongside capabilities. Each adapter declares an auth method from an extensible enum: `cli-delegated` (an official CLI owns credentials — GitHub via `gh` today, GitLab via `glab` when available; preferred whenever it exists), `token-env` (single secret env var — Linear, GitLab, Jenkins), or `basic-env` (composite credential treated as one connection — Jira's email + API token + base URL). `oauth` remains a reserved future value for hosted/team contexts and remote MCP-style authorization. Per method the contract declares: required env vars (name, secret flag, purpose, token-creation URL, minimal scopes), non-secret config fields (stored in `.qube` config), and a read-only **probe** (Linear `viewer`, Jira `/myself`, Jenkins `whoAmI`, GitLab `/user`; GitHub probes `gh auth status`).

Consumed generically: `qube install` renders a per-adapter "Connections" section (env vars, token URL, scopes, verify command); `qube init` prompts for non-secret fields into provider config, instructs on env vars, then runs each probe and reports per-connection pass/fail so setup ends verified; `qube doctor` runs all configured probes on every run. Probes are read-only, time-bounded, and skippable offline with an explicit `unverified` state — never a silent pass. Adapter packages ship probe contract tests against recorded fixtures plus an opt-in live-probe mode; full conformance and permutation testing is `M3-adapter-testkit-and-provider-permutations.md`.

Guidance states that QUBE adapters authenticate directly and do not reuse host MCP server credentials: the same token can serve both, but `qube doctor` verifies only QUBE's connection.

## Part 3: Host Toolkit Manifests

Each host adapter declares a **toolkit manifest**: instruction targets, subagent assets (review-focus plus the M1.7 economy catalog), command/skill assets (make-it-so as a tested managed asset for every host that supports commands, not only OpenCode), hook assets (aiu stop hooks composed in), and **CLI dependencies** (gh presence and auth state for `cli-delegated`, with the login command as a guided step when missing). `qube init` composes the full manifest per selected host — one command yields a completely equipped host — and `qube doctor` verifies manifest completeness per host, replacing today's scattered `missing` lines.

**Provider MCP servers are explicitly not installed by default.** QUBE routes provider access through qube commands — policy-carrying, evidence-recording, queue-respecting; a provider MCP server in the host is a policy-bypassing side channel for mutations and unsanitized provider text. Offer host MCP wiring only as explicit opt-in (for exploratory reading, with scoped/read-only credentials where supported) and print the bypass caveat in the plan.

## Part 4: Apply Safety And Integrity

### 4.1 - Pre-install registry verification

Before `--apply` executes an install step, verify against the registry: package identity/dist-tag, exact version existence, publish age against the supply-chain age gate (7 days default, 14 for sensitive classes), provenance attestation presence, and absence of install lifecycle scripts in resolved manifests. Any failed or unverifiable check downgrades that step to plan-only with the reason printed; no `--force` override exists. Offline likewise reports and downgrades. Init/scaffold steps (local file writes) are not blocked by registry state.

### 4.2 - Managed-file integrity that survives formatting

Managed-section checksums must be computed over normalized content (line endings, trailing whitespace) so CRLF drift does not produce false "edited outside Executor" conflicts. When a real conflict exists, show a diff of managed section vs rendered content before asking for `--force`.

### 4.3 - Manifest and install verification tests

Extend `install-smoke` to run `qube install --apply --yes` end-to-end in a temp project (local tarball registry), asserting: exact versions installed, no lifecycle scripts executed, host init steps ran per selection, components and doctor verify, second run is a no-op. Add a workspace verify/CI check that parses every publishable `package.json` as strict JSON (the committed truncation of `products/qube/package.json` made the CLI unbuildable and nothing caught it).

## Part 5: Composer CLI Surface Coherence

Defects found validating the merged surface:

- **Invalid JSON on failure paths.** `qube plan status --json` with no aib state prints two JSON objects on stdout (component error, then composer wrapper error), breaking every JSON consumer. The composer must merge or nest the component error into exactly one envelope; audit all passthroughs for double-emission on nonzero component exits.
- **Top-level name lottery.** `init`→aib, `doctor`→aiq, `status`/`continue`→aiu, `check`/`quality`→aiq. Resolved by Part 1 (`init` becomes composer setup, `doctor` aggregates); additionally make bare `status` a composer rollup (queue + continuation + planning + quality one-liner) or rename the aiu passthrough to `continue` only.
- **Surface-classification drift.** `docs/qube-command-surfaces.md` classifies aiq `bench|watch|serve` as standalone-only, yet all three are exposed top-level. Generate the doc and registry from one source.
- **Alias leakage.** `qube app start --help` prints `Usage: aie run start ...`; generated instructions say `qube aie run start` while the surface says `app start`. Alias help must present the composer-facing name; generated instructions pick one spelling.
- **Duplicate synonyms.** `check`≡`quality run`, `evidence`≡`quality evidence`, `status`≡`continue status`. Keep one canonical form each; hide the rest.
- **Blocking-model polish.** A crashed review session leaves `.review-lock.json` with no timeout; add stale-lock detection (age + no matching live evidence) to `pr gate` and doctor. `start`/`next` refusals should name the exact unblocking command instead of describing state in prose.

## Part 6: Diagnostics, Docs, And Notes

- `qube doctor` aggregation covers: component versions, host toolkit completeness, connection probes, managed-section freshness, stale review locks.
- Schema output covers new config fields and the init capability contract; `docs/qube-command-surfaces.md` regenerates from the registry.

---

## Proposed Work Item Set

1. **M2.1** Composer `qube init` orchestrator with component init capability contracts, repurposed `qube init`/`qube doctor` passthroughs (doctor aggregates), full setup plan as ordered copyable steps, host coverage mapping, and multi-select for hosts, adapters, and providers in flags and TTY prompts (Parts 1.1, 1.3).
2. **M2.2** State detection and delta planning: probe installed packages, configs, and managed-section freshness; render per-step `satisfied`/`stale`/`missing`; second run is a no-op (Part 1.2).
3. **M2.3** `qube install --apply` executing the delta with confirmation, complete adapter commands, and automatic components + doctor verification (Part 1.4).
4. **M2.4** Adapter connection contracts and probes: auth-method enum (`cli-delegated`/`token-env`/`basic-env`, `oauth` reserved), env-var/config-field/scope declarations, read-only probes wired into install guidance, init verification, and aggregated doctor, with fixture-based probe tests and opt-in live mode (Part 2).
5. **M2.5** Host toolkit manifests: per-host declaration of instructions, subagents, commands/skills, hooks, and CLI dependencies; `qube init` composes aie + aiu assets and dependency checks per host; doctor verifies completeness; provider MCP wiring opt-in only, with bypass caveat (Part 3).
6. **M2.6** Pre-install registry verification with age gate and downgrade-to-plan (Part 4.1).
7. **M2.7** Normalized managed-section checksums and conflict diffs before `--force` (Part 4.2).
8. **M2.8** Composer surface coherence: single-envelope JSON on failure paths, top-level name re-mapping with composer `status` rollup, surface classification generated from one source, alias-aware help rendering, canonical-vs-hidden synonyms, stale review-lock detection, and actionable unblocking messages (Part 5).
9. **M2.9** Install-apply smoke tests, strict-JSON manifest check in verify/CI, doctor/schema coverage, notes sync (Parts 4.3, 6).

Suggested sequencing: M2.4 (connection contracts) first — it shapes what init prompts for and doctor aggregates; then M2.1 → M2.2 → M2.3 deliver the setup contract; M2.5 completes host equipping; M2.6-M2.9 harden. M2.7 and M2.8 are independent and can land any time.

## Exit Criteria

- A fresh agent session (or a human) given only `qube install --host claude-code,codex,grok-build --work-provider github --ci-provider github` reaches a doctor-verified working setup by following the printed steps mechanically — package install, one `qube init`, labels, `qube doctor` — with no knowledge of the component packages and no undocumented commands; with `--apply --yes` the same result needs zero copy-paste.
- Re-running install against an already-configured repo reports every step `satisfied` and changes nothing; stale managed instruction sections are detected and refreshed without false conflicts from formatting drift.
- Selecting linear/jira/gitlab/jenkins during install prints the exact env vars, token source, and scopes needed; `qube init` ends with a per-connection pass/fail/unverified report; `qube doctor` re-verifies every configured connection; a bad or missing credential is discovered at setup time, not by a failed workflow command.
- Initializing a host equips it completely: instructions, subagents, commands/skills, hooks, and CLI dependency checks from one `qube init`; doctor reports per-host toolkit completeness.
- `qube install --apply` downgrades install steps to plan when registry verification fails; all existing supply-chain guarantees hold (exact pins, `--ignore-scripts`, PATH-integrity refusal, prompt gating under `--json`/CI).
- Every `--json` command emits exactly one JSON envelope on success and failure; workspace verify/CI fails on any publishable `package.json` that is not strict JSON.
