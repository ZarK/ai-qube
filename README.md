# QUBE

QUBE is a small package family for agent-assisted software work. The packages
cover planning, issue execution, quality gates, and continuation policy. Each
tool can be installed and used on its own; `@tjalve/qube` provides one composer
CLI for discovering and dispatching to the installed tools.

## Packages

| Package | Command | Purpose |
| --- | --- | --- |
| `@tjalve/aib` | `aib` | Turn an idea into planning state, a spec, milestones, and work item drafts. |
| `@tjalve/aie` | `aie` | Execute GitHub issues with branch, PR, review, and completion workflow controls. |
| `@tjalve/aiq` | `aiq` | Run staged quality gates and emit structured evidence for humans and agents. |
| `@tjalve/aiu` | `aiu` | Decide whether an idle agent session may safely continue from trusted local state. |
| `@tjalve/qube` | `qube` | List and dispatch to the package family from one installed entry point. |
| `@tjalve/qube-cli` | library | Shared TypeScript CLI metadata, schema, output, safety, and test helpers. |

## Install

Use exact versions for automation and keep dependency lifecycle scripts disabled
where your package manager supports it.

Use the guided installer when choosing between local/global use, package manager,
host surface, provider surface, docs notes, or migration from direct package
globals:

```sh
qube install
qube install --yes --dry-run --json
qube install --scope global --package-manager npm --yes
```

The installer prints a plan and copyable commands. It does not run package
managers or lifecycle scripts for you.

```sh
pnpm add -D --save-exact --ignore-scripts @tjalve/qube@0.1.1
pnpm exec qube components
```

Global installs are useful for manual command-line use, but project-local
installs are easier to audit and reproduce:

```sh
npm install -g @tjalve/qube@0.1.1 --ignore-scripts
qube components
```

Install a single component when you intentionally only need that package:

```sh
pnpm add -D --save-exact --ignore-scripts @tjalve/aib@0.1.1
pnpm exec aib --help
```

## Command Surface

`qube` dispatches to the component versions installed with the composer package.
Use the composer entry point for automation, agent instructions, hooks, and
durable examples in this monorepo. Direct component packages remain independently
installable; when they create repository state, they use the same QUBE-prefixed
paths such as `.qube/aie/config.json`, `.qube/aiq/config.json`, and
`.qube/aiq/out/`.

```sh
qube components
qube aib init . --idea "Ship a local notes CLI" --json
qube aie queue --json
qube aiq doctor --format json
qube aiu status --json
```

The composer first resolves component binaries from its own install scope, then
from the local workspace, then from ambient `PATH`. PATH fallback is diagnostic:
QUBE refuses a stale same-package binary when it can identify the installed
package version.

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
  github/         private workspace adapter
  opencode/       private workspace adapter
docs/
```

Public package READMEs live beside the package that npm publishes. Product and
release docs under `docs/` explain command boundaries, host surfaces, install
migration, and package version policy.

## Publishing

Publishing is package-specific. A tag selects exactly one package:

```text
publish-qube-cli-v<version>
publish-aib-v<version>
publish-aie-v<version>
publish-aiu-v<version>
publish-aiq-v<version>
publish-qube-v<version>
```

The shared publish workflow runs on `publish-*` tags, uses the GitHub Actions
environment `npm-publish`, verifies the selected package, and publishes to npm
with trusted publishing and provenance. See `docs/release-controls.md` for the
trusted-publishing setup, staged approval flow, and first publish exception for
brand-new package names.

## Development

```sh
corepack enable
pnpm install --frozen-lockfile --ignore-scripts
pnpm run verify
```

Use root workspace filters for package work:

```sh
pnpm --filter @tjalve/aie run verify
pnpm --filter @tjalve/qube run verify
```

Useful public docs:

- `docs/qube-command-surfaces.md`
- `docs/qube-host-surfaces.md`
- `docs/qube-paths-and-artifacts.md`
- `docs/release/install-migration.md`
- `docs/release/version-audit.json`
