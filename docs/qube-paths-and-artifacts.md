# QUBE Paths And Repository Artifacts

This matrix separates product-installed config/state paths from implementation-time repository workflow files.

| Owner | Path pattern | Classification | Committed | Migration policy |
| --- | --- | --- | --- | --- |
| QUBE | `.qube/` | shared QUBE namespace | no | Reserved for future composer-level cache, logs, and install diagnostics. Product defaults do not migrate into it automatically. |
| AIB | `.bootstrap/session.json` | standalone product state | no | AIB init and planning commands must preview writes, preserve existing state, and require explicit force for conflicting managed files. |
| AIQ | `.aiq/aiq.config.json` and `.aiq/progress.json` | standalone product config | yes | AIQ config init creates missing files only; stage updates write progress intentionally and do not overwrite host config. |
| AIU | `aiu.config.json` and `.umpire/` | standalone product config/state | config yes, state no | AIU init and migrate are conflict-aware, dry-runnable, and preserve `.umpire` state, locks, and logs unless cleanup is explicitly confirmed. |
| AIE | `aie.config.json` | standalone product config | yes | AIE init owns review/execution policy config and must keep copied repo workflow files separate from product config. |
| Repository | `products/*/AGENTS.md` and `products/*/aie.config.json` | implementation-time workflow policy | yes | Package-directory workflow files guide this monorepo's implementation work. They are not installed package product surfaces. |
| Repository | `products/*/test-projects/**` | test fixture or sample | yes | Fixture projects support tests and are not product config defaults. |

Only AIE is expected to own review-agent product configuration. A copied `aie.config.json` under another package directory is implementation-time workflow policy unless a product command explicitly documents and writes it as installed behavior.

Init and migrate commands must remain conflict-aware. The default posture is dry-run or create-missing-only behavior; replacement of existing host/config files requires an explicit force, apply, or cleanup confirmation path documented by the owning product.
