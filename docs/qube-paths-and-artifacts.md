# QUBE Paths And Repository Artifacts

This matrix separates product-installed config/state paths from implementation-time repository workflow files.

| Owner | Path pattern | Classification | Committed | Write policy |
| --- | --- | --- | --- | --- |
| QUBE | `.qube/` | shared QUBE namespace | no | Each product writes only its owned namespace under the shared QUBE root. |
| AIB | `.qube/aib/session.json` | standalone product state | no | Bootstrap writes its local planning session state here. Runtime state is not committed. |
| AIB | `aib.config.json` | repository configuration | yes | Bootstrap stores only repository settings that differ from explicit user-global settings. |
| AIB | `aib.config.local.json and ~/.qube/aib/config.json` | machine-local and user-global configuration | no | Bootstrap reads these higher and lower configuration layers without copying them into repository configuration. |
| AIQ | `.qube/aiq/config.json` | repository configuration | yes | Quality stores only repository settings that differ from explicit user-global settings. |
| AIQ | `.qube/aiq/config.local.json and ~/.qube/aiq/config.json` | machine-local and user-global configuration | no | Quality reads these layers without flattening them into tracked repository configuration. |
| AIQ | `.qube/aiq/progress.json and .qube/aiq/out/` | standalone product state | no | Quality keeps progress and generated reports repository- or machine-owned; they are not configuration layers. |
| AIU | `.qube/aiu/config.json` | repository configuration | yes | Umpire stores only repository continuation settings that differ from explicit user-global settings. |
| AIU | `.qube/aiu/config.local.json and ~/.qube/aiu/config.json` | machine-local and user-global configuration | no | Umpire reads these layers without flattening them into tracked repository configuration. |
| AIU | `.qube/aiu/state, .qube/aiu/locks, .qube/aiu/logs, and .qube/aiu/whip.json` | standalone product state | no | Umpire writes runtime state, locks, logs, and whip state below its QUBE namespace. Runtime state is not committed. |
| AIE | `.qube/aie/config.json` | repository configuration | yes | Executor stores only repository policy that differs from explicit user-global settings or is inherently repository-specific. |
| AIE | `.qube/aie/config.local.json and ~/.qube/aie/config.json` | machine-local and user-global configuration | no | Executor reads these layers without flattening them into tracked repository configuration. |
| AIE | `.qube/aie/gates/, .qube/aie/reviews/, and .qube/aie/runs/` | standalone product state | no | Executor keeps gates, reviews, and run evidence repository- or machine-owned; they are not configuration layers. |
| AIE | `~/.qube/verification/<repository>/<issue>/` | user-local UI audit evidence | no | UI audits write local screenshots, `browser-observation.md`, `notes.md`, and a head stamp here. The evidence is not committed. |
| Repository | `products/*/test-projects/**` | test fixture or sample | yes | Fixture projects support tests and are not product config defaults. |

Only Executor owns review-agent product configuration.

Setup commands must remain conflict-aware. Their default posture is dry-run or create-missing-only behavior. They preserve user-owned content and report a conflict when a safe merge is not possible.
