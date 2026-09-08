# @tjalve/qube

`@tjalve/qube` is the composer CLI for the QUBE package family. It gives users
one command for discovering the installed planning, execution, quality, and
continuation tools while keeping each component package independently usable.

QUBE's public landing page is designed for GitHub Pages at
https://zark.github.io/ai-qube/ and lives in the repository at
https://github.com/ZarK/ai-qube/blob/HEAD/docs/index.html.

## Install

Use npm or pnpm to install an exact version. Prefer project installation for
reproducible automation:

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

Follow the [first-task and daily-use guide](https://github.com/ZarK/ai-qube/blob/main/docs/qube-init.md#first-task)
to initialize a repository and complete a Ready issue with Codex and GitHub.
See the [contribution guide](https://github.com/ZarK/ai-qube/blob/main/CONTRIBUTING.md)
for the package layout, development toolchain, checks, and pull request process.

## Components

| Product | Package | Direct command | Purpose |
| --- | --- | --- | --- |
| Bootstrap | `@tjalve/aib` | `aib` | Planning state, specs, milestones, and work item drafts. |
| Executor | `@tjalve/aie` | `aie` | GitHub issue execution workflow. |
| Quality | `@tjalve/aiq` | `aiq` | Staged quality gates and evidence. |
| Umpire | `@tjalve/aiu` | `aiu` | Continuation policy from trusted local state. |

## Current development commands

This section describes the current source checkout. These commands can include
changes that are not in QUBE 0.2.12. In a source checkout, replace `qube` in
the examples with `node products/qube/bin/run`. Plain `qube` examples require a
global installation of the current development version.

### Usage

```sh
qube --help
qube components
qube init --global
qube init
qube autoresearch init ./scratch "improve notes summary quality" --json
qube make-it-so --flow planned "Create a README draft" --json
qube queue --json
qube doctor --json
```

The published commands above remain separate from this development surface.
Use the [current command reference](https://github.com/ZarK/ai-qube/blob/main/docs/qube-command-surfaces.md)
for the full command list and routing rules. One-shot is unavailable. Use
`qube make-it-so --flow planned <idea>` to create a Bootstrap plan.

Direct component packages remain independently installable when one package is
sufficient:

```sh
pnpm exec aiq doctor --format json
pnpm exec aie queue --json
```

## Maintained guides

- [Installation, first task, and daily use](https://github.com/ZarK/ai-qube/blob/main/docs/qube-init.md)
- [Commands](https://github.com/ZarK/ai-qube/blob/main/docs/qube-command-surfaces.md)
- [Host and provider integrations](https://github.com/ZarK/ai-qube/blob/main/docs/qube-host-surfaces.md)
- [Paths and artifacts](https://github.com/ZarK/ai-qube/blob/main/docs/qube-paths-and-artifacts.md)
- [Contribution](https://github.com/ZarK/ai-qube/blob/main/CONTRIBUTING.md)
- [Release controls](https://github.com/ZarK/ai-qube/blob/main/docs/release-controls.md)
