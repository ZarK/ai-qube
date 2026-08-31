import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { notRequiredGitPrerequisites } from "@tjalve/aie";

import {
  INIT_ACTION_LABELS,
  publicInitActionLabel,
  renderInitFailure,
  renderInitQuestion,
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
  it("renders prerequisites before choices from the same typed result", () => {
    const output = renderInitOutput({
      scope: "global",
      mode: "plan",
      changed: false,
      prerequisites: notRequiredGitPrerequisites(),
      answers,
    });

    assert.ok(output.indexOf("Prerequisites:") < output.indexOf("Choices:"));
    assert.match(output, /git: not-required/u);
    assert.match(output, /Required for: local-setup, issue-workflow/u);
  });

  it("shows every layer fact with a separate recommendation reason before an edited question", () => {
    const output = renderInitQuestion({
      step: 6,
      label: "Quality checks",
      explanation: "Choose the checks for this repository.",
      userGlobal: "—",
      repository: "—",
      effective: "Unit tests",
      source: "QUBE default",
      recommendation: "Unit tests",
      reason: "Use the cumulative baseline.",
      docsUrl: "https://example.test/qube-init#quality",
    });

    assert.match(output, /User-global: —/);
    assert.match(output, /Repository: —/);
    assert.match(output, /Effective: Unit tests/);
    assert.match(output, /Source: QUBE default/);
    assert.match(output, /Recommended: Unit tests/);
    assert.match(output, /Reason: Use the cumulative baseline\./);
    assert.match(output, /Documentation: https:\/\/example\.test\/qube-init#quality/);
  });

  it("confirms a plan with public answers and no apply instructions", () => {
    const output = renderInitOutput({
      scope: "repository",
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

    assert.match(output, /^Repository QUBE initialization plan is ready\./u);
    assert.match(output, /Mode: plan\./u);
    assert.match(output, /Persistent values changed: yes\./u);
    assert.match(output, /- Agent harnesses: Codex and OpenCode/u);
    assert.match(output, /Reason: Use the installed harnesses that support this workflow\./u);
    assert.match(output, /- Review source: Another installed harness/u);
    assert.match(output, /GitHub review publisher: not configured\./u);
    assert.doesNotMatch(output, /setup is complete|Start a new|\$make-it-so|qube review setup/u);
    assert.doesNotMatch(output, /hosts|review\.mode/u);
  });

  it("shows a changed apply, a new-session instruction, and applicable follow-ups", () => {
    const output = renderInitOutput({
      scope: "repository",
      mode: "apply",
      changed: true,
      answers,
      primaryHarness,
      pendingNextActions: [
        "Rerun `qube init` to continue Reviewer App setup.",
        "Rerun `qube init` to continue Reviewer App setup.",
        "  ",
      ],
      reviewPublisherReadiness: {
        state: "degraded",
        nextAction: "Run `qube review doctor --json` after you update the publisher.",
      },
    });

    assert.match(output, /^Repository QUBE initialization is complete\./u);
    assert.match(output, /Mode: apply\./u);
    assert.match(output, /Choices:\n- Agent harnesses: Codex and OpenCode/u);
    assert.match(output, /Start a new Codex session so it loads the setup\./u);
    assert.match(output, /In the new session, run `\$make-it-so`\./u);
    assert.match(output, /GitHub review publisher: needs attention\./u);
    assert.match(output, /Next actions:\n- Rerun `qube init` to continue Reviewer App setup\./u);
    assert.match(output, /- Run `qube review doctor --json` after you update the publisher\./u);
    assert.equal(output.match(/Rerun `qube init`/gu)?.length, 1);
  });

  it("keeps unchanged apply output concise", () => {
    const output = renderInitOutput({
      scope: "repository",
      mode: "apply",
      changed: false,
      answers,
      primaryHarness,
    });

    assert.equal(output, "Repository QUBE initialization is already current.\n");
  });

  it("does not add a follow-up for a ready review publisher", () => {
    const output = renderInitOutput({
      scope: "repository",
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
      scope: "repository",
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

  it("reports global scope without repository session instructions", () => {
    const output = renderInitOutput({
      scope: "global",
      mode: "apply",
      changed: true,
      answers,
      primaryHarness,
    });

    assert.match(output, /^Global QUBE initialization is complete\./u);
    assert.match(output, /Persistent values changed: yes\./u);
    assert.doesNotMatch(output, /Start a new|make-it-so/u);
  });

  it("renders a narrow source table and an edit path without color", () => {
    const output = renderInitOutput({
      scope: "repository",
      mode: "plan",
      changed: false,
      answers: [],
      configuration: {
        scope: "repository",
        action: "inherit",
        fields: [
          {
            id: "quality.stages",
            userGlobal: { present: true, value: ["unit", "build"] },
            repository: { present: true, value: ["unit"] },
            effective: { value: ["unit", "build"], source: "user-global" },
            planned: { repositoryAction: "remove", effectiveValue: ["unit", "build"], source: "user-global" },
          },
          {
            id: "review.harness",
            userGlobal: { present: false },
            repository: { present: false },
            effective: { value: "codex", source: "derived", derivedFrom: ["review.mode", "hosts"] },
            planned: { repositoryAction: "keep", effectiveValue: "codex", source: "derived", derivedFrom: ["review.mode", "hosts"] },
          },
        ],
      },
    });

    assert.match(output, /Setup scope: This repository/u);
    assert.match(output, /User-global setup: Found/u);
    assert.match(output, /Review or customize this repository/u);
    assert.match(output, /Inherit all user-global settings/u);
    assert.match(output, /Configuration action: inherit/u);
    assert.match(output, /- quality\.stages\n  User-global: unit, build\n  Repository: unit\n  Effective: unit, build\n  Source: user-global\n  Plan: remove/u);
    assert.match(output, /Source: derived from review\.mode, hosts/u);
    assert.doesNotMatch(output, /\u001b\[/u);
  });

  it("recommends completing repository setup when user-global fields are missing", () => {
    const output = renderInitOutput({
      scope: "repository",
      mode: "plan",
      changed: true,
      answers: [],
      configuration: {
        scope: "repository",
        action: "edit",
        fields: [{
          id: "quality.stages",
          userGlobal: { present: false },
          repository: { present: false },
          effective: { value: ["unit"], source: "repository" },
          planned: { repositoryAction: "add", effectiveValue: ["unit"], source: "repository" },
        }],
      },
    });

    assert.match(output, /Complete repository setup \(recommended\)/u);
    assert.doesNotMatch(output, /Use user-global setup \(recommended\)/u);
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
      git: "Git initialization",
      packages: "Package requirements",
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
