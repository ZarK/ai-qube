import assert from "node:assert/strict";
import { test } from "node:test";

import {
  capability,
  createInitialPlanningState,
  renderGitHubIssueDraft,
  renderMarkdownWorkItemDraft
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
