import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  RequestBudget,
  SHARED_SEED_MANIFEST,
  evaluateLiveGate,
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
      adapter: { ...linearAdapter, id: "jira" },
      env: { QUBE_TESTKIT_LIVE: "1" },
      config: {},
      liveEnvVar: "QUBE_TESTKIT_LIVE",
    });
    assert.equal(gate.status, "error");
    assert.equal(gate.reason, "unsupported-provider");
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
});
