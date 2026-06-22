import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createGitLabWorkProvider,
  gitLabIssueToWorkItem,
} from "../dist/index.js";

function makeGitLabIssue(overrides = {}) {
  return {
    id: 1001,
    iid: 42,
    project_id: 7,
    title: "Ship GitLab support",
    description: "Blocked by: #8\nSequence: 20\n- [x] map issue\n- [ ] wire provider",
    state: "opened",
    labels: ["S-InProgress", "P2-High", "backend"],
    assignees: [{ id: 1, name: "Ada", username: "ada" }],
    milestone: { id: 3, iid: 1, title: "Provider expansion", state: "active", due_date: "2026-08-01" },
    web_url: "https://gitlab.example.com/acme/qube/-/issues/42",
    references: { short: "#42", relative: "#42", full: "acme/qube#42" },
    task_completion_status: { count: 2, completed_count: 1 },
    issue_type: "issue",
    weight: 3,
    links: [],
    ...overrides,
  };
}

describe("GitLab work provider adapter", () => {
  it("maps GitLab issues without inventing GitHub issue semantics", () => {
    const item = gitLabIssueToWorkItem(makeGitLabIssue({
      links: [
        {
          link_type: "is_blocked_by",
          source_issue: { iid: 42, project_id: 7 },
          target_issue: { iid: 7, project_id: 7 },
        },
        {
          link_type: "is_blocked_by",
          source_issue: { iid: 42, project_id: 7 },
          target_issue: { iid: 7, project_id: 99 },
        },
        {
          link_type: "blocks",
          source_issue: { iid: 42, project_id: 7 },
          target_issue: { iid: 99, project_id: 7 },
        },
      ],
    }));

    assert.equal(item.key.providerId, "gitlab");
    assert.equal(item.key.id, "42");
    assert.equal(item.displayId, "#42");
    assert.equal(item.status, "in-progress");
    assert.equal(item.priority, "high");
    assert.deepEqual(item.assignees, ["Ada"]);
    assert.deepEqual(item.blockers, [{ providerId: "gitlab", id: "7" }, { providerId: "gitlab", id: "99:7" }, { providerId: "gitlab", id: "8" }]);
    assert.deepEqual(item.blockedBy, [{ providerId: "gitlab", id: "99" }]);
    assert.deepEqual(item.checklist, { total: 2, completed: 1 });
    assert.deepEqual(item.project, { id: "3", title: "Provider expansion", state: "open", dueOn: "2026-08-01" });
    assert.equal(item.sequence, "20");
    assert.equal(item.trustedMetadata.gitlabIssueIid, 42);
    assert.equal(item.trustedMetadata.githubIssueNumber, undefined);
    assert.ok(item.tags.includes("backend"));
    assert.ok(item.tags.includes("gitlab:state:opened"));
  });

  it("lists GitLab issues through provider-neutral work items and attaches reverse blockers", async () => {
    const issues = [
      makeGitLabIssue({ iid: 8, id: 1008, labels: ["S-Ready", "P3-Medium"], description: "", references: { short: "#8", relative: "#8", full: "acme/qube#8" }, task_completion_status: { count: 0, completed_count: 0 } }),
      makeGitLabIssue({ iid: 42, id: 1042, labels: ["S-Ready", "P3-Medium"], description: "Blocked by: #8", task_completion_status: { count: 0, completed_count: 0 } }),
    ];
    const provider = createGitLabWorkProvider({
      projectId: "acme/qube",
      client: {
        async listOpenIssues() {
          return issues;
        },
        async getIssue({ iid }) {
          const issue = issues.find((candidate) => String(candidate.iid) === iid || `#${candidate.iid}` === iid);
          if (!issue) throw new Error(`missing fixture issue ${iid}`);
          return issue;
        },
      },
    });

    const items = await provider.listOpenWorkItems();

    assert.equal(provider.capabilities().listOpenWork, true);
    assert.equal(provider.capabilities().applyLifecycleMutations, false);
    assert.deepEqual(items.map((item) => item.displayId), ["#8", "#42"]);
    assert.deepEqual(items.find((item) => item.key.id === "8")?.blockedBy, [{ providerId: "gitlab", id: "42" }]);
    assert.deepEqual(items.find((item) => item.key.id === "42")?.blockers, [{ providerId: "gitlab", id: "8" }]);
  });

  it("reports unsupported lifecycle mutations instead of falling back to GitHub labels", async () => {
    const issue = makeGitLabIssue();
    const provider = createGitLabWorkProvider({
      projectId: "acme/qube",
      client: {
        async listOpenIssues() {
          return [issue];
        },
        async getIssue() {
          return issue;
        },
      },
    });
    const item = await provider.getWorkItem({ providerId: "gitlab", id: "42" });
    const plan = provider.planStart(item, {});
    const result = (await provider.apply(plan))[0];

    assert.equal(plan.actions[0].kind, "start-work");
    assert.equal(plan.actions[0].details.providerId, "gitlab");
    assert.equal(result.status, "failed");
    assert.match(result.failure.cause, /unsupported/);
    assert.match(result.failure.nextAction, /GitLab issue state/);
  });

  it("handles unknown GitLab status labels and rejects non-GitLab work item keys", async () => {
    const item = gitLabIssueToWorkItem(makeGitLabIssue({ labels: [], state: "opened", description: "No blockers here.", task_completion_status: null }));
    const provider = createGitLabWorkProvider({
      projectId: "acme/qube",
      client: {
        async listOpenIssues() {
          return [];
        },
        async getIssue() {
          return makeGitLabIssue();
        },
      },
    });

    assert.equal(item.status, "ready");
    assert.equal(item.priority, "none");
    assert.deepEqual(item.blockers, []);
    await assert.rejects(
      () => provider.getWorkItem({ providerId: "github", id: "42" }),
      /providerId github is unsupported/,
    );
  });

  it("times out stalled GitLab API requests with a diagnostic error", async () => {
    const originalFetch = globalThis.fetch;
    let capturedSignal = null;
    try {
      globalThis.fetch = async (_url, options) => {
        capturedSignal = options.signal;
        throw new DOMException("The operation timed out.", "TimeoutError");
      };
      const provider = createGitLabWorkProvider({
        token: "gitlab-token",
        projectId: "acme/qube",
        requestTimeoutMs: 25,
      });

      await assert.rejects(
        () => provider.listOpenWorkItems(),
        /GitLab API request timed out after 25ms\. Service may be stalling or unreachable\. Verify GITLAB_TOKEN, GITLAB_BASE_URL, and GITLAB_PROJECT_ID, then retry\./,
      );
      assert.ok(capturedSignal instanceof AbortSignal);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses self-managed GitLab base URLs and follows paginated issue reads", async () => {
    const originalFetch = globalThis.fetch;
    const urls = [];
    try {
      globalThis.fetch = async (url) => {
        urls.push(String(url));
        const requestUrl = new URL(String(url));
        const page = requestUrl.searchParams.get("page");
        const headers = new Headers();
        if (page === "1") headers.set("x-next-page", "2");
        const issue = makeGitLabIssue({
          id: page === "1" ? 1001 : 1002,
          iid: page === "1" ? 1 : 2,
          labels: ["S-Ready"],
          description: "",
          task_completion_status: { count: 0, completed_count: 0 },
          references: { short: `#${page}`, relative: `#${page}`, full: `acme/qube#${page}` },
        });
        return new Response(JSON.stringify([issue]), { status: 200, headers });
      };
      const provider = createGitLabWorkProvider({
        token: "gitlab-token",
        projectId: "acme/qube",
        baseUrl: "https://gitlab.internal.example.com/",
        includeIssueLinks: false,
        limit: 2,
      });

      const items = await provider.listOpenWorkItems();
      const first = new URL(urls[0]);
      const second = new URL(urls[1]);

      assert.deepEqual(items.map((item) => item.key.id), ["1", "2"]);
      assert.equal(first.origin, "https://gitlab.internal.example.com");
      assert.match(first.pathname, /\/api\/v4\/projects\/acme%2Fqube\/issues$/);
      assert.equal(first.searchParams.get("page"), "1");
      assert.equal(first.searchParams.get("per_page"), "2");
      assert.equal(second.searchParams.get("page"), "2");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reports non-OK GitLab API responses with the HTTP status", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => new Response(JSON.stringify({ message: "unauthorized" }), { status: 401 });
      const provider = createGitLabWorkProvider({
        token: "gitlab-token",
        projectId: "acme/qube",
        includeIssueLinks: false,
      });

      await assert.rejects(
        () => provider.listOpenWorkItems(),
        /GitLab API request failed while reading .*\/issues\. Cause: HTTP 401\. Next action: verify GITLAB_TOKEN/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
