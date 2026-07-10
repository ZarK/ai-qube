import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  defineAdapterHarness,
  defineCiProviderHarness,
  defineReviewForgeHarness,
  defineWorkProviderHarness,
} from "@tjalve/qube-testkit";
import {
  assertGitHubOperationSupported,
  createGitHubReviewForgeProvider,
  createGitHubWorkProvider,
  githubAdapter,
  mapGitHubCheckStatus,
  probeGitHubConnection,
} from "../dist/index.js";

const workItems = readFixture("./fixtures/conformance-work-items.json");
const reviewFixture = readFixture("./fixtures/conformance-review.json");
const checkFixture = readFixture("./fixtures/conformance-checks.json");
const connectionFixture = readFixture("./fixtures/connection-pass.json");

const statusPolicy = {
  labels: {
    priorities: ["P1-Critical", "P2-High", "P3-Medium", "P4-Low"].map(name => ({ name })),
    statuses: ["S-Ready", "S-InProgress", "S-Blocked", "S-Blocking"].map(name => ({ name })),
  },
  milestoneOrdering: { enabled: false, order: [], missingAssignment: "warn" },
};

const work = defineWorkProviderHarness({
  fixtureFiles: ["fixtures/conformance-work-items.json"],
  createFixtureTransport: () => fixtureExec(workItems),
  createSubject: exec => createGitHubWorkProvider({ exec, includeAssignees: true }),
  capabilityCases: [
    {
      capabilityId: "map-work-item",
      name: "maps fixture issues into provider-neutral work items",
      run: async provider => {
        const [item] = await provider.listOpenWorkItems();
        assert.deepEqual(item.key, { providerId: "github", id: "42" });
        assert.deepEqual(item.checklist, { total: 1, completed: 1 });
      },
    },
    {
      capabilityId: "work-item-queue",
      name: "loads the fixture issue queue",
      run: async provider => {
        const items = await provider.listOpenWorkItems();
        assert.equal(items.length, 1);
        assert.equal(items[0].title, "Fixture issue");
      },
    },
    {
      capabilityId: "sync-issue-status",
      name: "plans lifecycle status from fixture work",
      run: async provider => {
        const items = await provider.listOpenWorkItems();
        const plan = provider.planStatusSync(items, statusPolicy);
        assert.equal(plan.actions.length, 1);
        assert.deepEqual(plan.actions[0].details.addLabels, ["S-Ready"]);
      },
    },
  ],
});

const review = defineReviewForgeHarness({
  fixtureFiles: ["fixtures/conformance-review.json"],
  createFixtureTransport: () => reviewExec(reviewFixture),
  createSubject: exec => createGitHubReviewForgeProvider({ exec }),
  capabilityCases: [
    {
      capabilityId: "load-pull-request",
      name: "loads fixture pull request state",
      run: async provider => {
        const item = await provider.findReviewForCurrentBranch();
        assert.deepEqual(item.key, { providerId: "github", id: "12" });
        assert.equal(item.title, "Fixture pull request");
      },
    },
    {
      capabilityId: "request-review-gate",
      name: "plans a provider-visible review request",
      run: async provider => {
        const item = await provider.findReviewForCurrentBranch();
        const plan = provider.planReviewRequest(item, { adapter: "github", reviewers: ["@copilot"], requestText: "" });
        assert.equal(plan.actions.length, 1);
        assert.equal(plan.actions[0].kind, "request-review");
      },
    },
    {
      capabilityId: "read-merge-blockers",
      name: "normalizes fixture mergeability and required review blockers",
      run: async provider => {
        const item = await provider.findReviewForCurrentBranch();
        assert.equal(item.mergeability, "mergeable");
        assert.deepEqual(item.mergeBlockers.map(blocker => blocker.reason), ["review-required"]);
      },
    },
    {
      capabilityId: "read-review-threads",
      name: "keeps absent fixture conversations explicit",
      run: async provider => {
        const item = await provider.findReviewForCurrentBranch();
        assert.deepEqual(item.conversations, []);
      },
    },
    {
      capabilityId: "resolve-review-threads",
      name: "declares review-thread resolution",
      run: provider => assert.equal(typeof provider.resolveReviewThreads, "function"),
    },
    {
      capabilityId: "approve-pull-request",
      name: "rejects fabricated provider approval",
      run: () => assertGitHubOperationSupported("approve-pull-request"),
    },
  ],
});

const ci = defineCiProviderHarness({
  fixtureFiles: ["fixtures/conformance-checks.json"],
  createFixtureTransport: () => checkFixture,
  createSubject: fixture => ({ fixture, mapCheck: mapGitHubCheckStatus }),
  capabilityCases: [
    {
      capabilityId: "read-ci-status",
      name: "maps successful current-head checks",
      run: provider => assert.equal(provider.mapCheck(provider.fixture.passed).result, "passed"),
    },
    {
      capabilityId: "diagnose-ci-status",
      name: "distinguishes failed and pending checks",
      run: provider => {
        assert.equal(provider.mapCheck(provider.fixture.failed).result, "failed");
        assert.equal(provider.mapCheck(provider.fixture.pending).result, "pending");
      },
    },
    {
      capabilityId: "run-aiq-github-action",
      name: "keeps standalone CI integration explicit",
      run: () => assert.equal(assertGitHubOperationSupported("run-aiq-github-action").support, "standalone"),
    },
    {
      capabilityId: "trigger-workflow-run",
      name: "rejects unsupported workflow mutation",
      run: () => assertGitHubOperationSupported("trigger-workflow-run"),
    },
  ],
});

export const githubHarness = defineAdapterHarness({
  adapter: githubAdapter,
  roles: {
    work,
    review,
    ci,
    connection: {
      fixtureFile: "fixtures/connection-pass.json",
      fixture: connectionFixture,
      contract: githubAdapter.connection,
      probe: probeGitHubConnection,
      live: { envVar: "QUBE_LIVE_PROBES" },
    },
  },
  ignoredCapabilities: [
    { id: "render-work-items", reason: "AIB owns provider draft rendering outside the runtime adapter roles." },
    { id: "mutate-repository-files", reason: "The repository provider owns filesystem mutation." },
    { id: "publish-release", reason: "Repository release workflows own publishing." },
  ],
});

function fixtureExec(issues) {
  return async args => {
    if (args.join(" ") === "issue list --state open --json number,title,state,labels,assignees,body,milestone,url --limit 1000") {
      return { args, exitCode: 0, stdout: JSON.stringify(issues), stderr: "" };
    }
    return { args, exitCode: 1, stdout: "", stderr: `unexpected fixture call: ${args.join(" ")}` };
  };
}

function reviewExec(pullRequest) {
  return async args => {
    if (args.join(" ") === "pr view --json number,title,state,url,reviewDecision,mergeStateStatus,mergeable,isDraft") {
      return { args, exitCode: 0, stdout: JSON.stringify(pullRequest), stderr: "" };
    }
    return { args, exitCode: 1, stdout: "", stderr: `unexpected fixture call: ${args.join(" ")}` };
  };
}

function readFixture(relativePath) {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8"));
}
