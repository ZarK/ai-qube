import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { loadRiskCardCatalog } from "@tjalve/aie";
import { createWorkItemDrafts, renderWorkItemDrafts } from "../dist/work_items.js";
import { lintWorkItemDrafts, WorkItemLintError } from "../dist/work_item_lint.js";
import { renderGitHubIssueDraft, renderMarkdownWorkItemDraft } from "../dist/renderers.js";

function milestoneFixture(overrides = {}) {
  return {
    id: "milestone-01-generation",
    title: "Work item generation",
    path: "docs/milestones/milestone-01-generation.md",
    summary: "Generate issue-specific work item bodies.",
    boundaries: ["No provider mutation changes.", "No new commands."],
    dependencies: [],
    proofOfCompletion: [],
    acceptanceCriteria: [
      "Allocation assigns each criterion to the owning slice and renders checkboxes.",
      "Linting rejects vague statements with stable diagnostic codes.",
      "Guidance sections render implementer faces from triggered risk cards.",
      "Guidance output stays deterministic across runs."
    ],
    likelyWorkItemThemes: ["criterion allocation", "draft linting", "risk guidance"],
    technicalDecisions: ["Allocation scoring uses word boundaries.", "Linting runs before render."],
    specAnchors: ["spec.md#work-items"],
    ...overrides
  };
}

function stateFixture(milestone, baseDir) {
  mkdirSync(join(baseDir, "docs", "milestones"), { recursive: true });
  writeFileSync(join(baseDir, milestone.path), `# ${milestone.title}\n`);
  return {
    project: { shape: "cli" },
    artifacts: { spec: { path: "docs/spec.md", status: "ready" }, milestones: [], workItems: [] },
    planning: { milestoneDrafts: [milestone], workItemDrafts: [] }
  };
}

function sectionBody(draft, heading) {
  return draft.bodySections.find((section) => section.heading === heading)?.body ?? null;
}

describe("work item generation", () => {
  it("allocates criteria to owning slices with non-identical checkbox sets", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "aib-work-items-"));
    const milestone = milestoneFixture();
    const result = createWorkItemDrafts(stateFixture(milestone, baseDir), undefined, baseDir);

    assert.equal(result.drafts.length, 3);
    const criteriaSets = result.drafts.map((draft) => sectionBody(draft, "Acceptance criteria"));
    assert.notEqual(criteriaSets[0], criteriaSets[1]);
    assert.notEqual(criteriaSets[1], criteriaSets[2]);
    for (const set of criteriaSets) {
      assert.match(set, /^- \[ \] /mu);
      assert.match(set, /\(verify: (?:unit|integration|manual observation|artifact review)/u);
    }
    const allRendered = criteriaSets.join("\n");
    for (const criterion of milestone.acceptanceCriteria) {
      assert.ok(allRendered.includes(criterion), `criterion not allocated: ${criterion}`);
    }
  });

  it("marks tied criteria shared with a stated reason", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "aib-work-items-"));
    const milestone = milestoneFixture({
      acceptanceCriteria: [
        "Allocation assigns each criterion to the owning slice and renders checkboxes.",
        "Linting rejects vague statements with stable diagnostic codes.",
        "Allocation and linting share one diagnostics format."
      ],
      likelyWorkItemThemes: ["criterion allocation", "draft linting"]
    });
    const result = createWorkItemDrafts(stateFixture(milestone, baseDir), undefined, baseDir);
    const bodies = result.drafts.map((draft) => sectionBody(draft, "Acceptance criteria"));
    for (const body of bodies) {
      assert.match(body, /Allocation and linting share one diagnostics format\. \(verify: unit; shared with [^:]+: names behavior spanning the criterion allocation and draft linting slices\)/u);
    }
  });

  it("renders slice-specific summary and scope, no placeholder tests, no boundary copy", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "aib-work-items-"));
    const milestone = milestoneFixture();
    const result = createWorkItemDrafts(stateFixture(milestone, baseDir), undefined, baseDir);

    for (const draft of result.drafts) {
      const summary = sectionBody(draft, "Summary");
      assert.doesNotMatch(summary, /work for milestone/u);
      assert.match(summary, /Deliver the .+ slice of Work item generation/u);
      assert.match(summary, /separate/u);
      const scope = sectionBody(draft, "Scope");
      assert.ok(!scope.includes("No provider mutation changes."), "scope copied milestone boundaries");
      assert.equal(sectionBody(draft, "Named E2E tests"), null);
      const rendered = renderMarkdownWorkItemDraft(draft).content;
      assert.doesNotMatch(rendered, /e2e:/u);
      assert.match(renderGitHubIssueDraft(draft).body, /- \[ \] /u);
    }
  });

  it("omits the guidance section when no cards trigger and renders implementer faces when they do", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "aib-work-items-"));
    const quiet = createWorkItemDrafts(stateFixture(milestoneFixture(), baseDir), undefined, baseDir);
    for (const draft of quiet.drafts) {
      assert.equal(sectionBody(draft, "Implementation guidance"), null);
      assert.ok(!renderMarkdownWorkItemDraft(draft).content.includes("Implementation guidance"));
    }

    const triggerDir = mkdtempSync(join(tmpdir(), "aib-work-items-"));
    const triggering = milestoneFixture({
      id: "milestone-02-parsing",
      path: "docs/milestones/milestone-02-parsing.md",
      title: "Payload parsing",
      acceptanceCriteria: [
        "Malformed json payloads are rejected loudly with an error message.",
        "Every parse result reports an explicit status instead of a silent fallback."
      ],
      likelyWorkItemThemes: ["payload parsing"]
    });
    const triggered = createWorkItemDrafts(stateFixture(triggering, triggerDir), undefined, triggerDir);
    const guidance = sectionBody(triggered.drafts[0], "Implementation guidance");
    assert.ok(guidance, "expected triggered guidance section");
    assert.match(guidance, /- serialization-encoding: /u);
    assert.ok(guidance.split("\n").filter((line) => line.startsWith("- ")).length <= 5, "guidance exceeded shared cap");
    const serializationCard = loadRiskCardCatalog().find((card) => card.id === "serialization-encoding");
    assert.ok(guidance.includes(serializationCard.implementerFace.trim()), "implementer face missing from guidance");
    assert.ok(!guidance.includes(serializationCard.reviewerFace.trim().slice(0, 40)), "reviewer-face text leaked");
  });

  it("diagnoses defaulted allocation with siblings and allows it for a single slice", () => {
    const multiDir = mkdtempSync(join(tmpdir(), "aib-work-items-"));
    const multiTheme = milestoneFixture({
      acceptanceCriteria: [
        "Allocation assigns each criterion to the owning slice and renders checkboxes.",
        "Linting rejects vague statements with stable diagnostic codes.",
        "Everything stays reproducible without further wording."
      ],
      likelyWorkItemThemes: ["criterion allocation", "draft linting"]
    });
    assert.throws(
      () => createWorkItemDrafts(stateFixture(multiTheme, multiDir), undefined, multiDir),
      (error) => error instanceof WorkItemLintError && error.diagnostics.some((entry) => entry.code === "work-item-unallocated-criterion")
    );

    const singleDir = mkdtempSync(join(tmpdir(), "aib-work-items-"));
    const singleTheme = milestoneFixture({
      id: "milestone-03-single",
      path: "docs/milestones/milestone-03-single.md",
      acceptanceCriteria: ["Everything stays reproducible without further wording."],
      likelyWorkItemThemes: ["handoff wrap-up"]
    });
    const single = createWorkItemDrafts(stateFixture(singleTheme, singleDir), undefined, singleDir);
    assert.equal(single.drafts.length, 1);
    assert.match(sectionBody(single.drafts[0], "Acceptance criteria"), /allocation defaulted: no theme matched/u);
  });

  it("is deterministic across runs", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "aib-work-items-"));
    const milestone = milestoneFixture();
    const state = stateFixture(milestone, baseDir);
    const first = createWorkItemDrafts(state, undefined, baseDir);
    const second = createWorkItemDrafts(state, undefined, baseDir);
    assert.deepEqual(first.drafts, second.drafts);
  });
});

describe("work item lint", () => {
  function draftWith(criteriaBody, overrides = {}) {
    return {
      draftId: "milestone-01-work-01-slice",
      title: "Milestone: Slice",
      priority: "high",
      status: "ready",
      components: ["aib"],
      sequence: 101,
      bodySections: [
        { heading: "Summary", body: "Deliver the slice." },
        { heading: "Acceptance criteria", body: criteriaBody }
      ],
      ...overrides
    };
  }

  it("fails with stable diagnostic codes for empty, duplicate, vague, unverified, and unexplained-shared cases", () => {
    const empty = lintWorkItemDrafts([draftWith("")]);
    assert.ok(empty.some((entry) => entry.code === "work-item-empty-criteria"));

    const duplicates = lintWorkItemDrafts([
      draftWith("- [ ] Same observable outcome renders. (verify: unit)"),
      draftWith("- [ ] Same observable outcome renders. (verify: unit)", { draftId: "milestone-01-work-02-other", sequence: 102 })
    ]);
    assert.ok(duplicates.some((entry) => entry.code === "work-item-duplicate-criteria"));

    const vague = lintWorkItemDrafts([draftWith("- [ ] Handles errors correctly. (verify: unit)")]);
    assert.ok(vague.some((entry) => entry.code === "work-item-vague-criterion"));

    const unverified = lintWorkItemDrafts([draftWith("- [ ] Renders the slice body.")]);
    assert.ok(unverified.some((entry) => entry.code === "work-item-missing-verification"));

    const unexplainedShared = lintWorkItemDrafts([draftWith("- [ ] Renders the slice body. (verify: unit; shared with linting slice)")]);
    assert.ok(unexplainedShared.some((entry) => entry.code === "work-item-shared-without-reason"));
  });

  it("passes a valid boundary fixture and surfaces codes in the thrown error message", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "aib-work-items-"));
    const generated = createWorkItemDrafts(stateFixture(milestoneFixture(), baseDir), undefined, baseDir);
    assert.deepEqual(lintWorkItemDrafts(generated.drafts), []);

    const state = {
      ...stateFixture(milestoneFixture(), baseDir),
      planning: { milestoneDrafts: [], workItemDrafts: [draftWith("- [ ] Handles errors correctly. (verify: unit)")] }
    };
    await assert.rejects(
      () => renderWorkItemDrafts(state, "markdown"),
      (error) => error instanceof WorkItemLintError && error.message.includes("work-item-vague-criterion")
    );
  });
});
