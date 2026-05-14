# @tjalve/aie

AI Executor — autonomous GitHub issue execution for agentic development.

## Installation

Executor follows strict supply-chain policy (see docs/cli-framework-decision.md and AGENTS.md).

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
- `git` (for repository operations in later milestones)
- GitHub CLI `gh` (for GitHub operations in later milestones)

## Status

M1 (Package + CLI + Config + Doctor) complete. See GitHub issues for the current bootstrap queue (#1–#17 chain).

Safe install, redaction helper, and full CLI metadata are in place. Later milestones add GitHub integration, init, and autonomous cycle.
