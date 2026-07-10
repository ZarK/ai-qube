import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  defineAdapterHarness,
  defineCiProviderHarness,
  defineWorkProviderHarness,
  verifyAdapterHarness,
} from "../dist/index.js";

function adapter(support = "supported", extraCapabilities = []) {
  return {
    id: "fixture",
    packageName: "@tjalve/qube-adapter-fixture",
    capabilities: [
      { id: "read-fixture", support, owner: "@tjalve/qube-adapter-fixture", summary: "read" },
      ...extraCapabilities,
    ],
  };
}

function workAdapter(overrides = {}) {
  return {
    id: "fixture",
    packageName: "@tjalve/qube-adapter-fixture",
    capabilities: [
      { id: "map-work-item", support: "supported", owner: "@tjalve/qube-adapter-fixture", summary: "map" },
      { id: "work-item-queue", support: "supported", owner: "@tjalve/qube-adapter-fixture", summary: "queue" },
      { id: "sync-issue-status", support: "supported", owner: "@tjalve/qube-adapter-fixture", summary: "sync" },
      ...(overrides.capabilities ?? []),
    ],
  };
}

function makeFixtureRoot(files = { "fixtures/check.json": { status: "success" } }) {
  const root = mkdtempSync(join(tmpdir(), "qube-testkit-"));
  for (const [relativePath, value] of Object.entries(files)) {
    const absolutePath = join(root, relativePath);
    mkdirSync(join(absolutePath, ".."), { recursive: true });
    writeFileSync(absolutePath, `${JSON.stringify(value)}\n`);
  }
  return root;
}

function workItem(id, overrides = {}) {
  return {
    key: { providerId: "fixture", id },
    displayId: `#${id}`,
    title: `Item ${id}`,
    body: "- [x] done",
    url: `https://example.test/${id}`,
    state: "open",
    status: "ready",
    priority: "medium",
    tags: [],
    assignees: [],
    project: null,
    blockers: [],
    blockedBy: [],
    sequence: null,
    checklist: { total: 1, completed: 1 },
    trustedMetadata: {},
    source: { providerId: "fixture", resourceKind: "work-item", resourceId: id, url: null, metadata: {} },
    ...overrides,
  };
}

function createWorkProvider(items, flagOverrides = {}) {
  return {
    id: "fixture",
    capabilities() {
      return {
        listOpenWork: true,
        loadWork: true,
        planStatusSync: true,
        planLifecycleMutations: true,
        applyLifecycleMutations: true,
        commentMutations: false,
        reviewIntegration: false,
        ciMergeStatus: false,
        ...flagOverrides,
      };
    },
    async listOpenWorkItems() {
      return items;
    },
    async getWorkItem(key) {
      const item = items.find(candidate => candidate.key.id === key.id);
      if (!item) throw new Error(`missing ${key.id}`);
      return item;
    },
    planStatusSync() {
      return { id: "plan", purpose: "sync", dryRun: true, actions: [{ id: "a1", kind: "sync-status", details: {} }] };
    },
    planStart(item) {
      return {
        id: "start",
        purpose: "start",
        dryRun: true,
        actions: [{ id: `start:${item.key.id}`, kind: "start-work", status: "planned", details: { issueNumber: item.key.id } }],
      };
    },
    planPause(item) {
      return {
        id: "pause",
        purpose: "pause",
        dryRun: true,
        actions: [{ id: `pause:${item.key.id}`, kind: "pause-work", status: "planned", details: { issueNumber: item.key.id } }],
      };
    },
    planComplete(item) {
      return {
        id: "complete",
        purpose: "complete",
        dryRun: true,
        actions: [{ id: `complete:${item.key.id}`, kind: "close-work", status: "planned", details: { issueNumber: item.key.id } }],
      };
    },
    async apply(plan) {
      return plan.actions.map(action => ({ actionId: action.id, status: "completed", failure: null, details: action.details ?? {} }));
    },
  };
}

function ciHarness(run, fixtureRoot = makeFixtureRoot()) {
  return defineCiProviderHarness({
    fixtureRoot,
    fixtureFiles: ["fixtures/check.json"],
    createFixtureTransport: () => ({ status: "success" }),
    createSubject: fixture => fixture,
    ciScenarios: {
      mapCheck: (_subject, check) => ({ result: check?.status === "success" ? "passed" : "failed" }),
      passedCheck: { status: "success" },
      failedCheck: { status: "failure" },
      pendingCheck: { status: "pending" },
      unsupportedTrigger: () => {
        throw new Error("unsupported trigger");
      },
    },
    capabilityCases: [{
      capabilityId: "read-fixture",
      name: "observed",
      run,
    }],
  });
}

describe("adapter conformance testkit", () => {
  it("accepts observed behavior that matches the capability declaration", async () => {
    await verifyAdapterHarness(defineAdapterHarness({
      adapter: adapter(),
      roles: {
        ci: ciHarness(() => undefined),
      },
    }));
  });

  it("fails when a supported capability behaves as unsupported", async () => {
    await assert.rejects(() => verifyAdapterHarness(defineAdapterHarness({
      adapter: adapter(),
      roles: {
        ci: ciHarness(() => {
          throw new Error("unsupported operation");
        }),
      },
    })), /declared supported but fixture behavior reported unsupported/);
  });

  it("fails when a declared capability has no case or explicit exclusion", () => {
    assert.throws(() => defineAdapterHarness({
      adapter: {
        id: "fixture",
        packageName: "@tjalve/qube-adapter-fixture",
        capabilities: [
          { id: "read-fixture", support: "supported", owner: "@tjalve/qube-adapter-fixture", summary: "read" },
          { id: "extra", support: "supported", owner: "@tjalve/qube-adapter-fixture", summary: "extra" },
        ],
      },
      roles: {
        ci: defineCiProviderHarness({
          fixtureRoot: makeFixtureRoot(),
          fixtureFiles: ["fixtures/check.json"],
          createFixtureTransport: () => ({}),
          createSubject: fixture => fixture,
          ciScenarios: {
            mapCheck: () => ({ result: "passed" }),
            passedCheck: {},
            failedCheck: {},
            pendingCheck: {},
          },
          capabilityCases: [{ capabilityId: "read-fixture", name: "only one", run: () => undefined }],
        }),
      },
    }), /Declared capability extra has no role case/);
  });

  it("does not let adapters exclude capabilities they own", () => {
    assert.throws(() => defineAdapterHarness({
      adapter: adapter(),
      roles: {
        ci: ciHarness(() => undefined),
      },
      ignoredCapabilities: [{ id: "read-fixture", reason: "skip" }],
    }), /Adapter-owned capability read-fixture cannot be excluded/);
  });

  it("rejects harnesses that name missing fixture files", () => {
    assert.throws(() => defineAdapterHarness({
      adapter: adapter(),
      roles: {
        ci: defineCiProviderHarness({
          fixtureRoot: makeFixtureRoot(),
          fixtureFiles: ["fixtures/does-not-exist.json"],
          createFixtureTransport: () => ({}),
          createSubject: fixture => fixture,
          ciScenarios: {
            mapCheck: () => ({ result: "passed" }),
            passedCheck: {},
            failedCheck: {},
            pendingCheck: {},
          },
          capabilityCases: [{ capabilityId: "read-fixture", name: "missing", run: () => undefined }],
        }),
      },
    }), /missing or unbound/);
  });

  it("matches unsupported errors repeatedly without sticky lastIndex", async () => {
    const pattern = /unsupported/g;
    const harness = defineAdapterHarness({
      adapter: adapter("unsupported"),
      roles: {
        ci: defineCiProviderHarness({
          fixtureRoot: makeFixtureRoot(),
          fixtureFiles: ["fixtures/check.json"],
          createFixtureTransport: () => ({}),
          createSubject: fixture => fixture,
          ciScenarios: {
            mapCheck: () => ({ result: "passed" }),
            passedCheck: {},
            failedCheck: {},
            pendingCheck: {},
          },
          capabilityCases: [{
            capabilityId: "read-fixture",
            name: "unsupported twice",
            unsupportedError: pattern,
            run: () => {
              throw new Error("unsupported operation");
            },
          }],
        }),
      },
    });
    await verifyAdapterHarness(harness);
    await verifyAdapterHarness(harness);
  });

  it("fails when supported work declarations disagree with role capability flags", async () => {
    const root = makeFixtureRoot({ "fixtures/work.json": [{ id: "1" }] });
    const items = [workItem("1"), workItem("2", { status: "blocked", checklist: { total: 1, completed: 0 } })];
    await assert.rejects(() => verifyAdapterHarness(defineAdapterHarness({
      adapter: workAdapter(),
      roles: {
        work: defineWorkProviderHarness({
          fixtureRoot: root,
          fixtureFiles: ["fixtures/work.json"],
          createFixtureTransport: () => items,
          createSubject: transport => createWorkProvider(transport, {
            listOpenWork: false,
            loadWork: false,
            planStatusSync: false,
          }),
          workScenarios: {
            statusPolicy: { labels: { priorities: [], statuses: [] } },
            createLargeResultTransport: () => items,
            expectedLargeResultCount: 2,
            createMalformedTransport: () => items,
            singleShotHighLimit: true,
          },
          getListRequestCount: () => 1,
          capabilityCases: [{
            capabilityId: "work-item-queue",
            name: "noop false success",
            run: () => undefined,
          }],
        }),
      },
    })), /must be true when adapter declares|listOpenWork must be true|requires work capability flag|loadWork must be true/);
  });

  it("fails when commentMutations is true but apply cannot complete a comment-work action", async () => {
    const root = makeFixtureRoot({ "fixtures/work.json": [{ id: "1" }, { id: "2" }] });
    const items = [
      workItem("1", { body: "- [x] a\n- [ ] b", checklist: { total: 2, completed: 1 }, status: "ready", priority: "high" }),
      workItem("2", {
        status: "blocked",
        priority: "low",
        body: "- [ ] blocked",
        checklist: { total: 1, completed: 0 },
        blockers: [{ providerId: "fixture", id: "1" }],
      }),
    ];
    await assert.rejects(() => verifyAdapterHarness(defineAdapterHarness({
      adapter: workAdapter(),
      roles: {
        work: defineWorkProviderHarness({
          fixtureRoot: root,
          fixtureFiles: ["fixtures/work.json"],
          createFixtureTransport: () => items,
          createSubject: transport => ({
            ...createWorkProvider(transport, {
              commentMutations: true,
              planLifecycleMutations: false,
              applyLifecycleMutations: false,
            }),
            async apply() {
              return [{ actionId: "comment", status: "failed", failure: { operation: "comment", cause: "no transport", nextAction: "fix" }, details: {} }];
            },
          }),
          workScenarios: {
            statusPolicy: { labels: { priorities: [], statuses: [] } },
            createLargeResultTransport: () => items,
            expectedLargeResultCount: 2,
            createMalformedTransport: () => items,
            singleShotHighLimit: true,
          },
          getListRequestCount: () => 1,
        }),
      },
    })), /commentMutations apply must complete/);
  });

  it("runs shared work suite against multi-item fixtures and rejects silent malformed lists", async () => {
    const root = makeFixtureRoot({ "fixtures/work.json": [{ id: "1" }, { id: "2" }] });
    const items = [
      workItem("1", {
        status: "ready",
        priority: "high",
        body: "- [x] a\n- [ ] b",
        checklist: { total: 2, completed: 1 },
      }),
      workItem("2", {
        status: "blocked",
        priority: "low",
        body: "- [ ] blocked",
        checklist: { total: 1, completed: 0 },
        blockers: [{ providerId: "fixture", id: "1" }],
      }),
    ];
    let listRequests = 0;
    await verifyAdapterHarness(defineAdapterHarness({
      adapter: workAdapter(),
      roles: {
        work: defineWorkProviderHarness({
          fixtureRoot: root,
          fixtureFiles: ["fixtures/work.json"],
          createFixtureTransport: () => ({ items, listRequests: 0 }),
          createSubject: transport => {
            if (transport.items === "malformed") {
              return {
                ...createWorkProvider([]),
                async listOpenWorkItems() {
                  throw new Error("malformed fixture payload");
                },
              };
            }
            const provider = createWorkProvider(transport.items);
            return {
              ...provider,
              async listOpenWorkItems() {
                transport.listRequests += 1;
                listRequests = transport.listRequests;
                return provider.listOpenWorkItems();
              },
            };
          },
          getListRequestCount: transport => transport.listRequests,
          workScenarios: {
            statusPolicy: { labels: { priorities: [], statuses: [] } },
            createLargeResultTransport: () => ({ items, listRequests: 0 }),
            expectedLargeResultCount: 2,
            maxListRequests: 2,
            singleShotHighLimit: true,
            createMalformedTransport: () => ({ items: "malformed" }),
          },
        }),
      },
    }));
    assert.ok(listRequests >= 1);
  });


  it("rejects duplicate capability ids", () => {
    assert.throws(() => defineAdapterHarness({
      adapter: {
        id: "fixture",
        packageName: "@tjalve/qube-adapter-fixture",
        capabilities: [
          { id: "read-fixture", support: "supported", owner: "@tjalve/qube-adapter-fixture", summary: "read" },
          { id: "read-fixture", support: "unsupported", owner: "@tjalve/qube-adapter-fixture", summary: "dup" },
        ],
      },
      roles: {
        ci: ciHarness(() => undefined),
      },
    }), /Duplicate capability id/);
  });

  it("requires explicit unsupported observation for unsupported CI triggers", () => {
    assert.throws(() => defineAdapterHarness({
      adapter: {
        id: "fixture",
        packageName: "@tjalve/qube-adapter-fixture",
        capabilities: [
          { id: "read-ci-status", support: "supported", owner: "@tjalve/qube-adapter-fixture", summary: "read" },
          { id: "trigger-workflow-run", support: "unsupported", owner: "@tjalve/qube-adapter-fixture", summary: "trigger" },
        ],
      },
      roles: {
        ci: defineCiProviderHarness({
          fixtureRoot: makeFixtureRoot(),
          fixtureFiles: ["fixtures/check.json"],
          createFixtureTransport: () => ({}),
          createSubject: fixture => fixture,
          ciScenarios: {
            mapCheck: () => ({ result: "passed" }),
            passedCheck: { status: "success" },
            failedCheck: { status: "failure" },
            pendingCheck: { status: "pending" },
          },
        }),
      },
    }), /unsupportedTrigger/);
  });
});
