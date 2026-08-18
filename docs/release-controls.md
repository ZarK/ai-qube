# Release Controls

QUBE packages publish from this repository through one set tag and npm trusted
publishing. npm publication is intentionally tokenless: the publish job uses
`id-token: write` so npm can verify the workflow identity through OIDC. Its
short-lived GitHub token has read-only access to repository contents and prior
workflow-attempt logs so a retry can restore a staging checkpoint.

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

Allow only `npm stage publish` on each trusted publisher. Do not allow direct
publishing and do not configure an npm token fallback. The GitHub environment is
named `npm-publish`. Keep reviewer approval enabled for that environment when
the repository plan supports it. npm approval remains the proof-of-presence gate.

## Normal Package Release

The maintainer triggers a release. Merge to main does not publish. Generate the
complete version change on an issue branch before the release PR:

```sh
pnpm release:prepare --dry-run
pnpm release:prepare --write
```

The preparation command finds the newest reachable prior `publish-set-v*` tag,
compares its commit with the current branch, and checks the live npm registry. It
bumps each changed public package once, preserves an unpublished initial version,
propagates internal dependency releases in publish order, generates the composer
and adapter pins, refreshes the version audit, and updates the lockfile with
lifecycle scripts disabled. Review and merge those generated changes through the
normal pull request controls. Package versions do not need to be copied into
release scripts by hand.

After the preparation PR is on `main`, run:

```sh
git switch main
git pull --ff-only origin main
pnpm release --dry-run
pnpm run release
```

`pnpm release --dry-run` prints the tag and the unpublished package list.
The release command refuses a dirty, stale, non-main, or incompletely prepared
checkout. It also refuses to move an existing immutable set tag. The workflow
repeats the preparation check, so a manually pushed incomplete set tag cannot
bypass this control.

Before tag creation, the release command also verifies that every package name
exists on npm. npm staged publishing cannot create a package name. If a name is
new, the command stops and identifies the package path and target version. Use
the separately reviewed first-publish procedure below, configure the stage-only
trusted publisher, and wait for the name to be readable from the registry before
retrying the set.

The workflow prepares the set, checks manifests and composer pins, packs every
current workspace package from the checkout, installs those tarballs into a
prefix outside the checkout, and fails if `qube`, `aie`, `aib`, `aiu`, or `aiq`
does not start. Then the same job stages every version that is not already on npm,
in dependency order:

```sh
npm stage publish . --access public --ignore-scripts --json
```

The job records one complete receipt that binds the ordered package names,
versions, stage IDs, dist-tags, and tarball shasums to the immutable release tag,
commit, and workflow run. Already-public versions are skipped. Unchanged adapters
do not need a bump. Composer pins for Bootstrap, Executor, Quality, Umpire, CLI,
and core must match the workspace versions; CI fails if they drift.

The job writes a checkpoint marker before staging and after every confirmed npm
stage. A rerun restores the latest checkpoint from a prior attempt only after it
matches the same workflow run, tag, commit, package plan, and attempt number. An
intent marker is written before each npm request. If an attempt ends after an
intent without a confirming checkpoint, the retry fails closed for manual npm
stage inspection instead of risking a duplicate stage. No npm credential is used
to restore the checkpoint.

After the workflow succeeds, run one command:

```sh
pnpm run release:approve -- publish-set-v<qube-version>
```

The command finds the successful workflow run and validates its receipt against
the local tag, `origin/main`, the package manifests at that commit, the active
npm stages, and the public registry. It displays the complete ordered set before
approval. npm can require authentication and proof-of-presence for each protected
stage approval; the command does not bypass those checks. All packages were
already built and staged together, so no dependency is rebuilt or restaged
between approvals.

If approval is interrupted, run the same command again. A package is skipped only
when its public registry shasum matches the release receipt. Remaining matching
stages continue in dependency order. Missing, stale, duplicate, or mismatched
evidence fails closed before an approval call.

If part of a set is approved before a later stage fails, keep the original tag
unchanged. After fixing the release pipeline on `main`, run:

```sh
pnpm release --retry --dry-run
pnpm release --retry
```

The retry command requires the original set tag on `origin`, verifies that it is
an ancestor of current `main`, verifies that publishable package inputs have not
changed since that tag, and creates the next unused immutable
`publish-set-v<qube-version>-retry.<number>` tag. It refuses a retry when no set
version is public, every set version is public, a package name is still missing,
or a tag conflicts. The retry workflow excludes public exact versions and
creates a fresh receipt bound to the retry tag, commit, workflow run, attempt,
and ordered remaining package plan. A checkpoint from the original tag or a
different retry cannot be restored.

To publish one package in an emergency, use a package-specific tag:

```sh
git tag publish-<package>-v<version>
git push origin publish-<package>-v<version>
pnpm run release:approve -- publish-<package>-v<version>
```

Valid package keys are `qube-cli`, `qube-core`, `qube-adapter-github`,
`qube-adapter-codex`, `qube-adapter-opencode`, `qube-adapter-claude-code`,
`qube-adapter-gitlab`, `qube-adapter-linear`, `qube-adapter-jira`,
`qube-adapter-jenkins`, `qube-adapter-grok-build`, `qube-adapter-cursor`,
`aib`, `aie`, `aiu`, `aiq`, and `qube`.

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
the selected package, and stages it with trusted publishing.

## First Publish Exception

Trusted publishing requires the package name to already exist on npm. This
pipeline does not fall back to direct publishing for a brand-new package name.
Bootstrap a new name through a separately reviewed and explicitly authorized
procedure, configure its stage-only trusted publisher, and only then add it to
this release set. Bootstrap order for new names is:

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
11. `@tjalve/qube-adapter-cursor`

Bootstrap any other brand-new package name only after its published dependencies
exist. Then configure the trusted publisher above for `npm stage publish` and use
the set tag for later versions.

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
