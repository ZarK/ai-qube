# @tjalve/qube-adapter-codex

Codex host capability adapter for QUBE local review runner and instruction
integrations.

Install this package when the executor or review workflow runs on Codex and needs
host profile detection, local review-runner capability probes, or Codex-specific
instruction surfaces. `@tjalve/aie` lists it as an optional dependency.

For the full QUBE package family and command deck, see
https://zark.github.io/ai-qube/ or the repository landing-page artifact at
https://github.com/ZarK/ai-qube/blob/HEAD/docs/index.html.

## Install

```sh
npm install --save-exact --ignore-scripts @tjalve/qube-adapter-codex@0.1.1 @tjalve/qube-core@0.2.1
```

Or use the guided composer:

```sh
npm install -g --ignore-scripts @tjalve/qube@0.2.0
qube install --scope local --host codex --work-provider github --yes
```

## Requirements

- Node.js 24 or newer
- `@tjalve/qube-core` at a compatible version

## Source

Monorepo path: https://github.com/ZarK/ai-qube/tree/main/adapters/codex