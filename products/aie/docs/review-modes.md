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
- `policy.reviews.localAgents` is empty. Isolated review uses `route` and `models`. Host mode writes the installed review hosts here.
- `policy.reviews.waitMinutes` is `0`. Isolated review does not wait for an external reviewer.
- `policy.reviews.route` points at the first installed host, tier `review`, `timeoutSeconds` `900`, `maxTurns` `16`.
- `policy.reviews.models.review` records the first live catalog model for each installed host that can list models. Setup does not embed model identifiers that can become obsolete.
- Setup leaves effort unset because the model catalog does not report effort support. You can select another listed model or an effort after init.
- `policy.reviews.failover` is written only when a second installed host also has a live model.
- `providers.review.publisher` stays `user` unless you pass a publisher flag. A user publisher that matches the pull request author cannot publish a formal GitHub review event. Isolated ship-ready uses lane evidence.
- Init asks whether to install attribution hygiene rules. The recommended answer is yes. `--yes` writes `policy.instructions.noCreditWarning` true. `--no-credit-warning` omits the block.

### Default lanes

The written `policy.reviews.lanes` list is:

- `issue-compliance`: `required` `always`, runner `local-host`, `rereview` `always-rerun`, carry-forward `all`. This lane asks whether the change satisfies the issue.
- `code-quality`: `required` `always`, runner `local-host`, `rereview` `delta`, carry-forward `scope`. This lane asks whether the code is sound.
- `performance`: `required` `when-matched`, runner `local-host`, `rereview` `delta`, carry-forward `scope`. Match: `**/*indexer*`, `**/*embed*`, `**/*retrieval*`, `**/*queue*`, `**/*cache*`, `**/*worker*`, `**/*stream*`, `**/*scheduler*`, `**/*virtual*`.
- `ui-ux-accessibility`: `required` `when-matched`, runner `local-host`, `rereview` `delta`, carry-forward `scope`. Match: `**/*.css`, `**/*.tsx`, `apps/**`, `design/**`.
- `security`: `required` `when-matched`, runner `local-host`, `rereview` `delta`, carry-forward `config`, explicit route to the default review host. Match: `**/auth/**`, `**/security/**`, `**/crypto/**`, `**/gateway/**`, `.github/**`, `.qube/**`, `package.json`, lockfiles, `**/*trust*`, `**/*token*`, `**/*auth*`.

### Convergence

- Advisory findings never block. Only `severityThreshold` `high` blockers stop merge.
- Reviews cap at two rounds unless a blocker fix changes the head. This rule lives in the managed instruction files that init writes.
- Merge when round two ends with green checks and no unresolved blockers. Residual advisories are fix-or-drop in the same pull request.

### Quality gate and UI audit

- Init records `policy.gates.definitions` from the repository `package.json` scripts `test`, then `verify`, then `check`, when one of those scripts exists. The command uses `pnpm`, `npm`, `yarn`, or `bun` from the lockfile, in the form `<manager> run <script>`.
- When `aiq` is available, `policy.gates.qualityControl` is `true` and init records one `kind: aiq` pre-PR gate: `qube aiq --up-to 2 --format json`. That command runs lint and format on the QUBE changed-file set. It does not call a repository-local helper script. Gate evidence is recorded under `.qube/aie/gates/`.
- When `aiq` is not available, `policy.gates.qualityControl` stays `false`.
- `policy.audit.manualUiAudit` is `true` only when the repository has user-facing UI and `agent-browser` is on PATH. The shipped static default is `false`.

### When no review path is configured

QUBE does not emulate another agent harness or generate a manual fallback reviewer. Native review requires one of the five supported harness profiles: Codex, Claude Code, OpenCode, Grok Build, or Cursor. External review requires a configured reviewer.

If neither path is configured, doctor and the review gate report review as unavailable. Configure a real harness or an external reviewer, then rerun init before you ship a pull request.
