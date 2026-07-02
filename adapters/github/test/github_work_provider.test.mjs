import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { computeWorkQueue, planStatusSyncFromWorkItems } from "@tjalve/qube-core";
import { createGitHubWorkProvider } from "../dist/index.js";

function success(args, stdout = "") {
  return { args, exitCode: 0, stdout, stderr: "" };
}

function failure(args, stderr = "permission denied") {
  return { args, exitCode: 1, stdout: "", stderr };
}

function makeIssue(number, overrides = {}) {
  return {
    number,
    title: `Issue ${number}`,
    body: "",
    state: "OPEN",
    labels: [],
    assignees: [],
    milestone: null,
    url: `https://github.com/example/repo/issues/${number}`,
    ...overrides,
  };
}

function makeFixtureExec(responses, calls = []) {
  return async (args) => {
    calls.push(args);
    const key = args.join(" ");
    return responses[key] ?? failure(args, `unexpected gh call: ${key}`);
  };
}

function statusPolicy() {
  return {
    labels: {
      priorities: ["P1-Critical", "P2-High", "P3-Medium", "P4-Low"].map(name => ({ name })),
      statuses: ["S-Ready", "S-InProgress", "S-Blocked", "S-Blocking"].map(name => ({ name })),
    },
    milestoneOrdering: { enabled: false, order: [], missingAssignment: "warn" },
  };
}

const queuePolicy = {
  priorityLabels: ["P1-Critical", "P2-High", "P3-Medium", "P4-Low"],
  statusLabels: ["S-Ready", "S-InProgress", "S-Blocked", "S-Blocking"],
  milestoneOrdering: { enabled: false, order: [], missingAssignment: "warn" },
};

describe("GitHub work provider", () => {
  it("maps GitHub issues to provider-neutral work items with reverse blockers", async () => {
    const issueList = [
      makeIssue(17, { title: "Blocked base", labels: [{ name: "P1-Critical" }, { name: "S-Ready" }], assignees: [{ login: "octo" }] }),
      makeIssue(42, {
        title: "1.2 Dependent work",
        body: "Sequence: beta\nBlocked by: #17\n- [x] done\n- [ ] todo",
        labels: [{ name: "P2-High" }, { name: "S-Ready" }, { name: "C-Backend" }],
        milestone: { number: 3, title: "Product", state: "OPEN", dueOn: "2026-06-01T00:00:00Z" },
      }),
    ];
    const exec = makeFixtureExec({
      "issue list --state open --json number,title,state,labels,assignees,body,milestone,url --limit 1000": success([], JSON.stringify(issueList)),
    });

    const provider = createGitHubWorkProvider({ exec });
    const items = await provider.listOpenWorkItems();
    const base = items.find(item => item.key.id === "17");
    const dependent = items.find(item => item.key.id === "42");

    assert.equal(base.assignees[0], "octo");
    assert.deepEqual(base.blockedBy, [{ providerId: "github", id: "42" }]);
    assert.equal(dependent.status, "ready");
    assert.equal(dependent.priority, "high");
    assert.deepEqual(dependent.blockers, [{ providerId: "github", id: "17" }]);
    assert.equal(dependent.sequence, "beta");
    assert.deepEqual(dependent.checklist, { total: 2, completed: 1 });
    assert.deepEqual(dependent.project, { id: "3", title: "Product", state: "open", dueOn: "2026-06-01T00:00:00Z" });
  });

  it("keeps queue and dependency computations provider-neutral after mapping", async () => {
    const issueList = [
      makeIssue(30, { labels: [{ name: "P3-Medium" }, { name: "S-Ready" }] }),
      makeIssue(22, { title: "2.1 Lower issue tie-break", body: "Sequence: alpha", labels: [{ name: "P2-High" }, { name: "S-Ready" }] }),
      makeIssue(23, { title: "2.1 Lower issue tie-break", body: "Sequence: alpha", labels: [{ name: "P2-High" }, { name: "S-Ready" }] }),
      makeIssue(21, { title: "2.1 Later sequence", body: "Sequence: beta", labels: [{ name: "P2-High" }, { name: "S-Ready" }] }),
    ];
    const exec = makeFixtureExec({
      "issue list --state open --json number,title,state,labels,assignees,body,milestone,url --limit 1000": success([], JSON.stringify(issueList)),
    });

    const items = await createGitHubWorkProvider({ exec }).listOpenWorkItems();
    const queue = computeWorkQueue(items, queuePolicy);
    const plans = planStatusSyncFromWorkItems(items, queuePolicy);

    assert.deepEqual(queue.items.map(item => Number(item.workItem.key.id)), [22, 23, 21, 30]);
    assert.deepEqual(plans.map(plan => Number(plan.key.id)), [30, 22, 23, 21]);
  });

  it("plans and applies status sync through typed provider actions", async () => {
    const issueList = [
      makeIssue(40, { labels: [{ name: "S-Ready" }] }),
      makeIssue(50, { body: "Blocked by: #40", labels: [] }),
    ];
    const calls = [];
    const exec = makeFixtureExec({
      "issue list --state open --json number,title,state,labels,assignees,body,milestone,url --limit 1000": success([], JSON.stringify(issueList)),
      "issue edit 40 --add-label S-Blocking": success([]),
      "issue edit 50 --add-label S-Blocked": success([]),
    }, calls);
    const provider = createGitHubWorkProvider({ exec });
    const items = await provider.listOpenWorkItems();
    const plan = provider.planStatusSync(items, statusPolicy());
    const results = await provider.apply(plan);

    assert.deepEqual(plan.actions.map(action => action.details.issueNumber), [40, 50]);
    assert.deepEqual(results.map(result => result.status), ["completed", "completed"]);
    assert.equal(calls.some(args => args.join(" ") === "issue edit 40 --add-label S-Blocking"), true);
    assert.equal(calls.some(args => args.join(" ") === "issue edit 50 --add-label S-Blocked"), true);
  });

  it("returns structured action failures when GitHub mutation fails", async () => {
    const issueList = [makeIssue(60, { labels: [] })];
    const exec = makeFixtureExec({
      "issue list --state open --json number,title,state,labels,assignees,body,milestone,url --limit 1000": success([], JSON.stringify(issueList)),
      "issue edit 60 --add-label S-Ready": failure([], "permission denied"),
    });
    const provider = createGitHubWorkProvider({ exec });
    const items = await provider.listOpenWorkItems();
    const results = await provider.apply(provider.planStatusSync(items, statusPolicy()));

    assert.equal(results[0].status, "failed");
    assert.match(results[0].failure.operation, /Synchronize dependency status labels/);
    assert.match(results[0].failure.cause, /permission denied/);
    assert.match(results[0].failure.nextAction, /gh authentication/);
  });

  it("refreshes completion dependents without touching active work or leaving stale blocking labels", async () => {
    const issueList = [
      makeIssue(70, { labels: [{ name: "S-InProgress" }] }),
      makeIssue(71, { body: "Blocked by: #70", labels: [{ name: "S-Blocked" }, { name: "S-Blocking" }] }),
      makeIssue(72, { body: "Blocked by: #70", labels: [{ name: "S-InProgress" }, { name: "S-Blocked" }] }),
    ];
    const exec = makeFixtureExec({
      "issue list --state open --json number,title,state,labels,assignees,body,milestone,url --limit 1000": success([], JSON.stringify(issueList)),
    });
    const provider = createGitHubWorkProvider({ exec });
    const items = await provider.listOpenWorkItems();
    const completed = items.find(item => item.key.id === "70");
    const dependents = items.filter(item => item.key.id !== "70");
    const plan = provider.planComplete(completed, dependents, statusPolicy());

    const dependentAction = plan.actions.find(action => action.details.issueNumber === 71);
    assert.deepEqual(dependentAction.details.addLabels, ["S-Ready"]);
    assert.deepEqual(dependentAction.details.removeLabels, ["S-Blocked", "S-Blocking"]);
    assert.equal(plan.actions.some(action => action.details.issueNumber === 72), false);
  });
});
