import { createJenkinsProvisioner, runLiveProvisionerSuite } from "@tjalve/qube-testkit";
import { createJenkinsCiProvider, jenkinsAdapter, probeJenkinsConnection } from "../dist/index.js";

const connectionFixture = {
  http: {
    status: 200,
    body: { authenticated: true, name: "fixture-user" },
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
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: headerMap({ "content-type": "application/json", ...headers }),
    async json() { return body; },
    async text() { return text; },
  };
}

function emptyResponse(status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: headerMap(),
    async json() { return undefined; },
    async text() { return ""; },
  };
}

function createJenkinsFixtureFetch() {
  const store = {
    folders: new Map(),
  };

  return async (url, init = {}) => {
    const href = String(url);
    const method = String(init.method ?? "GET").toUpperCase();
    const parsed = new URL(href);
    const path = parsed.pathname.replace(/\/+$/, "") || "/";

    if (method === "GET" && path.endsWith("/whoAmI/api/json")) {
      return jsonResponse({ authenticated: true, name: "fixture-user" });
    }
    if (method === "GET" && path.endsWith("/crumbIssuer/api/json")) {
      return jsonResponse(
        { crumb: "crumb-fixture", crumbRequestField: "Jenkins-Crumb" },
        { headers: { "set-cookie": "JSESSIONID=fixture" } },
      );
    }
    if (method === "GET" && path === "/api/json") {
      return jsonResponse({ jobs: [...store.folders.keys()].map(name => ({ name, _class: "com.cloudbees.hudson.plugins.folder.Folder" })) });
    }
    if (method === "POST" && path === "/createItem") {
      const name = parsed.searchParams.get("name") ?? "";
      store.folders.set(name, { name, jobs: new Map() });
      return emptyResponse(200);
    }

    const parts = path.split("/").filter(Boolean);
    if (parts[0] !== "job" || parts.length < 2) {
      return jsonResponse({ message: `unexpected ${method} ${path}` }, { status: 404 });
    }
    const folderName = decodeURIComponent(parts[1]);
    const folder = store.folders.get(folderName);

    if (parts.length === 3 && parts[2] === "doDelete" && method === "POST") {
      store.folders.delete(folderName);
      return emptyResponse(204);
    }
    if (parts.length === 3 && parts[2] === "createItem" && method === "POST") {
      if (!folder) return jsonResponse({ message: "404" }, { status: 404 });
      const name = parsed.searchParams.get("name") ?? "";
      folder.jobs.set(name, { name, description: String(init.body ?? "") });
      return emptyResponse(200);
    }
    if (parts.length === 4 && parts[2] === "api" && parts[3] === "json" && method === "GET") {
      if (!folder) return jsonResponse({ message: "404" }, { status: 404 });
      return jsonResponse({ name: folder.name, jobs: [...folder.jobs.keys()].map(name => ({ name })) });
    }
    if (parts.length === 6 && parts[2] === "job" && parts[4] === "api" && parts[5] === "json" && method === "GET") {
      const jobName = decodeURIComponent(parts[3]);
      if (!folder?.jobs.has(jobName)) return jsonResponse({ message: "404" }, { status: 404 });
      return jsonResponse({ name: jobName, disabled: true });
    }
    if (parts.length === 5 && parts[2] === "job" && parts[4] === "doDelete" && method === "POST") {
      const jobName = decodeURIComponent(parts[3]);
      folder?.jobs.delete(jobName);
      return emptyResponse(204);
    }
    return jsonResponse({ message: `unexpected ${method} ${path}` }, { status: 404 });
  };
}

const fixtureFetch = createJenkinsFixtureFetch();

runLiveProvisionerSuite({
  adapter: jenkinsAdapter,
  createProvisioner: context => createJenkinsProvisioner(context),
  createCiProvider: (_sandbox, context) => createJenkinsCiProvider({
    user: context.env.JENKINS_USER ?? "fixture-user",
    apiToken: context.env.JENKINS_API_TOKEN ?? "fixture-token",
    baseUrl: String(context.config.baseUrl ?? context.env.JENKINS_BASE_URL ?? "https://jenkins.example.com"),
    fetch: context.fetchImpl,
  }),
  probe: options => probeJenkinsConnection({
    ...options,
    env: {
      JENKINS_USER: "fixture-user",
      JENKINS_API_TOKEN: "fixture-token",
      JENKINS_BASE_URL: "https://jenkins.example.com",
      ...(options.env ?? {}),
    },
    config: { baseUrl: "https://jenkins.example.com", user: "fixture-user", ...(options.config ?? {}) },
  }),
  env: {
    QUBE_TESTKIT_LIVE: "1",
    JENKINS_USER: "fixture-user",
    JENKINS_API_TOKEN: "fixture-token",
    JENKINS_BASE_URL: "https://jenkins.example.com",
  },
  config: { baseUrl: "https://jenkins.example.com", user: "fixture-user" },
  fetchImpl: fixtureFetch,
  probeOptions: { mode: "fixture", fixture: connectionFixture },
});
