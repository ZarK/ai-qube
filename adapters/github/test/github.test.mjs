import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertGitHubOperationSupported,
  getGitHubOperationSupport,
  githubAdapter,
  githubIssueReference,
  githubPullRequestReference,
  githubReviewItemKey,
  githubReviewRequestMarker,
  githubWorkItemKey,
  listGitHubOperationSupport,
  mapGitHubCheckStatus,
} from "../dist/index.js";

describe("github adapter contract", () => {
  it("exposes a real GitHub capability map", () => {
    assert.equal(githubAdapter.id, "github");
    assert.equal(githubAdapter.contractOnly, false);
    assert.ok(githubAdapter.owns.includes("pull-requests"));
    assert.ok(githubAdapter.owns.includes("unsupported-capability-reporting"));
    assert.match(githubAdapter.boundary, /explicit capability records/);
    assert.ok(githubAdapter.capabilities?.some((capability) => capability.id === "map-work-item" && capability.support === "supported"));
    assert.ok(githubAdapter.capabilities?.some((capability) => capability.id === "run-aiq-github-action" && capability.support === "standalone"));
  });

  it("reports supported and unsupported operations without mock success", () => {
    const pullRequest = getGitHubOperationSupport("load-pull-request");
    assert.equal(pullRequest.support, "supported");
    assert.match(pullRequest.nextAction, /pr view/);

    const aiqAction = assertGitHubOperationSupported("run-aiq-github-action");
    assert.equal(aiqAction.support, "standalone");

    const workflowRun = getGitHubOperationSupport("trigger-workflow-run");
    assert.equal(workflowRun.support, "unsupported");
    assert.match(workflowRun.nextAction, /current-head run/);
    assert.throws(() => assertGitHubOperationSupported("trigger-workflow-run"), /Unsupported GitHub capability/);

    const unknown = getGitHubOperationSupport("launch-space-elevator");
    assert.equal(unknown.support, "unsupported");
    assert.match(unknown.summary, /No product package has registered real GitHub behavior/);
    assert.ok(listGitHubOperationSupport().length >= 13);
  });

  it("returns immutable operation descriptors", () => {
    const operations = listGitHubOperationSupport();
    assert.throws(() => operations.push(operations[0]), TypeError);
    assert.throws(() => {
      operations[0].summary = "mutated";
    }, TypeError);

    const aiqAction = getGitHubOperationSupport("run-aiq-github-action");
    assert.throws(() => aiqAction.paths.push("mutated"), TypeError);

    assert.throws(() => githubAdapter.capabilities.push(githubAdapter.capabilities[0]), TypeError);
    assert.throws(() => {
      githubAdapter.capabilities[0].summary = "mutated";
    }, TypeError);
  });

  it("normalizes GitHub issue and pull request references", () => {
    assert.equal(githubIssueReference(42), "#42");
    assert.equal(githubIssueReference("43"), "#43");
    assert.deepEqual(githubWorkItemKey(42), { providerId: "github", id: "42" });
    assert.equal(githubPullRequestReference(107), "#107");
    assert.deepEqual(githubReviewItemKey("108"), { providerId: "github", id: "108" });

    assert.throws(() => githubIssueReference(0), /positive safe integers/);
    assert.throws(() => githubPullRequestReference(" 7"), /positive safe integers/);
    assert.throws(() => githubWorkItemKey(Number.MAX_SAFE_INTEGER + 1), /positive safe integers/);
    assert.throws(() => githubWorkItemKey("9007199254740992"), /positive safe integers/);
  });

  it("keeps review request markers normalized", () => {
    assert.equal(
      githubReviewRequestMarker("coderabbitai", "ABCDEF1234567"),
      "github-review:coderabbitai:abcdef1234567",
    );
    assert.throws(() => githubReviewRequestMarker(" coderabbitai", "abcdef1"), /already normalized/);
    assert.throws(() => githubReviewRequestMarker("coderabbitai", "not-a-sha"), /hexadecimal/);
  });

  it("maps GitHub check status into stable provider evidence fields", () => {
    assert.deepEqual(mapGitHubCheckStatus({ name: "CI", status: "COMPLETED", conclusion: "SUCCESS" }), {
      key: "github-check:CI",
      name: "CI",
      result: "passed",
      reasonCode: "provider-check-passed",
      summary: "GitHub check status=COMPLETED conclusion=SUCCESS.",
      workflowName: null,
    });

    const failed = mapGitHubCheckStatus({ context: "build", status: "COMPLETED", conclusion: "FAILURE", workflowName: "Build" });
    assert.equal(failed.key, "github-check:build");
    assert.equal(failed.result, "failed");
    assert.equal(failed.reasonCode, "provider-check-failed");
    assert.equal(failed.workflowName, "Build");

    assert.equal(mapGitHubCheckStatus({ name: "queue", status: "IN_PROGRESS" }).result, "pending");
    assert.equal(mapGitHubCheckStatus({ name: "skip", conclusion: "SKIPPED" }).result, "skipped");
    assert.equal(mapGitHubCheckStatus({ name: "old", conclusion: "STALE" }).result, "stale");
    assert.equal(mapGitHubCheckStatus({}, 2).name, "GitHub check 3");
  });
});
