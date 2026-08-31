# @tjalve/qube-adapter-github

GitHub provider adapter for QUBE work items, pull request review, checks, and CI
integrations.

Install this package when `@tjalve/aie` or `@tjalve/aib` is configured to use
GitHub for issues, pull requests, review coordination, or check evidence. The
adapter owns GitHub API clients, credential probing, provider mapping, and
unsupported-operation diagnostics. `@tjalve/aie` lists it as an optional
dependency and installs it on demand.

For the full QUBE package family and command deck, see
https://zark.github.io/ai-qube/ or the repository landing-page artifact at
https://github.com/ZarK/ai-qube/blob/HEAD/docs/index.html.

## Install

```sh
npm install --save-exact --ignore-scripts @tjalve/qube-adapter-github@0.1.8 @tjalve/qube-core@0.2.6
```

Or install QUBE and initialize the provider:

```sh
npm install --save-exact --ignore-scripts @tjalve/qube@0.2.12 @tjalve/qube-adapter-github@0.1.8
qube init --work-provider github --yes
```

## Requirements

- Node.js 24 or newer
- `@tjalve/qube-core` at a compatible version
- `gh` CLI authenticated for GitHub.com or GitHub Enterprise when using live APIs

See the canonical [GitHub provider support guide](../../docs/qube-github-provider-support.md)
for conditional CLI requirements, credential precedence, capability probes,
Enterprise limitations, and stable recovery reasons.

## Source

Monorepo path: https://github.com/ZarK/ai-qube/tree/main/adapters/github
