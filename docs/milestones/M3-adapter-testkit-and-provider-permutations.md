# QUBE M3 - Adapter Testkit And Provider Permutations

Repo-level milestone spanning `packages/`, `adapters/`, and `products/aie`. Builds on M2's connection contracts (M2.4) and composer init (M2.1); see `M2-guided-install-and-composer-coherence.md`.

## Strategic Goal

Make every provider adapter provably correct against real providers, and make QUBE usable with any permutation of work, review, and CI providers — GitHub all-in-one, GitLab all-in-one, Jira + GitLab + Jenkins, Linear + GitHub, and every other supported combination — with a reusable test framework that future adapters adopt instead of reinventing.

Two forces motivate this now: the adapters for Linear, Jira, Jenkins, and GitLab are real API clients that have never been exercised against a live provider, and Codex has MCP connectors configured for GitLab, Atlassian, Jenkins, and Linear — giving an agent-assisted way to provision test spaces, record fixtures, and cross-verify adapter behavior against provider truth.

## Current State And Evidence

- Each adapter ships one ad-hoc unit test file (`adapters/*/test/*.test.mjs`) covering codecs and some client behavior against inline fixtures. There is no shared conformance suite: each adapter re-invents its own assertions, and a new adapter starts from zero.
- No test has ever run against a live Linear, Jira, Jenkins, or GitLab instance. Connection failures, pagination, rate limits, permission errors, and schema drift are unobserved territory.
- **The permutation space is mostly unreachable in config.** `ProviderSelections` accepts `work: github|gitlab|linear|jira` and `review: github|gitlab`, but `ci: github` only (`products/aie/src/config/types.ts:8`) — the Jenkins adapter that `qube install --ci-provider jenkins` plans for cannot be activated, and GitLab pipelines cannot be selected as CI. Split-provider combinations have no tests even at fixture level.
- Capability discipline exists in the contracts (supported/unsupported/unknown flags, `MissingWorkProvider`) but nothing asserts that a given combination degrades explicitly instead of silently assuming GitHub semantics.

## Design Constraints

- Test doubles, fixtures, provisioners, and harnesses live under test-support boundaries only; no fake adapters or mock paths in default runtime (aiq mocking policy).
- Normal `pnpm test` stays offline: fixture suites run everywhere; live suites are opt-in, env-gated, and skipped without credentials — never silently passed.
- Live suites authenticate through the M2.4 connection contracts (env vars, probes); probes gate suite start so a bad credential fails fast with the connection report, not mid-suite.
- Everything a live suite creates is tagged and destructible; suites must be safe to run against a personal account without leaving residue.
- Connectors/MCP are authoring and verification tooling for building the testkit; they are not runtime dependencies of adapters or tests.

---

## Part 1: Adapter Conformance Testkit

A shared test-support package (`packages/qube-testkit` or equivalent) that runs one conformance suite per role contract against any adapter:

- **Work provider suite**: queue reads, work-item codec round-trips, canonical status/priority mapping, blocker/dependency parsing, comment handling, unknown-state reporting, pagination behavior, malformed-payload tolerance.
- **Review forge suite**: review item load, feedback classification, marker/staleness semantics, finding partitioning (inline vs body), publish payload shape, thread resolution.
- **CI provider suite**: check/build state reads, diagnosis output, artifact references, explicit unsupported `trigger` behavior.
- **Connection suite**: probe behavior per auth method (success, bad credential, unreachable, timeout) from M2.4.

An adapter joins by implementing a small harness descriptor: how to construct the provider with a fixture transport, which capabilities it declares, and provider-specific fixture files. The suite asserts capability flags match observed behavior — an adapter claiming `sync-issue-status` must pass those cases; one that does not must fail them with explicit unsupported errors, not silence. Fixtures are recorded real API payloads (Part 3), versioned in-repo, and replayed through a transport seam (injected exec/fetch), not network mocks.

## Part 2: Constructible And Deconstructible Live Sandboxes

Each adapter's testkit harness gains a **provisioner** with a strict lifecycle, so a live suite can be built up and torn down on demand:

- `construct`: create an isolated sandbox in the provider — Linear: a dedicated team or label-scoped issue set; Jira: a dedicated project key; GitLab: a throwaway project; Jenkins: a folder with seeded jobs; GitHub: a scratch repository.
- `seed`: create deterministic test data — work items across statuses/priorities, blocker chains, a review item with comments/threads, CI runs in known states — from one shared seed manifest so every provider represents the same logical scenario.
- `verify`: run the Part 1 conformance suite against the live sandbox instead of fixtures (same suite, different transport).
- `deconstruct`: delete everything created; idempotent, safe to re-run.
- `sweep`: find and remove orphans from crashed runs.

Every created resource is tagged/prefixed (`qube-testkit-<runid>`) so deconstruct and sweep are mechanical. Provisioners use the adapter's own mutation capabilities where they exist and direct provider REST calls under the test-support boundary where they do not (provisioning needs like "create project" are not adapter product capabilities and must not become them). Suites are gated: env credentials present + probe pass + explicit `QUBE_TESTKIT_LIVE=1`; skipped otherwise with a visible `skipped: no live credentials` result. Bounded by run budget (request caps, timeouts) to respect rate limits on personal accounts.

## Part 3: Connector-Assisted Authoring And Verification

Use the Codex MCP connectors (Atlassian, GitLab, Jenkins, Linear) as the tooling path for building and trusting the testkit:

- **Bootstrap**: an agent session with the provider connector performs the one-time setup automation can't — creating the test workspace/org space, generating scoped API tokens, granting permissions — guided by a documented per-provider checklist.
- **Fixture recording**: run provisioner `construct` + `seed`, then capture the adapter's raw API exchanges into the fixture corpus; the connector session cross-checks that recorded payloads match provider truth (field semantics, not just shape) before fixtures are committed.
- **Spot verification**: after a live `verify` run, the connector session independently reads the same sandbox state and compares against what the adapter reported — catching adapter misreads that self-consistent tests cannot.
- **Drift refresh**: when a provider API changes, re-record fixtures against the live sandbox and diff; the connector session triages semantic changes.

This keeps determinism in the CLI/API testkit while using connectors where agent judgment helps: setup, semantic comparison, and drift triage.

## Part 4: Provider Permutation Matrix

- **Complete the config space first**: extend `CiProviderKind` to `github | gitlab | jenkins` and validate that `providers.{work,review,ci}` accept every supported combination; `qube init` (M2.1) writes any permutation from install selections.
- **Fixture-level combination tests**: run the aie provider composition (work + review + CI resolved together) for **all** supported permutations against testkit fixtures, asserting: commands compose, provider-neutral models flow, and every capability a combination lacks surfaces as an explicit unsupported/unknown state — never a silent GitHub assumption. This is cheap (offline) and runs in normal CI.
- **Curated live combinations**: full live runs for the realistic archetypes — GitHub all-in-one (baseline), GitLab all-in-one, Jira work + GitLab review + Jenkins CI (enterprise split), Linear work + GitHub review/CI (SaaS split) — each exercising the work cycle end to end: queue → start → branch → review item → gate evidence → complete.
- **Doctor coverage**: `qube doctor` reports the active permutation with per-role capability summaries so a user sees what their combination supports and what will report unknown.

## Proposed Work Item Set

1. **M3.1** Testkit package with role-contract conformance suites and the adapter harness descriptor; migrate the GitHub adapter onto it as the reference implementation (Part 1).
2. **M3.2** Fixture corpus and transport seams for linear/jira/jenkins/gitlab adapters on the shared suites, replacing ad-hoc per-adapter assertions (Parts 1, 3).
3. **M3.3** Provisioner lifecycle (`construct`/`seed`/`verify`/`deconstruct`/`sweep`) with tagging, gating, budgets, and the shared seed manifest; live suites for linear + gitlab first (Part 2).
4. **M3.4** Jira and Jenkins provisioners and live suites; connector-assisted bootstrap checklists per provider (Parts 2, 3).
5. **M3.5** Config permutation completion (`CiProviderKind` gitlab/jenkins), full fixture-level combination matrix in CI, and explicit-degradation assertions (Part 4).
6. **M3.6** Curated live combination runs, doctor permutation reporting, and fixture drift-refresh workflow (Parts 3, 4).

Sequencing: M3.1 → M3.2 → M3.5 are offline and deliver most regression value; M3.3/M3.4 (live) depend on the M2.4 connection contracts; M3.6 last. M3.5's config completion unblocks real Jenkins/GitLab-CI users independently of the rest.

## Exit Criteria

- A new adapter reaches full conformance coverage by writing a harness descriptor and fixtures — no new test logic — and cannot ship with capability flags its behavior does not honor.
- `QUBE_TESTKIT_LIVE=1` with valid credentials constructs, verifies, and deconstructs a sandbox on each supported provider, leaving zero residue (sweep finds nothing); without credentials the same suites report skipped, never passed.
- Every supported work/review/CI permutation is expressible in config, composes in fixture tests, and degrades explicitly where capabilities are missing; the four archetype combinations pass live end-to-end work cycles.
- Fixtures are recorded from real providers with a documented refresh workflow; a provider API drift shows up as a fixture diff, not a production surprise.
