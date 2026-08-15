# Review modes

Executor can review a pull request in three modes. One field selects the mode: `policy.reviews.mode`.

The adapter, lane runners, and `route` blocks remain details of the selected mode. They do not replace the mode field.

## external

An external review service reviews the pull request on its own servers. Examples include CodeRabbit and other provider bots.

Executor requests the review, waits for provider feedback, and reads that feedback back. Executor does not start model CLIs for review lanes.

Choose this mode when a review service already covers the repository.

## host

The coding agent runs the reviews. Executor renders one prompt per review lane. The host agent starts one fresh subagent per lane. Each subagent writes lane evidence and publishes its review.

Executor does not start isolated model CLIs in this mode.

Choose this mode when the host can spawn independent review subagents and you want those subagents to own the lane work.

## isolated

Executor runs the reviews. The gate starts a model CLI per lane in a fresh read-only session. It validates each answer against the evidence contract and publishes the review.

Choose this mode when you want Executor to run the lane batch itself, including failover to a second host.

## See the active mode

`aie doctor` prints one review-mode line. The line includes:

- the active mode and whether it is configured or inferred
- resolved reviewers and models
- the publisher identity
- the installed instruction tool version next to the running tool version

If the managed instruction stamp is older than the running tool, doctor names `aie init . --force`.

When `policy.reviews.mode` is omitted, Executor infers the mode:

- a global or lane `route` selects `isolated`
- a local, mixed, or shadow adapter without a route selects `host`
- otherwise the mode is `external`

## Fresh setup defaults

Plain `aie init . --yes` writes these values. `--defaults --yes` writes the same recommended values. The schema fallback is replaced by this setup at write time. A maintainer can read every shipped default from this page.

### Isolated setup when a review host is installed

- `policy.reviews.mode` is `isolated`. Isolated is the Executor-run mode.
- `policy.reviews.adapter` is `local`. The local adapter lets the gate run lanes and reach ship-ready from lane evidence.
- `policy.reviews.profile` is `local-focused`.
- `policy.reviews.severityThreshold` is `high`. Advisory findings never block merge.
- `policy.reviews.agents` is empty. Isolated review does not request an external review service.
- `policy.reviews.localAgents` lists the review hosts installed on this machine.
- `policy.reviews.waitMinutes` is `0`. Isolated review does not wait for an external reviewer.
- `policy.reviews.route` points at the first installed host, tier `review`, `timeoutSeconds` `900`, `maxTurns` `16`.
- `policy.reviews.models.review` records a live catalog model for each installed host that can list models. Setup validates the model before write.
- `policy.reviews.failover` is written only when a second installed host also has a live model.
- `providers.review.publisher` stays `user` unless you pass a publisher flag. A user publisher that matches the pull request author cannot publish a formal GitHub review event. Isolated ship-ready uses lane evidence.

### Default lanes

The written `policy.reviews.lanes` list is:

- `issue-compliance`: `required` `always`, runner `local-host`, `rereview` `always-rerun`. This lane asks whether the change satisfies the issue.
- `code-quality`: `required` `always`, runner `local-host`, `rereview` `delta`. This lane asks whether the code is sound.
- `security`: `required` `when-matched`, runner `local-host`, `rereview` `delta`. This lane wakes only when dependency, workflow, or auth-adjacent files change.

Security `match` patterns are: `package.json`, `**/package.json`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`, `bun.lock`, `.github/**`, `**/*auth*`, `**/*token*`, `**/*secret*`.

### Convergence

- Advisory findings never block. Only `severityThreshold` `high` blockers stop merge.
- Reviews cap at two rounds unless a blocker fix changes the head. This rule lives in the managed instruction files that init writes.
- Merge when round two ends with green checks and no unresolved blockers. Residual advisories are fix-or-drop in the same pull request.

### Quality gate and UI audit

- Init records `policy.gates.definitions` from the repository `package.json` scripts `test`, then `verify`, then `check`, when one of those scripts exists. The command uses `pnpm`, `npm`, `yarn`, or `bun` from the lockfile, in the form `<manager> run <script>`.
- `policy.gates.qualityControl` stays `false` unless you turn Quality Control on and `aiq` is available.
- `policy.audit.manualUiAudit` is `true` only when the repository has user-facing UI and `agent-browser` is on PATH. The shipped static default is `false`.

### Fallback when no review host is installed

Isolated is not available. Init writes:

- `policy.reviews.mode` `external`
- `policy.reviews.adapter` `github`
- `policy.reviews.profile` `remote-compatible`
- empty `policy.reviews.agents` and empty `policy.reviews.lanes`

Doctor on this fallback reports no setup warnings. The first pull request does not get an isolated review until a host is installed and you rerun init.
