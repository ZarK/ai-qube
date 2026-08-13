import { createJiraProvisioner, runLiveProvisionerSuite } from "@tjalve/qube-testkit";
import { createJiraWorkProvider, jiraAdapter, probeJiraConnection } from "../dist/index.js";

const connectionFixture = {
  http: {
    status: 200,
    body: { accountId: "fixture-account", displayName: "Fixture User" },
  },
};

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    async json() { return body; },
    async text() { return body === undefined ? "" : JSON.stringify(body); },
  };
}

function adfText(text) {
  return {
    type: "doc",
    version: 1,
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function createJiraFixtureFetch() {
  const store = {
    projects: new Map(),
    issues: new Map(),
    links: [],
    nextIssue: 1,
  };
  const priorities = [
    { id: "1", name: "Highest" },
    { id: "2", name: "High" },
    { id: "3", name: "Medium" },
    { id: "4", name: "Low" },
  ];
  const statuses = {
    ready: { name: "To Do", statusCategory: { key: "new", name: "To Do" } },
    progress: { name: "In Progress", statusCategory: { key: "indeterminate", name: "In Progress" } },
  };

  return async (url, init = {}) => {
    const href = String(url);
    const method = String(init.method ?? "GET").toUpperCase();
    const parsed = new URL(href);
    const path = parsed.pathname;
    const body = typeof init.body === "string" && init.body !== "" ? JSON.parse(init.body) : {};

    if (method === "GET" && path.endsWith("/rest/api/3/myself")) {
      return jsonResponse({ accountId: "fixture-account", displayName: "Fixture User" });
    }
    if (method === "GET" && path.endsWith("/rest/api/3/priority")) {
      return jsonResponse(priorities);
    }
    if (method === "GET" && path.endsWith("/rest/api/3/project/search")) {
      const query = parsed.searchParams.get("query") ?? "";
      const startAt = Number(parsed.searchParams.get("startAt") ?? "0");
      const maxResults = Number(parsed.searchParams.get("maxResults") ?? "50");
      const values = [...store.projects.values()].filter(project => String(project.name).includes(query));
      const page = values.slice(startAt, startAt + maxResults);
      return jsonResponse({
        values: page,
        startAt,
        maxResults,
        total: values.length,
        isLast: startAt + page.length >= values.length,
      });
    }
    if (method === "POST" && path.endsWith("/rest/api/3/project")) {
      const project = {
        id: String(store.projects.size + 1),
        key: body.key,
        name: body.name,
        issueTypes: [{ id: "10001", name: "Task", subtask: false }],
      };
      store.projects.set(project.key, project);
      store.issues.set(project.key, []);
      return jsonResponse(project, { status: 201 });
    }
    if (method === "POST" && path.endsWith("/rest/api/3/issue")) {
      const projectKey = body.fields?.project?.key;
      const project = store.projects.get(projectKey);
      if (!project) return jsonResponse({ message: "project missing" }, { status: 404 });
      const number = store.nextIssue++;
      const key = `${projectKey}-${number}`;
      const priority = priorities.find(item => item.id === body.fields?.priority?.id) ?? priorities[2];
      const issue = {
        id: String(1000 + number),
        key,
        fields: {
          summary: body.fields?.summary,
          description: body.fields?.description ?? adfText(""),
          issuetype: { id: "10001", name: "Task" },
          status: statuses.ready,
          priority,
          labels: [...(body.fields?.labels ?? [])],
          components: [],
          assignee: null,
          project: { id: project.id, key: project.key, name: project.name },
          issuelinks: [],
          parent: null,
          comment: { comments: [], total: 0 },
        },
      };
      store.issues.get(projectKey).push(issue);
      return jsonResponse({ id: issue.id, key: issue.key }, { status: 201 });
    }
    if (method === "POST" && path.endsWith("/rest/api/3/issueLink")) {
      store.links.push(body);
      const blockerKey = body.outwardIssue?.key;
      const blockedKey = body.inwardIssue?.key;
      for (const issues of store.issues.values()) {
        const blocked = issues.find(issue => issue.key === blockedKey);
        const blocker = issues.find(issue => issue.key === blockerKey);
        if (blocked && blocker) {
          blocked.fields.issuelinks.push({
            type: { name: "Blocks", inward: "is blocked by", outward: "blocks" },
            outwardIssue: { key: blocker.key, fields: { summary: blocker.fields.summary, status: blocker.fields.status } },
          });
          blocker.fields.issuelinks.push({
            type: { name: "Blocks", inward: "is blocked by", outward: "blocks" },
            inwardIssue: { key: blocked.key, fields: { summary: blocked.fields.summary, status: blocked.fields.status } },
          });
        }
      }
      return jsonResponse({}, { status: 201 });
    }

    const projectMatch = path.match(/\/rest\/api\/3\/project\/([^/]+)$/);
    if (projectMatch && method === "GET") {
      const project = store.projects.get(decodeURIComponent(projectMatch[1]));
      if (!project) return jsonResponse({ message: "404" }, { status: 404 });
      return jsonResponse(project);
    }
    if (projectMatch && method === "DELETE") {
      const key = decodeURIComponent(projectMatch[1]);
      store.projects.delete(key);
      store.issues.delete(key);
      return jsonResponse(undefined, { status: 204 });
    }

    const issueMatch = path.match(/\/rest\/api\/3\/issue\/([^/]+)(\/transitions)?$/);
    if (issueMatch) {
      const issueKey = decodeURIComponent(issueMatch[1]);
      const issue = [...store.issues.values()].flat().find(candidate => candidate.key === issueKey);
      if (issueMatch[2] && method === "GET") {
        return jsonResponse({
          transitions: [
            { id: "11", name: "To Do", to: statuses.ready },
            { id: "21", name: "In Progress", to: statuses.progress },
          ],
        });
      }
      if (issueMatch[2] && method === "POST") {
        if (!issue) return jsonResponse({ message: "404" }, { status: 404 });
        if (String(body.transition?.id) === "21") issue.fields.status = statuses.progress;
        if (String(body.transition?.id) === "11") issue.fields.status = statuses.ready;
        return jsonResponse(undefined, { status: 204 });
      }
      if (method === "GET") {
        if (!issue) return jsonResponse({ message: "404" }, { status: 404 });
        return jsonResponse(issue);
      }
      if (method === "PUT") {
        if (!issue) return jsonResponse({ message: "404" }, { status: 404 });
        if (body.fields?.description) issue.fields.description = body.fields.description;
        return jsonResponse(undefined, { status: 204 });
      }
    }

    if (method === "GET" && path.endsWith("/rest/api/3/search")) {
      const jql = parsed.searchParams.get("jql") ?? "";
      const projectKey = /project\s*=\s*"([^"]+)"/.exec(jql)?.[1];
      const issues = projectKey ? (store.issues.get(projectKey) ?? []) : [...store.issues.values()].flat();
      return jsonResponse({
        startAt: 0,
        maxResults: issues.length,
        total: issues.length,
        issues,
      });
    }

    return jsonResponse({ message: `unexpected ${method} ${path}` }, { status: 404 });
  };
}

const fixtureFetch = createJiraFixtureFetch();

runLiveProvisionerSuite({
  adapter: jiraAdapter,
  createProvisioner: context => createJiraProvisioner(context),
  createWorkProvider: (sandbox, context) => createJiraWorkProvider({
    projectKey: sandbox.projectId ?? "QFIXTURE",
    email: context.env.JIRA_EMAIL ?? "fixture@example.com",
    apiToken: context.env.JIRA_API_TOKEN ?? "fixture-token",
    baseUrl: String(context.config.baseUrl ?? context.env.JIRA_BASE_URL ?? "https://fixture.atlassian.net"),
    fetch: context.fetchImpl,
    pageSize: 50,
    limit: 100,
  }),
  probe: options => probeJiraConnection({
    ...options,
    env: {
      JIRA_EMAIL: "fixture@example.com",
      JIRA_API_TOKEN: "fixture-token",
      JIRA_BASE_URL: "https://fixture.atlassian.net",
      ...(options.env ?? {}),
    },
    config: { baseUrl: "https://fixture.atlassian.net", ...(options.config ?? {}) },
  }),
  env: {
    QUBE_TESTKIT_LIVE: "1",
    JIRA_EMAIL: "fixture@example.com",
    JIRA_API_TOKEN: "fixture-token",
    JIRA_BASE_URL: "https://fixture.atlassian.net",
  },
  config: { baseUrl: "https://fixture.atlassian.net" },
  fetchImpl: fixtureFetch,
  probeOptions: { mode: "fixture", fixture: connectionFixture },
});
