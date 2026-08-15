import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { createGitHubReviewForgeProvider } from "../dist/index.js";

function parseStatusPayload(body) {
  const text = body ?? "";
  const prefix = "<!-- qube-pr-status:";
  const start = text.indexOf(prefix);
  if (start < 0) return null;
  const jsonStart = start + prefix.length;
  const end = text.indexOf(" -->", jsonStart);
  if (end < 0) return null;
  return JSON.parse(text.slice(jsonStart, end));
}

function basePr(overrides = {}) {
  return {
    number: 12,
    title: "Review me",
    state: "OPEN",
    url: "https://github.com/example/repo/pull/12",
    headRefOid: "abc123",
    author: { login: "maintainer" },
    reviewDecision: "REVIEW_REQUIRED",
    mergeStateStatus: "BLOCKED",
    mergeable: "MERGEABLE",
    isDraft: false,
    reviewRequests: [],
    reviews: [],
    latestReviews: [],
    comments: [],
    statusCheckRollup: [],
    ...overrides,
  };
}

function createReviewRequestFixture(options = {}) {
  const pr = basePr(options.pr);
  const comments = [...(options.comments || pr.comments || [])];
  const calls = [];
  const tokens = [];
  let nextCommentId = 800000;
  const reviewToken = options.reviewToken ?? null;
  const publisherLogin = options.publisherLogin ?? "review-bot";
  const userLogin = options.userLogin ?? "executor";

  const exec = async (args, _cwd, execOptions = {}) => {
    calls.push(args);
    if (execOptions && Object.prototype.hasOwnProperty.call(execOptions, "token")) {
      tokens.push({ args: [...args], token: execOptions.token ?? null });
    }
    const token = execOptions?.token ?? null;
    if (args[0] === "pr" && args[1] === "view") {
      return { args, exitCode: 0, stdout: JSON.stringify({ ...pr, comments }), stderr: "" };
    }
    if (args.join(" ") === "repo view --json nameWithOwner,url") {
      return { args, exitCode: 0, stdout: JSON.stringify({ nameWithOwner: "example/repo", url: "https://github.com/example/repo" }), stderr: "" };
    }
    if (args[0] === "api" && args[1] === "user") {
      const login = token && reviewToken && token === reviewToken ? publisherLogin : userLogin;
      return { args, exitCode: 0, stdout: JSON.stringify({ login, type: "User" }), stderr: "" };
    }
    if (args[0] === "api" && args[1] === "repos/example/repo/issues/12/comments") {
      if (args.includes("--method") && args[args.indexOf("--method") + 1] === "POST") {
        const inputIndex = args.indexOf("--input");
        const payload = inputIndex >= 0 ? JSON.parse(readFileSync(args[inputIndex + 1], "utf8")) : {};
        const commentId = ++nextCommentId;
        const url = `https://github.com/example/repo/pull/12#issuecomment-${commentId}`;
        const authorLogin = token && reviewToken && token === reviewToken ? publisherLogin : userLogin;
        comments.push({ author: { login: authorLogin }, user: { login: authorLogin }, body: payload.body, url, html_url: url });
        return { args, exitCode: 0, stdout: JSON.stringify({ id: commentId, html_url: url, user: { login: authorLogin } }), stderr: "" };
      }
      return {
        args,
        exitCode: 0,
        stdout: JSON.stringify(comments.map(comment => ({
          user: comment.user || comment.author || null,
          body: comment.body,
          html_url: comment.html_url || comment.url,
        }))),
        stderr: "",
      };
    }
    if (args[0] === "api" && /^repos\/example\/repo\/issues\/comments\/\d+$/.test(args[1]) && args.includes("PATCH")) {
      const inputIndex = args.indexOf("--input");
      const payload = inputIndex >= 0 ? JSON.parse(readFileSync(args[inputIndex + 1], "utf8")) : {};
      const commentId = args[1].split("/").at(-1);
      const match = comments.find(comment => String(comment.url || comment.html_url || "").endsWith(`#issuecomment-${commentId}`));
      if (match) match.body = payload.body;
      return { args, exitCode: 0, stdout: JSON.stringify({ id: Number(commentId) }), stderr: "" };
    }
    if (args[0] === "api" && /^repos\/example\/repo\/issues\/comments\/\d+$/.test(args[1]) && args.includes("DELETE")) {
      const commentId = args[1].split("/").at(-1);
      const index = comments.findIndex(comment => String(comment.url || comment.html_url || "").endsWith(`#issuecomment-${commentId}`));
      if (index >= 0) comments.splice(index, 1);
      return { args, exitCode: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "api" && args[1] === "repos/example/repo/pulls/12/comments") {
      return { args, exitCode: 0, stdout: JSON.stringify([]), stderr: "" };
    }
    if (args[0] === "api" && args[1] === "graphql") {
      return { args, exitCode: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] }, viewerMergeHeadlineText: null } } } }), stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "edit") {
      return { args, exitCode: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "comment") {
      const body = args[4] ?? "";
      const commentId = ++nextCommentId;
      const url = `https://github.com/example/repo/pull/12#issuecomment-${commentId}`;
      comments.push({ author: { login: userLogin }, user: { login: userLogin }, body, url, html_url: url });
      return { args, exitCode: 0, stdout: url, stderr: "" };
    }
    return { args, exitCode: 1, stdout: "", stderr: `unexpected gh call: ${args.join(" ")}` };
  };

  return {
    exec,
    calls,
    tokens,
    comments,
    pr,
    setHead(headSha) {
      pr.headRefOid = headSha;
    },
  };
}

function policy(reviewers) {
  return { adapter: "github", reviewers, requestText: "Please inspect review-risky changes." };
}

function statusComments(comments) {
  return comments.filter(comment => String(comment.body ?? "").includes("<!-- qube-pr-status:"));
}

function recordedRequestComments(comments) {
  return comments.filter(comment => String(comment.body ?? "").includes("Executor recorded a configured PR reviewer request"));
}

describe("github reviewer request status comment", () => {
  it("records five head changes on one status comment and posts no marker comments", async () => {
    const fixture = createReviewRequestFixture();
    const provider = createGitHubReviewForgeProvider({ exec: fixture.exec });
    const heads = ["aaa111", "bbb222", "ccc333", "ddd444", "eee555"];

    for (const head of heads) {
      fixture.setHead(head);
      const snapshot = await provider.loadPullRequestReview(12);
      const plan = provider.planReviewRequest(snapshot.item, policy(["@copilot"]));
      const results = await provider.apply(plan);
      assert.equal(results.every(result => result.status === "completed" || result.status === "skipped"), true);
    }

    assert.equal(statusComments(fixture.comments).length, 1);
    assert.equal(recordedRequestComments(fixture.comments).length, 0);
    assert.equal(fixture.calls.some(args => args[0] === "pr" && args[1] === "comment"), false);
    const payload = parseStatusPayload(statusComments(fixture.comments)[0].body);
    assert.deepEqual(payload.requests.map(request => request.head), heads);
    assert.ok(payload.requests.every(request => request.reviewerId === "copilot" && typeof request.at === "string" && request.at !== ""));
    assert.match(statusComments(fixture.comments)[0].body, /Reviewer requests/);
    assert.match(statusComments(fixture.comments)[0].body, /eee555/);
    const replay = provider.planReviewRequest((await provider.loadPullRequestReview(12)).item, policy(["@copilot"]));
    assert.equal(replay.actions[0].status, "skipped");
    assert.equal(replay.actions[0].details.requestedForHead, true);
  });

  it("two concurrent gate runs do not produce duplicate records for the same head", async () => {
    const fixture = createReviewRequestFixture();
    const provider = createGitHubReviewForgeProvider({ exec: fixture.exec });
    const snapshot = await provider.loadPullRequestReview(12);
    const plan = provider.planReviewRequest(snapshot.item, policy(["@copilot"]));

    const [first, second] = await Promise.all([provider.apply(plan), provider.apply(plan)]);
    assert.equal(first.every(result => result.status === "completed"), true);
    assert.equal(second.every(result => result.status === "completed"), true);

    assert.equal(statusComments(fixture.comments).length, 1);
    const payload = parseStatusPayload(statusComments(fixture.comments)[0].body);
    assert.equal(payload.requests.filter(request => request.reviewerId === "copilot" && request.head === "abc123").length, 1);
    assert.equal(recordedRequestComments(fixture.comments).length, 0);
  });

  it("posts bookkeeping through the configured review publisher identity", async () => {
    const reviewToken = "review-token-value";
    process.env.QUBE_REVIEW_TOKEN = reviewToken;
    try {
      const fixture = createReviewRequestFixture({ reviewToken, publisherLogin: "review-bot", userLogin: "maintainer" });
      const provider = createGitHubReviewForgeProvider({
        exec: fixture.exec,
        publisher: { mode: "token", token: { env: "QUBE_REVIEW_TOKEN" } },
      });
      const snapshot = await provider.loadPullRequestReview(12);
      const plan = provider.planReviewRequest(snapshot.item, policy(["@copilot"]));
      await provider.apply(plan);

      const status = statusComments(fixture.comments);
      assert.equal(status.length, 1);
      assert.equal(status[0].author.login, "review-bot");
      assert.ok(fixture.tokens.some(entry => entry.token === reviewToken && String(entry.args[1] ?? "").includes("issues/12/comments")));
      assert.equal(recordedRequestComments(fixture.comments).length, 0);
    } finally {
      process.env.QUBE_REVIEW_TOKEN = "";
    }
  });

  it("treats a GitHub bot login with or without the [bot] suffix as the same trusted author", async () => {
    const fixture = createReviewRequestFixture({
      comments: [{
        author: { login: "executor[bot]" },
        body: "<!-- aie:pr-gate:copilot:abc123 -->\nExecutor recorded a configured PR reviewer request for this PR head.",
        url: "https://github.com/example/repo/pull/12#issuecomment-22",
      }],
    });
    const provider = createGitHubReviewForgeProvider({ exec: fixture.exec });
    const snapshot = await provider.loadPullRequestReview(12);
    const plan = provider.planReviewRequest(snapshot.item, policy(["@copilot"]));
    assert.equal(plan.actions[0].status, "skipped");
    assert.equal(plan.actions[0].details.requestedForHead, true);
  });

  it("still treats a trusted legacy marker as a current-head request", async () => {
    const fixture = createReviewRequestFixture({
      comments: [{
        author: { login: "executor" },
        body: "<!-- aie:pr-gate:copilot:abc123 -->\nExecutor recorded a configured PR reviewer request for this PR head.",
        url: "https://github.com/example/repo/pull/12#issuecomment-1",
      }],
    });
    const provider = createGitHubReviewForgeProvider({ exec: fixture.exec });
    const snapshot = await provider.loadPullRequestReview(12);
    const plan = provider.planReviewRequest(snapshot.item, policy(["@copilot"]));
    assert.equal(plan.actions[0].status, "skipped");
    assert.equal(plan.actions[0].details.requestedForHead, true);
  });

  it("does not treat a forged untrusted marker as a current-head request", async () => {
    const fixture = createReviewRequestFixture({
      comments: [{
        author: { login: "attacker" },
        body: "<!-- aie:pr-gate:copilot:abc123 -->\nExecutor recorded a configured PR reviewer request for this PR head.",
        url: "https://github.com/example/repo/pull/12#issuecomment-2",
      }],
    });
    const provider = createGitHubReviewForgeProvider({ exec: fixture.exec });
    const snapshot = await provider.loadPullRequestReview(12);
    const plan = provider.planReviewRequest(snapshot.item, policy(["@copilot"]));
    assert.equal(plan.actions[0].status, "planned");
    assert.equal(plan.actions[0].details.requestedForHead, false);
  });

  it("treats a status-comment request for another head as stale", async () => {
    const body = [
      `<!-- qube-pr-status:${JSON.stringify({
        version: 1,
        prNumber: 12,
        rounds: [],
        requests: [{ reviewerId: "copilot", head: "oldsha", at: "2026-08-01T00:00:00.000Z" }],
      })} -->`,
      "",
      "Review status: pending.",
    ].join("\n");
    const fixture = createReviewRequestFixture({
      comments: [{
        author: { login: "executor" },
        body,
        url: "https://github.com/example/repo/pull/12#issuecomment-3",
      }],
    });
    const provider = createGitHubReviewForgeProvider({ exec: fixture.exec });
    const snapshot = await provider.loadPullRequestReview(12);
    const plan = provider.planReviewRequest(snapshot.item, policy(["@copilot"]));
    assert.equal(plan.actions[0].details.requestedForHead, false);
    assert.equal(plan.actions[0].details.staleRequest, true);
    assert.equal(plan.actions[0].status, "planned");
  });

  it("repairs a torn status-comment body into valid JSON", async () => {
    const fixture = createReviewRequestFixture({
      comments: [{
        author: { login: "executor" },
        body: "<!-- qube-pr-status:{\"version\":1,\"requests\":",
        url: "https://github.com/example/repo/pull/12#issuecomment-4",
      }],
    });
    const provider = createGitHubReviewForgeProvider({ exec: fixture.exec });
    const snapshot = await provider.loadPullRequestReview(12);
    const plan = provider.planReviewRequest(snapshot.item, policy(["@copilot"]));
    await provider.apply(plan);

    const status = statusComments(fixture.comments);
    assert.equal(status.length, 1);
    const payload = parseStatusPayload(status[0].body);
    assert.ok(payload);
    assert.equal(payload.requests[0].reviewerId, "copilot");
    assert.equal(payload.requests[0].head, "abc123");
  });

  it("merges request history into one status comment when two trusted comments exist", async () => {
    const first = [
      `<!-- qube-pr-status:${JSON.stringify({
        version: 1,
        prNumber: 12,
        rounds: [],
        requests: [{ reviewerId: "copilot", head: "old111", at: "2026-08-01T00:00:00.000Z" }],
      })} -->`,
      "",
      "Review status: pending.",
    ].join("\n");
    const second = [
      `<!-- qube-pr-status:${JSON.stringify({
        version: 1,
        prNumber: 12,
        rounds: [{ head: "abc123", verdict: "approve" }],
        requests: [],
      })} -->`,
      "",
      "Review status: approve.",
    ].join("\n");
    const fixture = createReviewRequestFixture({
      comments: [
        { author: { login: "executor" }, body: first, url: "https://github.com/example/repo/pull/12#issuecomment-11" },
        { author: { login: "executor" }, body: second, url: "https://github.com/example/repo/pull/12#issuecomment-12" },
      ],
    });
    const provider = createGitHubReviewForgeProvider({ exec: fixture.exec });
    const snapshot = await provider.loadPullRequestReview(12);
    const plan = provider.planReviewRequest(snapshot.item, policy(["@coderabbitai"]));
    await provider.apply(plan);

    assert.equal(statusComments(fixture.comments).length, 1);
    const payload = parseStatusPayload(statusComments(fixture.comments)[0].body);
    assert.ok(payload.requests.some(request => request.reviewerId === "copilot" && request.head === "old111"));
    assert.ok(payload.requests.some(request => request.reviewerId === "coderabbitai" && request.head === "abc123"));
    assert.ok(payload.rounds.some(round => round.head === "abc123" && round.verdict === "approve"));
  });

  it("does not reuse a prior-head round verdict when recording a new-head request", async () => {
    const existing = [
      `<!-- qube-pr-status:${JSON.stringify({
        version: 1,
        prNumber: 12,
        rounds: [{ head: "old111", verdict: "approve" }],
        requests: [{ reviewerId: "copilot", head: "old111", at: "2026-08-01T00:00:00.000Z" }],
      })} -->`,
      "",
      "Review status: approve.",
      "Head: old111.",
    ].join("\n");
    const fixture = createReviewRequestFixture({
      comments: [{
        author: { login: "executor" },
        body: existing,
        url: "https://github.com/example/repo/pull/12#issuecomment-9",
      }],
    });
    const provider = createGitHubReviewForgeProvider({ exec: fixture.exec });
    const snapshot = await provider.loadPullRequestReview(12);
    const plan = provider.planReviewRequest(snapshot.item, policy(["@copilot"]));
    await provider.apply(plan);

    const payload = parseStatusPayload(statusComments(fixture.comments)[0].body);
    assert.equal(statusComments(fixture.comments).length, 1);
    assert.deepEqual(payload.rounds, [{ head: "old111", verdict: "approve" }]);
    assert.ok(payload.requests.some(request => request.reviewerId === "copilot" && request.head === "abc123"));
    assert.match(statusComments(fixture.comments)[0].body, /Review status: pending\./);
    assert.match(statusComments(fixture.comments)[0].body, /Head: abc123\./);
    assert.doesNotMatch(statusComments(fixture.comments)[0].body, /Review status: approve\./);
  });

  it("completes after one create when a reread does not yet see the status comment", async () => {
    const fixture = createReviewRequestFixture();
    const exec = async (args, cwd, options) => {
      if (args[0] === "api" && args[1] === "repos/example/repo/issues/12/comments" && !(args.includes("POST"))) {
        return { args, exitCode: 0, stdout: JSON.stringify([]), stderr: "" };
      }
      return fixture.exec(args, cwd, options);
    };
    const provider = createGitHubReviewForgeProvider({ exec });
    const snapshot = await provider.loadPullRequestReview(12);
    const plan = provider.planReviewRequest(snapshot.item, policy(["@copilot"]));
    const results = await provider.apply(plan);
    assert.equal(results.every(result => result.status === "completed"), true);
    assert.equal(statusComments(fixture.comments).length, 1);
    assert.equal(fixture.calls.filter(args => args[0] === "api" && String(args[1]).includes("issues/12/comments") && args.includes("POST")).length, 1);
  });

  it("still posts an external mention comment and records the request on the status comment", async () => {
    const fixture = createReviewRequestFixture();
    const provider = createGitHubReviewForgeProvider({ exec: fixture.exec });
    const snapshot = await provider.loadPullRequestReview(12);
    const plan = provider.planReviewRequest(snapshot.item, policy(["@coderabbitai"]));
    await provider.apply(plan);

    assert.equal(recordedRequestComments(fixture.comments).length, 0);
    assert.equal(fixture.comments.filter(comment => String(comment.body ?? "").includes("@coderabbitai review")).length, 1);
    assert.equal(statusComments(fixture.comments).length, 1);
    const payload = parseStatusPayload(statusComments(fixture.comments)[0].body);
    assert.equal(payload.requests[0].reviewerId, "coderabbitai");
  });
});
