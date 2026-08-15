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
