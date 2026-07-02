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
  isNonActionableSummary,
  listGitHubReviewAgents,
  listGitHubOperationSupport,
  mapGitHubCheckStatus,
  resolveReviewAgent,
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

    const mergeBlockers = getGitHubOperationSupport("read-merge-blockers");
    assert.equal(mergeBlockers.support, "supported");
    assert.match(mergeBlockers.summary, /provider merge UI reasons/);

    const resolveThreads = getGitHubOperationSupport("resolve-review-threads");
    assert.equal(resolveThreads.support, "supported");
    assert.match(resolveThreads.nextAction, /pr thread resolve/);

    const workflowRun = getGitHubOperationSupport("trigger-workflow-run");
    assert.equal(workflowRun.support, "unsupported");
    assert.match(workflowRun.nextAction, /current-head run/);
    assert.throws(() => assertGitHubOperationSupported("trigger-workflow-run"), /Unsupported GitHub capability/);

    const unknown = getGitHubOperationSupport("launch-space-elevator");
    assert.equal(unknown.support, "unsupported");
    assert.match(unknown.summary, /No product package has registered real GitHub behavior/);

    const operations = listGitHubOperationSupport();
    assert.equal(operations.filter((operation) => operation.support === "supported").length, 11);
    assert.equal(operations.filter((operation) => operation.support === "standalone").length, 1);
    assert.equal(operations.filter((operation) => operation.support === "unsupported").length, 4);
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
    assert.throws(() => githubReviewRequestMarker("some:bot", "abcdef1"), /whitespace or colon/);
    assert.throws(() => githubReviewRequestMarker("some bot", "abcdef1"), /whitespace or colon/);
    assert.throws(() => githubReviewRequestMarker("coderabbitai", "not-a-sha"), /hexadecimal/);
  });

  it("plans GitHub review-agent matching and triggers through adapter modules", () => {
    const agents = listGitHubReviewAgents();
    assert.deepEqual(agents.map(agent => agent.id), ["copilot", "coderabbit", "cubic", "qubereview"]);

    const copilot = resolveReviewAgent("@copilot");
    assert.equal(copilot.triggerFor("@copilot"), "github-reviewer");
    assert.equal(copilot.matches("copilot"), true);

    const coderabbit = resolveReviewAgent("@coderabbitai");
    assert.equal(coderabbit.id, "coderabbit");
    assert.equal(coderabbit.triggerFor("@coderabbitai"), "comment");
    assert.equal(coderabbit.commentBodyFor("@coderabbitai", { adapter: "github", reviewers: ["@coderabbitai"], requestText: "Review ghp_abcdefghijklmnopqrstuvwxyz123456" }, "abc123").body.includes("ghp_abcdefghijklmnopqrstuvwxyz123456"), false);
    assert.match(coderabbit.commentBodyFor("coderabbit", { adapter: "github", reviewers: ["coderabbit"], requestText: "" }, "abc123").body, /@coderabbitai review/);
    assert.match(coderabbit.commentBodyFor("coderabbit", { adapter: "github", reviewers: ["coderabbit"], requestText: "" }, "abc123").marker, /aie:pr-gate:coderabbit:abc123/);

    const cubic = resolveReviewAgent("@cubic-dev-ai");
    assert.equal(cubic.id, "cubic");
    assert.equal(cubic.triggerFor("@cubic-dev-ai"), "comment");
    assert.match(cubic.commentBodyFor("cubic", { adapter: "github", reviewers: ["cubic"], requestText: "" }, "abc123").body, /@cubic-dev-ai review this PR/);
  });

  it("filters optional review-agent modules by configured install set", () => {
    const agents = listGitHubReviewAgents({ agents: ["@copilot"] });
    assert.deepEqual(agents.map(agent => agent.id), ["copilot"]);
    assert.equal(resolveReviewAgent("@coderabbitai", { agents: ["@copilot"] }), null);
    assert.equal(isNonActionableSummary("No actionable comments were generated.", "coderabbitai", { agents: ["@copilot"] }), false);
    assert.equal(isNonActionableSummary("## Pull request overview\n### Reviewed Changes\nCopilot reviewed 2 out of 2 changed files in this pull request.", "copilot-pull-request-reviewer", { agents: ["@copilot"] }), true);
  });

  it("classifies non-actionable feedback per installed review agent", () => {
    const coderabbit = resolveReviewAgent("@coderabbitai");
    const cubic = resolveReviewAgent("@cubic-dev-ai");
    const copilot = resolveReviewAgent("@copilot");

    assert.equal(coderabbit.isNonActionableSummary("No actionable comments were generated.", "coderabbitai"), true);
    assert.equal(coderabbit.isNonActionableSummary("Actionable comments posted: 1", "coderabbitai"), false);
    assert.equal(cubic.isNonActionableSummary("No issues found", "cubic-dev-ai"), true);
    assert.equal(cubic.isNonActionableSummary("1 issue found", "cubic-dev-ai"), false);
    assert.equal(copilot.isNonActionableSummary("## Pull request overview\n### Reviewed Changes\nCopilot reviewed 1 out of 1 changed files in this pull request.", "copilot-pull-request-reviewer"), true);
  });

  it("maps GitHub check status into stable provider evidence fields", () => {
    assert.deepEqual(mapGitHubCheckStatus({ name: "CI", status: "COMPLETED", conclusion: "SUCCESS" }), {
      key: "github-check:CI",
      name: "CI",
      result: "passed",
      reasonCode: "provider-check-passed",
      summary: "GitHub check status=COMPLETED state=UNKNOWN conclusion=SUCCESS.",
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
    assert.equal(mapGitHubCheckStatus({ name: "legacy", state: "SUCCESS" }).result, "passed");
    assert.equal(mapGitHubCheckStatus({ name: "legacy", state: "FAILURE" }).result, "failed");
    assert.equal(mapGitHubCheckStatus({ name: "legacy", state: "ERROR" }).result, "failed");
    assert.equal(mapGitHubCheckStatus({ name: "legacy", state: "PENDING" }).result, "pending");
    assert.equal(mapGitHubCheckStatus({}, 2).name, "GitHub check 3");
  });
});
