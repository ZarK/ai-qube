# Guided `qube init`

Install QUBE with npm or pnpm before initialization. Use an exact version and
keep package lifecycle scripts disabled:

```sh
npm install --save-dev --save-exact --ignore-scripts @tjalve/qube@0.2.12
pnpm add --save-dev --save-exact --ignore-scripts @tjalve/qube@0.2.12
npm install --global --ignore-scripts @tjalve/qube@0.2.12
pnpm add --global --ignore-scripts @tjalve/qube@0.2.12
```

Package placement and configuration scope are independent. A project package
can write user-global settings, and a global package can initialize a
repository. After the `qube` command is available, use `qube init` for all
normal setup and resume work:

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
user-global setup does not require `.qube/init.json` or a copied product config.
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
prepares issue work and review. Quality Control prepares checks. Umpire prepares
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

QUBE lists the issue trackers that the installed QUBE version supports. The
later connection check reports whether the selected account is authenticated
and ready.

<a id="automated-checks-ci"></a>

## 3. Automated checks (CI)

Automated checks (CI) run required builds, tests, and policy checks. Executor
uses their results to decide whether work can move to review or merge.

Recommended: use the service that already runs the repository checks. QUBE
preselects it when one service is detected. If detection finds no service or
more than one service, QUBE asks for the service that controls required checks.

The checks service can differ from the issue tracker. QUBE lists the checks
providers that the installed QUBE version supports. It does not infer a value
when the repository is ambiguous.

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

<a id="quality-checks"></a>

## 6. Quality checks

Quality checks cover lint, format, type checks, unit tests, end-to-end tests,
source metrics, maintainability, coverage, and security. QUBE shows the current
Quality Control stage list during setup.

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

QUBE does not offer a review source that the selected harnesses cannot run. An
external service controls its own model. A harness-based review uses only
models that the applicable harness can list from the signed-in account.

<a id="review-publisher"></a>

## 8. Review publisher and model guidance

When the selected harness provides a live model catalog, QUBE offers only the
exact model IDs in that catalog. It recommends the first entry because the
catalog does not include comparable price or quality data. Check the harness
for current price and model details. Normal setup has no free-text model field.
If the harness does not support model discovery, QUBE leaves Review unpinned.
If a supported catalog is blocked or unavailable, setup stops and gives the
next action.

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
