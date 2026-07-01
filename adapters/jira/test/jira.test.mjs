import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createJiraWorkProvider,
  jiraIssueToWorkItem,
  renderJiraIssueDraft,
} from "../dist/index.js";

function makeJiraIssue(overrides = {}) {
  const { fields: fieldOverrides = {}, ...issueOverrides } = overrides;
  return {
    id: "10001",
    key: "ENG-123",
    self: "https://jira.example.com/rest/api/3/issue/10001",
    fields: {
      summary: "Ship Jira support",
      description: "Sequence: 42\n- [x] map issue\n- [ ] wire provider",
      issuetype: { id: "10003", name: "Story" },
      status: { id: "3", name: "In Review", statusCategory: { key: "indeterminate", name: "In Progress" } },
      priority: { id: "2", name: "Urgent" },
      labels: ["backend", "provider"],
      components: [{ id: "component-1", name: "Architecture" }],
      assignee: { accountId: "user-1", displayName: "Ada" },
      project: { id: "project-1", key: "ENG", name: "Engineering" },
      comment: {
        total: 2,
        comments: [
          { id: "comment-1", author: { displayName: "Grace" }, body: "Looks good." },
          { id: "comment-2", author: { displayName: "Linus" }, body: "Needs blocker mapping." },
        ],
      },
      issuelinks: [],
      customfield_10020: [{ id: 7, name: "Sprint 7", state: "active" }],
      customfield_10014: "EPIC-9",
      ...fieldOverrides,
    },
    ...issueOverrides,
  };
}

describe("Jira work provider adapter", () => {
  it("maps Jira issues with schema-driven status, priority, sprint, epic, comments, and links", () => {
    const issue = makeJiraIssue({
      fields: {
        issuelinks: [
          {
            type: { name: "Blocks", inward: "is blocked by", outward: "blocks" },
            inwardIssue: { id: "10000", key: "ENG-100" },
          },
          {
            type: { name: "Blocks", inward: "is blocked by", outward: "blocks" },
            outwardIssue: { id: "10002", key: "ENG-200" },
          },
        ],
      },
    });
    const item = jiraIssueToWorkItem(issue, {
      statusMap: { "In Review": "in-progress" },
      priorityMap: { Urgent: "critical" },
      sprintField: "customfield_10020",
      epicField: "customfield_10014",
    });

    assert.equal(item.key.providerId, "jira");
    assert.equal(item.key.id, "ENG-123");
    assert.equal(item.displayId, "ENG-123");
    assert.equal(item.title, "Ship Jira support");
    assert.equal(item.status, "in-progress");
    assert.equal(item.priority, "critical");
    assert.deepEqual(item.assignees, ["Ada"]);
    assert.deepEqual(item.blockers, [{ providerId: "jira", id: "ENG-100" }]);
    assert.deepEqual(item.blockedBy, [{ providerId: "jira", id: "ENG-200" }]);
    assert.deepEqual(item.checklist, { total: 2, completed: 1 });
    assert.deepEqual(item.project, { id: "ENG", title: "Engineering", state: "unknown", dueOn: null });
    assert.equal(item.sequence, "42");
    assert.equal(item.trustedMetadata.jiraIssueId, "10001");
    assert.equal(item.trustedMetadata.jiraEpicKey, "EPIC-9");
    assert.deepEqual(item.trustedMetadata.jiraSprints, ["Sprint 7"]);
    assert.equal(item.trustedMetadata.jiraCommentCount, 2);
    assert.deepEqual(item.trustedMetadata.jiraLatestCommentAuthors, ["Grace", "Linus"]);
    assert.equal(item.trustedMetadata.githubIssueNumber, undefined);
    assert.ok(item.tags.includes("backend"));
    assert.ok(item.tags.includes("jira:component:Architecture"));
    assert.ok(item.tags.includes("jira:sprint:Sprint 7"));
  });

  it("reads Jira work items from fixture clients and attaches reverse blockers", async () => {
    const issues = [
      makeJiraIssue({
        key: "OPS-1",
        fields: {
          summary: "Triage incident",
          status: { name: "Waiting for customer", statusCategory: { key: "indeterminate" } },
          priority: { name: "P0" },
          project: { key: "OPS", name: "Operations" },
          labels: [],
          components: [],
          assignee: null,
          description: "",
        },
      }),
      makeJiraIssue({
        key: "OPS-2",
        fields: {
          summary: "Resolve incident",
          status: { name: "Queued", statusCategory: { key: "new" } },
          priority: { name: "P2" },
          project: { key: "OPS", name: "Operations" },
          issuelinks: [
            {
              type: { name: "Dependency", inward: "depends on", outward: "is required by" },
              inwardIssue: { key: "OPS-1" },
            },
          ],
        },
      }),
    ];
    const provider = createJiraWorkProvider({
      projectKey: "OPS",
      workflowSchema: {
        statusMap: { "Waiting for customer": "blocked", Queued: "ready" },
        priorityMap: { P0: "critical", P2: "high" },
        linkRules: [{ typeName: "Dependency", inward: "blocker", outward: "blockedBy" }],
        sprintField: "customfield_10020",
        epicField: "customfield_10014",
      },
      client: {
        async listIssues(input) {
          assert.equal(input.jql, 'project = "OPS" AND resolution = Unresolved ORDER BY priority DESC, updated DESC');
          assert.ok(input.fields.includes("customfield_10020"));
          assert.ok(input.fields.includes("customfield_10014"));
          return issues;
        },
        async getIssue(key) {
          const issue = issues.find((candidate) => candidate.key === key);
          if (!issue) throw new Error(`missing fixture issue ${key}`);
          return issue;
        },
      },
    });

    const items = await provider.listOpenWorkItems();

    assert.equal(provider.capabilities().listOpenWork, true);
    assert.equal(provider.capabilities().applyLifecycleMutations, false);
    assert.deepEqual(items.map((item) => item.displayId), ["OPS-1", "OPS-2"]);
    assert.equal(items.find((item) => item.key.id === "OPS-1")?.status, "blocked");
    assert.equal(items.find((item) => item.key.id === "OPS-1")?.priority, "critical");
    assert.deepEqual(items.find((item) => item.key.id === "OPS-1")?.blockedBy, [{ providerId: "jira", id: "OPS-2" }]);
    assert.deepEqual(items.find((item) => item.key.id === "OPS-2")?.blockers, [{ providerId: "jira", id: "OPS-1" }]);
  });

  it("renders provider-neutral drafts into Jira previews without mutation fields", () => {
    const rendered = renderJiraIssueDraft({
      title: "Build neutral contracts",
      priority: "high",
      status: "ready",
      components: ["Architecture"],
      blockedBy: ["ENG-1"],
      sequence: 2,
      bodySections: [{ heading: "Summary", body: "Define provider-neutral contracts." }],
      providerMetadata: {
        jira: {
          projectKey: "ENG",
          issueType: "Story",
          priorityName: "Highest",
          labels: ["ready", "architecture"],
          components: ["Platform"],
          blockedBy: ["ENG-1"],
          url: "https://jira.example.com/browse/ENG-2",
        },
      },
    });

    assert.equal(rendered.summary, "Build neutral contracts");
    assert.equal(rendered.projectKey, "ENG");
    assert.equal(rendered.issueType, "Story");
    assert.equal(rendered.priorityName, "Highest");
    assert.deepEqual(rendered.labels, ["ready", "architecture"]);
    assert.deepEqual(rendered.components, ["Platform"]);
    assert.deepEqual(rendered.blockedBy, ["ENG-1"]);
    assert.match(rendered.description, /^Blocked by: ENG-1/m);
    assert.match(rendered.description, /^Sequence: 2/m);
    assert.equal(rendered.url, "https://jira.example.com/browse/ENG-2");
  });

  it("reports missing Jira credentials and unsupported mutations explicitly", async () => {
    assert.throws(
      () => createJiraWorkProvider({ baseUrl: "", email: "", apiToken: "", projectKey: "ENG" }),
      /JIRA_BASE_URL/,
    );
    assert.throws(
      () => createJiraWorkProvider({ baseUrl: "http://jira.example.com", email: "user@example.com", apiToken: "token", projectKey: "ENG" }),
      /requires JIRA_BASE_URL to use https/,
    );
    assert.throws(
      () => createJiraWorkProvider({ baseUrl: "https://jira.example.com", email: "user@example.com", apiToken: "token", projectKey: 'ENG" OR project = OPS' }),
      /projectKey must be a Jira project key/,
    );

    const issue = makeJiraIssue();
    const provider = createJiraWorkProvider({
      projectKey: "ENG",
      client: {
        async listIssues() {
          return [issue];
        },
        async getIssue() {
          return issue;
        },
      },
    });
    const item = await provider.getWorkItem({ providerId: "jira", id: "ENG-123" });
    const plan = provider.planStart(item, {});
    const result = (await provider.apply(plan))[0];

    assert.equal(plan.actions[0].kind, "start-work");
    assert.equal(plan.actions[0].details.providerId, "jira");
    assert.equal(result.status, "failed");
    assert.match(result.failure.cause, /not implemented/);
    assert.match(result.failure.nextAction, /Jira workflow transition/);
    await assert.rejects(
      () => provider.getWorkItem({ providerId: "github", id: "123" }),
      /providerId github is unsupported/,
    );
  });

  it("paginates Jira search reads and requests configured custom fields", async () => {
    const originalFetch = globalThis.fetch;
    const requests = [];
    try {
      globalThis.fetch = async (url, options) => {
        const requestUrl = new URL(String(url));
        requests.push({ url: requestUrl, options });
        const startAt = Number(requestUrl.searchParams.get("startAt"));
        const pageSize = startAt === 0 ? 100 : 50;
        return {
          ok: true,
          async json() {
            return {
              startAt,
              maxResults: pageSize,
              total: 150,
              issues: Array.from({ length: pageSize }, (_value, index) => makeJiraIssue({
                id: String(startAt + index + 1),
                key: `ENG-${startAt + index + 1}`,
              })),
            };
          },
        };
      };
      const provider = createJiraWorkProvider({
        baseUrl: "https://jira.example.com/",
        email: "user@example.com",
        apiToken: "token",
        projectKey: "ENG",
        limit: 150,
        workflowSchema: {
          sprintField: "customfield_10020",
          epicField: "customfield_10014",
        },
      });

      const items = await provider.listOpenWorkItems();

      assert.equal(items.length, 150);
      assert.deepEqual(requests.map((request) => request.url.searchParams.get("startAt")), ["0", "100"]);
      assert.deepEqual(requests.map((request) => request.url.searchParams.get("maxResults")), ["100", "50"]);
      assert.ok(requests[0].url.searchParams.get("fields").includes("customfield_10020"));
      assert.ok(requests[0].url.searchParams.get("fields").includes("customfield_10014"));
      assert.match(requests[0].options.headers.Authorization, /^Basic /);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
