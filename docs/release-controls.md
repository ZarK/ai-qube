# Release Controls

QUBE packages publish from this repository through package-specific release tags
and npm trusted publishing. The workflow is intentionally tokenless: it uses the
GitHub Actions `id-token: write` permission only inside the publish job so npm can
verify the workflow identity through OIDC.

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
| Allowed action | `npm stage publish` |

The GitHub environment is named `npm-publish`. Keep reviewer approval enabled for
that environment when the repository plan supports it.

## Normal Package Release

The maintainer triggers a release. Merge to main does not publish.

To publish the current packages as one set, tag the `@tjalve/qube` version after
that commit is on `main`:

```sh
git switch main
git pull --ff-only origin main
git tag publish-set-v<qube-version>
git push origin publish-set-v<qube-version>
```

The workflow prepares the set, checks manifests, packs the packages, installs
them into a prefix outside the checkout, and fails if `qube`, `aie`, `aib`,
`aiu`, or `aiq` does not start. Then it stages each package with trusted
publishing.

To publish one package, use a package-specific tag:

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
ordered seed and staged publish commands for the current workspace versions.
The workflow verifies the tag version against the selected package manifest,
checks that the tag commit is reachable from `origin/main`, installs dependencies
with lifecycle scripts disabled, builds required workspace dependencies, verifies
the selected package, and runs:

```sh
npm stage publish . --access public --ignore-scripts
```

Approve the staged package in npm after the workflow succeeds.

## First Publish Exception

npm staged publishing requires the package name to already exist on npm. A
brand-new package name must be seeded once with a normal authenticated publish.
Because local shells are not a supported provenance provider, override package
provenance for that seed publish:

```sh
cd <repo-root>
pnpm --filter @tjalve/qube-core run verify
cd packages/qube-core
npm publish --access public --provenance=false --otp <otp>
```

Seed publish order for the 0.2.0 wave:

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
for the new package and use staged publishing for later versions.

Staged publish order after seeds (tags on `main`):

1. `qube-cli`
2. all adapter keys (only needed again when adapter versions change)
3. `aib`
4. `aie`
5. `aiu`
6. `aiq`
7. `qube`

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
