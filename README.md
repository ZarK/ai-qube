# QUBE

QUBE is a set of command-line tools for agent-assisted work in a git
repository. It has four parts: Bootstrap, Executor, Quality, and Umpire. The
name comes from their initials. Each part is its own npm package and works on
its own. The `@tjalve/qube` composer CLI runs whichever parts are installed.

Work moves through the parts in this order:

1. **Bootstrap** (`aib`) turns an idea into a spec, milestones, and work items.
2. **Executor** (`aie`) takes a ready issue, starts a branch, opens the pull
   request, gathers reviews, and completes the issue after merge.
3. **Quality** (`aiq`) runs the repository's staged gates and records the
   results as structured evidence.
4. **Umpire** (`aiu`) decides from trusted local state whether an idle agent
   can continue, and writes the next prompt or stops.

## QUBE Review

`aie pr gate <pr>` runs review lanes against the pull request head. Each lane
is an agent with one focus, such as issue-compliance, code-quality, security,
or performance. The `qube-review[bot]` GitHub App publishes each round as one
review. The first line gives the verdict, the counts, and the head. A findings
table follows, and each finding gets one inline comment with a collapsed fix
prompt for agents. Notes and provenance stay collapsed. A single status comment
per pull request is edited in place on each run. When a finding is fixed, the
reviewer replies in its thread and resolves it. See
[QUBE Review Surfaces](./docs/qube-review-surfaces.md) for the format.

## Setup

`qube init` is a guided setup that asks only the questions that apply to the
repository. It checks Git and commit identity, then asks for the agent hosts
and where reviews run. It also asks for the issue tracker, the source of
automated checks, Continuous Shipping, Umpire continuation, Quality stages, and
the review publisher. It prints the plan before it writes anything.
`--dry-run --json` shows the resolved answers without changing files, and
`--yes` accepts the recommended values.

Setup writes repository settings to `.qube/init.json`, or user defaults to
`~/.qube/config.json` with `qube init --global`. It also writes each selected
host's instruction file and `make-it-so` entry point. QUBE stores credential
references, not values. After setup, open a new session in the agent host and
send its start command, for example `$make-it-so Complete issue 123, then stop.`
in Codex.

## Hosts and providers

QUBE configures an agent host. It does not install, sign in to, or wrap the
host. Install the adapter package for each host and provider you use.

| Host | Adapter | Instruction file | Start command |
| --- | --- | --- | --- |
| Codex | `@tjalve/qube-adapter-codex` | `AGENTS.md` | `$make-it-so` |
| Claude Code | `@tjalve/qube-adapter-claude-code` | `CLAUDE.md` | `/make-it-so` |
| OpenCode | `@tjalve/qube-adapter-opencode` | `AGENTS.md` | `/make-it-so` |
| Cursor | `@tjalve/qube-adapter-cursor` | `AGENTS.md` | `/make-it-so` |
| Grok Build | `@tjalve/qube-adapter-grok-build` | `AGENTS.md` | `/make-it-so` |

Review, task, subagent, model-list, and continuation support differ by host.
See the [capability matrix](./docs/qube-host-surfaces.md#capability-matrix).

| Provider | Role | Adapter |
| --- | --- | --- |
| GitHub | Issues, pull requests, checks, QUBE Review publishing | `@tjalve/qube-adapter-github` |
| GitLab | Issues, merge requests, pipelines | `@tjalve/qube-adapter-gitlab` |
| Linear | Issues | `@tjalve/qube-adapter-linear` |
| Jira | Issues | `@tjalve/qube-adapter-jira` |
| Jenkins | CI build evidence (read-only) | `@tjalve/qube-adapter-jenkins` |

Selecting a provider without its adapter installed fails with setup guidance.
QUBE does not fall back to GitHub.

## Website

The project page lives at `docs/index.html` and is published with GitHub Pages
at https://zark.github.io/ai-qube/. It follows the brand assets in
`docs/design/` and has light and dark themes. Preview it locally with:

```sh
pnpm run site:preview
```

The preview server uses port 4173 by default. Set `PORT` to use another port.

## Packages

| Package | Command | Purpose |
| --- | --- | --- |
| `@tjalve/aib` | `aib` | Bootstrap turns an idea into planning state, a spec, milestones, and work item drafts. |
| `@tjalve/aie` | `aie` | Executor handles GitHub issues, branches, pull requests, reviews, and completion. |
| `@tjalve/aiq` | `aiq` | Quality runs staged gates and emits structured evidence for humans and agents. |
| `@tjalve/aiu` | `aiu` | Umpire decides whether an idle agent can continue safely from trusted local state. |
| `@tjalve/qube` | `qube` | List and dispatch to the package family from one installed entry point. |
| `@tjalve/qube-cli` | library | Shared TypeScript CLI metadata, schema, output, safety, and test helpers. |
| `@tjalve/qube-adapter-*` | library | Host and provider adapters. See [Hosts and providers](#hosts-and-providers). |

## Install

Use exact versions for automation and keep dependency lifecycle scripts disabled
where your package manager supports it.

Use npm or pnpm to install the exact QUBE version. Project installation is
recommended for reproducible automation:

```sh
npm install --save-dev --save-exact --ignore-scripts @tjalve/qube@0.2.12
pnpm add --save-dev --save-exact --ignore-scripts @tjalve/qube@0.2.12
```

Use a global installation for manual shell use:

```sh
npm install --global --ignore-scripts @tjalve/qube@0.2.12
pnpm add --global --ignore-scripts @tjalve/qube@0.2.12
```

For a project installation, run the published CLI through the package manager:

```sh
npm exec -- qube init
pnpm exec qube init
```

For a global installation, run `qube init`. See the
[QUBE 0.2.12 command reference](https://github.com/ZarK/ai-qube/blob/51eb90562ac9c27590d3b647a515ef9ff9c8c884/docs/qube-command-surfaces.md)
for the commands in this release.

Follow the [first-task and daily-use guide](./docs/qube-init.md#first-task) to
initialize a repository and complete a Ready issue with Codex and GitHub.
See [CONTRIBUTING.md](./CONTRIBUTING.md) for the package layout, development
toolchain, focused checks, and pull request requirements.

Install a single component when you intentionally only need that package:

```sh
pnpm add -D --save-exact --ignore-scripts @tjalve/aib@0.2.9
pnpm exec aib --help
```

## Current development commands

This section describes the current source checkout. These commands can include
changes that are not in QUBE 0.2.12. In a source checkout, replace `qube` in
the examples with `node products/qube/bin/run`. Plain `qube` examples require a
global installation of the current development version.

### Command surface

`qube` dispatches to the component versions installed with the composer package.
Use the composer entry point for automation, agent instructions, hooks, and
durable examples. In a source checkout, `qube` can dispatch to matching workspace
packages.

```sh
qube components
qube autoresearch init ./scratch "improve notes summary quality" --json
qube make-it-so --flow planned "Ship a local notes CLI" --json
qube aib init . --idea "Ship a local notes CLI" --json
qube aie queue --json
qube aiq doctor --format json
qube aiu status --json
```

See the [current command reference](./docs/qube-command-surfaces.md) for command
behavior and the [paths and artifacts guide](./docs/qube-paths-and-artifacts.md)
for stored state. Use `qube mode local` for direct development and manual testing
without the issue and pull request cycle. See [local development](./docs/qube-local-mode.md).

## Repository Layout

```text
packages/
  qube-cli/       shared public CLI library
  qube-core/      private shared workspace contracts
  qube-testkit/   adapter conformance suites and fixtures
products/
  aib/            planning CLI
  aie/            execution CLI
  aiq/            quality CLI and adapters
  aiu/            continuation policy CLI
  qube/           composer CLI
adapters/
  claude-code/    Claude Code host adapter
  codex/          Codex host adapter
  cursor/         Cursor host adapter
  grok-build/     Grok Build host adapter
  opencode/       OpenCode host adapter
  github/         GitHub provider adapter, including QUBE Review publishing
  gitlab/         GitLab provider adapter
  linear/         Linear work provider adapter
  jira/           Jira work provider adapter
  jenkins/        Jenkins CI adapter
docs/
  index.html      project page (GitHub Pages)
  design/         brand marks, icons, and the brand board
```

Public package READMEs live beside the package that npm publishes. They contain
the package install instructions. Product docs under `docs/` explain command
boundaries and agent harness surfaces. `docs/release-controls.md` and
`docs/release/version-audit.json` describe release controls and package versions.

## Maintained guides

- [Installation, first task, and daily use](./docs/qube-init.md)
- [Commands](./docs/qube-command-surfaces.md)
- [Host and provider integrations](./docs/qube-host-surfaces.md)
- [Paths and artifacts](./docs/qube-paths-and-artifacts.md)
- [QUBE Review surfaces](./docs/qube-review-surfaces.md)
- [Contribution](./CONTRIBUTING.md)
- [Release controls](./docs/release-controls.md)
