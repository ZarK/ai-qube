# Release Controls

This file records the expected public-release controls for `@tjalve/aiu` after
the package moved into the QUBE monorepo.

## Active Repository

- Active repository: `ZarK/ai-qube`.
- Package path: `products/aiu`.
- Package name: `@tjalve/aiu`.
- Default branch: `main`.
- Publishing is driven by the root workflow `.github/workflows/publish.yml`.
- Product-local workflow files from the earlier standalone repository are not
  active GitHub workflows in the QUBE monorepo.

## GitHub Repository Controls

Required controls before public release:

- protect `main`
- require pull requests before merge
- require at least one approving review
- require CODEOWNERS review for release-sensitive files
- require conversation resolution
- require current CI status checks
- disable force pushes and branch deletion on `main`
- keep default workflow token permissions read-only
- keep secret scanning and push protection enabled where the repository plan
  supports them

## GitHub Actions

- CI workflow: root `.github/workflows/ci.yml`.
- Publish workflow: root `.github/workflows/publish.yml`.
- Third-party actions are pinned to full commit SHAs.
- CI and publish installs use `pnpm install --frozen-lockfile --ignore-scripts`.
- The publish job uses `id-token: write`, `package-manager-cache: false`, and
  the `npm-publish` GitHub environment.
- The publish job verifies the selected package before publishing.

## npm Publishing

- Primary publish path: npm trusted publishing for `ZarK/ai-qube`, workflow file
  `publish.yml`, environment `npm-publish`.
- The allowed npm trusted-publishing action must include `npm publish`.
- Long-lived `NPM_TOKEN` secrets are not required for the primary publish path.
- The `npm-publish` GitHub environment should require reviewer approval when the
  repository plan supports environment protection rules.
- For package-local installs and release checks, use exact versions and disabled
  lifecycle scripts:

  ```sh
  pnpm add -D --save-exact --ignore-scripts @tjalve/aiu@0.0.3
  pnpm install --frozen-lockfile --ignore-scripts
  ```

## Safe Removal

Remove AIU only after host files and trusted command descriptors no longer
depend on the package:

```sh
pnpm remove @tjalve/aiu
```

Use `aiu migrate --cleanup --dry-run --json` before deleting old copied helper
assets.
