# QUBE

QUBE combines Quality (aiQ), Umpire (aiU), Bootstrap (aiB), and Executor (aiE).
The package family supports agent-assisted planning, issue execution, quality
gates, and continuation policy. Each tool can be installed and used on its own;
`@tjalve/qube` provides one composer CLI for the installed tools.

## Website

The public-ready QUBE landing page lives at `docs/index.html` and is designed
for GitHub Pages at https://zark.github.io/ai-qube/. Preview it locally with:

```sh
pnpm run site:preview
```

## Packages

| Package | Command | Purpose |
| --- | --- | --- |
| `@tjalve/aib` | `aib` | Bootstrap turns an idea into planning state, a spec, milestones, and work item drafts. |
| `@tjalve/aie` | `aie` | Executor handles GitHub issues, branches, pull requests, reviews, and completion. |
| `@tjalve/aiq` | `aiq` | Quality runs staged gates and emits structured evidence for humans and agents. |
| `@tjalve/aiu` | `aiu` | Umpire decides whether an idle agent can continue safely from trusted local state. |
| `@tjalve/qube` | `qube` | List and dispatch to the package family from one installed entry point. |
| `@tjalve/qube-cli` | library | Shared TypeScript CLI metadata, schema, output, safety, and test helpers. |

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
qube oneshot "Ship a local notes CLI" --kind code --json
qube make-it-so "Ship a local notes CLI" --dry-run --json
qube aib init . --idea "Ship a local notes CLI" --json
qube aie queue --json
qube aiq doctor --format json
qube aiu status --json
```

See the [current command reference](./docs/qube-command-surfaces.md) for command
behavior and the [paths and artifacts guide](./docs/qube-paths-and-artifacts.md)
for stored state. `qube oneshot` remains a bounded local doc or code artifact
flow outside the GitHub issue, pull request, and review-gate workflow.

## Repository Layout

```text
packages/
  qube-cli/       shared public CLI library
  qube-core/      private shared workspace contracts
products/
  aib/            planning CLI
  aie/            execution CLI
  aiq/            quality CLI and adapters
  aiu/            continuation policy CLI
  qube/           composer CLI
adapters/
  github/         GitHub provider capability adapter
  opencode/       OpenCode host capability adapter
docs/
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
- [Contribution](./CONTRIBUTING.md)
- [Release controls](./docs/release-controls.md)
