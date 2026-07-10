import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import type {
  QubeAdapterContract,
  ReviewForgeProvider,
  WorkProvider,
} from "@tjalve/qube-core";

import {
  assertCapabilityFlagsMatchDeclarations,
  REVIEW_CAPABILITIES,
  REVIEW_DECLARATION_FLAGS,
  sharedCapabilityIds,
  WORK_CAPABILITIES,
  WORK_DECLARATION_FLAGS,
} from "./capabilities.js";
import { assertFixtureFilesBound } from "./fixtures.js";
import type {
  AdapterHarnessDescriptor,
  AdapterRole,
  RoleHarness,
  RoleHarnessInput,
} from "./types.js";

function defineRoleHarness<TTransport, TSubject>(
  role: AdapterRole,
  input: RoleHarnessInput<TTransport, TSubject>,
): RoleHarness {
  assert.ok(input.fixtureRoot && input.fixtureRoot.trim().length > 0, `${role} must set fixtureRoot so fixtureFiles are bound to on-disk fixtures.`);
  const adapterCases = (input.capabilityCases ?? []).map(testCase => Object.freeze({
    capabilityId: testCase.capabilityId,
    name: testCase.name,
    run: async (subject: unknown) => testCase.run(subject as TSubject),
    unsupportedError: testCase.unsupportedError ?? /unsupported/i,
    shared: false,
  }));
  return Object.freeze({
    role,
    fixtureRoot: input.fixtureRoot,
    fixtureFiles: Object.freeze([...input.fixtureFiles]),
    createFixtureTransport: input.createFixtureTransport,
    createSubject: async (transport: unknown) => input.createSubject(transport as TTransport),
    mutationBoundary: input.mutationBoundary,
    liveMutationEnvVar: input.liveMutationEnvVar,
    capabilityCases: Object.freeze(adapterCases),
    workScenarios: input.workScenarios,
    reviewScenarios: input.reviewScenarios,
    ciScenarios: input.ciScenarios,
    getListRequestCount: input.getListRequestCount
      ? (transport: unknown) => input.getListRequestCount!(transport as TTransport)
      : undefined,
  });
}

export function defineWorkProviderHarness<TTransport, TProvider extends WorkProvider>(
  input: RoleHarnessInput<TTransport, TProvider>,
): RoleHarness {
  return defineRoleHarness("work-provider", input);
}

export function defineReviewForgeHarness<TTransport, TProvider extends ReviewForgeProvider>(
  input: RoleHarnessInput<TTransport, TProvider>,
): RoleHarness {
  return defineRoleHarness("review-forge", input);
}

export function defineCiProviderHarness<TTransport, TProvider>(
  input: RoleHarnessInput<TTransport, TProvider>,
): RoleHarness {
  return defineRoleHarness("ci-provider", input);
}

export function defineAdapterHarness(descriptor: AdapterHarnessDescriptor): AdapterHarnessDescriptor {
  assertDescriptor(descriptor);
  return Object.freeze({
    adapter: descriptor.adapter,
    roles: Object.freeze({ ...descriptor.roles }),
    ignoredCapabilities: Object.freeze([...(descriptor.ignoredCapabilities ?? [])]),
  });
}

export function roleHarnesses(descriptor: AdapterHarnessDescriptor): RoleHarness[] {
  return [descriptor.roles.work, descriptor.roles.review, descriptor.roles.ci].filter((role): role is RoleHarness => role !== undefined);
}

export function assertRolePlacement(harness: RoleHarness | undefined, expected: AdapterRole, field: string): void {
  if (harness) assert.equal(harness.role, expected, `Harness roles.${field} must use the ${expected} role contract.`);
}

export function addCoverage(coverage: Map<string, string>, capabilityId: string, owner: string): void {
  assert.ok(capabilityId.trim().length > 0, "Capability case ids must be non-empty.");
  // Every declared capability must be covered by exactly one owner (shared suite, adapter case, or ignore).
  assert.equal(
    coverage.has(capabilityId),
    false,
    `Capability ${capabilityId} is covered more than once (${coverage.get(capabilityId)} and ${owner}).`,
  );
  coverage.set(capabilityId, owner);
}

export async function createSubject(harness: RoleHarness, transport?: unknown): Promise<unknown> {
  const resolved = transport ?? await harness.createFixtureTransport();
  return harness.createSubject(resolved);
}

export async function verifyRoleShape(adapter: QubeAdapterContract, harness: RoleHarness): Promise<void> {
  const subject = await createSubject(harness);
  assert.ok(subject !== null && typeof subject === "object", `${harness.role} fixture must construct an object.`);
  if (harness.role === "work-provider") {
    const provider = subject as WorkProvider;
    assert.equal(provider.id, adapter.id);
    const capabilities = provider.capabilities();
    for (const capability of WORK_CAPABILITIES) {
      assert.equal(typeof capabilities[capability], "boolean", `Work capability ${capability} must be boolean.`);
    }
    assertCapabilityFlagsMatchDeclarations(adapter, "work-provider", capabilities, WORK_DECLARATION_FLAGS);
  }
  if (harness.role === "review-forge") {
    const provider = subject as ReviewForgeProvider;
    assert.equal(provider.id, adapter.id);
    const capabilities = provider.capabilities();
    for (const capability of REVIEW_CAPABILITIES) {
      const value = capabilities[capability];
      if (value !== undefined) {
        assert.equal(typeof value, "boolean", `Review capability ${capability} must be boolean when present.`);
      }
    }
    // Required flags must always be present as booleans.
    for (const capability of ["loadReview", "loadReviewSnapshot", "findCurrentBranchReview", "planReviewRequests", "applyReviewRequests"] as const) {
      assert.equal(typeof capabilities[capability], "boolean", `Review capability ${capability} must be boolean.`);
    }
    // Optional true flags must expose the matching methods; bare flags without methods are false success.
    if (capabilities.publishLaneReview === true) {
      assert.equal(typeof provider.publishLaneReviewFeedback, "function", "publishLaneReview=true requires publishLaneReviewFeedback().");
    }
    if (capabilities.publishLaneReviewInline === true) {
      assert.equal(typeof provider.publishLaneReviewFeedback, "function", "publishLaneReviewInline=true requires publishLaneReviewFeedback().");
    }
    if (capabilities.resolveReviewThreads === true) {
      assert.equal(typeof provider.resolveReviewThreads, "function", "resolveReviewThreads=true requires resolveReviewThreads().");
    }
    if (capabilities.loadReviewSnapshot === true) {
      assert.equal(typeof provider.loadReviewSnapshot, "function", "loadReviewSnapshot=true requires loadReviewSnapshot().");
    }
    if (capabilities.applyReviewRequests === true) {
      assert.equal(typeof provider.apply, "function", "applyReviewRequests=true requires apply().");
    }
    assertCapabilityFlagsMatchDeclarations(adapter, "review-forge", capabilities, REVIEW_DECLARATION_FLAGS);
  }
}

export function assertDescriptor(descriptor: AdapterHarnessDescriptor): void {
  const harnesses = roleHarnesses(descriptor);
  assert.ok(harnesses.length > 0 || descriptor.roles.connection, "Adapter harness must define at least one role suite.");
  assertRolePlacement(descriptor.roles.work, "work-provider", "work");
  assertRolePlacement(descriptor.roles.review, "review-forge", "review");
  assertRolePlacement(descriptor.roles.ci, "ci-provider", "ci");

  const declaredList = descriptor.adapter.capabilities ?? [];
  const seenIds = new Set<string>();
  for (const capability of declaredList) {
    assert.ok(capability.id.trim().length > 0, "Capability ids must be non-empty.");
    assert.equal(seenIds.has(capability.id), false, `Duplicate capability id ${capability.id} is not allowed.`);
    seenIds.add(capability.id);
  }

  const declared = new Map(declaredList.map(capability => [capability.id, capability]));
  const coverage = new Map<string, string>();
  for (const harness of harnesses) {
    assert.ok(harness.fixtureFiles.length > 0, `${harness.role} must name at least one fixture file.`);
    assertFixtureFilesBound(harness);
    // Shared suite only covers supported declarations it actually observes.
    // Unsupported / standalone declarations need explicit capabilityCases (or CI trigger hooks).
    const sharedIds = sharedCapabilityIds(harness).filter(capabilityId => {
      const declaration = declared.get(capabilityId);
      return declaration?.support === "supported";
    });
    let harnessCovered = 0;
    if (harness.role === "ci-provider") {
      const trigger = declared.get("trigger-workflow-run");
      if (trigger?.support === "unsupported") {
        assert.ok(
          harness.ciScenarios?.unsupportedTrigger,
          "CI harness must supply ciScenarios.unsupportedTrigger when trigger-workflow-run is unsupported.",
        );
        addCoverage(coverage, "trigger-workflow-run", "ci-provider:shared-unsupported");
        harnessCovered += 1;
      }
    }
    for (const capabilityId of sharedIds) {
      addCoverage(coverage, capabilityId, `${harness.role}:shared`);
      harnessCovered += 1;
    }
    for (const testCase of harness.capabilityCases) {
      addCoverage(coverage, testCase.capabilityId, harness.role);
      harnessCovered += 1;
    }
    assert.ok(
      harnessCovered > 0,
      `${harness.role} must define shared suite coverage or at least one capability case.`,
    );
  }
  for (const ignored of descriptor.ignoredCapabilities ?? []) {
    assert.ok(ignored.reason.trim().length > 0, `Ignored capability ${ignored.id} must include a reason.`);
    const capability = declared.get(ignored.id);
    assert.ok(capability, `Harness excludes undeclared capability ${ignored.id}.`);
    assert.notEqual(capability.owner, descriptor.adapter.packageName, `Adapter-owned capability ${ignored.id} cannot be excluded from observed behavior.`);
    addCoverage(coverage, ignored.id, "ignored");
  }

  for (const capabilityId of coverage.keys()) {
    assert.ok(declared.has(capabilityId), `Harness covers undeclared capability ${capabilityId}.`);
  }
  for (const capabilityId of declared.keys()) {
    assert.ok(coverage.has(capabilityId), `Declared capability ${capabilityId} has no role case, shared suite coverage, or explicit exclusion.`);
  }

  if (descriptor.roles.work) {
    const workHarness = descriptor.roles.work;
    assert.ok(
      workHarness.mutationBoundary === "fixture-only" || workHarness.mutationBoundary === "live-opt-in",
      "Work provider harness must set mutationBoundary to fixture-only or live-opt-in.",
    );
    if (workHarness.mutationBoundary === "live-opt-in") {
      assert.ok(workHarness.liveMutationEnvVar?.trim(), "Work provider live-opt-in harness must set liveMutationEnvVar.");
    }
    const workScenarios = workHarness.workScenarios;
    assert.ok(workScenarios?.statusPolicy && typeof workScenarios.statusPolicy === "object", "Work provider harness must supply workScenarios.statusPolicy for the shared status suite.");
    const queueSupported = declaredList.some(capability => capability.id === "work-item-queue" && capability.support === "supported");
    const mapSupported = declaredList.some(capability => capability.id === "map-work-item" && capability.support === "supported");
    if (queueSupported) {
      assert.ok(
        workScenarios.createLargeResultTransport,
        "Work provider harness must supply workScenarios.createLargeResultTransport when work-item-queue is supported.",
      );
      assert.ok(
        workScenarios.createMalformedTransport,
        "Work provider harness must supply workScenarios.createMalformedTransport when work-item-queue is supported.",
      );
      assert.ok(
        workScenarios.createMultiPageTransport,
        "Work provider harness must supply workScenarios.createMultiPageTransport for multi-page pagination coverage when work-item-queue is supported.",
      );
    }
    if (mapSupported && !queueSupported) {
      const keyCount = (workScenarios.fixtureWorkKeys?.length ?? 0)
        || Object.keys(workScenarios.expectedWorkById ?? {}).length;
      assert.ok(
        keyCount >= 2,
        "map-work-item without work-item-queue requires fixtureWorkKeys or expectedWorkById with at least two keys.",
      );
    }
  }
  if (descriptor.roles.review) {
    const reviewHarness = descriptor.roles.review;
    assert.ok(
      reviewHarness.mutationBoundary === "fixture-only" || reviewHarness.mutationBoundary === "live-opt-in",
      "Review forge harness must set mutationBoundary to fixture-only or live-opt-in.",
    );
    if (reviewHarness.mutationBoundary === "live-opt-in") {
      assert.ok(reviewHarness.liveMutationEnvVar?.trim(), "Review forge live-opt-in harness must set liveMutationEnvVar.");
    }
    assert.ok(reviewHarness.reviewScenarios?.reviewPolicy, "Review forge harness must supply reviewScenarios.reviewPolicy for the shared review suite.");
    assert.ok(
      reviewHarness.reviewScenarios?.sampleFindings && reviewHarness.reviewScenarios.sampleFindings.length >= 2,
      "Review forge harness must supply sampleFindings with at least two findings.",
    );
    const needsFixtureKey = declaredList.some(capability =>
      (capability.id === "read-merge-blockers" || capability.id === "read-review-threads" || capability.id === "request-review-gate" || capability.id === "resolve-review-threads")
      && capability.support === "supported",
    ) && !declaredList.some(capability => capability.id === "load-pull-request" && capability.support === "supported");
    if (needsFixtureKey) {
      assert.ok(
        reviewHarness.reviewScenarios?.fixtureReviewKey,
        "Review forge harness must supply fixtureReviewKey when independent review reads are supported without load-pull-request.",
      );
    }
  }
  if (descriptor.roles.ci) {
    assert.ok(descriptor.roles.ci.ciScenarios, "CI provider harness must supply ciScenarios for the shared CI suite.");
    const triggerSupported = declaredList.some(capability => capability.id === "trigger-workflow-run" && capability.support === "supported");
    if (triggerSupported) {
      assert.ok(
        descriptor.roles.ci.mutationBoundary === "fixture-only" || descriptor.roles.ci.mutationBoundary === "live-opt-in",
        "CI harness must set mutationBoundary when trigger-workflow-run is supported.",
      );
      if (descriptor.roles.ci.mutationBoundary === "live-opt-in") {
        assert.ok(descriptor.roles.ci.liveMutationEnvVar?.trim(), "CI live-opt-in harness must set liveMutationEnvVar.");
      }
    }
  }

  const connection = descriptor.roles.connection;
  if (connection) {
    assert.ok(connection.fixtureFile.trim().length > 0, "Connection harness must name its fixture file.");
    assert.ok(connection.fixtureRoot && connection.fixtureRoot.trim().length > 0, "Connection harness must set fixtureRoot.");
    assert.equal(isAbsolute(connection.fixtureFile), false, "Connection fixtureFile must be relative to fixtureRoot.");
    assert.equal(connection.fixtureFile.includes(".."), false, "Connection fixtureFile must not escape fixtureRoot.");
    const absolutePath = join(connection.fixtureRoot, connection.fixtureFile);
    assert.ok(existsSync(absolutePath), `Connection fixture file is missing or unbound: ${connection.fixtureFile}.`);
    assert.equal(connection.contract.adapterId, descriptor.adapter.id);
    assert.deepEqual(connection.contract, descriptor.adapter.connection);
    assert.equal(connection.contract.probe.readOnly, true);
  }
}
