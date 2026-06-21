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

For package names that already exist on npm, publish through a package-specific
tag:

```sh
git switch main
git pull --ff-only origin main
git tag publish-<package>-v<version>
git push origin publish-<package>-v<version>
```

Valid package keys are `qube-cli`, `aib`, `aie`, `aiu`, `aiq`, and `qube`.
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
pnpm --filter @tjalve/qube-cli run build
cd products/aib
npm publish --access public --provenance=false --otp <otp>
```

Use the same pattern for any other brand-new package name, after its published
dependencies already exist. Then configure the trusted publisher above for the
new package and use staged publishing for later versions.

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
