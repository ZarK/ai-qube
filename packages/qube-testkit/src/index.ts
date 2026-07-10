import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { describe, it } from "node:test";

import type {
  ConnectionContract,
  ConnectionProbeFixture,
  ConnectionProbeOptions,
  ConnectionProbeResult,
  QubeAdapterCapability,
  QubeAdapterContract,
  ReviewForgeCapabilities,
  ReviewForgeProvider,
  ReviewItem,
  WorkItem,
  WorkProvider,
  WorkProviderCapabilities,
} from "@tjalve/qube-core";
import { normalizeReviewFinding, partitionReviewFindings } from "@tjalve/qube-core";

export type AdapterRole = "work-provider" | "review-forge" | "ci-provider";

export interface CapabilityCaseInput<TSubject> {
  readonly capabilityId: string;
  readonly name: string;
  readonly run: (subject: TSubject) => void | Promise<void>;
  readonly unsupportedError?: RegExp;
}

/** Shared work-provider scenario inputs consumed by the reusable suite. */
export interface WorkRoleScenarios {
  /** Policy object passed to planStatusSync for status-mapping cases. */
  readonly statusPolicy: unknown;
  /**
   * Optional multi-page / large-result transport. When set, the shared suite
   * constructs the subject from this transport and asserts list completeness
   * and request-count bounds.
   */
  readonly createLargeResultTransport?: () => unknown | Promise<unknown>;
  readonly expectedLargeResultCount?: number;
  readonly maxListRequests?: number;
  /** Optional malformed list payload transport; suite expects non-silent failure. */
  readonly createMalformedTransport?: () => unknown | Promise<unknown>;
}

/** Shared review-forge scenario inputs. */
export interface ReviewRoleScenarios {
  readonly reviewPolicy: {
    readonly adapter: "github" | "remote" | "local" | "mixed" | "shadow";
    readonly reviewers: readonly string[];
    readonly requestText: string;
  };
  /** Optional findings used to exercise partitionReviewFindings. */
  readonly sampleFindings?: readonly {
    readonly severity: "blocking" | "advisory";
    readonly message: string;
    readonly location?: { readonly path: string; readonly line?: number; readonly side?: "source" | "destination" };
  }[];
  readonly diffPathsWithLines?: Readonly<Record<string, readonly number[]>>;
}

/** Shared CI scenario inputs. */
export interface CiRoleScenarios {
  readonly mapCheck: (subject: unknown, check: unknown) => { readonly result: string };
  readonly passedCheck: unknown;
  readonly failedCheck: unknown;
  readonly pendingCheck: unknown;
  readonly unsupportedTrigger?: () => void;
}

export interface RoleHarnessInput<TTransport, TSubject> {
  /** Directory used to resolve and bind fixtureFiles on disk. */
  readonly fixtureRoot: string;
  readonly fixtureFiles: readonly string[];
  readonly createFixtureTransport: () => TTransport | Promise<TTransport>;
  readonly createSubject: (transport: TTransport) => TSubject | Promise<TSubject>;
  /**
   * Adapter-authored cases supplement the shared role suite for declared
   * capabilities that need provider-specific assertions. Shared suite cases
   * cover role-contract semantics so a new adapter does not start from zero.
   */
  readonly capabilityCases?: readonly CapabilityCaseInput<TSubject>[];
  readonly workScenarios?: WorkRoleScenarios;
  readonly reviewScenarios?: ReviewRoleScenarios;
  readonly ciScenarios?: CiRoleScenarios;
  /** Counts fixture-transport list invocations for pagination/large-result checks. */
  readonly getListRequestCount?: (transport: TTransport) => number;
}

export interface ConnectionHarness {
  readonly fixtureFile: string;
  readonly fixture: ConnectionProbeFixture;
  readonly contract: ConnectionContract;
  readonly probe: (options?: ConnectionProbeOptions) => Promise<ConnectionProbeResult>;
  readonly live?: {
    readonly envVar: string;
    readonly options?: ConnectionProbeOptions;
  };
  /** Deterministic negative probe fixtures for auth/trust-boundary coverage. */
  readonly negativeFixtures?: {
    readonly badCredential?: ConnectionProbeFixture;
    readonly unreachable?: ConnectionProbeFixture;
    readonly timeout?: ConnectionProbeFixture;
  };
}

export interface IgnoredCapability {
  readonly id: string;
  readonly reason: string;
}

interface CapabilityCase {
  readonly capabilityId: string;
  readonly name: string;
  readonly run: (subject: unknown) => void | Promise<void>;
  readonly unsupportedError: RegExp;
  readonly shared: boolean;
}

export interface RoleHarness {
  readonly role: AdapterRole;
  readonly fixtureRoot: string;
  readonly fixtureFiles: readonly string[];
  readonly createFixtureTransport: () => unknown | Promise<unknown>;
  readonly createSubject: (transport: unknown) => unknown | Promise<unknown>;
  readonly capabilityCases: readonly CapabilityCase[];
  readonly workScenarios?: WorkRoleScenarios;
  readonly reviewScenarios?: ReviewRoleScenarios;
  readonly ciScenarios?: CiRoleScenarios;
  readonly getListRequestCount?: (transport: unknown) => number;
}

export interface AdapterHarnessDescriptor {
  readonly adapter: QubeAdapterContract;
  readonly roles: {
    readonly work?: RoleHarness;
    readonly review?: RoleHarness;
    readonly ci?: RoleHarness;
    readonly connection?: ConnectionHarness;
  };
  readonly ignoredCapabilities?: readonly IgnoredCapability[];
}

const WORK_CAPABILITIES = Object.freeze([
  "listOpenWork",
  "loadWork",
  "planStatusSync",
  "planLifecycleMutations",
  "applyLifecycleMutations",
  "commentMutations",
  "reviewIntegration",
  "ciMergeStatus",
] as const satisfies readonly (keyof WorkProviderCapabilities)[]);

const REVIEW_CAPABILITIES = Object.freeze([
  "loadReview",
  "loadReviewSnapshot",
  "findCurrentBranchReview",
  "planReviewRequests",
  "applyReviewRequests",
  "publishLaneReview",
  "publishLaneReviewInline",
  "publishLocalReview",
  "resolveReviewThreads",
  "ciDiagnostics",
] as const satisfies readonly (keyof ReviewForgeCapabilities)[]);

/** Maps adapter capability declarations to role capability flags they imply. */
const WORK_DECLARATION_FLAGS: Readonly<Record<string, readonly (keyof WorkProviderCapabilities)[]>> = Object.freeze({
  "map-work-item": Object.freeze(["listOpenWork", "loadWork"] as const),
  "work-item-queue": Object.freeze(["listOpenWork"] as const),
  "sync-issue-status": Object.freeze(["planStatusSync"] as const),
});

const REVIEW_DECLARATION_FLAGS: Readonly<Record<string, readonly (keyof ReviewForgeCapabilities)[]>> = Object.freeze({
  "load-pull-request": Object.freeze(["loadReview", "findCurrentBranchReview"] as const),
  "request-review-gate": Object.freeze(["planReviewRequests"] as const),
  "read-merge-blockers": Object.freeze(["loadReview"] as const),
  "read-review-threads": Object.freeze(["loadReview"] as const),
  "resolve-review-threads": Object.freeze(["resolveReviewThreads"] as const),
});

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

export async function verifyAdapterHarness(descriptor: AdapterHarnessDescriptor): Promise<void> {
  assertDescriptor(descriptor);
  for (const harness of roleHarnesses(descriptor)) {
    await verifyRoleShape(descriptor.adapter, harness);
    await verifySharedRoleSuite(descriptor.adapter, harness);
    for (const testCase of harness.capabilityCases) {
      await verifyCapabilityCase(descriptor.adapter, harness, testCase);
    }
  }
  if (descriptor.roles.connection) await verifyConnection(descriptor.adapter, descriptor.roles.connection);
}

export function runAdapterConformance(descriptor: AdapterHarnessDescriptor): void {
  describe(`${descriptor.adapter.id} adapter conformance`, () => {
    it("covers every declared capability exactly once", () => assertDescriptor(descriptor));

    for (const harness of roleHarnesses(descriptor)) {
      describe(harness.role, () => {
        it("constructs the role through its fixture transport", async () => {
          await verifyRoleShape(descriptor.adapter, harness);
        });

        it("runs the shared role-contract suite", async () => {
          await verifySharedRoleSuite(descriptor.adapter, harness);
        });

        for (const testCase of harness.capabilityCases) {
          it(`${testCase.capabilityId}: ${testCase.name}`, async () => {
            await verifyCapabilityCase(descriptor.adapter, harness, testCase);
          });
        }
      });
    }

    const connection = descriptor.roles.connection;
    if (connection) {
      describe("connection-probe", () => {
        it("matches the adapter contract and passes from its fixture", async () => {
          await verifyConnection(descriptor.adapter, connection);
        });

        it("reports unverified without live access", async () => {
          const result = await connection.probe({ mode: "offline" });
          assert.equal(result.status, "unverified");
          assert.equal(result.readOnly, true);
        });

        it("fails bad-credential fixture probes", async () => {
          const fixture = connection.negativeFixtures?.badCredential ?? {
            command: { exitCode: 1, stdout: "", stderr: "authentication failed" },
          };
          const result = await connection.probe({ mode: "fixture", fixture });
          assert.equal(result.status, "fail");
          assert.equal(result.readOnly, true);
        });

        it("classifies unreachable fixture probes without pass", async () => {
          const fixture = connection.negativeFixtures?.unreachable ?? { error: "network" as const };
          const result = await connection.probe({ mode: "fixture", fixture });
          assert.notEqual(result.status, "pass");
          assert.equal(result.readOnly, true);
        });

        it("fails timeout fixture probes", async () => {
          const fixture = connection.negativeFixtures?.timeout ?? { error: "timeout" as const };
          const result = await connection.probe({ mode: "fixture", fixture });
          assert.equal(result.status, "fail");
          assert.match(result.summary, /timed out/i);
          assert.equal(result.readOnly, true);
        });

        if (connection.live) {
          it("runs live only when explicitly enabled", { skip: process.env[connection.live.envVar] !== "1" }, async () => {
            const result = await connection.probe({ ...connection.live?.options, mode: "live" });
            assert.equal(result.status, "pass");
            assert.equal(result.readOnly, true);
          });
        }
      });
    }
  });
}

function roleHarnesses(descriptor: AdapterHarnessDescriptor): RoleHarness[] {
  return [descriptor.roles.work, descriptor.roles.review, descriptor.roles.ci].filter((role): role is RoleHarness => role !== undefined);
}

function assertDescriptor(descriptor: AdapterHarnessDescriptor): void {
  const harnesses = roleHarnesses(descriptor);
  assert.ok(harnesses.length > 0 || descriptor.roles.connection, "Adapter harness must define at least one role suite.");
  assertRolePlacement(descriptor.roles.work, "work-provider", "work");
  assertRolePlacement(descriptor.roles.review, "review-forge", "review");
  assertRolePlacement(descriptor.roles.ci, "ci-provider", "ci");

  const declared = new Map((descriptor.adapter.capabilities ?? []).map(capability => [capability.id, capability]));
  const coverage = new Map<string, string>();
  for (const harness of harnesses) {
    assert.ok(harness.fixtureFiles.length > 0, `${harness.role} must name at least one fixture file.`);
    assertFixtureFilesBound(harness);
    // Shared suite only covers capabilities the adapter actually declares.
    const sharedIds = sharedCapabilityIds(harness).filter(capabilityId => declared.has(capabilityId));
    assert.ok(
      harness.capabilityCases.length > 0 || sharedIds.length > 0,
      `${harness.role} must define shared suite coverage or at least one capability case.`,
    );
    for (const capabilityId of sharedIds) addCoverage(coverage, capabilityId, `${harness.role}:shared`);
    for (const testCase of harness.capabilityCases) addCoverage(coverage, testCase.capabilityId, harness.role);
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
    assert.ok(descriptor.roles.work.workScenarios?.statusPolicy, "Work provider harness must supply workScenarios.statusPolicy for the shared status suite.");
  }
  if (descriptor.roles.review) {
    assert.ok(descriptor.roles.review.reviewScenarios?.reviewPolicy, "Review forge harness must supply reviewScenarios.reviewPolicy for the shared review suite.");
  }
  if (descriptor.roles.ci) {
    assert.ok(descriptor.roles.ci.ciScenarios, "CI provider harness must supply ciScenarios for the shared CI suite.");
  }

  const connection = descriptor.roles.connection;
  if (connection) {
    assert.ok(connection.fixtureFile.trim().length > 0, "Connection harness must name its fixture file.");
    assert.equal(connection.contract.adapterId, descriptor.adapter.id);
    assert.deepEqual(connection.contract, descriptor.adapter.connection);
    assert.equal(connection.contract.probe.readOnly, true);
  }
}

function sharedCapabilityIds(harness: RoleHarness): string[] {
  if (harness.role === "work-provider") return ["map-work-item", "work-item-queue", "sync-issue-status"];
  if (harness.role === "review-forge") {
    return ["load-pull-request", "request-review-gate", "read-merge-blockers", "read-review-threads", "resolve-review-threads"];
  }
  if (harness.role === "ci-provider") return ["read-ci-status", "diagnose-ci-status", "trigger-workflow-run"];
  return [];
}

function assertRolePlacement(harness: RoleHarness | undefined, expected: AdapterRole, field: string): void {
  if (harness) assert.equal(harness.role, expected, `Harness roles.${field} must use the ${expected} role contract.`);
}

function addCoverage(coverage: Map<string, string>, capabilityId: string, owner: string): void {
  assert.ok(capabilityId.trim().length > 0, "Capability case ids must be non-empty.");
  // Shared suite and adapter cases may both name the same capability; first writer wins for coverage accounting.
  if (!coverage.has(capabilityId)) coverage.set(capabilityId, owner);
}

async function createSubject(harness: RoleHarness, transport?: unknown): Promise<unknown> {
  const resolved = transport ?? await harness.createFixtureTransport();
  return harness.createSubject(resolved);
}

async function verifyRoleShape(adapter: QubeAdapterContract, harness: RoleHarness): Promise<void> {
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
    assertCapabilityFlagsMatchDeclarations(adapter, "review-forge", capabilities, REVIEW_DECLARATION_FLAGS);
  }
}

function assertCapabilityFlagsMatchDeclarations(
  adapter: QubeAdapterContract,
  role: AdapterRole,
  flags: WorkProviderCapabilities | ReviewForgeCapabilities,
  mapping: Readonly<Record<string, readonly string[]>>,
): void {
  const flagRecord = flags as unknown as Record<string, boolean | undefined>;
  for (const declaration of adapter.capabilities ?? []) {
    const requiredFlags = mapping[declaration.id];
    if (!requiredFlags) continue;
    if (declaration.support === "supported") {
      for (const flag of requiredFlags) {
        assert.equal(
          flagRecord[flag],
          true,
          `${role} capability flag ${flag} must be true when adapter declares ${declaration.id} as supported.`,
        );
      }
    }
    if (declaration.support === "unsupported") {
      // Fail only on a clear contradiction: every related flag is true while declared unsupported.
      if (requiredFlags.length > 0 && requiredFlags.every(flag => flagRecord[flag] === true)) {
        assert.fail(
          `${role} capability flags ${requiredFlags.join(", ")} are all true but adapter declares ${declaration.id} unsupported.`,
        );
      }
    }
  }
}

async function verifySharedRoleSuite(adapter: QubeAdapterContract, harness: RoleHarness): Promise<void> {
  if (harness.role === "work-provider") await verifyWorkRoleSuite(adapter, harness);
  if (harness.role === "review-forge") await verifyReviewRoleSuite(adapter, harness);
  if (harness.role === "ci-provider") await verifyCiRoleSuite(adapter, harness);
}

async function verifyWorkRoleSuite(adapter: QubeAdapterContract, harness: RoleHarness): Promise<void> {
  const scenarios = harness.workScenarios;
  assert.ok(scenarios, "Work provider harness must supply workScenarios.");
  const transport = await harness.createFixtureTransport();
  const provider = await harness.createSubject(transport) as WorkProvider;
  const caps = provider.capabilities();
  const declared = declarationMap(adapter);

  if (isSupported(declared, "work-item-queue") || isSupported(declared, "map-work-item")) {
    assert.equal(caps.listOpenWork, true, "listOpenWork must be true when queue/map work is supported.");
    const items = await provider.listOpenWorkItems();
    assert.ok(Array.isArray(items), "listOpenWorkItems must return an array.");
    assert.ok(items.length > 0, "Supported work queue fixture must yield at least one work item.");
    for (const item of items) assertWorkItemShape(item, adapter.id);

    if (isSupported(declared, "map-work-item")) {
      // Multi-item corpus exercises codec breadth (status/priority/checklist/blockers).
      assert.ok(items.length >= 2, "map-work-item shared suite requires a multi-item fixture corpus.");
      const statuses = new Set(items.map(item => item.status));
      assert.ok(statuses.size >= 1, "Work items must report canonical status values.");
      const withChecklist = items.filter(item => item.checklist.total > 0);
      assert.ok(withChecklist.length > 0, "At least one fixture work item must include checklist coverage.");
    }

    if (caps.loadWork && isSupported(declared, "map-work-item")) {
      const loaded = await provider.getWorkItem(items[0].key);
      assertWorkItemShape(loaded, adapter.id);
      assert.equal(loaded.key.id, items[0].key.id);
    }
  }

  if (isSupported(declared, "sync-issue-status")) {
    assert.equal(caps.planStatusSync, true, "planStatusSync must be true when sync-issue-status is supported.");
    const items = await provider.listOpenWorkItems();
    const plan = provider.planStatusSync(items, scenarios.statusPolicy as never);
    assert.ok(plan && typeof plan === "object", "planStatusSync must return an action plan object.");
    assert.ok(Array.isArray(plan.actions), "planStatusSync plan.actions must be an array.");
  }

  if (scenarios.createLargeResultTransport) {
    const largeTransport = await scenarios.createLargeResultTransport();
    const largeProvider = await harness.createSubject(largeTransport) as WorkProvider;
    const listed = await largeProvider.listOpenWorkItems();
    const expected = scenarios.expectedLargeResultCount ?? 2;
    assert.ok(listed.length >= expected, `Large-result suite expected at least ${expected} work items, got ${listed.length}.`);
    if (harness.getListRequestCount) {
      const requests = harness.getListRequestCount(largeTransport);
      const maxRequests = scenarios.maxListRequests ?? Math.max(1, expected);
      assert.ok(requests >= 1, "Large-result transport must record at least one list request.");
      assert.ok(requests <= maxRequests, `List request count ${requests} exceeds maxListRequests ${maxRequests}.`);
    }
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

async function verifyReviewRoleSuite(adapter: QubeAdapterContract, harness: RoleHarness): Promise<void> {
  const scenarios = harness.reviewScenarios;
  assert.ok(scenarios, "Review forge harness must supply reviewScenarios.");
  const provider = await createSubject(harness) as ReviewForgeProvider;
  const caps = provider.capabilities();
  const declared = declarationMap(adapter);

  if (isSupported(declared, "load-pull-request") || isSupported(declared, "read-merge-blockers") || isSupported(declared, "read-review-threads")) {
    assert.equal(caps.findCurrentBranchReview, true);
    const item = await provider.findReviewForCurrentBranch();
    assert.ok(item, "Supported review load fixture must yield a review item for the current branch.");
    assertReviewItemShape(item, adapter.id);

    if (isSupported(declared, "read-merge-blockers")) {
      assert.ok(Array.isArray(item.mergeBlockers), "Review item must expose mergeBlockers array.");
    }
    if (isSupported(declared, "read-review-threads")) {
      assert.ok(Array.isArray(item.conversations), "Review item must expose conversations array.");
    }
  }

  if (isSupported(declared, "request-review-gate")) {
    assert.equal(caps.planReviewRequests, true);
    const item = await provider.findReviewForCurrentBranch();
    assert.ok(item, "request-review-gate suite requires a loadable review item.");
    const plan = provider.planReviewRequest(item, scenarios.reviewPolicy);
    assert.ok(plan && Array.isArray(plan.actions), "planReviewRequest must return an action plan.");
  }

  if (isSupported(declared, "resolve-review-threads")) {
    assert.equal(caps.resolveReviewThreads, true, "resolveReviewThreads flag must be true when capability is supported.");
    assert.equal(typeof provider.resolveReviewThreads, "function", "resolve-review-threads requires a resolveReviewThreads method.");
  }

  if (scenarios.sampleFindings && scenarios.sampleFindings.length > 0) {
    const paths = scenarios.diffPathsWithLines ?? {};
    const diffIndex = {
      hasLine(path: string, line: number): boolean {
        return (paths[path] ?? []).includes(line);
      },
    };
    const partitioned = partitionReviewFindings(
      scenarios.sampleFindings.map(finding => normalizeReviewFinding(finding)),
      diffIndex,
    );
    assert.ok(partitioned.inline.length + partitioned.body.length === scenarios.sampleFindings.length);
  }

  for (const declaration of adapter.capabilities ?? []) {
    const flags = REVIEW_DECLARATION_FLAGS[declaration.id];
    if (!flags || declaration.support !== "supported") continue;
    for (const flag of flags) {
      const value = caps[flag as keyof ReviewForgeCapabilities];
      assert.equal(value, true, `Supported ${declaration.id} requires review capability flag ${String(flag)}=true.`);
    }
  }
}

async function verifyCiRoleSuite(adapter: QubeAdapterContract, harness: RoleHarness): Promise<void> {
  const scenarios = harness.ciScenarios;
  assert.ok(scenarios, "CI provider harness must supply ciScenarios.");
  const subject = await createSubject(harness);
  const declared = declarationMap(adapter);

  if (isSupported(declared, "read-ci-status")) {
    assert.equal(scenarios.mapCheck(subject, scenarios.passedCheck).result, "passed");
  }
  if (isSupported(declared, "diagnose-ci-status")) {
    assert.equal(scenarios.mapCheck(subject, scenarios.failedCheck).result, "failed");
    assert.equal(scenarios.mapCheck(subject, scenarios.pendingCheck).result, "pending");
  }
  if (isUnsupported(declared, "trigger-workflow-run") || declared.has("trigger-workflow-run")) {
    if (scenarios.unsupportedTrigger) {
      await assert.rejects(async () => {
        scenarios.unsupportedTrigger!();
      }, /unsupported/i);
    }
  }
}

async function verifyCapabilityCase(adapter: QubeAdapterContract, harness: RoleHarness, testCase: CapabilityCase): Promise<void> {
  const declaration = adapter.capabilities?.find(capability => capability.id === testCase.capabilityId);
  assert.ok(declaration, `Capability ${testCase.capabilityId} is not declared by ${adapter.id}.`);
  const subject = await createSubject(harness);

  // Refuse false success: supported declarations must not run against all-false role flags.
  if (declaration.support === "supported") {
    if (harness.role === "work-provider") {
      const caps = (subject as WorkProvider).capabilities();
      const flags = WORK_DECLARATION_FLAGS[declaration.id] ?? [];
      for (const flag of flags) {
        assert.equal(caps[flag], true, `Capability ${declaration.id} is supported but work flag ${flag} is false.`);
      }
    }
    if (harness.role === "review-forge") {
      const caps = (subject as ReviewForgeProvider).capabilities();
      const flags = REVIEW_DECLARATION_FLAGS[declaration.id] ?? [];
      for (const flag of flags) {
        assert.equal(
          caps[flag as keyof ReviewForgeCapabilities],
          true,
          `Capability ${declaration.id} is supported but review flag ${String(flag)} is false.`,
        );
      }
    }
  }

  let failure: unknown;
  try {
    await testCase.run(subject);
  } catch (error: unknown) {
    failure = error;
  }

  const message = failure === undefined ? "" : errorMessage(failure);
  if (declaration.support === "unsupported") {
    assert.ok(failure, `Capability ${declaration.id} is declared unsupported but its fixture case succeeded.`);
    assert.ok(
      matchesPattern(message, testCase.unsupportedError),
      `Capability ${declaration.id} must fail with an explicit unsupported error.`,
    );
    return;
  }
  if (!failure) return;
  if (matchesPattern(message, testCase.unsupportedError)) {
    assert.fail(`Capability ${declaration.id} is declared ${declaration.support} but fixture behavior reported unsupported.`);
  }
  throw failure;
}

function matchesPattern(message: string, pattern: RegExp): boolean {
  // Clone without the global flag so lastIndex cannot poison repeated suite runs.
  const flags = pattern.flags.replaceAll("g", "");
  return new RegExp(pattern.source, flags).test(message);
}

function assertFixtureFilesBound(harness: RoleHarness): void {
  assert.ok(
    harness.fixtureRoot && harness.fixtureRoot.trim().length > 0,
    `${harness.role} must set fixtureRoot so fixtureFiles are bound to on-disk fixtures.`,
  );
  for (const relativePath of harness.fixtureFiles) {
    const absolutePath = isAbsolute(relativePath) ? relativePath : join(harness.fixtureRoot, relativePath);
    assert.ok(
      existsSync(absolutePath),
      `${harness.role} fixture file is missing or unbound: ${relativePath} (resolved ${absolutePath}).`,
    );
  }
}

async function verifyConnection(adapter: QubeAdapterContract, harness: ConnectionHarness): Promise<void> {
  assert.equal(harness.contract.adapterId, adapter.id);
  assert.deepEqual(harness.contract, adapter.connection);
  assert.equal(harness.contract.probe.readOnly, true);
  const result = await harness.probe({ mode: "fixture", fixture: harness.fixture });
  assert.equal(result.status, "pass");
  assert.equal(result.adapterId, adapter.id);
  assert.equal(result.probeId, harness.contract.probe.id);
  assert.equal(result.readOnly, true);

  // Always exercise the three negative trust-boundary outcomes when a connection suite is present.
  const bad = await harness.probe({
    mode: "fixture",
    fixture: harness.negativeFixtures?.badCredential ?? {
      command: { exitCode: 1, stdout: "", stderr: "authentication failed" },
    },
  });
  assert.equal(bad.status, "fail", "Bad-credential connection fixture must fail.");

  const unreachable = await harness.probe({
    mode: "fixture",
    fixture: harness.negativeFixtures?.unreachable ?? { error: "network" },
  });
  assert.notEqual(unreachable.status, "pass", "Unreachable connection fixture must not pass.");

  const timeout = await harness.probe({
    mode: "fixture",
    fixture: harness.negativeFixtures?.timeout ?? { error: "timeout" },
  });
  assert.equal(timeout.status, "fail", "Timeout connection fixture must fail.");
  assert.match(timeout.summary, /timed out/i);
}

function declarationMap(adapter: QubeAdapterContract): Map<string, QubeAdapterCapability> {
  return new Map((adapter.capabilities ?? []).map(capability => [capability.id, capability]));
}

function isSupported(declared: Map<string, QubeAdapterCapability>, id: string): boolean {
  return declared.get(id)?.support === "supported";
}

function isUnsupported(declared: Map<string, QubeAdapterCapability>, id: string): boolean {
  return declared.get(id)?.support === "unsupported";
}

function assertWorkItemShape(item: WorkItem, adapterId: string): void {
  assert.equal(item.key.providerId, adapterId);
  assert.ok(item.key.id.trim().length > 0, "Work item key.id must be non-empty.");
  assert.ok(item.displayId.trim().length > 0, "Work item displayId must be non-empty.");
  assert.ok(item.title.trim().length > 0, "Work item title must be non-empty.");
  assert.ok(item.state === "open" || item.state === "closed", `Unexpected work item state ${item.state}.`);
  assert.ok(["in-progress", "ready", "blocked", "unknown"].includes(item.status), `Unexpected work status ${item.status}.`);
  assert.ok(["critical", "high", "medium", "low", "none"].includes(item.priority), `Unexpected work priority ${item.priority}.`);
  assert.ok(Array.isArray(item.blockers), "Work item blockers must be an array.");
  assert.ok(Array.isArray(item.blockedBy), "Work item blockedBy must be an array.");
  assert.ok(item.checklist && Number.isInteger(item.checklist.total), "Work item checklist.total must be an integer.");
  assert.ok(item.source && item.source.providerId === adapterId, "Work item source.providerId must match adapter id.");
}

function assertReviewItemShape(item: ReviewItem, adapterId: string): void {
  assert.equal(item.key.providerId, adapterId);
  assert.ok(item.key.id.trim().length > 0);
  assert.ok(item.displayId.trim().length > 0);
  assert.ok(item.title.trim().length > 0);
  assert.ok(Array.isArray(item.feedback), "Review feedback must be an array.");
  assert.ok(Array.isArray(item.mergeBlockers), "Review mergeBlockers must be an array.");
  assert.ok(Array.isArray(item.conversations), "Review conversations must be an array.");
  assert.ok(Array.isArray(item.checks), "Review checks must be an array.");
  assert.ok(item.source && item.source.providerId === adapterId);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type { QubeAdapterCapability };
