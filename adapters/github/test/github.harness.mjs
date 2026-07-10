import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

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

const fixtureRoot = dirname(fileURLToPath(import.meta.url));
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

const workListCommand = "issue list --state open --json number,title,state,labels,assignees,body,milestone,url --limit 1000";

function createCountingExec(issues) {
  const state = { listRequests: 0 };
  const exec = async args => {
    if (args.join(" ") === workListCommand) {
      state.listRequests += 1;
      return { args, exitCode: 0, stdout: JSON.stringify(issues), stderr: "" };
    }
    if (args[0] === "issue" && args[1] === "view") {
      const number = Number(args[2]);
      const issue = issues.find(item => item.number === number);
      if (!issue) {
        return { args, exitCode: 1, stdout: "", stderr: `issue ${number} not found in fixture` };
      }
      return { args, exitCode: 0, stdout: JSON.stringify(issue), stderr: "" };
    }
    return { args, exitCode: 1, stdout: "", stderr: `unexpected fixture call: ${args.join(" ")}` };
  };
  exec.listRequests = () => state.listRequests;
  return exec;
}

const work = defineWorkProviderHarness({
  fixtureRoot,
  fixtureFiles: ["fixtures/conformance-work-items.json"],
  createFixtureTransport: () => createCountingExec(workItems),
  createSubject: exec => createGitHubWorkProvider({ exec, includeAssignees: true }),
  getListRequestCount: transport => transport.listRequests(),
  workScenarios: {
    statusPolicy,
    createLargeResultTransport: () => createCountingExec(workItems),
    expectedLargeResultCount: workItems.length,
    maxListRequests: 1,
    createMalformedTransport: () => async args => {
      if (args.join(" ") === workListCommand) {
        return { args, exitCode: 0, stdout: "{not-json", stderr: "" };
      }
      return { args, exitCode: 1, stdout: "", stderr: `unexpected fixture call: ${args.join(" ")}` };
    },
  },
  capabilityCases: [
    {
      capabilityId: "map-work-item",
      name: "maps fixture priorities, statuses, blockers, and checklists",
      run: async provider => {
        const items = await provider.listOpenWorkItems();
        const byId = Object.fromEntries(items.map(item => [item.key.id, item]));
        assert.equal(byId["42"].status, "ready");
        assert.equal(byId["42"].priority, "high");
        assert.deepEqual(byId["42"].checklist, { total: 2, completed: 1 });
        assert.equal(byId["43"].status, "blocked");
        assert.deepEqual(byId["43"].blockers, [{ providerId: "github", id: "42" }]);
        assert.equal(byId["44"].status, "in-progress");
        assert.equal(byId["44"].priority, "critical");
        assert.equal(byId["45"].status, "unknown");
        assert.equal(byId["46"].priority, "low");
      },
    },
    {
      capabilityId: "work-item-queue",
      name: "loads the full multi-item fixture queue without truncation",
      run: async provider => {
        const items = await provider.listOpenWorkItems();
        assert.equal(items.length, workItems.length);
        assert.deepEqual(items.map(item => item.key.id).sort(), ["42", "43", "44", "45", "46"]);
      },
    },
    {
      capabilityId: "sync-issue-status",
      name: "plans lifecycle status labels from fixture work",
      run: async provider => {
        const items = await provider.listOpenWorkItems();
        const plan = provider.planStatusSync(items, statusPolicy);
        assert.ok(plan.actions.length >= 1);
        assert.ok(plan.actions.every(action => action.details && typeof action.details === "object"));
      },
    },
  ],
});

const review = defineReviewForgeHarness({
  fixtureRoot,
  fixtureFiles: ["fixtures/conformance-review.json"],
  createFixtureTransport: () => reviewExec(reviewFixture),
  createSubject: exec => createGitHubReviewForgeProvider({ exec }),
  reviewScenarios: {
    reviewPolicy: { adapter: "github", reviewers: ["@copilot"], requestText: "" },
    sampleFindings: [
      { severity: "blocking", message: "inline blocker", location: { path: "src/a.ts", line: 10, side: "destination" } },
      { severity: "advisory", message: "body-only note" },
    ],
    diffPathsWithLines: { "src/a.ts": [10] },
    // Non-empty thread ids force the dry-run planned path instead of the empty-id skip short-circuit.
    resolveThreadIds: ["PRRT_fixture_thread_1"],
  },
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
  fixtureRoot,
  fixtureFiles: ["fixtures/conformance-checks.json"],
  createFixtureTransport: () => checkFixture,
  createSubject: fixture => ({ fixture, mapCheck: mapGitHubCheckStatus }),
  ciScenarios: {
    mapCheck: (subject, check) => subject.mapCheck(check),
    passedCheck: checkFixture.passed,
    failedCheck: checkFixture.failed,
    pendingCheck: checkFixture.pending,
    unsupportedTrigger: () => {
      assertGitHubOperationSupported("trigger-workflow-run");
    },
  },
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
      negativeFixtures: {
        badCredential: { command: { exitCode: 1, stdout: "", stderr: "not logged in to github.com" } },
        unreachable: { error: "network" },
        timeout: { error: "timeout" },
      },
    },
  },
  ignoredCapabilities: [
    { id: "render-work-items", reason: "AIB owns provider draft rendering outside the runtime adapter roles." },
    { id: "mutate-repository-files", reason: "The repository provider owns filesystem mutation." },
    { id: "publish-release", reason: "Repository release workflows own publishing." },
  ],
});

function reviewExec(pullRequest) {
  const currentFields = "number,title,state,url,reviewDecision,mergeStateStatus,mergeable,isDraft";
  const fullFields = "number,title,state,url,headRefOid,author,reviewDecision,mergeStateStatus,mergeable,isDraft,reviewRequests,reviews,latestReviews,statusCheckRollup,closingIssuesReferences";
  return async args => {
    const joined = args.join(" ");
    if (joined === `pr view --json ${currentFields}`) {
      return { args, exitCode: 0, stdout: JSON.stringify(pullRequest), stderr: "" };
    }
    if (joined === `pr view ${pullRequest.number} --json ${fullFields}`) {
      return { args, exitCode: 0, stdout: JSON.stringify(pullRequest), stderr: "" };
    }
    if (joined === "repo view --json nameWithOwner") {
      return { args, exitCode: 0, stdout: JSON.stringify({ nameWithOwner: "example/qube" }), stderr: "" };
    }
    if (args[0] === "api" && args[1] === "user") {
      return { args, exitCode: 0, stdout: JSON.stringify({ login: "fixture-bot" }), stderr: "" };
    }
    // Optional secondary loads may fail; snapshot paths treat them as unavailable rather than hard errors.
    return { args, exitCode: 1, stdout: "", stderr: `unexpected fixture call: ${args.join(" ")}` };
  };
}

function readFixture(relativePath) {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8"));
}
