import assert from "node:assert/strict";

import type { QubeAdapterContract, WorkItem, WorkItemKey, WorkProvider } from "@tjalve/qube-core";
import {
  createAction,
  createActionPlan,
  normalizeWorkItem,
  parseWorkChecklist,
} from "@tjalve/qube-core";

import {
  declarationMap,
  isSupported,
  WORK_DECLARATION_FLAGS,
} from "./capabilities.js";
import { assertMutationAllowed, assertWorkItemShape } from "./fixtures.js";
import type { RoleHarness } from "./types.js";

async function loadMapCorpus(
  adapter: QubeAdapterContract,
  provider: WorkProvider,
  caps: ReturnType<WorkProvider["capabilities"]>,
  scenarios: NonNullable<RoleHarness["workScenarios"]>,
  declared: ReturnType<typeof declarationMap>,
): Promise<WorkItem[]> {
  if (caps.listOpenWork && isSupported(declared, "work-item-queue")) {
    const items = await provider.listOpenWorkItems();
    assert.ok(Array.isArray(items), "listOpenWorkItems must return an array.");
    return items;
  }

  const keys: WorkItemKey[] = scenarios.fixtureWorkKeys
    ? [...scenarios.fixtureWorkKeys]
    : Object.keys(scenarios.expectedWorkById ?? {}).map(id => ({ providerId: adapter.id, id }));
  assert.ok(
    keys.length >= 2,
    "map-work-item without work-item-queue requires fixtureWorkKeys or expectedWorkById with at least two keys.",
  );
  assert.equal(caps.loadWork, true, "map-work-item requires loadWork=true.");
  return Promise.all(keys.map(key => provider.getWorkItem(key)));
}

export async function verifyWorkRoleSuite(adapter: QubeAdapterContract, harness: RoleHarness): Promise<void> {
  const scenarios = harness.workScenarios;
  assert.ok(scenarios, "Work provider harness must supply workScenarios.");
  const transport = await harness.createFixtureTransport();
  const provider = await harness.createSubject(transport) as WorkProvider;
  const caps = provider.capabilities();
  const declared = declarationMap(adapter);

  // Cache one queue load for lifecycle/status/integration paths that need open work.
  let queueItems: WorkItem[] | null = null;
  async function openWorkItems(): Promise<WorkItem[]> {
    assert.equal(caps.listOpenWork, true, "listOpenWork must be true to load the open work queue.");
    if (!queueItems) {
      const listed = await provider.listOpenWorkItems();
      assert.ok(Array.isArray(listed), "listOpenWorkItems must return an array.");
      queueItems = [...listed];
    }
    return queueItems;
  }

  if (isSupported(declared, "work-item-queue")) {
    assert.equal(caps.listOpenWork, true, "listOpenWork must be true when work-item-queue is supported.");
    const items = await openWorkItems();
    assert.ok(items.length > 0, "Supported work queue fixture must yield at least one work item.");
    for (const item of items) assertWorkItemShape(item, adapter.id);
  }

  if (isSupported(declared, "map-work-item")) {
    assert.equal(caps.loadWork, true, "loadWork must be true when map-work-item is supported.");
    const items = await loadMapCorpus(adapter, provider, caps, scenarios, declared);
    assert.ok(items.length > 0, "map-work-item suite requires at least one mapped work item.");
    for (const item of items) assertWorkItemShape(item, adapter.id);

    // Multi-item corpus exercises codec breadth (status/priority/checklist/blockers).
    assert.ok(items.length >= 2, "map-work-item shared suite requires a multi-item fixture corpus.");
    const statuses = new Set(items.map(item => item.status));
    assert.ok(statuses.size >= 2, "map-work-item shared suite requires at least two distinct canonical statuses.");
    const priorities = new Set(items.map(item => item.priority));
    assert.ok(priorities.size >= 2, "map-work-item shared suite requires at least two distinct priorities.");
    const withChecklist = items.filter(item => item.checklist.total > 0);
    assert.ok(withChecklist.length > 0, "At least one fixture work item must include checklist coverage.");
    const withBlockers = items.filter(item => item.blockers.length > 0 || item.blockedBy.length > 0);
    assert.ok(withBlockers.length > 0, "At least one fixture work item must include blocker or blockedBy edges.");

    for (const item of items) {
      const roundTrip = normalizeWorkItem(item);
      assert.equal(roundTrip.key.id, item.key.id);
      assert.equal(roundTrip.status, item.status);
      assert.equal(roundTrip.priority, item.priority);
      assert.deepEqual(roundTrip.checklist, item.checklist);
      assert.deepEqual(roundTrip.blockers, item.blockers);
      if (item.body.includes("[") && item.checklist.total > 0) {
        assert.deepEqual(parseWorkChecklist(item.body), item.checklist);
      }
    }

    const first = items[0];
    const loaded = await provider.getWorkItem(first.key);
    assertWorkItemShape(loaded, adapter.id);
    assert.equal(loaded.key.id, first.key.id);
    assert.deepEqual(normalizeWorkItem(loaded).checklist, loaded.checklist);

    if (scenarios.expectedWorkById) {
      const byId = Object.fromEntries(items.map(item => [item.key.id, item]));
      for (const [id, expected] of Object.entries(scenarios.expectedWorkById)) {
        const item = byId[id] ?? await provider.getWorkItem({ providerId: adapter.id, id });
        assert.ok(item, `expectedWorkById references missing work item ${id}.`);
        if (expected.status !== undefined) assert.equal(item.status, expected.status, `Work item ${id} status mapping mismatch.`);
        if (expected.priority !== undefined) assert.equal(item.priority, expected.priority, `Work item ${id} priority mapping mismatch.`);
        if (expected.title !== undefined) assert.equal(item.title, expected.title, `Work item ${id} title mapping mismatch.`);
      }
    }
  }

  if (isSupported(declared, "sync-issue-status")) {
    assert.equal(caps.planStatusSync, true, "planStatusSync must be true when sync-issue-status is supported.");
    const items = await openWorkItems();
    // Adapter policy shapes vary by provider; the suite only requires a non-null policy object.
    const plan = provider.planStatusSync(items, scenarios.statusPolicy as never);
    assert.ok(plan && typeof plan === "object", "planStatusSync must return an action plan object.");
    assert.ok(Array.isArray(plan.actions), "planStatusSync plan.actions must be an array.");
  }

  // Observe true lifecycle flags through real plan methods; bare true flags without plans are false success.
  if (caps.planLifecycleMutations === true) {
    const items = await openWorkItems();
    assert.ok(items.length > 0, "planLifecycleMutations requires at least one work item.");
    const start = provider.planStart(items[0], scenarios.statusPolicy as never);
    assert.ok(start && Array.isArray(start.actions), "planStart must return an action plan when planLifecycleMutations is true.");
    assert.ok(start.actions.length > 0, "planStart must plan at least one action when planLifecycleMutations is true.");
    const pause = provider.planPause(items[0], items, scenarios.statusPolicy as never);
    assert.ok(pause && Array.isArray(pause.actions), "planPause must return an action plan when planLifecycleMutations is true.");
    assert.ok(pause.actions.length > 0, "planPause must plan at least one action when planLifecycleMutations is true.");
    const complete = provider.planComplete(items[0], items, scenarios.statusPolicy as never);
    assert.ok(complete && Array.isArray(complete.actions), "planComplete must return an action plan when planLifecycleMutations is true.");
    assert.ok(complete.actions.length > 0, "planComplete must plan at least one action when planLifecycleMutations is true.");
    if (caps.applyLifecycleMutations === true) {
      assertMutationAllowed(harness.mutationBoundary, transport, harness.role, harness.liveMutationEnvVar);
      const applied = await provider.apply(start);
      assert.ok(Array.isArray(applied), "apply must return action results when applyLifecycleMutations is true.");
      assert.equal(applied.length, start.actions.length, "apply must return one result per planned lifecycle action.");
      assert.ok(
        applied.every(result => result.status === "completed"),
        "applyLifecycleMutations must complete planned actions through the fixture transport.",
      );
    }
  }

  if (caps.commentMutations === true) {
    assertMutationAllowed(harness.mutationBoundary, transport, harness.role, harness.liveMutationEnvVar);
    const items = await openWorkItems();
    assert.ok(items.length > 0, "commentMutations requires at least one work item.");
    const item = items[0];
    const plan = createActionPlan({
      id: "testkit:comment-mutation",
      purpose: "Observe advertised commentMutations capability.",
      dryRun: false,
      actions: [
        createAction({
          id: `comment-work:${item.key.id}`,
          kind: "comment-work",
          target: { kind: "work-item", id: item.key.id },
          mutation: "work-provider",
          description: `Post conformance comment on ${item.displayId}.`,
          expectedResult: `Comment recorded on ${item.displayId}.`,
          details: {
            body: "qube-testkit conformance comment",
            issueNumber: item.key.id,
            providerId: item.key.providerId,
          },
        }),
      ],
    });
    const results = await provider.apply(plan);
    assert.ok(results.length === 1, "commentMutations apply must return one action result.");
    assert.equal(results[0].status, "completed", "commentMutations apply must complete through the fixture transport.");
  }
  if (caps.reviewIntegration === true) {
    assert.equal(caps.listOpenWork, true, "reviewIntegration=true requires listOpenWork.");
    assert.equal(caps.loadWork, true, "reviewIntegration=true requires loadWork so review forge can resolve work keys.");
    const items = await openWorkItems();
    assert.ok(items.length > 0, "reviewIntegration requires at least one work item.");
    assert.ok(items.every(item => item.key.providerId === adapter.id && item.key.id.trim().length > 0));
    const loaded = await provider.getWorkItem(items[0].key);
    assert.equal(loaded.key.id, items[0].key.id, "reviewIntegration must load the same work key review forge would reference.");
    assert.ok(loaded.url === null || typeof loaded.url === "string", "reviewIntegration work items must expose a stable url field.");
  }
  if (caps.ciMergeStatus === true) {
    assert.equal(caps.listOpenWork, true, "ciMergeStatus=true requires listOpenWork.");
    const items = await openWorkItems();
    assert.ok(items.length > 0, "ciMergeStatus requires at least one work item.");
    for (const item of items) {
      assert.ok(item.trustedMetadata && typeof item.trustedMetadata === "object", "ciMergeStatus requires trustedMetadata objects.");
      assert.ok(
        Object.keys(item.trustedMetadata).length > 0,
        "ciMergeStatus requires non-empty trustedMetadata so CI checks can attach to work items.",
      );
    }
  }

  if (scenarios.createLargeResultTransport) {
    const largeTransport = await scenarios.createLargeResultTransport();
    const largeProvider = await harness.createSubject(largeTransport) as WorkProvider;
    const listed = await largeProvider.listOpenWorkItems();
    const expected = scenarios.expectedLargeResultCount ?? 2;
    assert.equal(
      listed.length,
      expected,
      `Large-result suite expected exactly ${expected} work items, got ${listed.length}.`,
    );
    assert.ok(harness.getListRequestCount, "Large-result coverage requires getListRequestCount instrumentation.");
    const requests = harness.getListRequestCount!(largeTransport);
    const maxRequests = scenarios.maxListRequests ?? Math.max(1, expected);
    assert.ok(requests >= 1, "Large-result transport must record at least one list request.");
    assert.ok(requests <= maxRequests, `List request count ${requests} exceeds maxListRequests ${maxRequests}.`);
    if (scenarios.singleShotHighLimit === true) {
      assert.equal(requests, 1, "singleShotHighLimit adapters must use exactly one list request for large-result coverage.");
      assert.ok(expected >= 5, "singleShotHighLimit large-result corpus must include at least 5 work items.");
    }
  }

  if (scenarios.createMultiPageTransport) {
    assert.ok(harness.getListRequestCount, "Multi-page coverage requires getListRequestCount instrumentation.");
    const pagedTransport = await scenarios.createMultiPageTransport();
    const pagedProvider = await harness.createSubject(pagedTransport) as WorkProvider;
    const listed = await pagedProvider.listOpenWorkItems();
    const expected = scenarios.expectedMultiPageItemCount ?? 2;
    assert.equal(listed.length, expected, `Multi-page suite expected exactly ${expected} work items, got ${listed.length}.`);
    const uniqueIds = new Set(listed.map(item => `${item.key.providerId}:${item.key.id}`));
    assert.equal(uniqueIds.size, listed.length, "Multi-page list must not return duplicate work item keys.");
    const requests = harness.getListRequestCount(pagedTransport);
    const minRequests = scenarios.minMultiPageRequests ?? 2;
    const maxRequests = scenarios.maxListRequests ?? Math.max(minRequests, expected);
    assert.ok(requests >= minRequests, `Multi-page suite expected at least ${minRequests} list requests, got ${requests}.`);
    assert.ok(requests <= maxRequests, `Multi-page suite expected at most ${maxRequests} list requests, got ${requests}.`);
  }

  if (scenarios.createMalformedTransport) {
    const badTransport = await scenarios.createMalformedTransport();
    const badProvider = await harness.createSubject(badTransport) as WorkProvider;
    await assert.rejects(
      () => badProvider.listOpenWorkItems(),
      /./,
      "Malformed work fixture must fail loudly instead of returning silent empty success.",
    );
  }

  // Supported declarations must not pass via pure no-op when related flags are false.
  for (const declaration of adapter.capabilities ?? []) {
    const flags = WORK_DECLARATION_FLAGS[declaration.id];
    if (!flags || declaration.support !== "supported") continue;
    for (const flag of flags) {
      assert.equal(caps[flag], true, `Supported ${declaration.id} requires work capability flag ${flag}=true.`);
    }
  }
}
