import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  LIVE_SUITE_BOOTSTRAP_CHECKLISTS,
  LIVE_SUITE_PROVIDERS,
  RequestBudget,
  SHARED_SEED_MANIFEST,
  assertBootstrapChecklistsCoverLiveProviders,
  createGitLabProvisioner,
  createJenkinsProvisioner,
  createJiraProvisioner,
  evaluateLiveGate,
  jiraProjectKey,
  resourceTag,
  runProvisionerLifecycle,
  seededTitle,
} from "../dist/index.js";

const linearAdapter = {
  id: "linear",
  packageName: "@tjalve/qube-adapter-linear",
  connection: {
    adapterId: "linear",
    configPath: "providers.connections.linear",
    authMethod: "token-env",
    envVars: [{ name: "LINEAR_API_KEY", sensitive: true, purpose: "key" }],
    configFields: [{ name: "teamId", valueType: "string", required: true, purpose: "team", envFallback: "LINEAR_TEAM_ID" }],
    credentialUrl: "https://linear.app/settings/api",
    scopes: [],
    probe: {
      id: "linear-viewer",
      name: "Linear viewer",
      summary: "viewer",
      readOnly: true,
      timeoutMs: 5000,
      verifyCommand: "qube doctor --json",
      transport: { kind: "http", method: "POST", baseUrl: { defaultValue: "https://api.linear.app/graphql" }, path: "" },
    },
  },
};

function passingProbe() {
  return {
    adapterId: "linear",
    probeId: "linear-viewer",
    status: "pass",
    authMethod: "token-env",
    summary: "Linear viewer passed.",
    verifyCommand: "qube doctor --json",
    readOnly: true,
  };
}

function workItem(id, overrides = {}) {
  return {
    key: { providerId: "linear", id },
    displayId: id,
    title: overrides.title ?? id,
    body: overrides.body ?? "- [x] map codec\n- [ ] wire harness",
    url: null,
    state: "open",
    status: overrides.status ?? "ready",
    priority: overrides.priority ?? "high",
    tags: [overrides.tag ?? "qube-testkit-run"],
    assignees: [],
    project: null,
    blockers: overrides.blockers ?? [],
    blockedBy: overrides.blockedBy ?? [],
    sequence: null,
    checklist: overrides.checklist ?? { total: 2, completed: 1 },
    trustedMetadata: {},
    source: { providerId: "linear", resourceKind: "work-item", resourceId: id, url: null, metadata: {} },
  };
}

function createMemoryProvisioner(options = {}) {
  const store = { labels: [], issues: [], failVerify: options.failVerify === true };
  return {
    store,
    provisioner: {
      providerId: "linear",
      mapsBlockedStatus: false,
      async construct() {
        store.labels.push({ id: "label-1", tag: resourceTag("mem1") });
        return {
          providerId: "linear",
          runId: "mem1",
          tag: resourceTag("mem1"),
          teamId: "team-fixture",
          workIds: {},
          resources: [{ kind: "label", id: "label-1", tag: resourceTag("mem1") }],
        };
      },
      async seed(sandbox, manifest) {
        const workIds = {};
        const resources = [...sandbox.resources];
        for (const seed of manifest.workItems) {
          const id = `ENG-${seed.id}`;
          workIds[seed.id] = id;
          store.issues.push({
            id,
            title: seededTitle(sandbox.tag, seed.title),
            status: seed.status === "blocked" ? "ready" : seed.status,
            priority: seed.priority,
            blockers: seed.blockedBy.map(blockerId => ({ providerId: "linear", id: `ENG-${blockerId}` })),
            body: "- [x] map codec\n- [ ] wire harness",
            tag: sandbox.tag,
          });
          resources.push({ kind: "issue", id, tag: sandbox.tag });
        }
        if (store.failVerify) store.issues = [];
        return { ...sandbox, workIds, resources };
      },
      async deconstruct(sandbox) {
        store.issues = store.issues.filter(issue => issue.tag !== sandbox.tag);
        store.labels = store.labels.filter(label => label.tag !== sandbox.tag);
      },
      async sweep(tagPrefix = "qube-testkit-") {
        const leftoverIssues = store.issues.filter(issue => issue.tag.startsWith(tagPrefix));
        const leftoverLabels = store.labels.filter(label => label.tag.startsWith(tagPrefix));
        store.issues = store.issues.filter(issue => !issue.tag.startsWith(tagPrefix));
        store.labels = store.labels.filter(label => !label.tag.startsWith(tagPrefix));
        return [
          ...leftoverIssues.map(issue => ({ kind: "issue", id: issue.id, tag: issue.tag })),
          ...leftoverLabels.map(label => ({ kind: "label", id: label.id, tag: label.tag })),
        ];
      },
    },
    createWorkProvider(sandbox) {
      return {
        id: "linear",
        capabilities() {
          return {
            listOpenWork: true,
            loadWork: true,
            planStatusSync: false,
            planLifecycleMutations: false,
            applyLifecycleMutations: false,
            commentMutations: false,
            reviewIntegration: false,
            ciMergeStatus: false,
          };
        },
        async listOpenWorkItems() {
          return store.issues
            .filter(issue => issue.tag === sandbox.tag)
            .map(issue => workItem(issue.id, issue));
        },
        async getWorkItem(key) {
          const issue = store.issues.find(candidate => candidate.id === key.id);
          if (!issue) throw new Error(`missing ${key.id}`);
          return workItem(issue.id, issue);
        },
        planStatusSync() { return { id: "x", purpose: "x", dryRun: true, actions: [] }; },
        planStart() { return { id: "x", purpose: "x", dryRun: true, actions: [] }; },
        planPause() { return { id: "x", purpose: "x", dryRun: true, actions: [] }; },
        planComplete() { return { id: "x", purpose: "x", dryRun: true, actions: [] }; },
        async apply() { return []; },
      };
    },
  };
}

function liveOptions(overrides = {}) {
  const { memory: memoryInput, ...rest } = overrides;
  const memory = createMemoryProvisioner(memoryInput ?? {});
  return {
    adapter: linearAdapter,
    createProvisioner: () => memory.provisioner,
    createWorkProvider: sandbox => memory.createWorkProvider(sandbox),
    probe: async () => passingProbe(),
    env: {
      QUBE_TESTKIT_LIVE: "1",
      LINEAR_API_KEY: "fixture-key",
      LINEAR_TEAM_ID: "team-fixture",
    },
    config: { teamId: "team-fixture" },
    memory,
    ...rest,
  };
}

describe("provisioner lifecycle", () => {
  it("skips without credentials and never reports passed", async () => {
    const result = await runProvisionerLifecycle(liveOptions({ env: {}, config: {} }));
    assert.equal(result.status, "skipped");
    assert.notEqual(result.status, "passed");
    assert.match(result.summary, /skipped: no live credentials/);
  });

  it("skips when the live flag is set but credentials are missing", async () => {
    const result = await runProvisionerLifecycle(liveOptions({
      env: { QUBE_TESTKIT_LIVE: "1" },
      config: {},
    }));
    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "no-live-credentials");
    assert.notEqual(result.status, "passed");
  });

  it("skips without the live flag", async () => {
    const result = await runProvisionerLifecycle(liveOptions({
      env: { LINEAR_API_KEY: "fixture-key", LINEAR_TEAM_ID: "team-fixture" },
    }));
    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "no-live-flag");
    assert.notEqual(result.status, "passed");
  });

  it("does not report passed when the probe fails", async () => {
    const result = await runProvisionerLifecycle(liveOptions({
      probe: async () => ({ ...passingProbe(), status: "fail", summary: "authentication failed" }),
    }));
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "probe-failed");
    assert.notEqual(result.status, "passed");
  });

  it("does not report passed when the probe is unverified", async () => {
    const result = await runProvisionerLifecycle(liveOptions({
      probe: async () => ({ ...passingProbe(), status: "unverified", summary: "unreachable" }),
    }));
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "probe-unverified");
    assert.notEqual(result.status, "passed");
  });

  it("rejects unsupported providers loudly", () => {
    const gate = evaluateLiveGate({
      adapter: { ...linearAdapter, id: "github" },
      env: { QUBE_TESTKIT_LIVE: "1" },
      config: {},
      liveEnvVar: "QUBE_TESTKIT_LIVE",
    });
    assert.equal(gate.status, "error");
    assert.equal(gate.reason, "unsupported-provider");
  });

  it("accepts jira basic-env as a supported live auth mode", () => {
    const gate = evaluateLiveGate({
      adapter: {
        id: "jira",
        packageName: "@tjalve/qube-adapter-jira",
        connection: {
          adapterId: "jira",
          configPath: "providers.connections.jira",
          authMethod: "basic-env",
          envVars: [
            { name: "JIRA_EMAIL", sensitive: false, purpose: "email" },
            { name: "JIRA_API_TOKEN", sensitive: true, purpose: "token" },
          ],
          configFields: [{ name: "baseUrl", valueType: "string", required: true, purpose: "site", envFallback: "JIRA_BASE_URL" }],
          credentialUrl: "https://id.atlassian.com/manage-profile/security/api-tokens",
          scopes: [],
          probe: {
            id: "jira-myself",
            name: "Jira /myself",
            summary: "myself",
            readOnly: true,
            timeoutMs: 5000,
            verifyCommand: "qube doctor --json",
            transport: { kind: "http", method: "GET", baseUrl: { envVar: "JIRA_BASE_URL" }, path: "rest/api/3/myself" },
          },
        },
      },
      env: {
        QUBE_TESTKIT_LIVE: "1",
        JIRA_EMAIL: "fixture@example.com",
        JIRA_API_TOKEN: "fixture-token",
        JIRA_BASE_URL: "https://fixture.atlassian.net",
      },
      config: { baseUrl: "https://fixture.atlassian.net" },
      liveEnvVar: "QUBE_TESTKIT_LIVE",
    });
    assert.equal(gate.status, "passed");
    assert.equal(gate.reason, "ok");
  });

  it("exports jira and jenkins provisioners and a bootstrap checklist for every live provider", () => {
    assert.equal(typeof createJiraProvisioner, "function");
    assert.equal(typeof createJenkinsProvisioner, "function");
    assert.ok(LIVE_SUITE_PROVIDERS.includes("jira"));
    assert.ok(LIVE_SUITE_PROVIDERS.includes("jenkins"));
    assert.doesNotThrow(() => assertBootstrapChecklistsCoverLiveProviders());
    assert.equal(LIVE_SUITE_BOOTSTRAP_CHECKLISTS.length, LIVE_SUITE_PROVIDERS.length);
  });

  it("ships provisioner and bootstrap checklist modules on the package files surface", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    assert.ok(packageJson.files.includes("dist"));
    for (const relative of [
      "../dist/bootstrap-checklists.js",
      "../dist/provisioners/jira.js",
      "../dist/provisioners/jenkins.js",
      "../dist/provisioners/linear.js",
      "../dist/provisioners/gitlab.js",
    ]) {
      assert.equal(existsSync(fileURLToPath(new URL(relative, import.meta.url))), true, relative);
    }
  });

  it("rejects http Jira and Jenkins origins instead of sending credentials", () => {
    const budget = new RequestBudget();
    const fetchImpl = async () => {
      throw new Error("must not fetch");
    };
    assert.throws(() => createJiraProvisioner({
      adapter: { id: "jira", packageName: "@tjalve/qube-adapter-jira" },
      env: { JIRA_EMAIL: "fixture@example.com", JIRA_API_TOKEN: "fixture-token", JIRA_BASE_URL: "http://fixture.atlassian.net" },
      config: {},
      budget,
      fetchImpl,
    }), /https/);
    assert.throws(() => createJenkinsProvisioner({
      adapter: { id: "jenkins", packageName: "@tjalve/qube-adapter-jenkins" },
      env: { JENKINS_USER: "fixture-user", JENKINS_API_TOKEN: "fixture-token", JENKINS_BASE_URL: "http://jenkins.example.com" },
      config: {},
      budget,
      fetchImpl,
    }), /https/);
    assert.throws(() => createJenkinsProvisioner({
      adapter: { id: "jenkins", packageName: "@tjalve/qube-adapter-jenkins" },
      env: { JENKINS_USER: "fixture-user", JENKINS_API_TOKEN: "fixture-token", JENKINS_BASE_URL: "https://user:token@jenkins.example.com" },
      config: {},
      budget,
      fetchImpl,
    }), /omit credentials/);
  });

  it("derives a valid short Jira project key from the run id", () => {
    assert.equal(jiraProjectKey("abcd1234"), "QABCD1234");
    assert.match(jiraProjectKey("deadbeef"), /^Q[A-F0-9]{4,9}$/);
  });

  it("rejects unsupported auth modes loudly", () => {
    const gate = evaluateLiveGate({
      adapter: { ...linearAdapter, connection: { ...linearAdapter.connection, authMethod: "oauth" } },
      env: { QUBE_TESTKIT_LIVE: "1", LINEAR_API_KEY: "x", LINEAR_TEAM_ID: "t" },
      config: { teamId: "t" },
      liveEnvVar: "QUBE_TESTKIT_LIVE",
    });
    assert.equal(gate.status, "error");
    assert.equal(gate.reason, "unsupported-auth-mode");
  });

  it("constructs, verifies, and deconstructs with zero residue", async () => {
    const result = await runProvisionerLifecycle(liveOptions());
    assert.equal(result.status, "passed", result.summary);
    assert.equal(result.residue.length, 0);
    assert.equal(result.verifiedWork.length, SHARED_SEED_MANIFEST.workItems.length);
    assert.equal(result.reason, "ok");
  });

  it("deconstructs after verify failure and does not report passed", async () => {
    const options = liveOptions({ memory: { failVerify: true } });
    const result = await runProvisionerLifecycle(options);
    assert.notEqual(result.status, "passed");
    assert.equal(result.reason, "verify-failed");
    assert.equal(options.memory.store.issues.length, 0);
    assert.equal(options.memory.store.labels.length, 0);
  });

  it("fails when sweep still finds tagged residue", async () => {
    const memory = createMemoryProvisioner();
    const originalDeconstruct = memory.provisioner.deconstruct;
    memory.provisioner.deconstruct = async () => {
      await originalDeconstruct({ tag: "other" });
    };
    const result = await runProvisionerLifecycle(liveOptions({
      createProvisioner: () => memory.provisioner,
      createWorkProvider: sandbox => memory.createWorkProvider(sandbox),
    }));
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "residue-remaining");
    assert.ok(result.residue.length > 0);
    assert.notEqual(result.status, "passed");
  });

  it("counts budgeted requests and fails without reporting passed", async () => {
    const budget = new RequestBudget({ maxRequests: 1 });
    budget.consume();
    const fetchImpl = budget.wrapFetch(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    await assert.rejects(() => fetchImpl("https://example.test"), /request budget/);
  });

  it("counts the connection probe against the request budget", async () => {
    const budget = new RequestBudget({ maxRequests: 1, timeoutMs: 4321 });
    budget.consume();
    let observedTimeout;
    const result = await runProvisionerLifecycle(liveOptions({
      budget,
      probe: async options => {
        observedTimeout = options.timeoutMs;
        return passingProbe();
      },
    }));
    assert.notEqual(result.status, "passed");
    assert.equal(result.reason, "budget-exceeded");
    assert.equal(observedTimeout, undefined);
  });

  it("counts probe HTTP through the injected fetch against the request budget", async () => {
    const budget = new RequestBudget({ maxRequests: 1, timeoutMs: 5000 });
    const result = await runProvisionerLifecycle(liveOptions({
      budget,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: { getReader() { return { async read() { return { done: true, value: undefined }; }, async cancel() {} }; } },
        async json() { return {}; },
      }),
      probe: async options => {
        await options.fetch({
          url: "https://example.test/probe",
          method: "GET",
          headers: { Accept: "application/json" },
          timeoutMs: options.timeoutMs ?? 5000,
        });
        return passingProbe();
      },
    }));
    assert.notEqual(result.status, "passed");
    assert.equal(result.reason, "budget-exceeded");
  });

  it("bounds the connection probe with the live suite timeout", async () => {
    const budget = new RequestBudget({ maxRequests: 8, timeoutMs: 4321 });
    let observedTimeout;
    const result = await runProvisionerLifecycle(liveOptions({
      budget,
      probe: async options => {
        observedTimeout = options.timeoutMs;
        return passingProbe();
      },
    }));
    assert.equal(result.status, "passed", result.summary);
    assert.equal(observedTimeout, 4321);
    assert.ok(budget.requestCount >= 1);
  });

  it("follows GitLab project pages during sweep instead of treating the first page as complete", async () => {
    const deleted = [];
    const remaining = new Map([
      [11, { id: 11, path: "qube-testkit-a" }],
      [12, { id: 12, path: "qube-testkit-b" }],
    ]);
    const fetchImpl = async (url) => {
      const parsed = new URL(String(url));
      const path = parsed.pathname.replace(/\/api\/v4/, "");
      if (path === "/projects") {
        const page = parsed.searchParams.get("page") || "1";
        const all = [...remaining.values()];
        const items = page === "1" ? all.slice(0, 1) : all.slice(1);
        return {
          ok: true,
          status: 200,
          headers: { get: name => String(name).toLowerCase() === "x-next-page" ? (page === "1" && all.length > 1 ? "2" : "") : null },
          async json() { return items; },
        };
      }
      if (path.startsWith("/projects/")) {
        deleted.push(path);
        remaining.delete(Number(path.split("/")[2]));
        return { ok: true, status: 204, headers: { get: () => null }, async json() { return undefined; } };
      }
      throw new Error(`unexpected ${path}`);
    };
    const leftover = await createGitLabProvisioner({
      adapter: { id: "gitlab", packageName: "@tjalve/qube-adapter-gitlab" },
      env: { GITLAB_TOKEN: "fixture-token" },
      config: {},
      budget: new RequestBudget(),
      fetchImpl,
    }).sweep("qube-testkit-");
    assert.deepEqual(deleted, ["/projects/11", "/projects/12"]);
    assert.equal(leftover.length, 0);
  });

  it("follows Jira project search pages during sweep instead of treating the first page as complete", async () => {
    const remaining = [
      { id: "11", key: "QAAA1111", name: "qube-testkit-aaa" },
      { id: "12", key: "QBBB2222", name: "qube-testkit-bbb" },
    ];
    const deleted = [];
    const fetchImpl = async (url, init = {}) => {
      const parsed = new URL(String(url));
      const method = String(init.method ?? "GET").toUpperCase();
      if (method === "GET" && parsed.pathname.endsWith("/rest/api/3/project/search")) {
        const startAt = Number(parsed.searchParams.get("startAt") ?? "0");
        const item = remaining[startAt];
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          async json() {
            return {
              values: item ? [item] : [],
              startAt,
              maxResults: 1,
              total: remaining.length,
              isLast: startAt + 1 >= remaining.length,
            };
          },
        };
      }
      if (method === "DELETE" && parsed.pathname.includes("/rest/api/3/project/")) {
        const key = decodeURIComponent(parsed.pathname.split("/").pop() ?? "");
        deleted.push(key);
        const index = remaining.findIndex(project => project.key === key);
        if (index >= 0) remaining.splice(index, 1);
        return { ok: true, status: 204, headers: { get: () => null }, async json() { return undefined; } };
      }
      throw new Error(`unexpected ${method} ${parsed.pathname}`);
    };
    const leftover = await createJiraProvisioner({
      adapter: { id: "jira", packageName: "@tjalve/qube-adapter-jira" },
      env: { JIRA_EMAIL: "fixture@example.com", JIRA_API_TOKEN: "fixture-token", JIRA_BASE_URL: "https://fixture.atlassian.net" },
      config: { baseUrl: "https://fixture.atlassian.net" },
      budget: new RequestBudget(),
      fetchImpl,
    }).sweep("qube-testkit-");
    assert.deepEqual(deleted, ["QAAA1111", "QBBB2222"]);
    assert.equal(leftover.length, 0);
  });

  it("continues Jira sweep after a short non-final search page", async () => {
    const remaining = [
      { id: "11", key: "QAAA1111", name: "qube-testkit-aaa" },
      { id: "12", key: "QBBB2222", name: "qube-testkit-bbb" },
    ];
    const deleted = [];
    const fetchImpl = async (url, init = {}) => {
      const parsed = new URL(String(url));
      const method = String(init.method ?? "GET").toUpperCase();
      if (method === "GET" && parsed.pathname.endsWith("/rest/api/3/project/search")) {
        const startAt = Number(parsed.searchParams.get("startAt") ?? "0");
        const item = remaining[startAt];
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          async json() {
            return {
              values: item ? [item] : [],
              startAt,
              maxResults: 50,
              total: remaining.length,
              isLast: false,
            };
          },
        };
      }
      if (method === "DELETE" && parsed.pathname.includes("/rest/api/3/project/")) {
        const key = decodeURIComponent(parsed.pathname.split("/").pop() ?? "");
        deleted.push(key);
        const index = remaining.findIndex(project => project.key === key);
        if (index >= 0) remaining.splice(index, 1);
        return { ok: true, status: 204, headers: { get: () => null }, async json() { return undefined; } };
      }
      throw new Error(`unexpected ${method} ${parsed.pathname}`);
    };
    const leftover = await createJiraProvisioner({
      adapter: { id: "jira", packageName: "@tjalve/qube-adapter-jira" },
      env: { JIRA_EMAIL: "fixture@example.com", JIRA_API_TOKEN: "fixture-token", JIRA_BASE_URL: "https://fixture.atlassian.net" },
      config: { baseUrl: "https://fixture.atlassian.net" },
      budget: new RequestBudget(),
      fetchImpl,
    }).sweep("qube-testkit-");
    assert.deepEqual(deleted, ["QAAA1111", "QBBB2222"]);
    assert.equal(leftover.length, 0);
  });

  it("deletes every tagged Jira project after a complete search snapshot, even when later pages would shift", async () => {
    const remaining = [
      { id: "21", key: "QCCC3333", name: "qube-testkit-ccc" },
      { id: "22", key: "QDDD4444", name: "qube-testkit-ddd" },
    ];
    const deleted = [];
    const fetchImpl = async (url, init = {}) => {
      const parsed = new URL(String(url));
      const method = String(init.method ?? "GET").toUpperCase();
      if (method === "GET" && parsed.pathname.endsWith("/rest/api/3/project/search")) {
        const startAt = Number(parsed.searchParams.get("startAt") ?? "0");
        const item = remaining[startAt];
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          async json() {
            return {
              values: item ? [item] : [],
              startAt,
              maxResults: 1,
              total: remaining.length,
              isLast: startAt + 1 >= remaining.length,
            };
          },
        };
      }
      if (method === "DELETE" && parsed.pathname.includes("/rest/api/3/project/")) {
        const key = decodeURIComponent(parsed.pathname.split("/").pop() ?? "");
        deleted.push(key);
        const index = remaining.findIndex(project => project.key === key);
        if (index >= 0) remaining.splice(index, 1);
        return { ok: true, status: 204, headers: { get: () => null }, async json() { return undefined; } };
      }
      throw new Error(`unexpected ${method} ${parsed.pathname}`);
    };
    const leftover = await createJiraProvisioner({
      adapter: { id: "jira", packageName: "@tjalve/qube-adapter-jira" },
      env: { JIRA_EMAIL: "fixture@example.com", JIRA_API_TOKEN: "fixture-token", JIRA_BASE_URL: "https://fixture.atlassian.net" },
      config: { baseUrl: "https://fixture.atlassian.net" },
      budget: new RequestBudget(),
      fetchImpl,
    }).sweep("qube-testkit-");
    assert.deepEqual(deleted, ["QCCC3333", "QDDD4444"]);
    assert.equal(leftover.length, 0);
  });

  it("continues Jira sweep after an empty non-final search page", async () => {
    const remaining = [
      { id: "31", key: "QEEE5555", name: "qube-testkit-eee" },
      { id: "32", key: "QFFF6666", name: "qube-testkit-fff" },
    ];
    const deleted = [];
    const fetchImpl = async (url, init = {}) => {
      const parsed = new URL(String(url));
      const method = String(init.method ?? "GET").toUpperCase();
      if (method === "GET" && parsed.pathname.endsWith("/rest/api/3/project/search")) {
        const startAt = Number(parsed.searchParams.get("startAt") ?? "0");
        const item = startAt === 0 ? undefined : remaining[startAt - 1];
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          async json() {
            return {
              values: item ? [item] : [],
              startAt,
              maxResults: 1,
              total: remaining.length,
              isLast: false,
              nextPage: remaining[startAt]
                ? `https://fixture.atlassian.net/rest/api/3/project/search?query=qube-testkit-&startAt=${startAt + 1}&maxResults=1`
                : startAt === 0
                  ? "https://fixture.atlassian.net/rest/api/3/project/search?query=qube-testkit-&startAt=1&maxResults=1"
                  : undefined,
            };
          },
        };
      }
      if (method === "DELETE" && parsed.pathname.includes("/rest/api/3/project/")) {
        const key = decodeURIComponent(parsed.pathname.split("/").pop() ?? "");
        deleted.push(key);
        const index = remaining.findIndex(project => project.key === key);
        if (index >= 0) remaining.splice(index, 1);
        return { ok: true, status: 204, headers: { get: () => null }, async json() { return undefined; } };
      }
      throw new Error(`unexpected ${method} ${parsed.pathname}`);
    };
    const leftover = await createJiraProvisioner({
      adapter: { id: "jira", packageName: "@tjalve/qube-adapter-jira" },
      env: { JIRA_EMAIL: "fixture@example.com", JIRA_API_TOKEN: "fixture-token", JIRA_BASE_URL: "https://fixture.atlassian.net" },
      config: { baseUrl: "https://fixture.atlassian.net" },
      budget: new RequestBudget(),
      fetchImpl,
    }).sweep("qube-testkit-");
    assert.deepEqual(deleted, ["QEEE5555", "QFFF6666"]);
    assert.equal(leftover.length, 0);
  });

  it("does not report passed when the verify hook returns fabricated ids", async () => {
    const options = liveOptions();
    const result = await runProvisionerLifecycle({
      ...options,
      createProvisioner: () => ({
        ...options.memory.provisioner,
        verify: async () => ["fake-1", "fake-2"],
      }),
    });
    assert.notEqual(result.status, "passed");
    assert.equal(result.reason, "verify-failed");
    assert.match(result.summary, /Live verify did not observe at least two seeded resources/);
  });

  it("accepts a verify hook that returns seeded resource ids", async () => {
    const options = liveOptions();
    const result = await runProvisionerLifecycle({
      ...options,
      createProvisioner: () => ({
        ...options.memory.provisioner,
        verify: async sandbox => sandbox.resources
          .filter(resource => resource.kind === "issue")
          .map(resource => resource.id)
          .slice(0, 2),
      }),
    });
    assert.equal(result.status, "passed", result.summary);
    assert.deepEqual(result.verifiedWork, ["ENG-ready-high", "ENG-in-progress-critical"]);
  });

  it("sweeps leftover Jenkins folders that still match the live-suite tag prefix", async () => {
    const remaining = new Map([
      ["qube-testkit-a", { name: "qube-testkit-a" }],
      ["qube-testkit-b", { name: "qube-testkit-b" }],
    ]);
    const deleted = [];
    const fetchImpl = async (url, init = {}) => {
      const parsed = new URL(String(url));
      const method = String(init.method ?? "GET").toUpperCase();
      if (method === "GET" && parsed.pathname.endsWith("/crumbIssuer/api/json")) {
        return {
          ok: true,
          status: 200,
          headers: { get: name => String(name).toLowerCase() === "set-cookie" ? "JSESSIONID=fixture" : "application/json" },
          async json() { return { crumb: "crumb-fixture", crumbRequestField: "Jenkins-Crumb" }; },
        };
      }
      if (method === "GET" && parsed.pathname.endsWith("/api/json") && parsed.searchParams.get("tree")) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          async json() { return { jobs: [...remaining.values()] }; },
        };
      }
      if (method === "POST" && /\/job\/[^/]+\/doDelete$/.test(parsed.pathname)) {
        const name = decodeURIComponent(parsed.pathname.split("/")[2]);
        deleted.push(name);
        remaining.delete(name);
        return { ok: true, status: 204, headers: { get: () => null }, async text() { return ""; }, async json() { return undefined; } };
      }
      throw new Error(`unexpected ${method} ${parsed.pathname}`);
    };
    const leftover = await createJenkinsProvisioner({
      adapter: { id: "jenkins", packageName: "@tjalve/qube-adapter-jenkins" },
      env: { JENKINS_USER: "fixture-user", JENKINS_API_TOKEN: "fixture-token", JENKINS_BASE_URL: "https://jenkins.example.com" },
      config: { baseUrl: "https://jenkins.example.com", user: "fixture-user" },
      budget: new RequestBudget(),
      fetchImpl,
    }).sweep("qube-testkit-");
    assert.deepEqual(deleted, ["qube-testkit-a", "qube-testkit-b"]);
    assert.equal(leftover.length, 0);
  });
});
