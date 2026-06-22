import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createLinearWorkProvider,
  linearIssueToWorkItem,
} from "../dist/index.js";

function makeLinearIssue(overrides = {}) {
  return {
    id: "lin-issue-1",
    identifier: "ENG-123",
    number: 123,
    title: "Ship Linear support",
    description: "Blocked by: ENG-100\n- [x] map issue\n- [ ] wire provider",
    url: "https://linear.app/acme/issue/ENG-123/ship-linear-support",
    priority: 2,
    archivedAt: null,
    team: { id: "team-1", key: "ENG", name: "Engineering" },
    state: { id: "state-1", name: "In Progress", type: "started" },
    assignee: { id: "user-1", displayName: "Ada" },
    labels: { nodes: [{ id: "label-1", name: "backend" }] },
    project: { id: "project-1", name: "Provider expansion", targetDate: "2026-07-01", status: { name: "Active", type: "started" } },
    relations: { nodes: [] },
    ...overrides,
  };
}

describe("Linear work provider adapter", () => {
  it("maps Linear issues without GitHub-shaped status labels or milestones", () => {
    const item = linearIssueToWorkItem(makeLinearIssue({
      relations: {
        nodes: [
          { type: "blocks", relatedIssue: { id: "lin-issue-200", identifier: "ENG-200" } },
          { type: "blockedBy", relatedIssue: { id: "lin-issue-101", identifier: "ENG-101" } },
        ],
      },
    }));

    assert.equal(item.key.providerId, "linear");
    assert.equal(item.key.id, "ENG-123");
    assert.equal(item.displayId, "ENG-123");
    assert.equal(item.status, "in-progress");
    assert.equal(item.priority, "high");
    assert.deepEqual(item.assignees, ["Ada"]);
    assert.deepEqual(item.blockers, [{ providerId: "linear", id: "ENG-101" }, { providerId: "linear", id: "ENG-100" }]);
    assert.deepEqual(item.blockedBy, [{ providerId: "linear", id: "ENG-200" }]);
    assert.deepEqual(item.checklist, { total: 2, completed: 1 });
    assert.deepEqual(item.project, { id: "project-1", title: "Provider expansion", state: "open", dueOn: "2026-07-01" });
    assert.equal(item.trustedMetadata.linearIdentifier, "ENG-123");
    assert.equal(item.trustedMetadata.githubIssueNumber, undefined);
    assert.ok(item.tags.includes("backend"));
    assert.ok(item.tags.includes("linear:state-type:started"));
  });

  it("lists Linear issues through provider-neutral work items and attaches reverse blockers", async () => {
    const issues = [
      makeLinearIssue({ identifier: "ENG-100", state: { id: "todo", name: "Todo", type: "unstarted" }, priority: 1, description: "" }),
      makeLinearIssue({ identifier: "ENG-123", state: { id: "todo", name: "Todo", type: "unstarted" }, description: "Blocked by: ENG-100", priority: 3 }),
    ];
    const provider = createLinearWorkProvider({
      teamId: "team-1",
      client: {
        async listOpenIssues() {
          return issues;
        },
        async getIssue(id) {
          const issue = issues.find((candidate) => candidate.identifier === id || candidate.id === id);
          if (!issue) throw new Error(`missing fixture issue ${id}`);
          return issue;
        },
      },
    });

    const items = await provider.listOpenWorkItems();

    assert.equal(provider.capabilities().listOpenWork, true);
    assert.equal(provider.capabilities().applyLifecycleMutations, false);
    assert.deepEqual(items.map((item) => item.displayId), ["ENG-100", "ENG-123"]);
    assert.deepEqual(items.find((item) => item.key.id === "ENG-100")?.blockedBy, [{ providerId: "linear", id: "ENG-123" }]);
    assert.deepEqual(items.find((item) => item.key.id === "ENG-123")?.blockers, [{ providerId: "linear", id: "ENG-100" }]);
  });

  it("reports unsupported lifecycle mutations instead of falling back to GitHub labels", async () => {
    const issue = makeLinearIssue();
    const provider = createLinearWorkProvider({
      teamId: "team-1",
      client: {
        async listOpenIssues() {
          return [issue];
        },
        async getIssue() {
          return issue;
        },
      },
    });
    const item = await provider.getWorkItem({ providerId: "linear", id: "ENG-123" });
    const plan = provider.planStart(item, {});
    const result = (await provider.apply(plan))[0];

    assert.equal(plan.actions[0].kind, "start-work");
    assert.equal(plan.actions[0].details.providerId, "linear");
    assert.equal(result.status, "failed");
    assert.match(result.failure.cause, /not implemented/);
    assert.match(result.failure.nextAction, /Linear workflow-state/);
  });

  it("handles unknown Linear states and rejects non-Linear work item keys", async () => {
    const item = linearIssueToWorkItem(makeLinearIssue({ state: null, priority: null, description: "No blockers here." }));
    const provider = createLinearWorkProvider({
      teamId: "team-1",
      client: {
        async listOpenIssues() {
          return [];
        },
        async getIssue() {
          return makeLinearIssue();
        },
      },
    });

    assert.equal(item.status, "unknown");
    assert.equal(item.priority, "none");
    assert.deepEqual(item.blockers, []);
    await assert.rejects(
      () => provider.getWorkItem({ providerId: "github", id: "123" }),
      /providerId github is unsupported/,
    );
  });

  it("times out stalled Linear GraphQL requests with a diagnostic error", async () => {
    const originalFetch = globalThis.fetch;
    let capturedSignal = null;
    try {
      globalThis.fetch = async (_url, options) => {
        capturedSignal = options.signal;
        throw new DOMException("The operation timed out.", "TimeoutError");
      };
      const provider = createLinearWorkProvider({
        apiKey: "linear-token",
        teamId: "team-1",
        requestTimeoutMs: 25,
      });

      await assert.rejects(
        () => provider.listOpenWorkItems(),
        /Linear GraphQL request timed out after 25ms\. Service may be stalling or unreachable\. Verify LINEAR_API_KEY and endpoint, then retry\./,
      );
      assert.ok(capturedSignal instanceof AbortSignal);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
