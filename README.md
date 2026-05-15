# @tjalve/aie

AI Executor — autonomous GitHub issue execution for agentic development.

## Installation

Executor follows strict supply-chain policy.

**Recommended (pinned, no lifecycle scripts):**

```bash
npm ci --ignore-scripts
# or for one-off:
npm install @tjalve/aie@0.1.0 --ignore-scripts --save-exact
```

Do not use `npm install @tjalve/aie@latest` as the preferred path.

The package has no `preinstall`, `install`, or `postinstall` scripts.

## Usage

```bash
aie --version
aie --help
```

## Requirements

- Node.js 24 LTS or newer
- `git`
- GitHub CLI `gh`

## Design

See [docs/spec.md](docs/spec.md) for the functional requirements.
