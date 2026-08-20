# QUBE Paths And Repository Artifacts

This matrix separates product-installed config/state paths from implementation-time repository workflow files.

| Owner | Path pattern | Classification | Committed | Write policy |
| --- | --- | --- | --- | --- |
| QUBE | `.qube/` | shared QUBE namespace | no | Each product writes only its owned namespace under the shared QUBE root. |
| AIB | `.qube/aib/session.json` | standalone product state | no | Bootstrap writes its local planning session state here. Runtime state is not committed. |
| AIQ | `.qube/aiq/config.json, .qube/aiq/progress.json, and .qube/aiq/out/` | standalone product config | yes | Quality writes repository configuration and progress under its QUBE namespace and keeps generated output below the same namespace. |
| AIU | `.qube/aiu/config.json` | standalone product config | yes | Umpire writes repository continuation policy only to this canonical config path. |
| AIU | `.qube/aiu/state, .qube/aiu/locks, .qube/aiu/logs, and .qube/aiu/whip.json` | standalone product state | no | Umpire writes runtime state, locks, logs, and whip state below its QUBE namespace. Runtime state is not committed. |
| AIE | `.qube/aie/config.json, .qube/aie/gates/, .qube/aie/reviews/, and .qube/aie/runs/` | standalone product config | yes | Executor writes repository policy and runtime evidence only below its QUBE namespace. |
| AIE | `~/.qube/verification/<repository>/<issue>/` | user-local UI audit evidence | no | UI audits write local screenshots, `browser-observation.md`, `notes.md`, and a head stamp here. The evidence is not committed. |
| Repository | `products/*/test-projects/**` | test fixture or sample | yes | Fixture projects support tests and are not product config defaults. |

Only Executor owns review-agent product configuration.

Setup commands must remain conflict-aware. Their default posture is dry-run or create-missing-only behavior. They preserve user-owned content and report a conflict when a safe merge is not possible.
