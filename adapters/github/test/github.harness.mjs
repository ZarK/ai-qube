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
  const state = { listRequests: 0, comments: [] };
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
    if (args[0] === "issue" && args[1] === "comment") {
      state.comments.push({ issueNumber: args[2], body: args[args.indexOf("--body") + 1] ?? "" });
      return { args, exitCode: 0, stdout: JSON.stringify({ url: `https://github.com/example/qube/issues/${args[2]}#comment` }), stderr: "" };
    }
    if (args[0] === "issue" && args[1] === "edit") {
      return { args, exitCode: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "api" && args[1] === "user") {
      return { args, exitCode: 0, stdout: JSON.stringify({ login: "fixture-bot" }), stderr: "" };
    }
    return { args, exitCode: 1, stdout: "", stderr: `unexpected fixture call: ${args.join(" ")}` };
  };
  exec.listRequests = () => state.listRequests;
  exec.comments = () => state.comments;
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
    singleShotHighLimit: true,
    createMalformedTransport: () => async args => {
      if (args.join(" ") === workListCommand) {
        return { args, exitCode: 0, stdout: "{not-json", stderr: "" };
      }
      return { args, exitCode: 1, stdout: "", stderr: `unexpected fixture call: ${args.join(" ")}` };
    },
  },
  // Supported work capabilities are covered by the shared work suite + fixtures.
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
    // Unsupported approval is not part of the shared supported-review suite.
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
    // Standalone AIQ packaging is outside the shared CI role suite.
    {
      capabilityId: "run-aiq-github-action",
      name: "keeps standalone CI integration explicit",
      run: () => assert.equal(assertGitHubOperationSupported("run-aiq-github-action").support, "standalone"),
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
    if (joined === "repo view --json nameWithOwner" || joined === "repo view --json nameWithOwner,url") {
      return {
        args,
        exitCode: 0,
        stdout: JSON.stringify({ nameWithOwner: "example/qube", url: "https://github.com/example/qube" }),
        stderr: "",
      };
    }
    if (args[0] === "api" && args[1] === "user") {
      return { args, exitCode: 0, stdout: JSON.stringify({ login: "fixture-bot" }), stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "edit") {
      return { args, exitCode: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "comment") {
      return { args, exitCode: 0, stdout: JSON.stringify({ url: "https://github.com/example/qube/pull/12#issuecomment-1" }), stderr: "" };
    }
    // Optional secondary loads may fail; snapshot paths treat them as unavailable rather than hard errors.
    return { args, exitCode: 1, stdout: "", stderr: `unexpected fixture call: ${args.join(" ")}` };
  };
}

function readFixture(relativePath) {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8"));
}
