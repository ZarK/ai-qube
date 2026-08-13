# QUBE Command Surfaces

Generated from the composer command registry. Do not edit by hand; regenerate with `pnpm --dir products/qube run docs:surfaces` after a build.

See also the static command-flow visual: [QUBE Command Surface: Idea to Complete Implementation](./qube-command-surface-visual.html).

## Composer-level commands

| Command | Description |
| --- | --- |
| `qube components` | List QUBE component packages and commands. |
| `qube install` | Build a guided, supply-chain-safe QUBE install plan. |
| `qube init` | Initialize QUBE workspace setup by composing each installed component's init through its init capability contract. |
| `qube doctor` | Aggregate Quality Control, Executor workflow, Umpire continuation, host toolkit completeness, and configured provider connection diagnostics. |
| `qube autoresearch` | Run a safety-bounded local autoresearch arena lifecycle. Agent entry: translate the request into <target-directory> plus <goal>, then use AIB arena synthesis before edits. |
| `qube oneshot` | Create a bounded local artifact without the normal issue, PR, or review-gate workflow. |
| `qube make-it-so` | Map an intent to the safest real QUBE workflow. |
| `qube run` | Run a QUBE component command with passthrough arguments. |

## Direct workflow commands

Each direct command is the composer-facing name for one component command.

| Command | Routes to | Description |
| --- | --- | --- |
| `qube idea` | `aib init` | Start Bootstrap from a concise idea. |
| `qube plan status` | `aib status` | Show Bootstrap planning status. |
| `qube plan next` | `aib next` | Show the next Bootstrap planning action. |
| `qube answer` | `aib answer` | Record a Bootstrap planning answer. |
| `qube spec draft` | `aib spec draft` | Draft the Bootstrap spec artifact. |
| `qube spec validate` | `aib spec validate` | Validate the Bootstrap spec artifact. |
| `qube spec accept` | `aib spec accept` | Accept reviewed Bootstrap spec sections. |
| `qube spec reopen` | `aib spec reopen` | Reopen accepted Bootstrap spec sections. |
| `qube milestones` | `aib milestones generate` | Generate milestone planning artifacts. |
| `qube milestones generate` | `aib milestones generate` | Generate milestone planning artifacts. |
| `qube work-items` | `aib work-items generate` | Generate provider-neutral work item drafts. |
| `qube work-items generate` | `aib work-items generate` | Generate provider-neutral work item drafts. |
| `qube work-items render` | `aib work-items render` | Render work item drafts for a provider. |
| `qube queue` | `aie queue` | Show the Executor issue queue. |
| `qube next` | `aie next` | Select the next Executor issue. |
| `qube start` | `aie start` | Start or resume Executor issue work. |
| `qube switch` | `aie switch` | Switch Executor issue work. |
| `qube view` | `aie view` | Show Executor issue context. |
| `qube complete` | `aie complete` | Complete post-merge Executor issue work. |
| `qube branch` | `aie branch` | Show Executor branch helpers. |
| `qube branch suggest` | `aie branch suggest` | Suggest the policy-compliant issue branch. |
| `qube branch check` | `aie branch check` | Check the current issue branch. |
| `qube branch create` | `aie branch create` | Create or switch to the issue branch. |
| `qube gates` | `aie gates` | Show Executor gate helpers. |
| `qube gates plan` | `aie gates plan` | Show configured Executor gate obligations. |
| `qube gates status` | `aie gates status` | Show recorded Executor gate evidence. |
| `qube audit` | `aie audit` | Show Executor audit helpers. |
| `qube audit ui` | `aie audit ui` | Plan or check manual UI audit evidence. |
| `qube review` | `aie review` | Set up and validate provider publishing or show host-run Executor review helpers. |
| `qube review setup` | `aie review setup` | Show guided reviewer publisher setup paths. |
| `qube review setup github-app` | `aie review setup github-app` | Configure a user-owned GitHub App reviewer publisher with safe secret references. |
| `qube review setup token` | `aie review setup token` | Configure a separate-user fine-grained token reviewer publisher with an env reference. |
| `qube review doctor` | `aie review doctor` | Validate reviewer publisher readiness and permissions without exposing secrets. |
| `qube review gate` | `aie review gate` | Render configured review-agent gate prompts. |
| `qube pr` | `aie pr` | Show Executor pull request helpers. |
| `qube pr view` | `aie pr view` | Show concise pull request state. |
| `qube pr body` | `aie pr body` | Draft a pull request body for issue work. |
| `qube pr gate` | `aie pr gate` | Request and inspect configured pull request reviews. |
| `qube deps` | `aie deps` | Show Executor dependency helpers. |
| `qube deps blockers` | `aie deps blockers` | List direct blockers for an issue. |
| `qube deps blocked` | `aie deps blocked` | List blocked open issues. |
| `qube deps blocking` | `aie deps blocking` | List open issues blocked by an issue. |
| `qube deps ready` | `aie deps ready` | List ready issues with no open blockers. |
| `qube deps chain` | `aie deps chain` | Show recursive issue blockers. |
| `qube deps graph` | `aie deps graph` | Emit the open issue dependency graph. |
| `qube deps fix` | `aie deps fix` | Synchronize dependency status labels. |
| `qube app start` | `aie run start` | Start a local app process for audit work. |
| `qube app wait` | `aie run wait` | Wait for a local audit app readiness URL. |
| `qube app status` | `aie run status` | Show local audit app process status. |
| `qube app stop` | `aie run stop` | Stop a local audit app process. |
| `qube check` | `aiq check` | Run Quality Control checks for explicit paths. |
| `qube quality` | `aiq run` | Run AIQ quality stages for explicit paths. |
| `qube quality run` | `aiq run` | Run AIQ quality stages for explicit paths. |
| `qube quality plan` | `aiq plan` | Resolve the AIQ quality plan. |
| `qube quality status` | `aiq status` | Show AIQ quality status. |
| `qube quality setup` | `aiq setup` | Render AIQ setup guidance. |
| `qube evidence` | `aiq evidence` | Emit structured AIQ quality evidence. |
| `qube quality evidence` | `aiq evidence` | Emit structured AIQ quality evidence. |
| `qube bench` | `aiq bench` | Run the standalone AIQ benchmark corpus. |
| `qube watch` | `aiq watch` | Run AIQ continuously for explicit paths. |
| `qube serve` | `aiq serve` | Start the standalone AIQ quality server. |
| `qube continue` | `aiu status` | Show Umpire continuation status and resume guidance. |
| `qube whip` | `aiu whip` | Inspect and manage durable idle whip tasks. |

## Hidden synonyms

These names stay dispatchable for compatibility but are excluded from help listings; their help renders the canonical composer-facing command.

| Synonym | Canonical command |
| --- | --- |
| `qube status` | `qube continue` |
| `qube continue status` | `qube continue` |

## Component passthroughs

`qube components` exposes the package-level component CLIs only. Standalone-only package commands remain valid on each component CLI without being required for composer dispatch or component discovery.

| Command | Component | Aliases |
| --- | --- | --- |
| `qube aib <args...>` | @tjalve/aib | `qube bootstrap` |
| `qube aie <args...>` | @tjalve/aie | `qube executor` |
| `qube aiq <args...>` | @tjalve/aiq | — |
| `qube aiu <args...>` | @tjalve/aiu | `qube umpire` |

## Package command surface contracts

Package-level classification from the core contracts: which package command patterns are QUBE-facing workflow surfaces and which stay standalone-only.

| Package | Command pattern | Classification | QUBE-facing | Schema required | Notes |
| --- | --- | --- | --- | --- | --- |
| `@tjalve/aib` | `aib init\|status\|next\|answer\|spec *\|milestones *\|work-items *` | qube-facing workflow command | yes | yes | Bootstrap planning commands are safe to discover through QUBE and keep provider mutation behind dry-run or local-file guards. |
| `@tjalve/aie` | `aie queue\|start\|switch\|branch *\|pr *\|complete\|review\|doctor\|schema\|init\|migrate` | qube-facing workflow command | yes | yes | Executor owns GitHub issue, PR, and review workflow behavior plus host instruction init/migration. |
| `@tjalve/aiq` | `aiq run\|check\|plan\|doctor\|setup\|status\|config\|evidence\|schema` | qube-facing workflow command | yes | yes | Quality workflow commands are discoverable by QUBE; mutating or tool-running commands expose dry-run and supply-chain metadata. |
| `@tjalve/aiq` | `aiq bench\|watch\|serve\|hook install\|ci setup\|ignore write` | standalone package command | no | yes | AIQ benchmark, daemon, and adapter-guidance commands remain standalone package surfaces and are documented as such. |
| `@tjalve/aiu` | `aiu config\|doctor\|status\|paths\|init\|migrate\|hook-stop\|whip` | qube-facing workflow command | yes | yes | Umpire exposes continuation policy, trusted-state, OpenCode host integration, and local whip state commands. |
