import assert from "node:assert/strict";
import { test } from "node:test";

import {
  capability,
  createInitialPlanningState,
  getProfileByKind,
  selectProjectProfile,
  renderGitHubIssueDraft,
  renderMarkdownWorkItemDraft,
  specChaptersForProject,
  workItemValidationForProject
} from "../dist/index.js";

const sampleDraft = {
  draftId: "draft-foundation",
  title: "Build neutral contracts",
  priority: "high",
  status: "ready",
  components: ["Architecture", "Data"],
  blockedBy: ["draft-package"],
  sequence: 2,
  bodySections: [
    {
      heading: "Summary",
      body: "Define canonical planning state and work item draft contracts."
    },
    {
      heading: "Acceptance Criteria",
      body: "- Contracts do not require provider IDs.\n- Renderers adapt provider details at the edge."
    }
  ]
};

test("initial planning state is provider and host neutral", () => {
  const state = createInitialPlanningState({ intent: "Bootstrap a research project" });
  assert.equal(state.version, 1);
  assert.equal(state.project.intent, "Bootstrap a research project");
  assert.deepEqual(state.providers, []);
  assert.deepEqual(state.agentHosts, []);
  assert.equal(state.nextAction.kind, "ask_human");

  const serialized = JSON.stringify(state);
  assert.doesNotMatch(serialized, /github/i);
  assert.doesNotMatch(serialized, /opencode/i);
});

test("capability reports represent policy-blocked operations", () => {
  assert.deepEqual(capability("policy-blocked", "offline project"), {
    status: "policy-blocked",
    reason: "offline project"
  });
});

test("markdown work item rendering does not require GitHub auth or IDs", () => {
  const rendered = renderMarkdownWorkItemDraft(sampleDraft, "planning/issues");
  assert.equal(rendered.path, "planning/issues/draft-foundation.md");
  assert.match(rendered.content, /^Blocked by: draft-package/m);
  assert.match(rendered.content, /# Build neutral contracts/);
  assert.doesNotMatch(rendered.content, /github/i);
  assert.doesNotMatch(rendered.content, /https:\/\/github\.com/i);
});

test("GitHub rendering adapts canonical drafts at the provider edge", () => {
  const rendered = renderGitHubIssueDraft({
    ...sampleDraft,
    providerMetadata: {
      github: {
        blockedBy: [1],
        url: "https://github.com/example/repo/issues/2"
      }
    }
  });
  assert.equal(rendered.title, sampleDraft.title);
  assert.deepEqual(rendered.blockedBy, [1]);
  assert.deepEqual(rendered.labels, ["P2-High", "S-Ready", "C-Architecture", "C-Data"]);
  assert.match(rendered.body, /^Blocked by: #1/m);
  assert.equal(rendered.url, "https://github.com/example/repo/issues/2");
});

test("research profile uses evidence validation instead of coding gates", () => {
  const profile = selectProjectProfile("research effort for competitive evidence");

  assert.equal(profile.kind, "research");
  assert.equal(profile.codingProject, false);
  assert.equal(profile.allowsRepositoryMutation, false);
  assert.ok(profile.specChapters.includes("Research or evidence plan"));
  assert.ok(profile.specChapters.includes("Method and source constraints"));
  assert.deepEqual(profile.workItemValidation, ["evidence", "review", "acceptance"]);
  assert.doesNotMatch(profile.workItemValidation.join(" "), /\b(tests|build)\b/);
});

test("documentation and process profiles omit coding-only sections by default", () => {
  const processProfile = selectProjectProfile("operations process playbook");
  const documentationChapters = specChaptersForProject("documentation content guide");
  const documentationValidation = workItemValidationForProject("documentation content guide");
  const processChapters = specChaptersForProject("operations process playbook");

  assert.ok(documentationChapters.includes("Documentation/content structure"));
  assert.ok(documentationChapters.includes("Review and publication plan"));
  assert.ok(!documentationChapters.includes("Command surface"));
  assert.ok(!documentationChapters.includes("Package and release constraints"));
  assert.doesNotMatch(documentationValidation.join(" "), /\b(tests|build|selectors|schemas|package commands)\b/);

  assert.ok(processChapters.includes("Operations and support"));
  assert.ok(processChapters.includes("Process roles and handoffs"));
  assert.equal(processProfile.kind, "process");
});

test("coding profiles keep implementation validation where it belongs", () => {
  const cliProfile = selectProjectProfile("CLI package for agent tooling");
  const localAiProfile = selectProjectProfile("local AI model planner");

  assert.equal(cliProfile.kind, "cli_package");
  assert.equal(cliProfile.codingProject, true);
  assert.equal(cliProfile.allowsRepositoryMutation, true);
  assert.ok(cliProfile.specChapters.includes("Command surface"));
  assert.deepEqual(cliProfile.workItemValidation, ["tests", "build", "review", "acceptance"]);

  assert.equal(localAiProfile.kind, "local_ai");
  assert.equal(localAiProfile.codingProject, true);
  assert.ok(localAiProfile.specChapters.includes("AI/model behavior"));
});

test("export-only projects support markdown deliverables without repository mutation", () => {
  const profile = selectProjectProfile("markdown-only export with no repo mutation");

  assert.equal(profile.kind, "export_only");
  assert.equal(profile.codingProject, false);
  assert.equal(profile.allowsRepositoryMutation, false);
  assert.ok(profile.specChapters.includes("Export and handoff constraints"));
  assert.ok(profile.milestoneDeliverables.includes("markdown export"));
  assert.deepEqual(profile.workItemValidation, ["review", "acceptance"]);
});

test("unknown profile is returned for unrecognized or empty input", () => {
  assert.equal(selectProjectProfile(undefined).kind, "unknown");
  assert.equal(selectProjectProfile("").kind, "unknown");
  assert.equal(selectProjectProfile("some unrecognized shape xyz").kind, "unknown");
  assert.equal(selectProjectProfile(undefined).allowsRepositoryMutation, false);
});

test("design profile omits coding gates and keeps design chapters", () => {
  const profile = selectProjectProfile("ux design prototype wireframe");

  assert.equal(profile.kind, "design");
  assert.equal(profile.codingProject, false);
  assert.equal(profile.allowsRepositoryMutation, false);
  assert.ok(profile.specChapters.includes("Design review plan"));
  assert.doesNotMatch(profile.workItemValidation.join(" "), /\b(tests|build)\b/);
});

test("profile selection avoids broad false positives", () => {
  assert.equal(selectProjectProfile("domain model documentation").kind, "documentation");
  assert.equal(selectProjectProfile("rag report").kind, "unknown");
  assert.equal(selectProjectProfile("brief API project spec").kind, "coding");
  assert.equal(selectProjectProfile("stakeholder analysis for a web app").kind, "coding");
});

test("profile accessors do not expose shared mutable profile state", () => {
  const profile = selectProjectProfile("research effort");
  assert.throws(() => profile.specChapters.push("Mutated chapter"), TypeError);

  const nextProfile = selectProjectProfile("research effort");
  assert.ok(!nextProfile.specChapters.includes("Mutated chapter"));
  assert.equal(getProfileByKind("research").kind, "research");
});
