# QUBE Command Surfaces

This matrix defines which package commands are part of the QUBE-facing workflow and which remain standalone package surfaces.

See also the static command-flow visual: [QUBE Command Surface: Idea to Complete Implementation](./qube-command-surface-visual.html).

| Package | Command pattern | Classification | QUBE-facing | Schema required | Notes |
| --- | --- | --- | --- | --- | --- |
| `@tjalve/aib` | `aib init\|status\|next\|answer\|spec *\|milestones *\|work-items *` | QUBE-facing workflow command | yes | yes | Bootstrap planning commands are discoverable through QUBE and keep provider mutation behind dry-run or local-file guards. |
| `@tjalve/aie` | `aie queue\|start\|switch\|branch *\|pr *\|complete\|review\|doctor\|schema\|init\|migrate` | QUBE-facing workflow command | yes | yes | Executor owns GitHub issue, PR, review, queue, lifecycle, and host-instruction workflows. |
| `@tjalve/aiq` | `aiq run\|check\|plan\|doctor\|setup\|status\|config\|evidence\|schema` | QUBE-facing workflow command | yes | yes | Quality workflow commands are the QUBE-facing AIQ surface. Mutating or tool-running commands must expose dry-run and supply-chain metadata. |
| `@tjalve/aiq` | `aiq bench\|watch\|serve\|hook install\|ci setup\|ignore write` | standalone package command | no | yes | Benchmark, watcher/server, and adapter-guidance commands remain standalone-only and are not required for `qube components` discovery. |
| `@tjalve/aiu` | `aiu config\|doctor\|status\|paths\|init\|migrate\|hook-stop\|whip` | QUBE-facing workflow command | yes | yes | Umpire exposes continuation policy, trusted-state, OpenCode host integration, and local whip state commands. |

`qube components` exposes the four package-level component CLIs: `aib`, `aie`, `aiq`, and `aiu`. Its JSON output also exposes adapter capability reports for installed, missing, standalone, and unsupported integration behavior. It must not imply that every standalone-only command is required for the top-level QUBE workflow, and missing adapter packages must never imply a GitHub fallback or fake success.

AIQ is the important boundary case. `bench`, `watch`, `serve`, `hook install`, `ci setup`, and `ignore write` are valid standalone AIQ commands, but QUBE does not depend on them for composer dispatch or component discovery.
