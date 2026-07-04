# @tjalve/qube-adapter-jenkins

Jenkins CI provider adapter for QUBE gate evidence reads and unsupported mutation
reporting.

Install this package when repository policy references Jenkins for CI gate
evidence. The adapter surfaces build status, unstable runs, queued jobs, and
missing pipeline evidence through provider-neutral gate evidence fields.

For the full QUBE package family and command deck, see
https://zark.github.io/ai-qube/ or the repository landing-page artifact at
https://github.com/ZarK/ai-qube/blob/HEAD/docs/index.html.

## Install

```sh
npm install --save-exact --ignore-scripts @tjalve/qube-adapter-jenkins@0.1.1 @tjalve/qube-core@0.2.1
```

## Requirements

- Node.js 24 or newer
- `@tjalve/qube-core` at a compatible version
- Jenkins API access to the jobs referenced by repository policy

## Source

Monorepo path: https://github.com/ZarK/ai-qube/tree/main/adapters/jenkins