# AI Code Quality Notes

`ai-code-quality` (`@tjalve/aiq`) owns reusable quality gates and should become the package that catches fake progress, shallow checks, and unsafe implementation patterns across QUBE-driven work.

## Provider And Repository Impact

Provider and repository modularity changes Quality-control from a mostly repo-local checker into a layout-aware evidence checker that can also inspect provider-facing artifacts.

Quality-control should understand:

- work item text from GitHub Issues, GitLab Issues, Jira, Linear, Azure Boards, or export files
- review item text from pull requests, merge requests, Gerrit changes, patchsets, and provider-specific review bodies
- CI/check evidence from GitHub Actions, GitLab CI, Bitbucket Pipelines, Azure Pipelines, Buildkite, CircleCI, Jenkins, Woodpecker, CodeBuild, and local gate commands
- repository layout signals for single-project repos, JS/TS workspaces, Python workspaces, Rust/Go workspaces, Gradle/Maven, .NET, Bazel/Pants/Buck, CMake, mobile, infrastructure, docs, polyrepo, and generated/vendor-heavy repos

The package should expose layout-aware JSON that Executor and Umpire can trust:

- changed paths classified by project/package/service
- generated/vendor/test-support/harness boundaries
- likely gate commands by affected scope
- evidence source and trust level
- warnings for broad commands when affected-scope detection is uncertain
- provider text findings, such as unsafe generated instructions or fake-completion claims

Quality-control should not become a provider mutation package. It may read provider artifacts or normalized snapshots supplied by Executor, but lifecycle transitions, review updates, and comments belong to Executor.

## Quality Guard Role

Quality-control should help enforce:

- no no-op package scripts posing as checks
- no tests that pass without validating real behavior
- no product-visible fake features, mock product paths, or default runtime test doubles
- no generated build output committed when policy forbids it
- no implementation artifacts using planning/bootstrap/reference-corpus language
- no transient status/progress markdown created during implementation unless explicitly requested

Some of these are static checks; others may be policy checks over diffs, file names, package scripts, review body text, or generated work item instructions.

Provider-neutral wording: checks should apply to review item bodies and work item instructions, with GitHub PR bodies and GitHub issue instructions as the default provider encoding.

## Mocking And Test Doubles

QUBE should not ban all mocks. The stricter rule is:

- do not mock the actual feature under test
- use real behavior in acceptance/E2E paths
- allow deterministic fixtures, test doubles, harness adapters, and probes only inside test-support or harness boundaries
- never register fake adapters or mock paths in the default product runtime
- prove architecture seams with domain-named production seams plus test-only adapters, not product-visible fake features

Quality-control should provide checks or review prompts that distinguish useful test isolation from fake product behavior.

Provider adapters should be especially strict about test-only boundaries. A fake GitHub/GitLab/Jira/Linear adapter is acceptable only under test-support; production provider seams should be real interfaces with capability flags and explicit unknown-state handling.

## Supply-Chain Checks

Supply-chain guard should be part of the `aiq` quality surface where practical:

- detect install lifecycle scripts in package metadata
- flag floating dependency ranges where exact pins are expected
- flag lockfile rewrites and unexpected transitive additions
- flag Git URL, branch, tarball, and binary-download dependencies
- flag CI actions or reusable workflows not pinned according to policy
- inspect package scripts for curl-pipe-shell, broad upgrades, or hidden generated-code execution
- verify dependency age/provenance when registry metadata is available

`aiq` does not replace human approval for high-risk dependency choices, but it can make risky changes visible before Executor or Umpire continues.

Repository layout support expands supply-chain checks. Infrastructure repos, CI-heavy repos, mobile repos, generated-client repos, and monorepos need path-aware policies so `aiq` can distinguish normal lockfile/build metadata changes from risky dependency, generated-code, or deployment-surface changes.

## Evidence

Quality-control should prefer real evidence:

- real command exit codes
- real test output
- real build/lint/typecheck output
- real browser/UI audit artifacts when applicable
- real provider check/build ids when available
- real review/work item state snapshots when supplied by Executor
- clear distinction between agent-reported and tool-verified status

It should avoid treating narrative claims in work item comments, review item bodies, or review comments as verified quality evidence.

## Legacy Adoption Stages

`aiq` should make legacy adoption practical through cumulative stages. A project that did not use `aiq` from the beginning may have too many findings across too many dimensions for a useful one-shot fix loop.

The stage model should let Umpire and agents run:

- stage 1 alone until clean
- stages 1-2 together until clean
- stages 1-3 together until clean
- continuing until the configured stage set passes

Structured output should include:

- available stages and their order
- active cumulative stage set
- pass/fail state per stage
- findings grouped by stage, severity, path, and rule
- whether a finding is fixable automatically, requires code judgment, or requires policy/human input
- stable command hints for rerunning the same cumulative check

This should support an Umpire whip mode that moves one stage at a time while preserving earlier passes. `aiq` should make suppressions explicit and auditable so legacy adoption does not turn into hiding findings to make the dashboard green.
