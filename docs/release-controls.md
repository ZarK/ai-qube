# Release Controls

QUBE packages publish from this repository through one set tag and npm trusted
publishing. The workflow is intentionally tokenless: it uses the GitHub Actions
`id-token: write` permission only inside the publish job so npm can verify the
workflow identity through OIDC.

## GitHub Controls

- Protect `main` with pull requests, current CI, linear history, and conversation
  resolution.
- Keep third-party workflow actions pinned to full commit SHAs.
- Keep default workflow token permissions read-only.
- Treat `.github/workflows/`, `.github/CODEOWNERS`, `.npmrc`, package manifests,
  workspace metadata, package sources, adapters, and plugins as release-sensitive
  CODEOWNERS paths.

## npm Trusted Publishing

Configure each npm package with this trusted publisher:

| Field | Value |
| --- | --- |
| Publisher | GitHub Actions |
| Organization or user | `ZarK` |
| Repository | `ai-qube` |
| Workflow filename | `publish.yml` |
| Environment | `npm-publish` |
| Allowed action | `npm publish` |

Allow `npm publish` once on each trusted publisher. After that, pushing the set
tag is the only maintainer action. The GitHub environment is named `npm-publish`.
Keep reviewer approval enabled for that environment when the repository plan
supports it. That environment approval, if required, is the proof-of-presence
gate. There is no per-package npm UI approval step.

## Normal Package Release

The maintainer triggers a release. Merge to main does not publish.

After the versions you want are on `main`, run one command:

```sh
git switch main
git pull --ff-only origin main
pnpm run release
```

Or push the set tag yourself:

```sh
git tag publish-set-v<qube-version>
git push origin publish-set-v<qube-version>
```

`pnpm run release -- --dry-run` prints the tag and the unpublished package list
without pushing.

The workflow prepares the set, checks manifests and composer pins, packs every
current workspace package from the checkout, installs those tarballs into a
prefix outside the checkout, and fails if `qube`, `aie`, `aib`, `aiu`, or `aiq`
does not start. Then it publishes only the versions that are not already on npm:

```sh
npm publish . --access public --ignore-scripts
```

Already-public versions are skipped. Unchanged adapters do not need a bump.
Composer pins for Bootstrap, Executor, Quality, Umpire, CLI, and core must match
the workspace versions; CI fails if they drift.

To publish one package in an emergency, use a package-specific tag:

```sh
git tag publish-<package>-v<version>
git push origin publish-<package>-v<version>
```

Valid package keys are `qube-cli`, `qube-core`, `qube-adapter-github`,
`qube-adapter-codex`, `qube-adapter-opencode`, `qube-adapter-claude-code`,
`qube-adapter-gitlab`, `qube-adapter-linear`, `qube-adapter-jira`,
`qube-adapter-jenkins`, `qube-adapter-grok-build`, `aib`, `aie`, `aiu`,
`aiq`, and `qube`.

Adapter packages are separate npm packages sourced from `adapters/*` in this
monorepo. `@tjalve/aie` lists them as optional dependencies; install only the
adapters your forge and host need. The default GitHub + Codex executor stack is:

```sh
npm install -g --ignore-scripts \
  @tjalve/aie@<version> \
  @tjalve/qube-core@<version> \
  @tjalve/qube-adapter-github@<version> \
  @tjalve/qube-adapter-codex@<version>
```

Or install the composer package, which bundles the core product packages:

```sh
npm install -g --ignore-scripts @tjalve/qube@<version>
```

Run `node scripts/print-publish-plan.mjs` from the repository root to print the
ordered seed and set-tag commands for the current workspace versions.
The workflow verifies the tag version against the selected package manifest,
checks that the tag commit is reachable from `origin/main`, installs dependencies
with lifecycle scripts disabled, builds required workspace dependencies, verifies
the selected package, and publishes with trusted publishing.

## First Publish Exception

Trusted publishing requires the package name to already exist on npm. A
brand-new package name must be seeded once with a normal authenticated publish.
Because local shells are not a supported provenance provider, override package
provenance for that seed publish:

```sh
cd <repo-root>
pnpm --filter @tjalve/qube-core run verify
cd packages/qube-core
npm publish --access public --provenance=false --otp <otp>
```

Seed publish order for a new name:

1. `@tjalve/qube-core`
2. `@tjalve/qube-adapter-github`
3. `@tjalve/qube-adapter-codex`
4. `@tjalve/qube-adapter-opencode`
5. `@tjalve/qube-adapter-claude-code`
6. `@tjalve/qube-adapter-gitlab`
7. `@tjalve/qube-adapter-linear`
8. `@tjalve/qube-adapter-jira`
9. `@tjalve/qube-adapter-jenkins`
10. `@tjalve/qube-adapter-grok-build`

Use the same seed pattern for any other brand-new package name, after its
published dependencies already exist. Then configure the trusted publisher above
for the new package, allow `npm publish`, and use the set tag for later versions.

For package-local installs and release checks, use exact versions and disabled
lifecycle scripts:

```sh
pnpm add -D --save-exact --ignore-scripts @tjalve/aiu@0.0.4
pnpm install --frozen-lockfile --ignore-scripts
```

Remove a package only after host files and trusted command descriptors no longer
depend on it:

```sh
pnpm remove @tjalve/aiu
```
