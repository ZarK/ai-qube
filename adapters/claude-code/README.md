# @tjalve/qube-adapter-claude-code

Claude Code host capability adapter for QUBE instruction and workspace
integrations.

Install this package when the workflow runs on Claude Code and needs host profile
detection, workspace capability inspection, or Claude Code-specific instruction
surfaces. `@tjalve/qube` and `@tjalve/aie` can install it as an optional
dependency.

For the full QUBE package family and command deck, see
https://zark.github.io/ai-qube/ or the repository landing-page artifact at
https://github.com/ZarK/ai-qube/blob/HEAD/docs/index.html.

## Install

```sh
npm install --save-exact --ignore-scripts @tjalve/qube-adapter-claude-code@0.1.6 @tjalve/qube-core@0.2.6
```

Or install QUBE and initialize the host:

```sh
npm install --save-exact --ignore-scripts @tjalve/qube@0.2.12 @tjalve/qube-adapter-claude-code@0.1.6 @tjalve/qube-adapter-github@0.1.8
qube init --host claude-code --work-provider github --yes
```

## Requirements

- Node.js 24 or newer
- `@tjalve/qube-core` at a compatible version

## Source

Monorepo path: https://github.com/ZarK/ai-qube/tree/main/adapters/claude-code
