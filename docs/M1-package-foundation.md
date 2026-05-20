# M1 - Package Foundation

## Goal

Create the safe, publishable TypeScript npm package foundation for the shared CLI toolkit.

This milestone does not migrate consuming packages. It creates the package baseline that later milestones can build on without mixing toolkit infrastructure with product behavior.

## Scope

| ID | Requirement | Source |
| --- | --- | --- |
| M1-001 | Create package metadata for a reusable TypeScript npm library with a clear package name, version, license, source metadata, `type: module`, `main`, `types`, `exports`, and `files`. | FR-01-001, FR-01-002, FR-07-007, FR-07-008 |
| M1-002 | Target Node.js 24 LTS or newer and pnpm for development and release workflows. | FR-06-001 |
| M1-003 | Add exact dependency versions, checked-in lockfile, and package-manager configuration that avoids dependency lifecycle scripts during normal install guidance. | FR-06-002, FR-06-003 |
| M1-004 | Add the minimal runtime dependency set needed for the specified toolkit surface: `@oclif/core` and `@clack/prompts`, with documented dependency review. | FR-03-001, FR-06-004 |
| M1-005 | Add TypeScript build configuration that emits compiled JavaScript and declaration files. | FR-01-002 |
| M1-006 | Add root exports and stable subpath exports only for surfaces implemented in the current package. | FR-01-003, FR-01-004, FR-07-007 |
| M1-007 | Add release scripts for build, typecheck, tests, package dry-run, and publish-file assertions. | FR-06-007, FR-07-003 |
| M1-008 | Add README usage notes that position the package as CLI infrastructure, not a product-specific package. | NFR-02-001, NFR-02-002 |

## Out Of Scope

- Consumer-package migration.
- Runtime toolkit surfaces that belong to later milestones.
- End-user command behavior beyond neutral fixture and documentation examples.
- Install-time side effects such as shell profile edits, hook installation, network calls, or background processes.

## Acceptance Criteria

- `pnpm install --frozen-lockfile` succeeds.
- `pnpm run build` emits only intended runtime JavaScript and declarations.
- `pnpm run typecheck` passes.
- `pnpm test` runs a real test command and fails if no tests exist.
- `pnpm pack --dry-run` output contains only intended runtime files, declarations, README, license, and package metadata.
- The package has no `preinstall`, `install`, or `postinstall` lifecycle scripts for normal package use.
- The README states that consuming packages own the behavior and side effects of their commands.

## Verification Notes

M1 should be complete before adding public APIs that consumers can adopt. The main risk is creating exported paths that look stable before the implementation is actually present; only export implemented surfaces.
