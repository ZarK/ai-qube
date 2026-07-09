# @tjalve/qube-adapter-jira

Jira work provider adapter for QUBE issue reads, draft rendering, and unsupported
lifecycle reporting.

Install this package when `@tjalve/aie` or `@tjalve/aib` is configured to use
Jira for issue tracking. The adapter maps Jira issues with schema-driven status,
priority, sprint, epic, comments, and links into provider-neutral work items.

For the full QUBE package family and command deck, see
https://zark.github.io/ai-qube/ or the repository landing-page artifact at
https://github.com/ZarK/ai-qube/blob/HEAD/docs/index.html.

## Install

```sh
npm install --save-exact --ignore-scripts @tjalve/qube-adapter-jira@0.1.1 @tjalve/qube-core@0.2.1
```

Or use the guided composer:

```sh
npm install -g --ignore-scripts @tjalve/qube@0.2.0
qube install --scope local --work-provider jira --yes
```

## Requirements

- Node.js 24 or newer
- `@tjalve/qube-core` at a compatible version
- Jira API credentials with access to the target site and project

## Source

Monorepo path: https://github.com/ZarK/ai-qube/tree/main/adapters/jira