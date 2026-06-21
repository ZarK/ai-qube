# QUBE Paths And Repository Artifacts

This matrix separates product-installed config/state paths from implementation-time repository workflow files.

| Owner | Path pattern | Classification | Committed | Migration policy |
| --- | --- | --- | --- | --- |
| QUBE | `.qube/` | shared QUBE namespace | no | Shared namespace for package config, state, logs, locks, cache, and generated artifacts. Product migrations preserve legacy paths unless explicitly applied. |
| AIB | `.qube/aib/session.json` | standalone product state | no | AIB defaults write QUBE-prefixed state. Explicit legacy `.bootstrap/session.json` paths remain readable and migration must preserve existing state. |
| AIQ | `.qube/aiq/config.json, .qube/aiq/progress.json, and .qube/aiq/out/` | standalone product config | yes | AIQ setup creates missing QUBE-prefixed files only. Legacy `.aiq/` and `aiq.config.json` discovery remain migration/backward-compatible inputs. |
| AIU | `.qube/aiu/config.json` | standalone product config | yes | AIU init and migrate prefer QUBE-prefixed config, fall back to legacy `aiu.config.json`, and preserve existing config unless explicit replacement is confirmed. |
| AIU | `.qube/aiu/state, .qube/aiu/locks, .qube/aiu/logs, and .qube/aiu/whip.json` | standalone product state | no | AIU defaults write QUBE-prefixed state. Migration detects and preserves legacy `.umpire` state unless cleanup is explicitly confirmed. |
| AIE | `.qube/aie/config.json, .qube/aie/gates/, .qube/aie/reviews/, and .qube/aie/runs/` | standalone product config | yes | AIE init writes QUBE-prefixed product config and runtime evidence. Legacy `aie.config.json` remains a repo-policy fallback and copied workflow files remain separate. |
| Repository | `products/*/AGENTS.md and products/*/aie.config.json` | implementation-time workflow policy | yes | Package-directory workflow files guide this monorepo's implementation work. They are not installed package product surfaces. |
| Repository | `products/*/test-projects/**` | test fixture or sample | yes | Fixture projects support tests and are not product config defaults. |

Only AIE is expected to own review-agent product configuration. A copied `aie.config.json` under another package directory is implementation-time workflow policy unless a product command explicitly documents and writes it as installed behavior.

Init and migrate commands must remain conflict-aware. The default posture is dry-run or create-missing-only behavior; replacement of existing host/config files requires an explicit force, apply, or cleanup confirmation path documented by the owning product.
