# QUBE Autoresearch Mode Notes

Research status: current as of 2026-05-23.

## Source Pattern

Karpathy's `autoresearch` is a constrained autonomous experiment loop, not a general framework. The repo keeps the fixed referee small and gives the agent one mutable surface:

- fixed setup/evaluation code in `prepare.py`
- mutable target code in `train.py`
- human-authored operating instructions in `program.md`
- fixed wall-clock experiment budget
- one primary metric, `val_bpb`
- git/log state that lets the agent keep improvements and discard regressions

The key product lesson for QUBE is that autoresearch works because the arena is engineered before the loop starts. A useful loop needs an editable target, a fixed evaluator, a scalar score, invariants, reversible state, and visible history.

Primary source: <https://github.com/karpathy/autoresearch>

Karpathy's linked X posts are currently hard to inspect directly without X rendering, but the repository links to:

- announcement/context post: <https://x.com/karpathy/status/2029701092347630069>
- result/generalization post: <https://x.com/karpathy/status/2031135152349524125>

Secondary indexed copies and event pages consistently summarize the result post as a roughly two-day nanochat run on a depth-12 proxy model, about 700 experiments, about 20 additive improvements, and a transfer result from about 2.02 hours to 1.80 hours time-to-GPT-2.

## Follow-On Project Patterns

The ecosystem split into four useful patterns:

- **Hardware ports**: macOS, MLX, Windows RTX, AMD, ANE, consumer-GPU forks. These preserve the simple loop while adapting the evaluator to different machines.
- **Generalized loop frameworks**: `autoresearch-anything`, Claude/Codex skills, and similar projects expose propose/evaluate/keep abstractions for any verifiable problem.
- **Research-pipeline systems**: AutoResearchClaw turns the idea into an end-to-end multi-agent research-paper pipeline with literature search, experiment execution, review, citation checks, and human-in-the-loop modes.
- **Meta-loop systems**: Bilevel Autoresearch applies an outer loop to optimize the inner autoresearch mechanism itself.

Useful references:

- Karpathy notable forks list: <https://github.com/karpathy/autoresearch#notable-forks>
- `autoresearch-anything`: <https://pypi.org/project/autoresearch-anything/>
- AutoResearchClaw paper: <https://arxiv.org/abs/2605.20025>
- Bilevel Autoresearch paper: <https://arxiv.org/abs/2603.23420>
- Claudini adversarial-research example: <https://arxiv.org/abs/2603.24511>
- AutoResearch-RL, withdrawn but useful as a cautionary signal around claims and publication hygiene: <https://arxiv.org/abs/2603.07300>

## Local Precedent: `aiq-autoreserach`

The local repo `/Users/tjalve/Github/aiq-autoreserach` is the best QUBE-shaped prototype. It adapts the pattern to `ai-code-quality` with:

- fixed harness: `prepare.py`
- agent instructions: `AGENTS.md` and `continuation.md`
- target repo: `/Users/tjalve/Github/ai-code-quality`
- runtime state under `.aiq-autoresearch/`
- commands: `init`, `baseline`, `evaluate`, `status`, `serve-report`
- objective: minimize `aiq bench --format json --tag ci` `summary.totalDurationMs`
- verification gates: build, tests, smoke tests
- acceptance rules: same benchmark contract, passing scenarios, no budget failures, variance below threshold, minimum improvement over current best
- dashboard artifacts: `dashboard.html`, `dashboard-data.json`, `results.tsv`, per-run `evaluation.json`

The important design improvement over the original Karpathy repo is sandboxing. The harness snapshots the target checkout, including dirty tracked files and untracked non-ignored files, into `.aiq-autoresearch/sandbox/workspace` and runs verification plus benchmarks there. This prevents the referee from depending on or mutating the user's active checkout.

The result ledger shows the approach worked: an initial baseline around `4359ms` was improved through accepted candidates down to `940ms` before the benchmark surface expanded. After expanded coverage, the active best recorded in `current-best.json` was `03ec8bb`, `reuse stage temp directories for JS and Python tests`, with an objective value around `1080ms` against a `1105.67ms` baseline.

The prototype also exposed hazards QUBE should handle deliberately:

- the fixed harness must live outside the target's product surface
- benchmark selection must be immutable during a run
- target edits must not be allowed to change fixtures or evaluator parsing
- dashboard/report state should be generated from structured run data, not agent prose
- rejected commits need a reliable restore-to-best workflow
- profile-specific runs need isolated state, as seen in `.aiq-autoresearch-profiles/<profile>/`

## Proposed Command Shape

The user-facing command should be:

```bash
qube autoresearch <target> <goal>
```

Examples:

```bash
qube autoresearch . "reduce CLI benchmark wall time without changing behavior"
qube autoresearch /repo/api "improve p95 endpoint latency under the existing load test"
qube autoresearch github:tjalve/ai-code-quality "reduce aiq bench totalDurationMs"
```

The command should create an external run workspace, not inject a large harness into the target repo:

```text
.qube/autoresearch/
  config.json
  arena.md
  current-best.json
  results.tsv
  dashboard.html
  dashboard-data.json
  runs/<run-id>/evaluation.json
  sandbox/workspace/
```

For local targets this can live inside the target's ignored `.qube/` directory or in a central QUBE state directory. For remote/provider targets, QUBE should prefer a managed clone/workspace. The target repo should only receive accepted product changes, normal commits, and optional stable project config when explicitly approved.

## Package Responsibilities

`qube` should be a thin orchestration wrapper. The domain work belongs to the existing packages:

- **`aib` arena synthesis**: inspect the target, ask only blocking setup questions, produce `arena.md`, evaluator spec, mutable surface policy, objective metric, invariants, and initial work items if harness build is non-trivial.
- **`aie` harness build and execution**: materialize sandbox, install or reuse dependencies according to policy, run baseline/evaluate commands, commit candidates, restore rejected candidates, and execute accepted implementation tasks.
- **`aiq` referee and safety**: validate metric contract, scenario coverage, changed-file policy, gate truthfulness, generated/vendor boundaries, supply-chain risk, and regression evidence.
- **`aiu` continuation/whip**: keep the loop running from trusted JSON state, restart after context loss, stop on human/safety blockers, and issue concrete next prompts.
- **dashboard**: shared autoresearch run view fed by structured state from `aie`/`aiq`, not by agent narrative.

`aiq` should appear at least four times in the loop:

1. Target inspection: classify layout, likely gates, generated/vendor/test boundaries, and risky mutation surfaces.
2. Arena validation: decide whether the proposed evaluator is gameable, too slow, too noisy, or missing invariants.
3. Candidate acceptance: compare contract, gates, quality findings, and policy checks before promotion.
4. Periodic audit: inspect accepted history for fake progress, benchmark narrowing, suspicious dependency changes, and accumulated complexity.

## Autoresearch Lifecycle

1. `qube autoresearch init <target> <goal>`
   - Detect target kind: repo path, provider repo, package, command, URL, or configured workspace.
   - Run `aie repo inspect --json` and `aiq inspect --json` style probes.
   - Ask only if no reliable objective/evaluator can be inferred.
   - Write `config.json` and `arena.md`.

2. `qube autoresearch baseline`
   - Snapshot target into sandbox.
   - Run setup, verification, and evaluator trials.
   - Record objective mean, variance, report contract, environment, and provenance.

3. `qube autoresearch run`
   - `aiu` asks the active agent to choose one hypothesis.
   - `aie` lets the agent edit only allowed surfaces.
   - Candidate is committed or snapshotted.
   - `aie evaluate` runs verification/evaluator trials.
   - `aiq` judges contract/safety.
   - Accepted candidates become current best; rejected candidates restore to current best.
   - Dashboard updates after each trial.

4. `qube autoresearch status --json`
   - Return trusted loop state: current best, active candidate, last decision, blockers, next action, dashboard URL/path, and policy warnings.

5. `qube autoresearch dashboard`
   - Serve or export the run dashboard.

6. `qube autoresearch promote`
   - Convert accepted candidate(s) into normal QUBE work: branch, review item, gate evidence, changelog/summary where policy allows, and work item completion.

## Arena Requirements

QUBE should refuse or require explicit human setup when an arena lacks any of:

- stable target snapshot
- allowed mutation surfaces
- deterministic setup command or dependency policy
- at least one trustworthy objective shape: scalar metric, composite score, threshold checks, finding reduction, judge-backed rubric, pairwise preference, or explicit human-gated promotion
- objective direction: minimize, maximize, hit threshold, or satisfy all checks
- fixed evaluator command or adapter
- baseline and trial count
- variance/noise policy
- invariant checks that make metric gaming expensive
- restore strategy for rejected candidates
- run ledger and dashboard output

For many repositories, QUBE can infer enough to propose defaults:

- performance goal: use existing benchmark/load-test command
- quality goal: use `aiq` findings count/severity plus repository gates
- test-speed goal: use test wall time with unchanged test set
- bundle-size goal: use build artifact size plus smoke tests
- UI goal: use Playwright/Lighthouse/browser visual checks plus accessibility gates
- docs/content goal: use link/build/lint checks plus human-review threshold where quality is not scalar enough
- security/attack-surface goal: use static findings, dependency/permission surface, reachable endpoint/API inventory, threat-model checks, and human-gated promotion for ambiguous reductions
- complexity goal: use maintainability/complexity metrics, dependency graph risk, churn size, and behavior-preserving tests
- non-code artifact goal: use file-format render/parse checks, source-preservation checks, duplicate/conflict metrics, retrieval/evaluation fixtures, and rubric review when necessary

The command should be honest when a goal is not a good autoresearch target. Some goals need normal `aib` planning and `aie` execution because there is no cheap, reliable score.

## Target And Goal Agnosticism

`qube autoresearch <target> <goal>` should be as agnostic as possible about both arguments. The target might be a repository, package, command, service, UI, dataset, document folder, notes corpus, policy config, workflow, prompt pack, or generated artifact. The goal might be performance, memory, attack-surface reduction, complexity reduction, UX improvement, accessibility, documentation quality, support burden, test reliability, retrieval quality, or something domain-specific.

QUBE should not special-case autoresearch as "benchmark speed mode." Speed, memory, and throughput are the easy cases because an evaluator can usually be a normal command with structured output. The harder and more valuable product surface is arena synthesis for goals that are only partially measurable.

The generic contract is:

```text
target + goal -> arena
arena = mutable surface + evaluator + invariants + acceptance policy + dashboard
```

The evaluator can be one of several shapes:

- **Direct metric**: a command prints JSON/standard output with a scalar metric, such as duration, memory, bundle size, score, or pass rate.
- **Composite metric**: QUBE combines several metrics into a weighted or gated score, such as complexity plus test pass plus coverage unchanged.
- **Threshold objective**: the loop tries to satisfy all checks below/above thresholds instead of maximizing a continuous score.
- **Finding reduction**: `aiq` or another analyzer reports findings by severity/category and the loop reduces accepted findings without suppressing coverage.
- **Judge-backed rubric**: an LLM or human-review rubric scores artifacts, but only with stable prompts, sampled evidence, and anti-regression checks. This should be lower trust than deterministic metrics.
- **Pairwise preference**: candidate artifacts are compared against current best by a configured reviewer or test panel. Useful for UX/design/docs, but requires strong provenance and periodic human audit.
- **Human-gated loop**: QUBE can run propose/build/check cycles autonomously but promotion waits for human decision because no reliable automated score exists.

The acceptance policy should separate the primary objective from non-negotiable invariants. For example:

- performance goal: primary score is benchmark time; invariants are same scenario set, passing tests, same outputs, no budget failures
- attack-surface goal: primary score may be fewer reachable risky APIs or findings; invariants are no feature removal unless allowed, tests pass, threat-model coverage unchanged or expanded
- complexity goal: primary score may be lower complexity/churn/dependency graph risk; invariants are behavior-preserving tests and no metric gaming by deleting functionality
- UX/design goal: primary score may be accessibility/visual-regression/task-success rubric; invariants are no broken flows, responsive checks, and human review for subjective shifts
- notes/documents goal: primary score may be retrieval quality, link health, lint findings, duplicate/conflict count, or rubric score; invariants are no lost source material, citations preserved, and changelog/provenance kept where appropriate
- prompt/workflow goal: primary score may be task success rate on a fixture set; invariants are no fixture leakage, no narrower test set, and no unsafe instruction changes

This means the first hard job for `aib` is not "write a benchmark." It is "decide whether the goal can be converted into a trustworthy arena." If yes, generate the smallest evaluator that gives useful feedback. If no, route to normal planning/execution or require human-gated review instead of pretending subjective progress is an objective loop.

## Dashboard Requirements

The dashboard should be close to the local `aiq-autoreserach` dashboard, generalized:

- current best curve
- objective over time with accepted/rejected markers
- variance/error bars
- accepted milestone list
- recent rejected experiments and referee reasons
- slowest/failing scenarios or quality categories
- gate status and last trusted evidence
- changed-file/mutation-surface summary
- sandbox/source provenance
- active blocker and next action
- profile/filter selector for multi-slice runs

The dashboard should not be only cosmetic. It is part of the control loop because it lets humans and agents see whether the loop is improving, stuck in noise, failing contracts, or gaming the evaluator.

## Implementation Phasing

1. Extract the `aiq-autoreserach` harness model into a generic `autoresearch` arena schema and runner.
2. Add `qube autoresearch init/baseline/evaluate/status/dashboard` as wrappers over `aib`/`aie`/`aiq`/`aiu` capabilities.
3. Support local repository targets first with sandboxed snapshots and fixed evaluator commands.
4. Add target profiles for common repository goals: benchmark speed, test speed, bundle size, quality findings, and UI checks.
5. Add Umpire continuation so `qube autoresearch run` can survive stops, context limits, and rejected experiments.
6. Add provider-backed promotion: accepted candidate to branch/review/work-item flow.
7. Add meta-autoresearch later: optimize the arena instructions and search strategy only after the inner loop is reliable.

## Product Boundary

Autoresearch should become a QUBE mode, not a fifth peer package at first. It is an orchestration pattern that composes the existing package boundaries:

- `aib` plans the arena
- `aie` executes the loop
- `aiq` referees the loop
- `aiu` sustains the loop
- `qube` exposes the human command surface

The biggest engineering risk is letting autoresearch mutate its own referee or redefine its metric. The default architecture should keep the harness outside the target, make evaluator changes explicit, and treat dashboard/ledger state as trusted artifacts.
