import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { notRequiredGitPrerequisites } from "@tjalve/aie";

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
  it("omits healthy prerequisites from normal terminal output", () => {
    const output = renderInitOutput({
      scope: "global",
      mode: "plan",
      changed: false,
      prerequisites: notRequiredGitPrerequisites(),
      answers,
    });

    assert.match(output, /Choices:/u);
    assert.doesNotMatch(output, /Prerequisites:|git: not-required|Required for:|https?:\/\//u);
  });

  it("shows only the problem and next action for an unavailable prerequisite", () => {
    const baseline = notRequiredGitPrerequisites();
    const prerequisites = {
      ...baseline,
      status: "needs-action",
      checks: baseline.checks.map((check, index) => index === 0 ? {
        ...check,
        status: "needs-action",
        reasonCode: "git-not-found",
        summary: "Git is not installed.",
        nextAction: "Install Git, then run qube init again.",
        docsUrl: "https://example.test/git",
      } : check),
    };
    const output = renderInitOutput({ scope: "repository", mode: "apply", changed: false, prerequisites, answers: [] });

    assert.match(output, /^Repository QUBE initialization is complete\./u);
    assert.match(output, /Repository setup needs attention:\n- Git is not installed\.\n  Next: Install Git, then run qube init again\./u);
    assert.doesNotMatch(output, /git-not-found|Required for:|https?:\/\//u);
  });

  it("keeps later workflow prerequisites quiet for a fresh repository", () => {
    const baseline = notRequiredGitPrerequisites();
    const prerequisites = {
      ...baseline,
      status: "needs-action",
      checks: baseline.checks.map(check => check.id === "head" ? {
        ...check,
        status: "needs-action",
        reasonCode: "head-missing",
        summary: "The repository does not have a commit yet.",
        nextAction: "Create the first commit before issue work.",
      } : check),
    };
    const output = renderInitOutput({ scope: "repository", mode: "apply", changed: false, prerequisites, answers: [] });

    assert.equal(output, "Repository QUBE initialization is already current.\n");
    assert.doesNotMatch(output, /commit|head|needs attention/iu);
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
    assert.match(output, /- Agent harnesses: Codex and OpenCode/u);
    assert.match(output, /- Review source: Another installed harness/u);
    assert.match(output, /Review publisher: not configured\./u);
    assert.doesNotMatch(output, /setup is complete|Start a new|\$make-it-so|qube review setup/u);
    assert.doesNotMatch(output, /hosts|review\.mode|Mode:|Persistent values|Reason:/u);
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
    assert.match(output, /Choices:\n- Agent harnesses: Codex and OpenCode/u);
    assert.match(output, /Start a new Codex session so it loads the setup\./u);
    assert.match(output, /In the new session, run `\$make-it-so`\./u);
    assert.match(output, /Review publisher: needs attention\./u);
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

    assert.doesNotMatch(output, /Review publisher|Next actions|must not become/u);
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
    assert.doesNotMatch(output, /Persistent values|Start a new|make-it-so/u);
  });

  it("omits configuration layers and field plans from terminal output", () => {
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

    assert.equal(output, "Repository QUBE initialization plan is ready.\n");
    assert.doesNotMatch(output, /Setup scope|User-global|Repository overrides|Configuration|quality\.stages|review\.harness/u);
    assert.doesNotMatch(output, /\u001b\[/u);
  });

  it("does not print configuration recommendations when global fields are missing", () => {
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

    assert.equal(output, "Repository QUBE initialization plan is ready.\n");
    assert.doesNotMatch(output, /recommended|user-global|quality\.stages/iu);
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
