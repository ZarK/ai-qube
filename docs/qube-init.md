# Guided `qube init`

Install QUBE with npm or pnpm before initialization. Use an exact version and
keep package lifecycle scripts disabled:

```sh
npm install --save-dev --save-exact --ignore-scripts @tjalve/qube@0.2.12
pnpm add --save-dev --save-exact --ignore-scripts @tjalve/qube@0.2.12
npm install --global --ignore-scripts @tjalve/qube@0.2.12
pnpm add --global --ignore-scripts @tjalve/qube@0.2.12
```

For a project installation, run the published CLI through the package manager:

```sh
npm exec -- qube init
pnpm exec qube init
```

For a global installation, run `qube init`. See the
[QUBE 0.2.12 command reference](https://github.com/ZarK/ai-qube/blob/51eb90562ac9c27590d3b647a515ef9ff9c8c884/docs/qube-command-surfaces.md)
for the commands in this release.

<a id="first-task"></a>

## First task and daily use

This example uses QUBE 0.2.12 with Codex and GitHub. The
[QUBE 0.2.12 command reference](https://github.com/ZarK/ai-qube/blob/51eb90562ac9c27590d3b647a515ef9ff9c8c884/docs/qube-command-surfaces.md)
defines the released command set.

Before you start:

- Install Node.js 24 or newer, Git 2.28.0 or newer, Codex, and GitHub CLI.
- Sign in to Codex and GitHub CLI.
- [Create a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app),
  install it only on this repository, and follow the QUBE [App permission
  guidance](./qube-github-provider-support.md#capabilities-and-least-privilege).
  QUBE 0.2.12 asks for Pull requests and Contents read/write. Repository rules
  must accept the App's approval.
- Use the primary checkout of the GitHub repository.
- Choose a real GitHub issue that has the repository's Ready status and labels.
  Replace `123` below with that issue number.
- Review [Codex host support](./qube-codex-host-support.md), the [host capability
  matrix](./qube-host-surfaces.md#capability-matrix), and [GitHub provider
  support](./qube-github-provider-support.md).

Use the project or global installation commands above. Package placement and
configuration scope are separate in 0.2.12. `qube init` stores repository
settings in `.qube/init.json` by default. `qube init --config-scope global`
stores user defaults in `~/.qube/config.json`; repository values override them.
The [current development guide](#current-development-guide) documents newer
source commands and settings.

Preview repository setup, then apply it:

```sh
npm exec -- qube init --dry-run --json
npm exec -- qube init
```

With a global package, use `qube` instead of `npm exec -- qube`. With pnpm, use
`pnpm exec qube`. Select Codex, GitHub issues, GitHub checks, Primary-harness
subagents, and the QUBE Reviewer App. Read the plan before you confirm it. QUBE
can update `AGENTS.md`, add the Codex Make It So skill, and write repository
configuration. The plan lists the affected files.

[Generate and download an App private key](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps#generating-private-keys),
restrict the key file to your user account, and keep it outside the repository.
Replace the example IDs and path, then apply the released setup command and
check readiness:

```sh
npm exec -- qube review setup github-app --app-id 123456 --installation-id 789012 --private-key-path "$HOME/.config/qube/reviewer.pem" --yes
npm exec -- qube review doctor --json
```

Setup stores the App IDs and the key's path. Doctor succeeds
when it reports `ready`, no missing fields, repository access, and Pull requests
write permission for an identity separate from the pull request author.

Inspect and select the issue:

```sh
npm exec -- qube queue --json
npm exec -- qube start 123 --json
npm exec -- qube view 123 --json
```

`qube start` selects or resumes issue work. It does not edit product code.
`qube make-it-so --flow issue` also selects work; it does not implement it.

Open a fresh Codex chat in the initialized repository. Send this exact request:

```text
$make-it-so Complete issue 123, then stop.
```

Codex reads the repository instructions and starts the workflow. Subject to
repository policy, it can implement, check, review, merge, and close the issue.
The expected end state is a merged pull request and a closed issue. If the pull
request merged but completion stopped, run:

```sh
npm exec -- qube complete 123 --json
```

GitHub stores the issue, pull request, checks, and published reviews. Repository
work state stays under `.qube/`. Executor stores its policy in
`.qube/aie/config.json`.

<a id="daily-use"></a>

### Daily use

Inspect current work with:

```sh
npm exec -- qube view 123 --json
npm exec -- qube pr view <pr-number> --json
```

In this example, implementation and reviews use the signed-in Codex account
and its model allowance or charges. The GitHub App publishes review results;
it does not run the model. QUBE follows host trust, GitHub permissions, and
required checks. It stores credential references, not values. Code sent to a
model follows that account's privacy terms. GitHub records follow repository
visibility.

If initialization reports a GitHub authentication failure, repair the GitHub
CLI account and rerun initialization:

```sh
gh auth status --hostname github.com
gh auth login --hostname github.com
npm exec -- qube init
```

To stop safely, stop the Codex task or press Ctrl+C in the active terminal.
Leave state in place during writes. Open a new Codex chat and send the same Make
It So request to resume. For a setup or readiness failure, correct the reported
item and rerun `npm exec -- qube init` or `npm exec -- qube review doctor --json`
as applicable.

QUBE has no full automatic removal command. Use the removal command for your
package manager and installation scope:

| Installation | npm | pnpm |
| --- | --- | --- |
| Project | `npm uninstall --save-dev @tjalve/qube` | `pnpm remove --save-dev @tjalve/qube` |
| Global | `npm uninstall --global @tjalve/qube` | `pnpm remove --global @tjalve/qube` |

Use the init plan and Git diff to remove only QUBE-managed content. Preserve
unrelated files, hooks, configuration, and credentials. Remove credentials with
their own tools only when you intend to remove access.

## Current development guide

The remaining sections describe the current source checkout. They can include
changes that are not in QUBE 0.2.12. In a source checkout, replace `qube` in
the examples with `node products/qube/bin/run`. From another project, use
`node <absolute-path-to-QUBE-checkout>/products/qube/bin/run`. Plain `qube`
examples require a global installation of the current development version.

Package placement and configuration scope are independent. A project package
can write user-global settings, and a global package can initialize a
repository. Use one of these current development commands:

```sh
qube init --global
qube init
qube init <target>
qube init <target> --git-init
```

Global initialization reads and writes only user-global settings. It does not
require Git, inspect repository files, or run repository component setup.
Repository initialization uses the current directory when no target is given.
It inherits user-global settings. It stores only repository settings that have
a different value. It can also create or update repository integration assets
that the selected harness requires. These assets are not configuration copies.

QUBE resolves each independent setting in this order:

1. An explicit config path or supported command override.
2. A machine-local overlay.
3. A repository setting.
4. A user-global setting.
5. A detected value, when detection is supported for that setting.
6. The QUBE default.

QUBE applies dependency rules after it resolves the independent settings. It
reports the source of each effective value. A derived value also names the
setting that controls it.

Repository setup shows the user-global value, the stored repository value, the
effective value, its source, and the planned repository action. A complete
user-global setup does not require `.qube/init.json`. Repository initialization
can write effective product configuration, including inherited review policy,
when a product needs that configuration at runtime.
Use either of these commands to remove repository overrides:

```sh
qube init --inherit quality.stages
qube init --inherit-all
```

`--inherit` accepts a comma-separated field list and can be repeated by command
surfaces that preserve repeated options. `--inherit-all` removes all composer
repository settings. QUBE then recomputes effective values from the remaining
layers. A selection option and an inherit action for the same field conflict.
Inheritance actions are not valid with `qube init --global`.

When a repository target is not in Git, interactive setup asks whether to
initialize Git. Non-interactive mutation requires `--git-init`. A dry run
reports the Git action without creating `.git` or QUBE configuration. QUBE
does not create a commit, remote, hosted repository, account, or credential.

<a id="git-prerequisites"></a>

## Git prerequisites

`qube init --global` does not require Git. It does not run `git`, inspect a
repository, or read commit identity. Its repository prerequisite rows have the
`not-required` status.

Repository initialization requires Git 2.28.0 or newer and the commands that
QUBE uses, including `git init --initial-branch` and `git switch`. Install Git
from the official download page for
[Windows](https://git-scm.com/downloads/win),
[macOS](https://git-scm.com/downloads/mac), or
[Linux](https://git-scm.com/downloads/linux). QUBE reports the detected
platform and installation link. It never runs an operating-system package
manager or installer.

For an existing repository, run `qube init` from the checkout or pass its
directory. For a new project directory, use an interactive terminal or pass
`--git-init` in a non-interactive command:

```sh
qube init ./existing-project
qube init ./new-project --dry-run
qube init ./new-project --git-init
```

Git initialization creates only repository metadata and the `main` branch. It
does not create an initial commit or a remote. Local QUBE setup can complete in
an unborn or remote-less repository. The readiness summary keeps the issue,
review, completion, and shipping stages at `needs-action` until their Git
requirements are ready.

### Commit identity

Future commits need an effective author name and email. QUBE reads each value
with its Git configuration source: repository, user-global, system, or an
included configuration file. Structured output reports only presence and
source. It does not record the author name or email.

In an interactive repository setup, QUBE shows the identity state before the
ordinary setup choices. If a value is missing, QUBE recommends repository
scope. Repository scope changes only the selected repository. User-global
scope changes the default for all repositories used by the current operating-
system user. The choices are **This repository** and **All repositories**.
QUBE checks each value before the next question. If a value is invalid, correct
that value without restarting setup. QUBE asks for confirmation before it
writes Git configuration. It does not infer identity from a provider
account, operating-system account, package manifest, or QUBE setting.

Cancel a prompt to stop before QUBE applies pending setup changes. A dry run
does not write configuration or start credential repair. JSON mode never asks
questions. Complete arguments and `--yes` need no extra confirmation.

You can also configure identity directly. See the official
[first-time Git setup guide](https://git-scm.com/book/en/v2/Getting-Started-First-Time-Git-Setup).

```sh
git config --local user.name "Your Name"
git config --local user.email "you@example.com"

git config --global user.name "Your Name"
git config --global user.email "you@example.com"
```

### HEAD, branch, base, and working tree

QUBE reports these facts separately:

- Whether `HEAD` resolves to a commit or the repository is unborn.
- Whether the checkout uses a named branch or detached `HEAD`.
- Whether the checkout is primary or a linked worktree.
- Whether the working tree is clean or dirty.
- Whether the configured local base branch and remote-tracking base reference
  exist and are current when repository policy requires freshness.

Dirty files do not block QUBE configuration writes. They can block the start
of new issue or branch work when clean-primary-checkout policy applies. A
single active issue can still use its recovery path; the observation remains
dirty, while only the new-work policy is bypassed.

### Remote transport and provider connections

A Git remote is not required for local setup. Provider-backed issue and
shipping workflows normally require a remote. When a remote exists, QUBE uses
a bounded, read-only `git ls-remote` probe. The probe disables terminal and
credential-manager prompts, does not create or update refs, and does not test
push access. A successful probe proves read access only.

HTTPS transport can use an operating-system credential helper, a personal
access token, or OAuth. SSH transport uses SSH keys and host-key verification.
See the official [Git credential documentation](https://git-scm.com/docs/gitcredentials)
for credential-helper behavior. QUBE removes URL user information, passwords,
tokens, queries, fragments, and sensitive transport text from terminal output,
JSON, logs, and errors.

Git transport access is separate from a provider connection. For example,
`gh auth` controls GitHub API access for issues and pull requests. It does not
prove that Git can fetch or push a remote. QUBE never describes Git as logged
in, and a read-only Git probe never claims write permission.

### GitHub connection prerequisite

After repository provider choices resolve, QUBE shows a GitHub connection
section only when work, review, CI, setup-source, or a pending provider action
uses GitHub. The section reports the selected roles, derived host and
repository, CLI version, safe credential source, active account, capability
rows, stable reason code, and one next action. User-global and fully non-GitHub
initialization do not invoke `gh`.

Missing or invalid GitHub readiness does not undo safe local setup. Dependent
provider actions remain pending, and a later `qube init` resumes them without
rewriting unchanged files. Offline and dry-run paths do not spawn `gh`.

See the [GitHub provider support guide](./qube-github-provider-support.md) for
installation, account and host selection, environment-token precedence,
least-privilege permissions, Enterprise support, and reason-code recovery.

Run offline diagnostics when network access is unavailable:

```sh
qube doctor --offline --json
qube aie doctor --offline --json
```

Offline diagnostics run every local Git check. Only the network-dependent
remote transport row becomes `unverified`.

### Readiness statuses and recovery

| Status | Meaning |
| --- | --- |
| `ready` | The observed prerequisite is available for the listed stages. |
| `needs-action` | One next action is required before the listed stages can run. |
| `unverified` | QUBE did not make a trustworthy observation, usually because an offline run skipped the remote probe. |
| `not-required` | The selected scope or stage does not use this prerequisite. |

Rerun `qube init` after a prerequisite changes. QUBE reevaluates the pending
rows and does not rewrite unchanged setup.

### Stable reason codes

| Reason code | Recovery |
| --- | --- |
| `git-not-found` | Install Git from the official download page, then rerun initialization. |
| `git-unsupported` | Install Git 2.28.0 or newer with the required commands. |
| `not-a-repository` | Confirm interactive Git initialization or pass `--git-init`. |
| `repository-unreadable` | Repair repository metadata or directory permissions. |
| `identity-name-missing` | Configure `user.name` at repository or user-global scope. |
| `identity-email-missing` | Configure `user.email` at repository or user-global scope. |
| `head-missing` | Review the setup and create the initial commit. |
| `detached-head` | Switch to a named branch before starting issue work. |
| `linked-worktree` | Continue from the primary checkout when repository policy requires it. |
| `dirty-worktree` | Preserve local changes before starting new issue or branch work. |
| `base-ref-missing` | Create or fetch the configured base branch and remote-tracking ref. |
| `base-ref-stale` | Update the local base branch from the configured remote. |
| `remote-missing` | Add the configured remote when provider-backed work is required. |
| `remote-auth-failed` | Repair the selected HTTPS or SSH transport credential, permission, or host-key state. |
| `remote-unreachable` | Correct the remote URL, repository path, or network access. |
| `remote-unverified` | Rerun online when remote transport needs verification. |

Initialization checks required component and adapter packages before any
write. If a package is missing, QUBE reports its exact name and version, gives
one exact npm or pnpm command for the detected package placement, and tells you
to rerun `qube init`.

The guided flow has eight steps. Review details appear only when they apply.
QUBE keeps a valid effective answer unless you choose to review that setting.
The repository summary always gives an edit path, including when all values are
inherited. Before each edited question, QUBE shows the user-global, repository,
and effective values and names the effective source. It then explains the
choice, gives the recommendation and reason, and links to the applicable
section in this guide.

QUBE initializes the complete system. Bootstrap prepares planning. Executor
prepares issue work and review. Quality prepares checks. Umpire prepares
safe continuation. You do not select these products separately.

QUBE supplies repository instructions, trusted state, commands, and supported
continuation hooks. The selected agent harness decides what runs. It also
controls repository trust, account authentication, permissions, agent sessions,
and model access. QUBE cannot bypass these controls.

On a rerun, QUBE preselects a valid repository override. If no repository value
exists, it recommends the user-global value. QUBE asks only for a selected,
missing, or conflicting required value. A normalized no-change run performs no
configuration write.

Use `--yes` or `--defaults` to accept the same recommended values without
prompts. Use `--json` to get the resolved answers and the reason for each
answer. Add `--dry-run` to inspect the result without changing the repository.
If an action fails, QUBE names the action, keeps the original reason, and gives
the next action.

<a id="agent-harnesses"></a>

## 1. Agent harnesses

An agent harness runs the agent session. It supplies model access, task and
subagent features, trust controls, and permissions. QUBE adds the instructions,
commands, and hooks that the harness supports.

Recommended: select the harness that you will use for the next session. Select
another harness only when you plan to use it for work or review. This keeps the
setup small and makes each trust boundary clear.

QUBE shows only supported harness choices. Later choices also use the declared
capabilities of the selected harnesses. For example, QUBE does not offer
subagent review for a harness that cannot start subagents. See the
[agent harness capability matrix](./qube-host-surfaces.md#capability-matrix) for
the current support levels.

<a id="issue-tracker"></a>

## 2. Issue tracker

The issue tracker is the service that stores work items, priorities, status,
and discussion. Executor uses this service as the durable record of work.

Recommended: use the tracker that already owns the repository work. For a new
GitHub repository, use GitHub. This keeps issue state and pull request state in
one service.

QUBE shows its known issue trackers. Executor can select Jira and Linear for
read flows. Their issue writes and lifecycle changes remain manual. Use GitHub
for automatic issue lifecycle changes.

<a id="automated-checks-ci"></a>

## 3. Automated checks (CI)

Automated checks (CI) run required builds, tests, and policy checks. Executor
uses their results to decide whether work can move to review or merge.

Recommended: use the service that already runs the repository checks. QUBE
preselects it when one service is detected. If detection finds no service or
more than one service, QUBE asks for the service that controls required checks.

The checks service can differ from the issue tracker. QUBE shows its known CI
providers and marks unavailable workflow choices. The Jenkins adapter API can
read build evidence, but Jenkins setup is unavailable for Executor workflows.
Use GitHub or GitLab CI. QUBE does not infer a value when the repository is
ambiguous.

<a id="continuous-shipping"></a>

## 4. Continuous Shipping

Continuous Shipping lets Executor complete the authorized issue cycle. It can
prepare a branch, open a pull request, run required checks and review, merge
when policy permits, and continue with the next Ready issue.

Recommended: turn Continuous Shipping on when the selected issue tracker can
update the issue lifecycle. It keeps the full cycle consistent and prevents
finished work from stopping before required completion actions. QUBE selects
off when the tracker is read-only.

Continuous Shipping does not remove safety controls. Human approval, supply
chain approval, repository policy, required checks, and blocking review results
still stop the cycle when they apply. Turn it off when you want the harness to
stop after each issue for manual coordination.

<a id="umpire"></a>

## 5. Umpire

Umpire decides whether an idle agent session can safely continue. It uses
trusted QUBE state. It does not use untrusted issue or review text as authority.

Recommended: select **Ready issues only**. This lets Umpire finish current work
and start work that the issue tracker already marks Ready. It stops when no
Ready issue remains.

The scope choices are:

- **Ready issues only:** Continue current work and Ready issue work. Do not
  start post-queue tasks.
- **Standard post-queue work:** After the Ready queue is empty, continue with
  the standard repository quality and measured-performance tasks.
- **Custom set:** After the Ready queue is empty, use only the concrete Umpire
  tasks that the repository configures.

Umpire continuation also depends on the selected harness. The harness must
support the QUBE continuation method and trust the installed hook or command.
If the harness does not support continuation, QUBE records the scope but does
not claim that the harness can resume itself.

Cursor uses one project Stop hook in `.cursor/hooks.json`. QUBE preserves
unrelated hooks, limits the native follow-up loop, and requires Cursor to trust
the repository before the hook can run. QUBE does not change Cursor trust. Run
`qube aiu verify --tool cursor --model <model-id> --json` with an explicit model
after setup. Run the command in an interactive terminal with standard input and
standard error attached to TTYs. Verification tests the Cursor CLI project Stop
reprompt. It does not assert continuation support in Cursor desktop, cloud, or
headless mode.

<a id="quality-checks"></a>

## 6. Quality checks

Quality checks cover lint, format, type checks, unit tests, end-to-end tests,
source metrics, maintainability, coverage, and security. QUBE shows the current
Quality stage list during setup.

Recommended: select the single **unit** stage. A single stage is cumulative, so
this selection includes end-to-end tests, lint, format, type checks, and unit
tests. It gives a useful default without adding the slower later stages.

Selection has two exact rules:

- Select one stage to run that stage and every earlier stage.
- Select multiple stages to run only those stages.

For example, `unit` is cumulative. A multiple selection of `lint` and
`security` runs those two exact stages.

<a id="review"></a>

## 7. Review

Review checks the proposed change before merge. Choose the source by deciding
which account or service review work should use.

QUBE recommends the first available choice in this order:

1. Use another selected, installed harness when it supports separate review sessions.
   Review usage goes to the account used by that harness, and review runs outside the
   primary harness session.
2. Otherwise, use subagents in the primary harness when it supports them.
   Review usage goes to the primary harness account, subscription, or configured model account.
3. Otherwise, use an external review service. Review usage follows that
   service plan.

OpenCode and Claude Code support native host review. They cannot serve as the
isolated-review harness. QUBE marks unavailable review harness choices. An
external service controls its own model. A
harness-based review uses only models that the applicable harness can list
from the signed-in account.

<a id="review-publisher"></a>

## 8. Review publisher and model guidance

When the selected harness provides a live model catalog, QUBE offers only the
model IDs that the active review transport can execute with the same model,
reasoning effort, and speed. For example, native Windows Cursor review uses
ACP. QUBE omits a Cursor CLI model when ACP cannot preserve its exact
semantics. Native models appear first. QUBE sorts native models and other models
alphabetically within each group. This order does not compare price or quality.
Check the harness for current price and model details. Normal setup has no
free-text model field.
If the harness does not support model discovery, QUBE leaves Review unpinned.
If a supported catalog is blocked or unavailable, setup stops and gives the
next action.

<a id="review-backup-harness"></a>
<a id="review-backup-model"></a>
<a id="review-backup-effort"></a>

For isolated review, choose a **Backup reviewer** or **None**. QUBE offers only
eligible installed harnesses that differ from the main reviewer. An option
that uses the implementation harness says so before selection. It still runs
an isolated review, but uses the implementation harness's account.

An enabled backup requires a model and effort. Choose low, medium, or high
effort. Cursor uses the effort in its exact model ID and stores no separate
effort value. QUBE does not select a backup automatically.

Use `--review-backup-harness`, `--review-backup-model`, and
`--review-backup-effort` to supply these choices without questions. Omit the
effort flag for Cursor. Use `--review-backup-harness none` to disable the backup.
Global setup saves the choice for later repositories. A repository choice
overrides the global choice. Saved choices do not cause repeated questions.
Run `qube init` in an existing repository to apply a changed global backup.

For GitHub review publishing, QUBE can use the current GitHub account or the
QUBE Reviewer App.

Recommended: use the current GitHub account for the first setup. It uses the
existing authentication and needs no separate publisher credentials. When the
pull request author and publisher are the same account, GitHub does not record
the result as a separate formal approval.

Use the QUBE Reviewer App when review needs a separate identity. The App can
publish formal verdicts and inline comments when its installation has the
required access. An App approval does not always satisfy branch protection.
GitHub applies the repository rules and decides whether the approval counts.

`qube init` owns QUBE Reviewer App onboarding and publisher readiness. It stores
only safe credential references. External account creation, App installation,
repository access, and authentication remain pending when QUBE cannot verify
them. Complete the external action and rerun `qube init`; normal setup does not
require a separate QUBE setup or doctor command.

After successful setup, QUBE shows a compact answer summary and only the
follow-up commands that apply. It does not list generated files or internal
diagnostics. Start a new harness session so it loads the QUBE instructions.
Then use the harness-specific Make It So entry point:

| Agent harness | Make It So |
| --- | --- |
| OpenCode | `/make-it-so` |
| Codex | `$make-it-so` |
| Claude Code | `/make-it-so` |
| Grok Build | `/make-it-so` |
| Cursor | `/make-it-so` |
