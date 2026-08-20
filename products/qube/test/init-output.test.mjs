import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  INIT_ACTION_LABELS,
  publicInitActionLabel,
  renderInitFailure,
  renderInitOutput,
} from "../dist/init_output.js";

const answers = Object.freeze([
  Object.freeze({
    id: "hosts",
    label: "Agent harnesses",
    value: "Codex and OpenCode",
    reason: "Use the installed harnesses that support this workflow.",
  }),
  Object.freeze({
    id: "review.mode",
    label: "Review source",
    value: "Another installed harness",
    reason: "Use an independent harness for a separate review context.",
  }),
]);

const primaryHarness = Object.freeze({
  displayName: "Codex",
  makeItSo: "$make-it-so",
});

describe("public QUBE init output", () => {
  it("confirms a plan with public answers and no apply instructions", () => {
    const output = renderInitOutput({
      mode: "plan",
      changed: true,
      answers,
      primaryHarness,
      postInitCommands: ["qube review setup github-app"],
      reviewPublisherReadiness: {
        state: "unconfigured",
        nextAction: "Set up the GitHub review publisher.",
      },
    });

    assert.match(output, /^QUBE setup plan is ready\./u);
    assert.match(output, /- Agent harnesses: Codex and OpenCode/u);
    assert.match(output, /Reason: Use the installed harnesses that support this workflow\./u);
    assert.match(output, /- Review source: Another installed harness/u);
    assert.match(output, /GitHub review publisher: not configured\./u);
    assert.doesNotMatch(output, /setup is complete|Start a new|\$make-it-so|qube review setup/u);
    assert.doesNotMatch(output, /hosts|review\.mode/u);
  });

  it("shows a changed apply, a new-session instruction, and applicable follow-ups", () => {
    const output = renderInitOutput({
      mode: "apply",
      changed: true,
      answers,
      primaryHarness,
      postInitCommands: [
        "qube review setup github-app",
        "qube review setup github-app",
        "  ",
      ],
      reviewPublisherReadiness: {
        state: "degraded",
        nextAction: "Run `qube review doctor --json` after you update the publisher.",
      },
    });

    assert.match(output, /^QUBE setup is complete\./u);
    assert.match(output, /Choices:\n- Agent harnesses: Codex and OpenCode/u);
    assert.match(output, /Start a new Codex session so it loads the setup\./u);
    assert.match(output, /In the new session, run `\$make-it-so`\./u);
    assert.match(output, /GitHub review publisher: needs attention\./u);
    assert.match(output, /Next actions:\n- Run `qube review setup github-app`\./u);
    assert.match(output, /- Run `qube review doctor --json` after you update the publisher\./u);
    assert.equal(output.match(/qube review setup github-app/gu)?.length, 1);
  });

  it("emits one quiet line for an unchanged apply", () => {
    const output = renderInitOutput({
      mode: "apply",
      changed: false,
      answers,
      primaryHarness,
      postInitCommands: ["qube review setup github-app"],
      reviewPublisherReadiness: {
        state: "unavailable",
        nextAction: "Run the review doctor.",
      },
    });

    assert.equal(output, "QUBE setup is already current.\n");
  });

  it("does not add a follow-up for a ready review publisher", () => {
    const output = renderInitOutput({
      mode: "apply",
      changed: true,
      answers,
      primaryHarness,
      reviewPublisherReadiness: {
        state: "ready",
        nextAction: "This text must not become a follow-up.",
      },
    });

    assert.match(output, /GitHub review publisher: ready\./u);
    assert.doesNotMatch(output, /Next actions|must not become/u);
  });

  it("does not expose implementation details from normalized answer IDs", () => {
    const output = renderInitOutput({
      mode: "apply",
      changed: true,
      answers: [
        { id: "component-aie", label: "Issue tracker", value: "GitHub", reason: "Use the repository provider." },
      ],
      primaryHarness,
    });

    for (const internalTerm of [
      "component-aie",
      "host surface",
      "notes target",
      "model routing",
      "review tier",
      "Generic terminal",
      ".qube/init.json",
    ]) {
      assert.doesNotMatch(output, new RegExp(internalTerm, "iu"));
    }
  });
});

describe("public QUBE init failures", () => {
  it("maps each setup action to its public label", () => {
    assert.deepEqual(INIT_ACTION_LABELS, {
      aie: "Agent harness and Review setup",
      aib: "Project planning setup",
      aiq: "Quality checks setup",
      aiu: "Umpire setup",
      labels: "Issue tracker labels",
      config: "Repository setup choices",
    });
  });

  it("renders the public action with the exact reason and next action", () => {
    for (const [actionId, label] of Object.entries(INIT_ACTION_LABELS)) {
      const reason = `The ${label} command exited with code 17.`;
      const nextAction = `Fix ${label}, then run qube init again.`;
      const output = renderInitFailure({ actionId, reason, nextAction });

      assert.equal(output, `Action: ${label}\nReason: ${reason}\nNext action: ${nextAction}\n`);
      assert.doesNotMatch(output, new RegExp(`Action: ${actionId}(?:\\n|$)`, "u"));
    }
  });

  it("uses a public fallback for an unknown failed action", () => {
    assert.equal(publicInitActionLabel("internal-child"), "QUBE setup");
    assert.equal(
      renderInitFailure({
        actionId: "internal-child",
        reason: "The command failed.",
        nextAction: "Correct the error, then run qube init again.",
      }),
      "Action: QUBE setup\nReason: The command failed.\nNext action: Correct the error, then run qube init again.\n",
    );
  });
});
