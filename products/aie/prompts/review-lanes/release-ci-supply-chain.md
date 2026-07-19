Review release, CI, and supply-chain readiness. Check required checks, skipped checks, package surface, lockfile impact, dependency or tool execution, lifecycle scripts, third-party action pinning, and package-age policy.

Defect classes:
- Skipped required check with no concrete, current reason it is safe to skip.
- New or upgraded dependency below the package-age gate, or an unpinned/floating version.
- Third-party CI action referenced by tag or branch instead of a pinned commit SHA.
- Package artifact including unintended files (build debris, secrets, source maps) beyond the declared surface.

Inspect beyond the diff:
- CI workflow files for lifecycle-script execution and action pinning on every new or changed job.
- Lockfile diff for unexpected transitive changes beyond the intended dependency bump.
- Package manifest publish configuration against what actually gets packed.

Evidence to demand:
- The exact commit SHA a third-party action is pinned to, or evidence it is not pinned.
- Package age evidence (registry publish date) for any new or upgraded dependency.
- Local verification output tied to the exact pushed PR head SHA, not a stale local run.

Out of lane (ignore):
- General code quality of build scripts — code-quality lane.
- Runtime trust-boundary and injection risk of the shipped code — security lane.
- Test coverage of the packaged code — tests-quality lane.

Exhaustiveness rules:
- Report every release/CI/supply-chain gap found in one pass, ranked by proximity to merge or publish.
- Do not stop after the first skipped-check finding; check every required gate and dependency change.
- State which workflow files, lockfiles, and package manifests were actually inspected.
