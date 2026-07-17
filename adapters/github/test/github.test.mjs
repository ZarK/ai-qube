import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  assertGitHubOperationSupported,
  createGitHubReviewForgeProvider,
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

    const reviewStats = getGitHubOperationSupport("review-stats");
    assert.equal(reviewStats.support, "supported");
    assert.equal(reviewStats.support === "supported", createGitHubReviewForgeProvider().capabilities().reviewStats);

    const workflowRun = getGitHubOperationSupport("trigger-workflow-run");
    assert.equal(workflowRun.support, "unsupported");
    assert.match(workflowRun.nextAction, /current-head run/);
    assert.throws(() => assertGitHubOperationSupported("trigger-workflow-run"), /Unsupported GitHub capability/);

    const unknown = getGitHubOperationSupport("launch-space-elevator");
    assert.equal(unknown.support, "unsupported");
    assert.match(unknown.summary, /No product package has registered real GitHub behavior/);

    const operations = listGitHubOperationSupport();
    assert.equal(operations.filter((operation) => operation.support === "supported").length, 12);
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

  it("keeps optional review-agent implementations off the static registry load path", () => {
    const registrySource = readFileSync(new URL("../dist/github_review_agents.js", import.meta.url), "utf8");
    assert.doesNotMatch(registrySource, /import\s+.*github_review_agent_coderabbit/u);
    assert.doesNotMatch(registrySource, /import\s+.*github_review_agent_cubic/u);
    assert.match(registrySource, /requireAgentModule\('\.\/github_review_agent_coderabbit\.js'\)/u);
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

  it("lists a bounded newest-first window of merged or closed pull requests", async () => {
    const calls = [];
    const exec = async args => {
      calls.push(args);
      return {
        args,
        exitCode: 0,
        stdout: JSON.stringify([
          { number: 41, title: "Open", state: "OPEN", url: "https://example.invalid/41", headRefOid: "open" },
          { number: 39, title: "Closed", state: "CLOSED", url: "https://example.invalid/39", headRefOid: "closed", closedAt: "2026-07-03T00:00:00Z" },
          { number: 40, title: "Merged", state: "MERGED", url: "https://example.invalid/40", headRefOid: "merged", closedAt: "2026-07-01T00:00:00Z", mergedAt: "2026-07-01T00:00:00Z" },
        ]),
        stderr: "",
      };
    };
    const provider = createGitHubReviewForgeProvider({ exec });

    const listed = await provider.listRecentPullRequests({ limit: 3 });

    assert.deepEqual(listed.map(pr => pr.number), [39, 40]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].join(" "), "pr list --state all --search is:closed sort:updated-desc --limit 6 --json number,title,state,url,headRefOid,author,reviewDecision,mergeStateStatus,mergeable,isDraft,closedAt,mergedAt,updatedAt");
    assert.equal(provider.capabilities().reviewStats, true);
    await assert.rejects(() => provider.listRecentPullRequests({ limit: 51 }), /limit must be an integer from 1 to 50/);
    assert.equal(calls.length, 1);
  });

  it("fails loudly when the bounded candidate read cannot prove closure-time recency", async () => {
    const calls = [];
    const exec = async args => {
      calls.push(args);
      const candidateLimit = Number(args[args.indexOf("--limit") + 1]);
      return {
        args,
        exitCode: 0,
        stdout: JSON.stringify(Array.from({ length: candidateLimit }, (_, index) => ({
          number: index + 1,
          title: `PR ${index + 1}`,
          state: "CLOSED",
          url: `https://example.invalid/${index + 1}`,
          headRefOid: `head-${index + 1}`,
          closedAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-07-01T00:00:00Z",
        }))),
        stderr: "",
      };
    };
    const provider = createGitHubReviewForgeProvider({ exec });

    await assert.rejects(() => provider.listRecentPullRequests({ limit: 50 }), /cannot prove the latest closure-time window/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][calls[0].indexOf("--limit") + 1], "100");
  });

  it("ties recent pull request provider work to a small requested window", async () => {
    const calls = [];
    const exec = async args => {
      calls.push(args);
      return {
        args,
        exitCode: 0,
        stdout: JSON.stringify([{ number: 7, title: "Recent", state: "CLOSED", url: "https://example.invalid/7", headRefOid: "head-7", closedAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-01T00:00:00Z" }]),
        stderr: "",
      };
    };
    const provider = createGitHubReviewForgeProvider({ exec });

    const listed = await provider.listRecentPullRequests({ limit: 1 });

    assert.deepEqual(listed.map(pr => pr.number), [7]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][calls[0].indexOf("--limit") + 1], "2");
  });

  it("loads trusted lane history with bounded calls, chronology, and malformed diagnostics", async () => {
    const calls = [];
    const laneMarker = ({ head, lane, recommendation, status, blockingFindingCount, prNumber = 12 }) => `<!-- qube-pr-review:${JSON.stringify({
      version: 1,
      head,
      lane,
      expectedLanes: [lane],
      profile: "local-focused",
      runId: `${head}-${lane}`,
      issueNumber: 290,
      prNumber,
      host: "codex",
      recommendation,
      status,
      summary: "review summary",
      inline: "review-api",
      bodyFindingCount: blockingFindingCount,
      blockingFindingCount,
    })} -->`;
    const exec = async args => {
      calls.push(args);
      if (args.join(" ") === "api user") return { args, exitCode: 0, stdout: JSON.stringify({ login: "trusted" }), stderr: "" };
      if (args.join(" ") === "repo view --json nameWithOwner,url") return { args, exitCode: 0, stdout: JSON.stringify({ nameWithOwner: "example/qube", url: "https://example.invalid/qube" }), stderr: "" };
      const number = Number(args.find(arg => arg.startsWith("pr="))?.slice(3));
      if (number === 13) {
        return {
          args,
          exitCode: 0,
          stdout: JSON.stringify({ data: { repository: { pullRequest: { headRefOid: "bad", comments: { nodes: [{ author: { login: "trusted" }, createdAt: "2026-01-01T00:00:00Z", body: "<!-- qube-pr-review:{bad json} -->" }], pageInfo: { hasNextPage: false } }, reviews: { nodes: [], pageInfo: { hasNextPage: false } } } } } }),
          stderr: "",
        };
      }
      return {
        args,
        exitCode: 0,
        stdout: JSON.stringify({ data: { repository: { pullRequest: {
          headRefOid: "later",
          comments: { nodes: [
            { author: { login: "trusted" }, createdAt: "2026-02-01T00:00:00Z", body: laneMarker({ head: "first", lane: "code-quality", recommendation: "request-changes", status: "failed", blockingFindingCount: 1 }) },
            { author: { login: "trusted" }, createdAt: "2026-02-02T00:00:00Z", body: laneMarker({ head: "later", lane: "code-quality", recommendation: "request-changes", status: "failed", blockingFindingCount: 1 }) },
            { author: { login: "trusted" }, createdAt: "2026-02-03T00:00:00Z", body: laneMarker({ head: "foreign", lane: "code-quality", recommendation: "approve", status: "passed", blockingFindingCount: 0, prNumber: 999 }) },
          ], pageInfo: { hasNextPage: false } },
          reviews: { nodes: [{ author: { login: "trusted" }, submittedAt: "2026-02-01T01:00:00Z", body: laneMarker({ head: "first", lane: "code-quality", recommendation: "approve", status: "passed", blockingFindingCount: 0 }) }], pageInfo: { hasNextPage: false } },
        } } } }),
        stderr: "",
      };
    };
    const provider = createGitHubReviewForgeProvider({ exec });

    const history = await provider.loadLaneReviewHistory(12);
    const malformed = await provider.loadLaneReviewHistory(13);

    assert.deepEqual(history.trustedLaneReviews.map(record => record.head), ["first", "first", "later"]);
    assert.deepEqual(history.trustedLaneReviews.map(record => record.recommendation), ["request-changes", "approve", "request-changes"]);
    assert.deepEqual(history.trustedLaneReviews.map(record => record.blockingFindingCount), [1, 0, 1]);
    assert.ok(history.trustedLaneReviews.every(record => record.prNumber === 12));
    assert.equal(history.unavailableReason, null);
    assert.match(malformed.unavailableReason, /1 malformed marker/);
    assert.equal(calls.filter(args => args.join(" ") === "api user").length, 1);
    assert.equal(calls.filter(args => args.join(" ") === "repo view --json nameWithOwner,url").length, 1);
    assert.equal(calls.filter(args => args[0] === "api" && args[1] === "graphql").length, 2);
    assert.ok(calls.filter(args => args[0] === "api" && args[1] === "graphql").every(args => args.join(" ").includes("comments(first: 100)") && args.join(" ").includes("reviews(first: 100)") && !args.includes("--paginate")));
  });

  it("degrades truncated lane history instead of counting a partial bounded page", async () => {
    const calls = [];
    const exec = async args => {
      calls.push(args);
      if (args.join(" ") === "repo view --json nameWithOwner,url") return { args, exitCode: 0, stdout: JSON.stringify({ nameWithOwner: "example/qube", url: "https://example.invalid/qube" }), stderr: "" };
      return { args, exitCode: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: { headRefOid: "head", comments: { nodes: [{ author: { login: "trusted" }, body: "partial" }], pageInfo: { hasNextPage: true, endCursor: "next" } }, reviews: { nodes: [], pageInfo: { hasNextPage: false } } } } } }), stderr: "" };
    };
    const provider = createGitHubReviewForgeProvider({ exec });

    const history = await provider.loadLaneReviewHistory(12);

    assert.deepEqual(history.trustedLaneReviews, []);
    assert.match(history.unavailableReason, /exceeded the bounded 100-comment or 100-review read.*not counted partially/);
    assert.equal(calls.filter(args => args[0] === "api" && args[1] === "graphql").length, 1);
    assert.equal(calls.filter(args => args.join(" ") === "api user").length, 0);
  });

  it("reports distinct publisher identity as unavailable when its public login is omitted", async () => {
    const calls = [];
    const exec = async args => {
      calls.push(args);
      return {
      args,
      exitCode: 0,
      stdout: JSON.stringify({}),
      stderr: "",
      };
    };
    const provider = createGitHubReviewForgeProvider({ exec, publisher: { mode: "token", token: { env: "QUBE_REVIEW_TOKEN" } } });

    const history = await provider.loadLaneReviewHistory(12);

    assert.deepEqual(history.trustedLaneReviews, []);
    assert.match(history.unavailableReason, /publisher login was unavailable/);
    assert.equal(calls.length, 0);
  });

  it("trusts only the configured distinct publisher for lane history", async () => {
    const marker = login => ({
      author: { login },
      createdAt: "2026-01-01T00:00:00Z",
      body: `<!-- qube-pr-review:${JSON.stringify({ version: 1, head: "head", lane: "code-quality", expectedLanes: ["code-quality"], profile: "local-focused", runId: `${login}-run`, issueNumber: 290, prNumber: 12, host: "codex", recommendation: "approve", status: "passed", summary: "review summary", inline: "review-api", bodyFindingCount: 0, blockingFindingCount: 0 })} -->`,
    });
    const exec = async args => {
      if (args.join(" ") === "api user") return { args, exitCode: 0, stdout: JSON.stringify({ login: "actor-user" }), stderr: "" };
      if (args.join(" ") === "repo view --json nameWithOwner,url") return { args, exitCode: 0, stdout: JSON.stringify({ nameWithOwner: "example/qube", url: "https://example.invalid/qube" }), stderr: "" };
      return { args, exitCode: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: { headRefOid: "head", comments: { nodes: [marker("actor-user"), marker("review-bot")], pageInfo: { hasNextPage: false } }, reviews: { nodes: [], pageInfo: { hasNextPage: false } } } } } }), stderr: "" };
    };
    const provider = createGitHubReviewForgeProvider({ exec, publisher: { mode: "token", token: { env: "QUBE_REVIEW_TOKEN", login: "review-bot" } } });

    const history = await provider.loadLaneReviewHistory(12);

    assert.deepEqual(history.trustedLaneReviews.map(record => record.author), ["review-bot"]);
  });
});
