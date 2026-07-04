# @tjalve/qube-adapter-linear

Linear work provider adapter for QUBE issue reads, draft rendering, and
unsupported lifecycle reporting.

Install this package when `@tjalve/aie` or `@tjalve/aib` is configured to use
Linear for issue tracking. The adapter maps Linear issues into provider-neutral
work items without inventing GitHub-shaped status labels or milestones.

For the full QUBE package family and command deck, see
https://zark.github.io/ai-qube/ or the repository landing-page artifact at
https://github.com/ZarK/ai-qube/blob/HEAD/docs/index.html.

## Install

```sh
npm install --save-exact --ignore-scripts @tjalve/qube-adapter-linear@0.1.1 @tjalve/qube-core@0.2.1
```

Or use the guided composer:

```sh
npm install -g --ignore-scripts @tjalve/qube@0.2.0
qube install --scope local --work-provider linear --yes
```

## Requirements

- Node.js 24 or newer
- `@tjalve/qube-core` at a compatible version
- Linear API key with access to the target team

## Source

Monorepo path: https://github.com/ZarK/ai-qube/tree/main/adapters/linear