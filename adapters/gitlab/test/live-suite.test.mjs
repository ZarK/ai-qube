import { createGitLabProvisioner, runLiveProvisionerSuite } from "@tjalve/qube-testkit";
import {
  createGitLabReviewForgeProvider,
  createGitLabWorkProvider,
  gitLabAdapter,
  probeGitLabConnection,
} from "../dist/index.js";

const connectionFixture = {
  http: {
    status: 200,
    body: { id: 7, username: "fixture-bot" },
  },
};

function headerMap(headers = {}) {
  return {
    get(name) {
      const key = Object.keys(headers).find(candidate => candidate.toLowerCase() === String(name).toLowerCase());
      return key ? headers[key] : null;
    },
  };
}

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  const text = body === undefined ? "" : JSON.stringify(body);
  const encoded = new TextEncoder().encode(text);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: headerMap({ "content-length": String(encoded.byteLength), ...headers }),
    async json() { return body; },
    async text() { return text; },
    body: {
      getReader() {
        let done = false;
        return {
          async read() {
            if (done) return { done: true, value: undefined };
            done = true;
            return { done: false, value: encoded };
          },
          async cancel() { done = true; },
        };
      },
    },
  };
}

function createGitLabFixtureFetch() {
  const store = {
    projects: new Map(),
    issues: new Map(),
    links: new Map(),
    branches: new Map(),
    mergeRequests: new Map(),
    notes: new Map(),
    next: 1,
  };

  return async (url, init = {}) => {
    const href = String(url);
    const method = String(init.method ?? "GET").toUpperCase();
    const parsed = new URL(href);
    const path = parsed.pathname.replace(/\/api\/v4/, "");
    const body = typeof init.body === "string" && init.body !== "" ? JSON.parse(init.body) : {};

    if (method === "GET" && (path === "/user" || path === "/user/")) {
      return jsonResponse({ id: 7, username: "fixture-bot", name: "Fixture Bot" });
    }

    if (method === "POST" && path === "/projects") {
      const id = store.next++;
      const project = {
        id,
        path: body.path,
        path_with_namespace: `fixture/${body.path}`,
        default_branch: "main",
        name: body.name,
      };
      store.projects.set(String(id), project);
      store.issues.set(String(id), []);
      store.links.set(String(id), new Map());
      store.branches.set(String(id), ["main"]);
      store.mergeRequests.set(String(id), []);
      store.notes.set(String(id), new Map());
      return jsonResponse(project, { status: 201 });
    }

    const projectMatch = path.match(/^\/projects\/([^/]+)(.*)$/);
    if (!projectMatch && method === "GET" && path === "/projects") {
      const search = parsed.searchParams.get("search") ?? "";
      return jsonResponse([...store.projects.values()].filter(project => String(project.path ?? "").includes(search)));
    }

    if (!projectMatch) return jsonResponse({ message: `unexpected ${method} ${path}` }, { status: 404 });
    const projectId = decodeURIComponent(projectMatch[1]);
    const rest = projectMatch[2] ?? "";
    const project = store.projects.get(projectId);
    if (!project && method !== "DELETE") return jsonResponse({ message: "404" }, { status: 404 });

    if (method === "DELETE" && rest === "") {
      store.projects.delete(projectId);
      store.issues.delete(projectId);
      return jsonResponse(undefined, { status: 204 });
    }
    if (method === "GET" && rest === "") return jsonResponse(project);

    if (method === "POST" && rest === "/issues") {
      const iid = (store.issues.get(projectId)?.length ?? 0) + 1;
      const issue = {
        id: 1000 + iid,
        iid,
        project_id: Number(projectId),
        title: body.title,
        description: body.description ?? "",
        state: "opened",
        labels: String(body.labels ?? "").split(",").map(label => label.trim()).filter(Boolean),
        web_url: `https://gitlab.example.com/fixture/${project.path}/-/issues/${iid}`,
        references: { short: `#${iid}` },
        task_completion_status: null,
      };
      store.issues.get(projectId).push(issue);
      return jsonResponse(issue, { status: 201 });
    }
    if (method === "PUT" && /\/issues\/\d+$/.test(rest)) {
      const iid = Number(rest.split("/").pop());
      const issue = store.issues.get(projectId).find(candidate => candidate.iid === iid);
      if (!issue) return jsonResponse({ message: "404" }, { status: 404 });
      if (body.description !== undefined) issue.description = body.description;
      return jsonResponse(issue);
    }
    if (method === "POST" && /\/issues\/\d+\/links$/.test(rest)) {
      const iid = Number(rest.split("/")[2]);
      const links = store.links.get(projectId);
      const list = links.get(String(iid)) ?? [];
      list.push({
        id: store.next++,
        link_type: body.link_type ?? "is_blocked_by",
        source_issue: { iid, project_id: Number(projectId) },
        target_issue: { iid: Number(body.target_issue_iid), project_id: Number(body.target_project_id) },
      });
      links.set(String(iid), list);
      return jsonResponse(list[list.length - 1], { status: 201 });
    }
    if (method === "GET" && /\/issues\/[^/]+\/links$/.test(rest)) {
      const iid = decodeURIComponent(rest.split("/")[2]);
      return jsonResponse(store.links.get(projectId)?.get(String(iid)) ?? []);
    }
    if (method === "GET" && /\/issues\/[^/]+$/.test(rest)) {
      const iid = decodeURIComponent(rest.split("/")[2]);
      const issue = store.issues.get(projectId).find(candidate => String(candidate.iid) === iid);
      if (!issue) return jsonResponse({ message: "404" }, { status: 404 });
      return jsonResponse(issue);
    }
    if (method === "GET" && (rest === "/issues" || rest === "/issues/")) {
      const issues = store.issues.get(projectId) ?? [];
      return jsonResponse(issues, { headers: { "x-next-page": "" } });
    }
    if (method === "POST" && rest === "/repository/branches") {
      store.branches.get(projectId).push(body.branch);
      return jsonResponse({ name: body.branch }, { status: 201 });
    }
    if (method === "POST" && rest === "/repository/commits") {
      return jsonResponse({ id: "abc123" }, { status: 201 });
    }
    if (method === "POST" && rest === "/merge_requests") {
      const iid = (store.mergeRequests.get(projectId)?.length ?? 0) + 1;
      const mr = {
        id: 2000 + iid,
        iid,
        project_id: Number(projectId),
        title: body.title,
        description: "",
        state: "opened",
        web_url: `https://gitlab.example.com/fixture/${project.path}/-/merge_requests/${iid}`,
        source_branch: body.source_branch,
        target_branch: body.target_branch,
        sha: "abc123",
        detailed_merge_status: "mergeable",
      };
      store.mergeRequests.get(projectId).push(mr);
      store.notes.get(projectId).set(String(iid), []);
      return jsonResponse(mr, { status: 201 });
    }
    if (method === "POST" && /\/merge_requests\/\d+\/notes$/.test(rest)) {
      const iid = rest.split("/")[2];
      const note = { id: store.next++, body: body.body, system: false };
      store.notes.get(projectId).get(String(iid)).push(note);
      return jsonResponse(note, { status: 201 });
    }
    if (method === "GET" && /\/merge_requests\/[^/]+$/.test(rest) && !rest.includes("/notes") && !rest.includes("/discussions")) {
      const iid = decodeURIComponent(rest.split("/")[2]);
      const mr = store.mergeRequests.get(projectId).find(candidate => String(candidate.iid) === iid);
      if (!mr) return jsonResponse({ message: "404" }, { status: 404 });
      return jsonResponse(mr);
    }
    if (method === "GET" && /\/merge_requests\/[^/]+\/notes$/.test(rest)) {
      const iid = decodeURIComponent(rest.split("/")[2]);
      return jsonResponse(store.notes.get(projectId)?.get(String(iid)) ?? [], { headers: { "x-next-page": "" } });
    }
    if (method === "GET" && /\/merge_requests\/[^/]+\/discussions$/.test(rest)) {
      return jsonResponse([], { headers: { "x-next-page": "" } });
    }
    return jsonResponse({ message: `unexpected ${method} ${path}` }, { status: 404 });
  };
}

const fixtureFetch = createGitLabFixtureFetch();

runLiveProvisionerSuite({
  adapter: gitLabAdapter,
  createProvisioner: context => createGitLabProvisioner(context),
  createWorkProvider: (sandbox, context) => createGitLabWorkProvider({
    projectId: sandbox.projectId ?? "1",
    token: context.env.GITLAB_TOKEN ?? "fixture-token",
    baseUrl: "https://gitlab.example.com",
    fetch: context.fetchImpl,
    pageSize: 50,
    limit: 100,
    includeIssueLinks: true,
  }),
  createReviewProvider: (sandbox, context) => createGitLabReviewForgeProvider({
    projectId: sandbox.projectId ?? "1",
    token: context.env.GITLAB_TOKEN ?? "fixture-token",
    baseUrl: "https://gitlab.example.com",
    fetch: context.fetchImpl,
  }),
  probe: options => probeGitLabConnection({
    ...options,
    env: { GITLAB_TOKEN: "fixture-token", ...(options.env ?? {}) },
    config: { projectId: "fixture/seed", baseUrl: "https://gitlab.example.com", ...(options.config ?? {}) },
  }),
  env: {
    QUBE_TESTKIT_LIVE: "1",
    GITLAB_TOKEN: "fixture-token",
    GITLAB_PROJECT_ID: "fixture/seed",
    GITLAB_BASE_URL: "https://gitlab.example.com",
  },
  config: { projectId: "fixture/seed", baseUrl: "https://gitlab.example.com" },
  fetchImpl: fixtureFetch,
  probeOptions: { mode: "fixture", fixture: connectionFixture },
});
