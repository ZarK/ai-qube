# @tjalve/qube-adapter-grok-build

Grok Build host adapter for isolated review, host profile, and capability
reporting.

Install this package when Executor or composer should treat Grok Build as an
installed host. `@tjalve/aie` and `@tjalve/qube` do not ship this adapter by
default.

## Install

```sh
npm install --save-exact --ignore-scripts @tjalve/qube-adapter-grok-build@0.1.8 @tjalve/qube-core@0.2.6
```

Or install QUBE and initialize the host:

```sh
npm install --save-exact --ignore-scripts @tjalve/qube@0.2.12 @tjalve/qube-adapter-grok-build@0.1.8 @tjalve/qube-adapter-github@0.1.8
qube init --host grok-build --work-provider github --yes
```

## Requirements

- Node.js 24 or newer
- `@tjalve/qube-core` at a compatible version
- The `grok` CLI on PATH for isolated review

## Source

Monorepo path: https://github.com/ZarK/ai-qube/tree/main/adapters/grok-build
